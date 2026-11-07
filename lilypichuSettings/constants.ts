/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Same presets as lilypichu.theme.css: dark base, light base, and how far the
// decoration images (drawn for the default red) turn to match.
// Kept out of index.tsx: components.tsx reads it at load time, and index.tsx
// imports components.tsx, so it would still be undefined there.
export const PRESETS: Record<string, [dark: string, light: string, hueTurn: number]> = {
    pink: ["#632d46", "#f766a8", -14],
    red: ["#6e3f4a", "#fd8787", 0],
    orange: ["#5e2e16", "#e6803d", 34],
    yellow: ["#5d4a1f", "#fdd046", 56],
    green: ["#2f4626", "#5e9846", 117],
    cyan: ["#245150", "#41c7c1", -167],
    blue: ["#1e305b", "#3e64c7", -124],
    purple: ["#472a5e", "#9050b8", -73],
};

// Hue of the theme's default base color (#6e3f4a), which the decorations match
export const DEFAULT_HUE = 346;
