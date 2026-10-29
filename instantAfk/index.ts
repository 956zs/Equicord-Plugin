/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";

const settings = definePluginSettings({
    timeoutSeconds: {
        type: OptionType.NUMBER,
        default: 0,
        description: "Seconds of inactivity before the client reports AFK (mobile push takes over). 0 = always AFK. The server clamps the synced setting to 60, this only overrides the local value.",
        isValid: (v: number) => Number.isInteger(v) && v >= 0 || "Must be a non-negative integer",
    },
});

export default definePlugin({
    name: "InstantAfk",
    description: "Override the push notification inactive timeout locally, allowing values below the 1 minute minimum (including 0)",
    authors: [{ name: "nlcat", id: 586502118530351114n }],
    settings,
    patches: [
        {
            find: 'type:"AFK",afk:!0',
            replacement: {
                match: /0===\((\i)=\i\.\i\.getSetting\(\)\)/,
                replace: "0===($1=$self.getTimeout())",
            },
        },
    ],
    getTimeout() {
        return settings.store.timeoutSeconds;
    },
});
