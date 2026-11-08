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
import { findComponentByCodeLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, GuildStore, Menu, Popout, RestAPI, showToast, useEffect, useReducer, useRef, UserGuildSettingsStore, UserStore } from "@webpack/common";

import { applyJournal, Deps, HttpError, restoreJournal } from "./engine";
import { DmInfo, DmPrefs, emptyJournal, GuildPrefs, isKept, Journal, matches, parseIds, planFocus } from "./planner";

const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

const JOURNAL_KEY = "NotificationProfiles_journal";

const settings = definePluginSettings({
    whitelist: {
        type: OptionType.STRING,
        description: "專注模式下仍然通知的使用者 ID（逗號分隔）。也可以在使用者的右鍵選單加入或移除",
        default: "",
        isValid: (v: string) => v.split(/[\s,;]+/).filter(Boolean).every(s => /^\d{15,25}$/.test(s)) || "只能填使用者 ID（數字）",
    },
    excludedGuilds: {
        type: OptionType.STRING,
        description: "專注模式不會動的伺服器 ID（逗號分隔）。也可以在伺服器的右鍵選單設定",
        default: "",
        isValid: (v: string) => v.split(/[\s,;]+/).filter(Boolean).every(s => /^\d{15,25}$/.test(s)) || "只能填伺服器 ID（數字）",
    },
    muteServers: {
        type: OptionType.BOOLEAN,
        description: "專注模式時讓伺服器不通知（靜音、手機推播關閉、通知設為「無」）",
        default: true,
    },
    muteGroupDMs: {
        type: OptionType.BOOLEAN,
        description: "專注模式時把群組私訊靜音",
        default: true,
    },
});

// ---------- state ----------

let journal: Journal = emptyJournal();
/** Last failures to show in the menu, by kind */
let lastFailed: { guilds: string[]; channels: string[]; restoring: boolean; } = { guilds: [], channels: [], restoring: false };
let busy = false;
let listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

function useProfileState() {
    const [, bump] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        listeners.add(bump);
        return () => void listeners.delete(bump);
    }, []);
    return { journal, lastFailed, busy };
}

const whitelist = () => new Set(parseIds(settings.store.whitelist));
const excluded = () => new Set(parseIds(settings.store.excludedGuilds));

// ---------- Discord access ----------

function currentGuild(id: string): GuildPrefs | null {
    if (!GuildStore.getGuild(id)) return null;
    const s = UserGuildSettingsStore as any;
    return {
        muted: s.isMuted(id),
        mute_config: s.getMuteConfig(id) ?? null,
        mobile_push: s.isMobilePushEnabled(id),
        message_notifications: s.getMessageNotifications(id),
        suppress_everyone: s.isSuppressEveryoneEnabled(id),
        suppress_roles: s.isSuppressRolesEnabled(id),
    };
}

function currentDm(id: string): DmPrefs | null {
    if (!ChannelStore.getChannel(id)) return null;
    const s = UserGuildSettingsStore as any;
    return { muted: s.isChannelMuted(null, id), mute_config: s.getChannelMuteConfig(null, id) ?? null };
}

function privateChannels(): DmInfo[] {
    return (ChannelStore.getSortedPrivateChannels() as any[])
        .filter(c => c.type === 1 || c.type === 3)
        .map(c => ({ id: c.id as string, type: c.type as number, recipients: (c.recipients ?? []) as string[] }));
}

async function patch(url: string, body: object) {
    try {
        const res: any = await RestAPI.patch({ url, body });
        return res?.body;
    } catch (e: any) {
        console.warn("[NotificationProfiles] PATCH", url, "failed:", e?.status, JSON.stringify(e?.body ?? e?.message ?? e).slice(0, 500));
        throw new HttpError(typeof e?.status === "number" ? e.status : undefined, e?.body?.retry_after);
    }
}

// The requests go out directly (Discord's own helpers do not wait for the
// server), then the local stores get the same update Discord dispatches
const deps: Deps = {
    async patchGuilds(batch) {
        const body = await patch("/users/@me/guilds/settings", { guilds: batch });
        for (const [guildId, settings] of Object.entries(batch))
            FluxDispatcher.dispatch({ type: "USER_GUILD_SETTINGS_GUILD_UPDATE", guildId, settings });
        return body;
    },
    async patchDms(overrides) {
        const body = await patch("/users/@me/guilds/@me/settings", { channel_overrides: overrides });
        FluxDispatcher.dispatch({ type: "USER_GUILD_SETTINGS_CHANNEL_UPDATE_BULK", guildId: null, overrides });
        return body;
    },
    currentGuild,
    currentDm,
    save: async j => {
        await DataStore.set(JOURNAL_KEY, j);
        emit();
    },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
};

