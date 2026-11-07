/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";

// When the emoji / GIF / sticker picker closes, Discord focuses the message box
// and then hands focus back to the chat bar button that opened the picker, so
// Enter reopens the picker instead of sending. This puts focus back in the
// message box whenever a chat bar button gets focus without the user clicking
// it or tabbing to it. DOM based on purpose: no webpack patch to break when
// Discord moves modules around.

const INTENT_WINDOW_MS = 1000;

let lastPointer: { target: EventTarget | null; time: number; } | null = null;
let lastKey: { key: string; time: number; } | null = null;

function onPointerDown(e: PointerEvent) {
    lastPointer = { target: e.target, time: performance.now() };
}

function onKeyDown(e: KeyboardEvent) {
    lastKey = { key: e.key, time: performance.now() };
}

function onFocusIn(e: FocusEvent) {
    const button = e.target;
    if (!(button instanceof HTMLElement) || !button.matches('[role="button"], button')) return;
    if (!button.closest('[class^="buttons_"], [class*=" buttons_"]')) return;

    const textbox = button.closest("form")?.querySelector<HTMLElement>('[role="textbox"]');
    if (!textbox) return;

    const now = performance.now();
    const clickedIt = lastPointer != null
        && now - lastPointer.time < INTENT_WINDOW_MS
        && lastPointer.target instanceof Node
        && button.contains(lastPointer.target);
    const tabbedToIt = lastKey?.key === "Tab" && now - lastKey.time < INTENT_WINDOW_MS;
    if (clickedIt || tabbedToIt) return;

    // After Discord has finished restoring focus; the caret stays where the
    // picked emoji was inserted
    setTimeout(() => textbox.isConnected && textbox.focus(), 0);
}

export default definePlugin({
    name: "ExpressionPickerFocus",
    description: "After picking an emoji, GIF or sticker, the cursor goes back to the message box, so Enter sends instead of reopening the picker",
    authors: [{ name: "nlcat", id: 586502118530351114n }],

    start() {
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("focusin", onFocusIn, true);
    },

    stop() {
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("focusin", onFocusIn, true);
        lastPointer = lastKey = null;
    },
});
