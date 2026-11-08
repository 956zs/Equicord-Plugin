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

import * as controller from "./controller";
import { HttpError, type Result } from "./engine";
import { type Flag, isShared, newDeviceId, parseFlag } from "./flag";
import { type DmInfo, type DmPrefs, emptyJournal, FOCUS_DM, type GuildPrefs, type Journal, parseIds } from "./planner";
import { SYNC_CHANNEL_NAME } from "./sync";

const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

const JOURNAL_KEY = "NotificationProfiles_journal";
const DEVICE_KEY = "NotificationProfiles_device";
const DEVICE_LABEL = "desktop";

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

/** This device's copy of the journal (the shared one lives in the sync channel) */
let local: controller.LocalState = { journal: emptyJournal() };
let deviceId = "";
/** Last known cross-device flag (the private note on your own account) */
let sharedFlag: Flag | null = null;
/** The shared journal of the current flag could not be read last time */
let journalLost = false;
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
    return { journal: local.journal, lastFailed, busy, sharedFlag, journalLost };
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

/** A group DM with nobody else in it, like the sync channel: never worth muting */
const isSolo = (c: any) => c.type === 3 && !c.recipients?.length;

function privateChannels(): DmInfo[] {
    return (ChannelStore.getSortedPrivateChannels() as any[])
        .filter(c => (c.type === 1 || c.type === 3) && !isSolo(c))
        .map(c => ({ id: c.id as string, type: c.type as number, recipients: (c.recipients ?? []) as string[] }));
}

async function rest(method: "get" | "post" | "patch" | "del", url: string, options: { body?: object; query?: object; } = {}) {
    try {
        const res: any = await RestAPI[method]({ url, ...options });
        return res?.body;
    } catch (e: any) {
        console.warn("[NotificationProfiles]", method.toUpperCase(), url, "failed:", e?.status, JSON.stringify(e?.body ?? e?.message ?? e).slice(0, 500));
        throw new HttpError(typeof e?.status === "number" ? e.status : undefined, e?.body?.retry_after);
    }
}

// The requests go out directly (Discord's own helpers do not wait for the
// server), then the local stores get the same update Discord dispatches
const deps: controller.Platform["deps"] = {
    async patchGuilds(batch) {
        const body = await rest("patch", "/users/@me/guilds/settings", { body: { guilds: batch } });
        for (const [guildId, settings] of Object.entries(batch))
            FluxDispatcher.dispatch({ type: "USER_GUILD_SETTINGS_GUILD_UPDATE", guildId, settings });
        return body;
    },
    async patchDms(overrides) {
        const body = await rest("patch", "/users/@me/guilds/@me/settings", { body: { channel_overrides: overrides } });
        FluxDispatcher.dispatch({ type: "USER_GUILD_SETTINGS_CHANNEL_UPDATE_BULK", guildId: null, overrides });
        return body;
    },
    currentGuild,
    currentDm,
    sleep: ms => new Promise(r => setTimeout(r, ms)),
};

const guildName = (id: string) => GuildStore.getGuild(id)?.name ?? id;

// ---------- cross-device flag and shared journal ----------

const deviceName = (label: string) => ({ desktop: "電腦", phone: "手機" })[label] ?? label;
const flagTime = (f: Flag) => new Date(f.at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
const noteUrl = () => `/users/@me/notes/${UserStore.getCurrentUser().id}`;

async function readNote(): Promise<string | null> {
    try {
        const res: any = await RestAPI.get({ url: noteUrl() });
        return res?.body?.note || null;
    } catch (e: any) {
        if (e?.status === 404) return null;
        throw new Error(`讀不到同步旗標（HTTP ${e?.status ?? "?"}）`);
    }
}

async function writeNote(note: string) {
    try {
        await RestAPI.put({ url: noteUrl(), body: { note } });
    } catch (e: any) {
        throw new Error(`寫不進同步旗標（HTTP ${e?.status ?? "?"}）`);
    }
}

/** The group DM with only you that holds the shared journal; made on first use */
async function syncChannel(): Promise<string> {
    const me = UserStore.getCurrentUser().id;
    const found = (ChannelStore.getSortedPrivateChannels() as any[])
        .find(c => isSolo(c) && c.ownerId === me && c.name === SYNC_CHANNEL_NAME);
    if (found) return found.id;
    const { id } = await rest("post", "/users/@me/channels", { body: { recipients: [] } });
    await rest("patch", `/channels/${id}`, { body: { name: SYNC_CHANNEL_NAME } });
    await deps.patchDms({ [id]: FOCUS_DM });
    return id;
}

const platform: controller.Platform = {
    get deviceId() { return deviceId; },
    deviceLabel: DEVICE_LABEL,
    deps,
    guildIds: () => Object.keys(GuildStore.getGuilds()),
    privateChannels,
    options: () => ({
        whitelist: whitelist(),
        excluded: excluded(),
        muteServers: settings.store.muteServers,
        muteGroupDMs: settings.store.muteGroupDMs,
    }),
    readNote,
    writeNote,
    syncChannel,
    async listMessages(channelId) {
        const body = await rest("get", `/channels/${channelId}/messages`, { query: { limit: 100 } });
        return (Array.isArray(body) ? body : []).map((m: any) => ({ id: String(m.id), content: String(m.content ?? "") }));
    },
    async sendMessage(channelId, content) {
        // 4096: sent without a notification
        await rest("post", `/channels/${channelId}/messages`, { body: { content, flags: 4096 } });
    },
    async deleteMessage(channelId, messageId) {
        await rest("del", `/channels/${channelId}/messages/${messageId}`);
    },
    loadLocal: () => JSON.parse(JSON.stringify(local)),
    async saveLocal(state) {
        local = state;
        await DataStore.set(JOURNAL_KEY, state);
        emit();
    },
    now: () => Date.now(),
};

function setFlag(note: string | null) {
    const flag = parseFlag(note);
    if (flag?.journal !== sharedFlag?.journal) journalLost = false;
    sharedFlag = flag;
    emit();
}

async function refreshFlag() {
    try {
        const note = await readNote();
        setFlag(note);
        if (!busy) await controller.reconcile(platform, note);
    } catch (e) {
        console.warn("[NotificationProfiles]", e);
    }
}

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
        await refreshFlag();
    }
}