/**
 * Restoring trusts the local stores to show what the server has. If most
 * confirmed changes look untouched there, the stores are stale (the local
 * update did not apply): stop rather than skip everything.
 */
function storesLookStale() {
    const done = Object.entries(journal.guilds).filter(([, c]) => c.status === "done");
    if (done.length < 3) return false;
    const stale = done.filter(([id, c]) => matches(currentGuild(id), c.prev)).length;
    return stale / done.length > 0.5;
}

const guildName = (id: string) => GuildStore.getGuild(id)?.name ?? id;

// ---------- switching ----------

async function run(task: () => Promise<void>) {
    if (busy) return;
    busy = true;
    emit();
    try {
        await task();
    } catch (e) {
        console.error("[NotificationProfiles]", e);
        showToast({ text: `出錯了：${String((e as Error)?.message ?? e)}`, variant: "critical" });
    } finally {
        busy = false;
        emit();
    }
}

function report(kind: "focus" | "normal", r: Awaited<ReturnType<typeof applyJournal>>) {
    const failedG = r.guilds.failed;
    const failedC = r.channels.failed;
    lastFailed = { guilds: failedG, channels: failedC, restoring: kind === "normal" };
    if (!failedG.length && !failedC.length) {
        showToast({
            text: kind === "focus"
                ? `專注模式：改了 ${r.guilds.ok.length} 個伺服器、${r.channels.ok.length} 個私訊`
                : `一般模式：還原了 ${r.guilds.ok.length} 個伺服器、${r.channels.ok.length} 個私訊`,
            variant: "success",
        });
    } else {
        const names = failedG.slice(0, 3).map(guildName).join("、");
        showToast({
            text: `${kind === "focus" ? "有些沒改成功" : "有些沒還原"}：${failedG.length} 個伺服器${names ? `（${names}…）` : ""}、${failedC.length} 個私訊。點鈴鐺重試`,
            variant: "critical",
        });
    }
}

function enterFocus() {
    return run(async () => {
        if (journal.profile !== "focus") {
            const dms = privateChannels();
            const guilds: Record<string, GuildPrefs> = {};
            for (const id of Object.keys(GuildStore.getGuilds())) {
                const cur = currentGuild(id);
                if (cur) guilds[id] = cur;
            }
            journal = planFocus({
                guilds,
                dms: dms.map(info => ({ info, prefs: currentDm(info.id)! })).filter(d => d.prefs),
                whitelist: whitelist(),
                excludedGuilds: excluded(),
                muteServers: settings.store.muteServers,
                muteGroupDMs: settings.store.muteGroupDMs,
            });
        }
        // also retries anything that failed last time
        report("focus", await applyJournal(journal, deps));
    });
}

function leaveFocus() {
    return run(async () => {
        if (storesLookStale()) {
            showToast({ text: "Discord 的設定畫面看起來還沒同步，為了不漏還原先停下來。按 Ctrl+R 重新載入後再切回一般模式", variant: "critical" });
            return;
        }
        report("normal", await restoreJournal(journal, deps));
    });
}

/** Applies or restores single items while Focus is on (whitelist / exclusion edits, new DMs) */
async function syncItems(guildIds: string[], channelIds: string[]) {
    if (journal.profile !== "focus") return;
    const wl = whitelist();
    const ex = excluded();
    const sub: Journal = { profile: "focus", guilds: {}, channels: {} };
    const toRestore: Journal = { profile: "focus", guilds: {}, channels: {} };

    for (const id of guildIds) {
        const cur = currentGuild(id);
        if (!cur) continue;
        if (ex.has(id)) {
            if (journal.guilds[id]) toRestore.guilds[id] = journal.guilds[id];
        } else if (settings.store.muteServers && !journal.guilds[id]) {
            Object.assign(sub.guilds, planFocus({ guilds: { [id]: cur }, dms: [], whitelist: wl, excludedGuilds: ex, muteServers: true, muteGroupDMs: true }).guilds);
        }
    }
    for (const id of channelIds) {
        const ch: any = ChannelStore.getChannel(id);
        const cur = currentDm(id);
        if (!ch || !cur || (ch.type !== 1 && ch.type !== 3)) continue;
        const info: DmInfo = { id, type: ch.type, recipients: ch.recipients ?? [] };
        if (isKept(info, wl, settings.store.muteGroupDMs)) {
            if (journal.channels[id]) toRestore.channels[id] = journal.channels[id];
        } else if (!journal.channels[id]) {
            Object.assign(sub.channels, planFocus({ guilds: {}, dms: [{ info, prefs: cur }], whitelist: wl, excludedGuilds: ex, muteServers: false, muteGroupDMs: settings.store.muteGroupDMs }).channels);
        }
    }

    const restoreGuilds = Object.keys(toRestore.guilds);
    const restoreChannels = Object.keys(toRestore.channels);
    if (restoreGuilds.length || restoreChannels.length) {
        // restoreJournal drops what it put back from toRestore; mirror that in the main journal
        await restoreJournal(toRestore, { ...deps, save: async () => { } });
        for (const id of restoreGuilds) if (!toRestore.guilds[id]) delete journal.guilds[id];
        for (const id of restoreChannels) if (!toRestore.channels[id]) delete journal.channels[id];
        await deps.save(journal);
    }
    if (Object.keys(sub.guilds).length || Object.keys(sub.channels).length) {
        Object.assign(journal.guilds, sub.guilds);
        Object.assign(journal.channels, sub.channels);
        await applyJournal(journal, deps);
    }
}

