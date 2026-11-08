/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { UserAreaRenderProps } from "@api/UserArea";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, findComponentByCodeLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, GuildStore, Menu, Popout, showToast, useEffect, useReducer, useRef, UserGuildSettingsStore, UserStore } from "@webpack/common";

import { DmInfo, emptyState, FocusState, isKept, parseIds, planFocus, planRestore } from "./planner";

const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
const NotificationActions = findByPropsLazy("updateGuildNotificationSettings");

const STATE_KEY = "NotificationProfiles_state";

type Profile = "normal" | "focus";

interface StoredState {
    profile: Profile;
    muted: FocusState;
}

const settings = definePluginSettings({
    whitelist: {
        type: OptionType.STRING,
        description: "專注模式下仍然通知的使用者 ID（逗號分隔）。也可以在使用者的右鍵選單加入或移除",
        default: "",
        isValid: (v: string) => v.split(/[\s,;]+/).filter(Boolean).every(s => /^\d{15,25}$/.test(s)) || "只能填使用者 ID（數字）",
    },
    muteServers: {
        type: OptionType.BOOLEAN,
        description: "專注模式時把所有伺服器靜音",
        default: true,
    },
    muteGroupDMs: {
        type: OptionType.BOOLEAN,
        description: "專注模式時把群組私訊靜音",
        default: true,
    },
});

let stored: StoredState = { profile: "normal", muted: emptyState() };
let listeners = new Set<() => void>();
let busy = false;

const emit = () => listeners.forEach(l => l());

async function persist() {
    await DataStore.set(STATE_KEY, stored);
    emit();
}

function useProfileState() {
    const [, bump] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        listeners.add(bump);
        return () => void listeners.delete(bump);
    }, []);
    return stored;
}

const whitelist = () => new Set(parseIds(settings.store.whitelist));

function privateChannels(): DmInfo[] {
    return (ChannelStore.getSortedPrivateChannels() as any[])
        .filter(c => c.type === 1 || c.type === 3)
        .map(c => ({ id: c.id as string, type: c.type as number, recipients: (c.recipients ?? []) as string[] }));
}

function muteChannel(channelId: string, muted: boolean) {
    const a = NotificationActions as any;
    if (typeof a.updateChannelOverrideSettings === "function")
        return a.updateChannelOverrideSettings({ guildId: null, channelId, settings: { muted } });
    return a.updateGuildAndChannelNotificationSettings(null, { channel_overrides: { [channelId]: { muted } } });
}

function muteGuild(guildId: string, muted: boolean) {
    return (NotificationActions as any).updateGuildNotificationSettings(guildId, { muted });
}

const isGuildMuted = (id: string) => UserGuildSettingsStore.isMuted(id) as boolean;
const isChannelMuted = (id: string) => UserGuildSettingsStore.isChannelMuted(null!, id) as boolean;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function enterFocus() {
    const wl = whitelist();
    const plan = planFocus({
        guildIds: Object.keys(GuildStore.getGuilds()),
        mutedGuilds: new Set(Object.keys(GuildStore.getGuilds()).filter(isGuildMuted)),
        dms: privateChannels(),
        mutedChannels: new Set(privateChannels().map(d => d.id).filter(isChannelMuted)),
        whitelist: wl,
        muteServers: settings.store.muteServers,
        muteGroupDMs: settings.store.muteGroupDMs,
    });

    const done: FocusState = { guilds: [...stored.muted.guilds], channels: [...stored.muted.channels] };
    stored = { profile: "focus", muted: done };

    // Mute one DM first and make sure it took before touching the rest
    for (const [i, id] of plan.channels.entries()) {
        await muteChannel(id, true);
        if (i === 0) {
            await sleep(400);
            if (!isChannelMuted(id)) {
                stored = { profile: "normal", muted: emptyState() };
                throw new Error("靜音沒有生效，已停止（沒有改動其他設定）");
            }
        }
        done.channels.push(id);
    }
    for (const id of plan.guilds) {
        await muteGuild(id, true);
        done.guilds.push(id);
    }
    await persist();
    return plan;
}

