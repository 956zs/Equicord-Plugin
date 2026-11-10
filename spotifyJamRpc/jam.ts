/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Pure helpers (no Discord imports) so they can be tested with plain tsx.

// Discord limits for activity fields
export const MAX_TEXT = 128;
export const MAX_BUTTON_LABEL = 32;
export const MAX_BUTTON_URL = 512;

// Default texts (all editable in plugin settings). Placeholders: {song} {artist} {album}.
// Kept under the limits in UTF-16 units too, since the Tibetan marks are combining characters.
export const DEFAULT_TEXT = {
    activityName: "⁺‧₊˚ ཐི⋆♱ spotify jam ♱⋆ཋྀ ˚₊‧⁺",
    details: "{song}",
    state: "{artist}",
    imageText: "{album}",
    buttonLabel: "⋆♱ join the jam ♡ ♱⋆",
};

export const PLACEHOLDERS = ["{song}", "{artist}", "{album}"] as const;

export const ACTIVITY_TYPE_LISTENING = 2;
export const ACTIVITY_FLAG_INSTANCE = 1 << 0;

export type ParseResult = { ok: true; url: string; } | { ok: false; error: string; };

/**
 * Accepts a Spotify Jam invite: open.spotify.com/socialsession/<id> (copy link)
 * or a spotify.link / spotify.app.link short link (share sheet).
 */
export function parseJamUrl(input: unknown): ParseResult {
    if (typeof input !== "string" || !input.trim()) return { ok: false, error: "連結是空的" };
    const raw = input.trim();

    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { ok: false, error: "不是有效的網址" };
    }

    if (url.protocol !== "https:") return { ok: false, error: "連結必須是 https://" };
    if (url.username || url.password) return { ok: false, error: "連結不能包含帳號密碼" };

    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    if (host === "open.spotify.com") {
        if (!/^(\/intl-[a-z-]+)?\/socialsession\/[A-Za-z0-9]+$/.test(path))
            return { ok: false, error: "open.spotify.com 連結必須是 /socialsession/<id>（Jam 邀請）" };
    } else if (host === "spotify.link" || host === "spotify.app.link") {
        if (!/^\/[A-Za-z0-9_-]+$/.test(path)) return { ok: false, error: "短網址格式不對" };
    } else {
        return { ok: false, error: "只接受 open.spotify.com、spotify.link 或 spotify.app.link 的連結" };
    }

    const out = url.toString();
    if (out.length > MAX_BUTTON_URL) return { ok: false, error: `連結超過 ${MAX_BUTTON_URL} 字元` };
    return { ok: true, url: out };
}

export function truncate(text: string, max: number): string {
    const chars = Array.from(text);
    if (chars.length <= max) return text;
    return chars.slice(0, Math.max(0, max - 1)).join("") + "…";
}

export interface JamTrack {
    id: string;
    name: string;
    artists: string[];
    album?: string;
}

export interface JamOptions {
    appId: string;
    activityName: string;
    details: string;
    state: string;
    imageText: string;
    buttonLabel: string;
    showAlbumArt: boolean;
}

/** Fills {song} {artist} {album}; unknown braces stay as typed. Result is trimmed. */
export function renderTemplate(template: string, track: JamTrack): string {
    const values: Record<string, string> = {
        song: track.name ?? "",
        artist: track.artists.filter(Boolean).join(", "),
        album: track.album ?? "",
    };
    return template.replace(/\{(song|artist|album)\}/g, (_, k: string) => values[k]).trim();
}

export interface JamActivity {
    application_id: string;
    name: string;
    type: number;
    flags: number;
    details?: string;
    state?: string;
    assets?: { large_image?: string; large_text?: string; };
    buttons: string[];
    metadata: { button_urls: string[]; };
}

/**
 * Builds the activity, or null when it should be hidden
 * (no valid link, nothing playing, or missing names).
 */
export function buildActivity(jamUrl: string, track: JamTrack | null, opts: JamOptions, largeImage?: string): JamActivity | null {
    const parsed = parseJamUrl(jamUrl);
    if (!parsed.ok || !track) return null;

    const render = (tpl: string, max: number) => truncate(renderTemplate(tpl, track), max);
    const name = render(opts.activityName, MAX_TEXT);
    const label = render(opts.buttonLabel, MAX_BUTTON_LABEL);
    if (!name || !label || !/^\d{16,21}$/.test(opts.appId)) return null;

    const activity: JamActivity = {
        application_id: opts.appId,
        name,
        type: ACTIVITY_TYPE_LISTENING,
        flags: ACTIVITY_FLAG_INSTANCE,
        buttons: [label],
        metadata: { button_urls: [parsed.url] },
    };

    // Empty lines (blank template, or a placeholder with no value) are left out
    const details = render(opts.details, MAX_TEXT);
    if (details) activity.details = details;
    const state = render(opts.state, MAX_TEXT);
    if (state) activity.state = state;
    if (opts.showAlbumArt && largeImage) {
        const imageText = render(opts.imageText, MAX_TEXT);
        activity.assets = { large_image: largeImage, ...(imageText ? { large_text: imageText } : {}) };
    }

    return activity;
}

/** Same key = same activity, so the plugin can skip redundant dispatches. */
export function activityKey(jamUrl: string, track: JamTrack | null, opts: JamOptions): string {
    return JSON.stringify([jamUrl, track ? [track.id, track.name, track.artists, track.album] : null, opts]);
}