function report(kind: "focus" | "normal", r: { guilds: Result; channels: Result; }, syncError?: string) {
    const failedG = r.guilds.failed;
    const failedC = r.channels.failed;
    lastFailed = { guilds: failedG, channels: failedC, restoring: kind === "normal" };
    const sync = syncError ? `。同步頻道的紀錄沒更新（${syncError}）` : "";
    if (!failedG.length && !failedC.length) {
        showToast({
            text: (kind === "focus"
                ? `專注模式：改了 ${r.guilds.ok.length} 個伺服器、${r.channels.ok.length} 個私訊`
                : `一般模式：還原了 ${r.guilds.ok.length} 個伺服器、${r.channels.ok.length} 個私訊`) + sync,
            variant: syncError ? "critical" : "success",
        });
    } else {
        const names = failedG.slice(0, 3).map(guildName).join("、");
        showToast({
            text: `${kind === "focus" ? "有些沒改成功" : "有些沒還原"}：${failedG.length} 個伺服器${names ? `（${names}…）` : ""}、${failedC.length} 個私訊。點鈴鐺重試${sync}`,
            variant: "critical",
        });
    }
}

function show(o: controller.Outcome) {
    const fail = (text: string) => showToast({ text, variant: "critical" });
    switch (o.kind) {
        case "applied":
            return report("focus", o.result, o.syncError);
        case "restored":
            return report("normal", o.result, o.syncError);
        case "already-normal":
            lastFailed = { guilds: [], channels: [], restoring: false };
            return showToast({ text: "已經是一般模式", variant: "success" });
        case "other-device":
            return fail(`專注模式是${deviceName(o.flag.label)}在 ${flagTime(o.flag)} 開的，請到那台切換。那台資料不見的話，可以在這裡清除同步旗標`);
        case "foreign-note":
            return fail("你自己帳號的備註已經有別的內容，為了不蓋掉它，同步旗標用不了");
        case "stale-stores":
            return fail("Discord 的設定畫面看起來還沒同步，為了不漏還原先停下來。按 Ctrl+R 重新載入後再切回一般模式");
        case "journal-unreadable":
            journalLost = true;
            return fail(`讀不到同步頻道裡的紀錄（${o.error}），沒有改任何設定。到開專注模式的那台切回一般模式；那台的資料也不見了的話，才清除同步旗標`);
        case "unrestored":
            return fail("上次的專注模式還有設定沒還原，先切回一般模式再開");
    }
}

const enterFocus = () => run(async () => show(await controller.enter(platform)));
const leaveFocus = () => run(async () => show(await controller.leave(platform)));

function clearFlag() {
    return run(async () => {
        await controller.clearFlag(platform);
        showToast({ text: "已清除同步旗標", variant: "success" });
    });
}

const syncItems = (guildIds: string[], channelIds: string[]) =>
    controller.syncItems(platform, guildIds, channelIds).catch(e => console.error("[NotificationProfiles]", e));

// Another device changed the flag: Discord pushes note updates to every session
function onNoteUpdate({ id, note }: { id?: string; note?: string; }) {
    if (id !== UserStore.getCurrentUser()?.id) return;
    setFlag(note || null);
    if (!busy) controller.reconcile(platform, note || null).catch(e => console.error("[NotificationProfiles]", e));
}

function onChannelCreate({ channel }: { channel?: { id: string; }; }) {
    if (channel && !busy) syncItems([], [channel.id]);
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
    if (dmId) syncItems([], [dmId]);
}

function toggleExcluded(guildId: string) {
    toggleId("excludedGuilds", guildId);
    syncItems([guildId], []);
}

// ---------- UI ----------