async function leaveFocus() {
    const guilds = Object.keys(GuildStore.getGuilds()).filter(isGuildMuted);
    const channels = privateChannels().map(d => d.id).filter(isChannelMuted);
    const restore = planRestore(stored.muted, new Set(guilds), new Set(channels));

    for (const id of restore.channels) await muteChannel(id, false);
    for (const id of restore.guilds) await muteGuild(id, false);

    stored = { profile: "normal", muted: emptyState() };
    await persist();
    return restore;
}

async function switchProfile(next: Profile) {
    if (busy || stored.profile === next) return;
    busy = true;
    try {
        if (next === "focus") {
            const plan = await enterFocus();
            showToast({ text: `專注模式：靜音了 ${plan.guilds.length} 個伺服器、${plan.channels.length} 個私訊，保留 ${plan.kept.length} 個`, variant: "success" });
        } else {
            const r = await leaveFocus();
            showToast({ text: `一般模式：還原了 ${r.guilds.length} 個伺服器、${r.channels.length} 個私訊`, variant: "success" });
        }
    } catch (e) {
        console.error("[NotificationProfiles]", e);
        await persist();
        showToast({ text: String((e as Error)?.message ?? e), variant: "critical" });
    } finally {
        busy = false;
    }
}

/** Keep one DM in step with the whitelist while Focus mode is on */
async function syncDm(channelId: string) {
    if (stored.profile !== "focus") return;
    const ch: any = ChannelStore.getChannel(channelId);
    if (!ch || (ch.type !== 1 && ch.type !== 3)) return;

    const dm: DmInfo = { id: ch.id, type: ch.type, recipients: ch.recipients ?? [] };
    const keep = isKept(dm, whitelist(), settings.store.muteGroupDMs);
    const weMuted = stored.muted.channels.includes(dm.id);

    if (keep && weMuted) {
        await muteChannel(dm.id, false);
        stored.muted.channels = stored.muted.channels.filter(id => id !== dm.id);
        await persist();
    } else if (!keep && !isChannelMuted(dm.id)) {
        await muteChannel(dm.id, true);
        stored.muted.channels.push(dm.id);
        await persist();
    }
}

function onChannelCreate({ channel }: { channel?: { id: string; }; }) {
    if (channel) syncDm(channel.id).catch(e => console.error("[NotificationProfiles]", e));
}

async function toggleWhitelist(userId: string) {
    const ids = new Set(parseIds(settings.store.whitelist));
    if (ids.has(userId)) ids.delete(userId);
    else ids.add(userId);
    settings.store.whitelist = [...ids].join(", ");

    const dmId = ChannelStore.getDMFromUserId(userId);
    if (dmId) await syncDm(dmId);
    emit();
}

const BELL = "M12 2a1 1 0 0 1 1 1v1.1A7 7 0 0 1 19 11v4l1.7 2.3a1 1 0 0 1-.8 1.7H4.1a1 1 0 0 1-.8-1.7L5 15v-4a7 7 0 0 1 6-6.9V3a1 1 0 0 1 1-1Zm0 20a3 3 0 0 1-2.8-2h5.6A3 3 0 0 1 12 22Z";
const BELL_OFF = "M12 2a1 1 0 0 1 1 1v1.1A7 7 0 0 1 19 11v4l1.7 2.3a1 1 0 0 1-.8 1.7H4.1a1 1 0 0 1-.8-1.7L5 15v-4a7 7 0 0 1 6-6.9V3a1 1 0 0 1 1-1Zm0 20a3 3 0 0 1-2.8-2h5.6A3 3 0 0 1 12 22ZM3.3 3.3a1 1 0 0 1 1.4 0l16 16a1 1 0 0 1-1.4 1.4l-16-16a1 1 0 0 1 0-1.4Z";

function Bell({ className, width = 20, height = 20 }: { className?: string; width?: number; height?: number; }) {
    const { profile } = useProfileState();
    return (
        <svg className={className} width={width} height={height} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={profile === "focus" ? BELL_OFF : BELL} />
        </svg>
    );
}