function onChannelCreate({ channel }: { channel?: { id: string; }; }) {
    if (channel) syncItems([], [channel.id]).catch(e => console.error("[NotificationProfiles]", e));
}

function toggleId(key: "whitelist" | "excludedGuilds", id: string) {
    const ids = new Set(parseIds(settings.store[key]));
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    settings.store[key] = [...ids].join(", ");
    emit();
}

function toggleWhitelist(userId: string) {
    toggleId("whitelist", userId);
    const dmId = ChannelStore.getDMFromUserId(userId);
    if (dmId) syncItems([], [dmId]).catch(e => console.error("[NotificationProfiles]", e));
}

function toggleExcluded(guildId: string) {
    toggleId("excludedGuilds", guildId);
    syncItems([guildId], []).catch(e => console.error("[NotificationProfiles]", e));
}

// ---------- UI ----------

const BELL = "M12 2a1 1 0 0 1 1 1v1.1A7 7 0 0 1 19 11v4l1.7 2.3a1 1 0 0 1-.8 1.7H4.1a1 1 0 0 1-.8-1.7L5 15v-4a7 7 0 0 1 6-6.9V3a1 1 0 0 1 1-1Zm0 20a3 3 0 0 1-2.8-2h5.6A3 3 0 0 1 12 22Z";
const SLASH = "M3.3 3.3a1 1 0 0 1 1.4 0l16 16a1 1 0 0 1-1.4 1.4l-16-16a1 1 0 0 1 0-1.4Z";

const pendingCount = (j: Journal) =>
    Object.values(j.guilds).filter(c => c.status !== "done").length + Object.values(j.channels).filter(c => c.status !== "done").length;

function Bell({ className, width = 20, height = 20 }: { className?: string; width?: number; height?: number; }) {
    const { journal: j, lastFailed: f } = useProfileState();
    const warn = pendingCount(j) > 0 || (f.restoring && (f.guilds.length || f.channels.length));
    return (
        <svg className={className} width={width} height={height} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={BELL} />
            {j.profile === "focus" && <path d={SLASH} />}
            {warn && <circle cx="19" cy="5" r="4" fill="var(--status-danger, #f23f43)" />}
        </svg>
    );
}

