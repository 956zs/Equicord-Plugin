/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Pure planning for Focus mode, kept free of Discord imports so it can be
// tested on its own (see planner.test.mjs).

export interface DmInfo {
    id: string;
    /** 1 = DM, 3 = group DM */
    type: number;
    recipients: string[];
}

export interface FocusInput {
    guildIds: string[];
    mutedGuilds: ReadonlySet<string>;
    dms: DmInfo[];
    mutedChannels: ReadonlySet<string>;
    whitelist: ReadonlySet<string>;
    muteServers: boolean;
    muteGroupDMs: boolean;
}

export interface FocusPlan {
    guilds: string[];
    channels: string[];
    kept: string[];
}

export interface FocusState {
    /** Servers and DM channels Focus mode muted itself, so only those are restored */
    guilds: string[];
    channels: string[];
}

export const emptyState = (): FocusState => ({ guilds: [], channels: [] });

export function isKept(dm: DmInfo, whitelist: ReadonlySet<string>, muteGroupDMs: boolean) {
    if (dm.type === 1) return dm.recipients.some(id => whitelist.has(id));
    return !muteGroupDMs;
}

/** What to mute: everything not already muted and not kept by the whitelist */
export function planFocus(input: FocusInput): FocusPlan {
    const guilds = input.muteServers
        ? input.guildIds.filter(id => !input.mutedGuilds.has(id))
        : [];

    const channels: string[] = [];
    const kept: string[] = [];
    for (const dm of input.dms) {
        if (isKept(dm, input.whitelist, input.muteGroupDMs)) kept.push(dm.id);
        else if (!input.mutedChannels.has(dm.id)) channels.push(dm.id);
    }
    return { guilds, channels, kept };
}

/** What to unmute: only what Focus muted and is still muted (anything the user changed by hand stays) */
export function planRestore(state: FocusState, mutedGuilds: ReadonlySet<string>, mutedChannels: ReadonlySet<string>): FocusState {
    return {
        guilds: state.guilds.filter(id => mutedGuilds.has(id)),
        channels: state.channels.filter(id => mutedChannels.has(id)),
    };
}

export function parseIds(text: string): string[] {
    return [...new Set(text.split(/[\s,;]+/).map(s => s.trim()).filter(s => /^\d{15,25}$/.test(s)))];
}
