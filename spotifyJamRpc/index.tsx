/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { ApplicationAssetUtils, FluxDispatcher, Menu, SpotifyStore } from "@webpack/common";

import { activityKey, buildActivity, DEFAULT_TEXT, JamOptions, JamTrack, parseJamUrl } from "./jam";

const SOCKET_ID = "SpotifyJamRpc";

const TEXT_FIELDS = [
    { key: "activityName", label: "活動名稱", required: true },
    { key: "details", label: "第一行", required: false },
    { key: "state", label: "第二行", required: false },
    { key: "imageText", label: "封面提示", required: false },
    { key: "buttonLabel", label: "按鈕文字", required: true },
] as const;
const logger = new Logger("SpotifyJamRpc");

const settings = definePluginSettings({
    jamUrl: {
        type: OptionType.STRING,
        default: "",
        description: "Spotify Jam invite link (open.spotify.com/socialsession/... or spotify.link/...). Also settable with /jam <link>.",
        isValid: (v: string) => !v || (r => r.ok || r.error)(parseJamUrl(v)),
        onChange: () => refresh(),
    },
    enabled: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show the Jam activity while Spotify is playing (keeps the link when off)",
        onChange: () => refresh(),
    },
    activityName: {
        type: OptionType.STRING,
        default: DEFAULT_TEXT.activityName,
        description: "Activity name, shown as \"Listening to <name>\". Placeholders: {song} {artist} {album}",
        onChange: () => refresh(),
    },
    details: {
        type: OptionType.STRING,
        default: DEFAULT_TEXT.details,
        description: "First line (empty = hidden). Placeholders: {song} {artist} {album}",
        onChange: () => refresh(),
    },
    state: {
        type: OptionType.STRING,
        default: DEFAULT_TEXT.state,
        description: "Second line (empty = hidden). Placeholders: {song} {artist} {album}",
        onChange: () => refresh(),
    },
    imageText: {
        type: OptionType.STRING,
        default: DEFAULT_TEXT.imageText,
        description: "Album art tooltip. Placeholders: {song} {artist} {album}",
        onChange: () => refresh(),
    },
    buttonLabel: {
        type: OptionType.STRING,
        default: DEFAULT_TEXT.buttonLabel,
        description: "Button text, max 32 characters. Placeholders: {song} {artist} {album}",
        onChange: () => refresh(),
    },
    showAlbumArt: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show the album cover of the current song",
        onChange: () => refresh(),
    },
    appId: {
        type: OptionType.STRING,
        default: "1108588077900898414",
        description: "Discord application ID the activity is sent under (needed for buttons and album art). Default is the shared app used by MusicRichPresence.",
        isValid: (v: string) => /^\d{16,21}$/.test(v) || "Must be a Discord application ID",
        onChange: () => refresh(),
    },
});

function currentTrack(): JamTrack | null {
    // Discord's SpotifyStore only keeps a player state while the track is playing
    const t = SpotifyStore?.getTrack();
    if (!t) return null;
    return {
        id: t.id,
        name: t.name,
        artists: (t.artists ?? []).map(a => a.name),
        album: t.album?.name,
    };
}

function currentImageUrl(): string | undefined {
    return SpotifyStore?.getTrack()?.album?.image?.url;
}

function options(): JamOptions {
    const s = settings.store;
    return { appId: s.appId, activityName: s.activityName, details: s.details, state: s.state, imageText: s.imageText, buttonLabel: s.buttonLabel, showAlbumArt: s.showAlbumArt };
}

const assetCache = new Map<string, string>();
async function resolveImage(appId: string, url: string | undefined): Promise<string | undefined> {
    if (!url) return undefined;
    const key = `${appId}:${url}`;
    const cached = assetCache.get(key);
    if (cached) return cached;
    try {
        const [id] = await ApplicationAssetUtils.fetchAssetIds(appId, [url]);
        if (id) {
            if (assetCache.size > 200) assetCache.clear();
            assetCache.set(key, id);
        }
        return id;
    } catch (e) {
        logger.warn("Album art lookup failed, sending without image", e);
        return undefined;
    }
}

let running = false;
let lastKey: string | null = null;
let generation = 0;

function dispatch(activity: object | null) {
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: SOCKET_ID });
}

async function refresh() {
    if (!running) return;
    const { jamUrl, enabled } = settings.store;
    const track = enabled ? currentTrack() : null;
    const opts = options();
    const key = activityKey(enabled ? jamUrl : "", track, opts);
    if (key === lastKey) return;
    lastKey = key;

    const gen = ++generation;
    if (!buildActivity(jamUrl, track, opts)) {
        dispatch(null);
        return;
    }

    const image = opts.showAlbumArt ? await resolveImage(opts.appId, currentImageUrl()) : undefined;
    if (gen !== generation || !running) return;
    dispatch(buildActivity(jamUrl, track, opts, image));
}