const BELL = "M12 2a1 1 0 0 1 1 1v1.1A7 7 0 0 1 19 11v4l1.7 2.3a1 1 0 0 1-.8 1.7H4.1a1 1 0 0 1-.8-1.7L5 15v-4a7 7 0 0 1 6-6.9V3a1 1 0 0 1 1-1Zm0 20a3 3 0 0 1-2.8-2h5.6A3 3 0 0 1 12 22Z";
const SLASH = "M3.3 3.3a1 1 0 0 1 1.4 0l16 16a1 1 0 0 1-1.4 1.4l-16-16a1 1 0 0 1 0-1.4Z";

const pendingCount = (j: Journal) =>
    Object.values(j.guilds).filter(c => c.status !== "done").length + Object.values(j.channels).filter(c => c.status !== "done").length;

function Bell({ className, width = 20, height = 20 }: { className?: string; width?: number; height?: number; }) {
    const { journal: j, lastFailed: f, sharedFlag: flag } = useProfileState();
    const warn = pendingCount(j) > 0 || (f.restoring && (f.guilds.length || f.channels.length));
    // Focus on any device shows the slashed bell
    const focusAnywhere = j.profile === "focus" || flag != null;
    return (
        <svg className={className} width={width} height={height} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={BELL} />
            {focusAnywhere && <path d={SLASH} />}
            {warn && <circle cx="19" cy="5" r="4" fill="var(--status-danger, #f23f43)" />}
        </svg>
    );
}

function ProfileMenu({ onClose }: { onClose(): void; }) {
    const { journal: j, lastFailed: f, busy: isBusy, sharedFlag: flag, journalLost: lost } = useProfileState();
    const { whitelist: wlText, excludedGuilds: exText } = settings.use(["whitelist", "excludedGuilds"]);
    const wl = parseIds(wlText);
    const ex = parseIds(exText);
    const elsewhere = flag != null && flag.device !== deviceId ? flag : null;
    // A shared journal can be restored from here; a v1 flag only on its own device
    const lockedElsewhere = elsewhere != null && !isShared(elsewhere);
    const focus = j.profile === "focus" || flag != null;

    useEffect(() => void refreshFlag(), []);
    const failedNames = f.guilds.slice(0, 5).map(guildName);
    const leftovers = focus ? pendingCount(j) : 0;

    return (
        <Menu.Menu navId="vc-notification-profiles" onClose={onClose} aria-label="通知設定檔">
            <Menu.MenuGroup label={isBusy ? "通知設定檔（處理中…）" : "通知設定檔"}>
                <Menu.MenuRadioItem
                    group="vc-nprof"
                    id="vc-nprof-normal"
                    label="一般模式"
                    subtext={lockedElsewhere
                        ? `要在${deviceName(elsewhere.label)}切回`
                        : elsewhere ? `在這裡還原${deviceName(elsewhere.label)}開的專注模式`
                            : focus ? "把專注模式改過的設定還原" : "照 Discord 原本的通知設定"}
                    checked={!focus}
                    disabled={isBusy || lockedElsewhere}
                    action={leaveFocus}
                />
                <Menu.MenuRadioItem
                    group="vc-nprof"
                    id="vc-nprof-focus"
                    label={elsewhere ? `專注模式（${deviceName(elsewhere.label)}開的）` : "專注模式"}
                    subtext={elsewhere
                        ? `${flagTime(elsewhere)} 在${deviceName(elsewhere.label)}開的`
                        : `只通知白名單的 ${wl.length} 個人的私訊`}
                    checked={focus}
                    disabled={isBusy || elsewhere != null}
                    action={enterFocus}
                />
                {elsewhere && (lockedElsewhere || lost) && (
                    <Menu.MenuItem
                        id="vc-nprof-clear-flag"
                        label="清除同步旗標"
                        subtext={`只有${deviceName(elsewhere.label)}的資料不見時才需要；不會改任何通知設定`}
                        color="danger"
                        disabled={isBusy}
                        action={clearFlag}
                    />
                )}
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

            {j.profile === "focus" && (
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
    const { journal: j, sharedFlag: flag } = useProfileState();
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
                    tooltipText={props?.hideTooltips ? void 0 : `通知設定檔：${j.profile === "focus" || flag ? "專注模式" : "一般模式"}`}
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
        // Older versions stored the bare journal
        const saved = await DataStore.get<controller.LocalState | Journal>(JOURNAL_KEY);
        local = saved && "journal" in saved ? saved : { journal: (saved as Journal | undefined) ?? emptyJournal() };
        deviceId = (await DataStore.get<string>(DEVICE_KEY)) ?? newDeviceId();
        await DataStore.set(DEVICE_KEY, deviceId);
        emit();
        FluxDispatcher.subscribe("CHANNEL_CREATE", onChannelCreate);
        FluxDispatcher.subscribe("USER_NOTE_UPDATE", onNoteUpdate);
        refreshFlag();
    },

    stop() {
        FluxDispatcher.unsubscribe("CHANNEL_CREATE", onChannelCreate);
        FluxDispatcher.unsubscribe("USER_NOTE_UPDATE", onNoteUpdate);
        listeners = new Set();
    },
});