function ProfileMenu({ onClose }: { onClose(): void; }) {
    const state = useProfileState();
    const ids = parseIds(settings.use(["whitelist"]).whitelist);

    return (
        <Menu.Menu navId="vc-notification-profiles" onClose={onClose} aria-label="通知設定檔">
            <Menu.MenuGroup label="通知設定檔">
                <Menu.MenuRadioItem
                    group="vc-nprof"
                    id="vc-nprof-normal"
                    label="一般模式"
                    subtext="照 Discord 原本的通知設定"
                    checked={state.profile === "normal"}
                    action={() => switchProfile("normal")}
                />
                <Menu.MenuRadioItem
                    group="vc-nprof"
                    id="vc-nprof-focus"
                    label="專注模式"
                    subtext={`只通知白名單裡的 ${ids.length} 個人的私訊`}
                    checked={state.profile === "focus"}
                    action={() => switchProfile("focus")}
                />
            </Menu.MenuGroup>
            <Menu.MenuSeparator />
            <Menu.MenuGroup label="白名單（點一下移除）">
                {ids.length === 0 && (
                    <Menu.MenuItem id="vc-nprof-empty" label="還沒有人" subtext="在使用者的右鍵選單加入" disabled />
                )}
                {ids.map(id => {
                    const user: any = UserStore.getUser(id);
                    return (
                        <Menu.MenuItem
                            key={id}
                            id={`vc-nprof-wl-${id}`}
                            label={user?.globalName ?? user?.username ?? id}
                            subtext={user ? `@${user.username}` : id}
                            color="danger"
                            action={() => toggleWhitelist(id)}
                        />
                    );
                })}
            </Menu.MenuGroup>
            {state.profile === "focus" && (
                <>
                    <Menu.MenuSeparator />
                    <Menu.MenuItem
                        id="vc-nprof-info"
                        label={`專注模式靜音了 ${state.muted.guilds.length} 個伺服器、${state.muted.channels.length} 個私訊`}
                        subtext="切回一般模式只會還原這些"
                        disabled
                    />
                </>
            )}
        </Menu.Menu>
    );
}

function ProfileButton(props: UserAreaRenderProps) {
    const buttonRef = useRef<HTMLDivElement | null>(null);
    const { profile } = useProfileState();
    return (
        <Popout
            position="top"
            align="left"
            targetElementRef={buttonRef}
            renderPopout={({ closePopout }) => <ProfileMenu onClose={closePopout} />}
        >
            {popoutProps => (
                <PanelButton
                    ref={buttonRef}
                    tooltipText={props?.hideTooltips ? void 0 : `通知設定檔：${profile === "focus" ? "專注模式" : "一般模式"}`}
                    icon={Bell}
                    plated={props?.nameplate != null}
                    onClick={popoutProps.onClick}
                />
            )}
        </Popout>
    );
}

const UserContext: NavContextMenuPatchCallback = (children, props: { user?: { id: string; }; channel?: { type: number; }; }) => {
    const userId = props?.user?.id;
    if (!userId || userId === UserStore.getCurrentUser()?.id) return;

    const group = findGroupChildrenByChildId("close-dm", children) ?? findGroupChildrenByChildId("message-user", children);
    if (!group) return;

    const listed = parseIds(settings.store.whitelist).includes(userId);
    group.push(
        <Menu.MenuItem
            id="vc-nprof-whitelist"
            label={listed ? "從專注白名單移除" : "加入專注白名單"}
            action={() => toggleWhitelist(userId)}
        />
    );
};

export default definePlugin({
    name: "NotificationProfiles",
    description: "Switch between your normal notifications and a focus mode that mutes every server and DM except the people on your whitelist. It changes the real Discord settings, so your phone follows too",
    authors: [{ name: "nlcat", id: 586502118530351114n }],
    dependencies: ["UserAreaAPI"],
    settings,
    userAreaButton: {
        icon: Bell,
        render: ProfileButton,
    },
    contextMenus: {
        "user-context": UserContext,
        "gdm-context": UserContext,
    },

    async start() {
        stored = (await DataStore.get<StoredState>(STATE_KEY)) ?? { profile: "normal", muted: emptyState() };
        emit();
        FluxDispatcher.subscribe("CHANNEL_CREATE", onChannelCreate);
    },

    stop() {
        FluxDispatcher.unsubscribe("CHANNEL_CREATE", onChannelCreate);
        listeners = new Set();
    },
});