function ProfileMenu({ onClose }: { onClose(): void; }) {
    const { journal: j, lastFailed: f, busy: isBusy } = useProfileState();
    const { whitelist: wlText, excludedGuilds: exText } = settings.use(["whitelist", "excludedGuilds"]);
    const wl = parseIds(wlText);
    const ex = parseIds(exText);
    const focus = j.profile === "focus";
    const failedNames = f.guilds.slice(0, 5).map(guildName);
    const leftovers = focus ? pendingCount(j) : 0;

    return (
        <Menu.Menu navId="vc-notification-profiles" onClose={onClose} aria-label="通知設定檔">
            <Menu.MenuGroup label={isBusy ? "通知設定檔（處理中…）" : "通知設定檔"}>
                <Menu.MenuRadioItem
                    group="vc-nprof"
                    id="vc-nprof-normal"
                    label="一般模式"
                    subtext={focus ? "把專注模式改過的設定還原" : "照 Discord 原本的通知設定"}
                    checked={!focus}
                    disabled={isBusy}
                    action={leaveFocus}
                />
                <Menu.MenuRadioItem
                    group="vc-nprof"
                    id="vc-nprof-focus"
                    label="專注模式"
                    subtext={`只通知白名單的 ${wl.length} 個人的私訊`}
                    checked={focus}
                    disabled={isBusy}
                    action={enterFocus}
                />
            </Menu.MenuGroup>

            {(f.guilds.length > 0 || f.channels.length > 0 || leftovers > 0) && (
                <Menu.MenuGroup label="需要處理">
                    <Menu.MenuItem
                        id="vc-nprof-retry"
                        label={f.restoring ? "重試還原" : "重試沒改成功的"}
                        subtext={`${f.guilds.length} 個伺服器、${f.channels.length} 個私訊${failedNames.length ? `：${failedNames.join("、")}` : ""}`}
                        color="danger"
                        disabled={isBusy}
                        action={f.restoring ? leaveFocus : enterFocus}
                    />
                </Menu.MenuGroup>
            )}

            <Menu.MenuSeparator />
            <Menu.MenuGroup label="白名單（點一下移除）">
                {wl.length === 0 && <Menu.MenuItem id="vc-nprof-wl-empty" label="還沒有人" subtext="在使用者的右鍵選單加入" disabled />}
                {wl.map(id => {
                    const user: any = UserStore.getUser(id);
                    return (
                        <Menu.MenuItem
                            key={id}
                            id={`vc-nprof-wl-${id}`}
                            label={user?.globalName ?? user?.username ?? id}
                            subtext={user ? `@${user.username}` : id}
                            action={() => toggleWhitelist(id)}
                        />
                    );
                })}
            </Menu.MenuGroup>

            <Menu.MenuGroup label="不會動的伺服器（點一下移除）">
                {ex.length === 0 && <Menu.MenuItem id="vc-nprof-ex-empty" label="沒有" subtext="在伺服器的右鍵選單設定" disabled />}
                {ex.map(id => (
                    <Menu.MenuItem key={id} id={`vc-nprof-ex-${id}`} label={guildName(id)} action={() => toggleExcluded(id)} />
                ))}
            </Menu.MenuGroup>

            {focus && (
                <>
                    <Menu.MenuSeparator />
                    <Menu.MenuItem
                        id="vc-nprof-info"
                        label={`專注模式改了 ${Object.keys(j.guilds).length} 個伺服器、${Object.keys(j.channels).length} 個私訊`}
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
    const { journal: j } = useProfileState();
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
                    tooltipText={props?.hideTooltips ? void 0 : `通知設定檔：${j.profile === "focus" ? "專注模式" : "一般模式"}`}
                    icon={Bell}
                    plated={props?.nameplate != null}
                    onClick={popoutProps.onClick}
                />
            )}
        </Popout>
    );
}

const UserContext: NavContextMenuPatchCallback = (children, props: { user?: { id: string; }; }) => {
    const userId = props?.user?.id;
    if (!userId || userId === UserStore.getCurrentUser()?.id) return;
    const group = findGroupChildrenByChildId("close-dm", children) ?? findGroupChildrenByChildId("message-user", children);
    if (!group) return;
    const listed = parseIds(settings.store.whitelist).includes(userId);
    group.push(
        <Menu.MenuItem id="vc-nprof-whitelist" label={listed ? "從專注白名單移除" : "加入專注白名單"} action={() => toggleWhitelist(userId)} />
    );
};

const GuildContext: NavContextMenuPatchCallback = (children, props: { guild?: { id: string; }; }) => {
    const guildId = props?.guild?.id;
    if (!guildId) return;
    const listed = parseIds(settings.store.excludedGuilds).includes(guildId);
    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem
                id="vc-nprof-exclude"
                label={listed ? "專注模式也可以動這個伺服器" : "專注時不要動這個伺服器"}
                action={() => toggleExcluded(guildId)}
            />
        </Menu.MenuGroup>
    );
};

export default definePlugin({
    name: "NotificationProfiles",
    description: "Switch between your normal notifications and a focus mode that silences every server and DM except the people on your whitelist. It changes the real Discord settings (your phone follows), checks every change with the server and restores exactly what it changed",
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
        "guild-context": GuildContext,
    },

    async start() {
        journal = (await DataStore.get<Journal>(JOURNAL_KEY)) ?? emptyJournal();
        emit();
        FluxDispatcher.subscribe("CHANNEL_CREATE", onChannelCreate);
    },

    stop() {
        FluxDispatcher.unsubscribe("CHANNEL_CREATE", onChannelCreate);
        listeners = new Set();
    },
});