function statusText(): string {
    const { jamUrl, enabled } = settings.store;
    if (!jamUrl) return "目前沒有設定 Jam 連結。用 `/jam <連結>` 設定。";
    const playing = currentTrack() != null;
    const shown = enabled && playing;
    return [
        `Jam 連結：<${jamUrl}>`,
        `顯示開關：${enabled ? "開" : "關"}`,
        `Spotify：${playing ? "播放中" : "沒在播放"}`,
        shown ? "RPC 正在顯示。" : "RPC 目前沒有顯示。",
    ].join("\n");
}

export default definePlugin({
    name: "SpotifyJamRpc",
    description: "Shows a Rich Presence with a \"join my Jam\" button while Spotify is playing, so people can join your Spotify Jam without putting the link in your custom status",
    authors: [{ name: "nlcat", id: 586502118530351114n }],
    settings,
    requiresRestart: false,

    commands: [
        {
            name: "jam",
            description: "Set your Spotify Jam invite link, or show the current one",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "link",
                    description: "Jam invite link from Spotify (leave empty to show status)",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                },
            ],
            execute: (args, ctx) => {
                const link = findOption<string>(args, "link", "");
                if (!link.trim()) {
                    sendBotMessage(ctx.channel.id, { content: statusText() });
                    return;
                }
                const parsed = parseJamUrl(link);
                if (!parsed.ok) {
                    sendBotMessage(ctx.channel.id, { content: `沒有設定：${parsed.error}` });
                    return;
                }
                settings.store.jamUrl = parsed.url;
                settings.store.enabled = true;
                refresh();
                sendBotMessage(ctx.channel.id, { content: `已設定 Jam 連結。\n${statusText()}` });
            },
        },
        {
            name: "jam-text",
            description: "Change a line of the Jam activity ({song} {artist} {album} work); leave text empty to reset it",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "field",
                    description: "Which text to change",
                    type: ApplicationCommandOptionType.STRING,
                    required: true,
                    choices: TEXT_FIELDS.map(f => ({ name: f.key, label: f.label, value: f.key })),
                },
                {
                    name: "text",
                    description: "New text. Leave empty to reset to default, or type - to hide the line",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                },
            ],
            execute: (args, ctx) => {
                const field = TEXT_FIELDS.find(f => f.key === findOption<string>(args, "field", ""));
                if (!field) {
                    sendBotMessage(ctx.channel.id, { content: "不認得這個欄位。" });
                    return;
                }
                const text = findOption<string>(args, "text", "");
                const value = text.trim() === "" ? DEFAULT_TEXT[field.key] : text.trim() === "-" ? "" : text;
                if (field.required && !value.trim()) {
                    sendBotMessage(ctx.channel.id, { content: `${field.label}不能是空的。` });
                    return;
                }
                settings.store[field.key] = value;
                refresh();
                sendBotMessage(ctx.channel.id, { content: `${field.label}：\`${value.trim() || "（隱藏）"}\`${text.trim() === "" ? "（已重設為預設）" : ""}` });
            },
        },
        {
            name: "jam-stop",
            description: "Remove your Spotify Jam invite link and hide the activity",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                settings.store.jamUrl = "";
                refresh();
                sendBotMessage(ctx.channel.id, { content: "已移除 Jam 連結，RPC 已隱藏。" });
            },
        },
    ],

    toolboxActions() {
        const { enabled } = settings.use(["enabled"]);
        return (
            <Menu.MenuCheckboxItem
                id="spotify-jam-rpc-toggle"
                label="Show Spotify Jam RPC"
                checked={enabled}
                action={() => {
                    settings.store.enabled = !enabled;
                }}
            />
        );
    },

    // Discord hides buttons on your own activity; let them show so you can check the link.
    // CustomRPC ships the same patch, so only apply it when that plugin is off.
    patches: [
        {
            find: ".USER_PROFILE_ACTIVITY_BUTTONS),",
            predicate: () => !isPluginEnabled("CustomRPC"),
            replacement: {
                match: /.getId\(\)===\i.id/,
                replace: "$& && false",
            },
        },
    ],

    start() {
        running = true;
        lastKey = null;
        SpotifyStore.addChangeListener(refresh);
        refresh();
    },

    stop() {
        SpotifyStore.removeChangeListener(refresh);
        running = false;
        generation++;
        lastKey = null;
        dispatch(null);
    },
});
