/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { useForceUpdater } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { RestAPI, showToast, useEffect } from "@webpack/common";

const logger = new Logger("AlwaysTyping");

// Discord shows a typing indicator for 10 s after each request
const MIN_INTERVAL = 3;
const MAX_INTERVAL = 9;

const settings = definePluginSettings({
    intervalSeconds: {
        type: OptionType.NUMBER,
        default: 8,
        description: `Seconds between typing requests (${MIN_INTERVAL}-${MAX_INTERVAL}). The indicator lasts 10 s, so keep it below that.`,
        isValid: (v: number) => Number.isInteger(v) && v >= MIN_INTERVAL && v <= MAX_INTERVAL || `Must be an integer between ${MIN_INTERVAL} and ${MAX_INTERVAL}`,
        onChange: () => restartTimer(),
    },
});

const activeChannels = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function notify() {
    for (const l of listeners) l();
}

async function sendTyping(channelId: string) {
    try {
        await RestAPI.post({ url: `/channels/${channelId}/typing` });
    } catch (e: any) {
        // 429 is a transient rate limit; anything else means we cannot type here
        if (e?.status === 429) return;
        logger.error(`Typing failed in ${channelId}, stopping`, e);
        activeChannels.delete(channelId);
        showToast({ text: "Always Typing stopped: no permission to type in this channel", variant: "critical" });
        syncTimer();
        notify();
    }
}

function tick() {
    for (const id of activeChannels) void sendTyping(id);
}

function syncTimer() {
    if (activeChannels.size === 0) {
        if (timer != null) clearInterval(timer);
        timer = null;
    } else if (timer == null) {
        timer = setInterval(tick, settings.store.intervalSeconds * 1000);
    }
}

function restartTimer() {
    if (timer != null) clearInterval(timer);
    timer = null;
    syncTimer();
}

function toggle(channelId: string) {
    if (activeChannels.has(channelId)) {
        activeChannels.delete(channelId);
    } else {
        activeChannels.add(channelId);
        void sendTyping(channelId);
    }
    syncTimer();
    notify();
}

function TypingIcon({ active }: { active?: boolean; } & Record<string, any>) {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
            <path
                fill={active ? "var(--status-positive)" : "currentColor"}
                d="M4 5a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h16a3 3 0 0 0 3-3V8a3 3 0 0 0-3-3H4Zm2 4h2v2H6V9Zm4 0h2v2h-2V9Zm4 0h2v2h-2V9Zm4 0h2v2h-2V9ZM6 13h2v2H6v-2Zm4 0h4v2h-4v-2Zm6 0h2v2h-2v-2Z"
            />
        </svg>
    );
}

const AlwaysTypingButton: ChatBarButtonFactory = ({ channel, isMainChat }) => {
    const forceUpdate = useForceUpdater();
    useEffect(() => {
        listeners.add(forceUpdate);
        return () => void listeners.delete(forceUpdate);
    }, []);

    if (!isMainChat) return null;
    const active = activeChannels.has(channel.id);

    return (
        <ChatBarButton
            tooltip={active ? "Stop Always Typing" : "Always Typing"}
            onClick={() => toggle(channel.id)}
        >
            <TypingIcon active={active} />
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "AlwaysTyping",
    description: "Keep your typing indicator showing in chosen channels until you turn it off (toggle from the chat bar)",
    authors: [{ name: "nlcat", id: 586502118530351114n }],
    dependencies: ["ChatInputButtonAPI"],
    settings,
    chatBarButton: {
        icon: TypingIcon,
        render: AlwaysTypingButton,
    },
    stop() {
        activeChannels.clear();
        syncTimer();
        notify();
    },
});
