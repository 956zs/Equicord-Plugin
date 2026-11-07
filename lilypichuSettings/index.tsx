/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import definePlugin, { makeRange, OptionType } from "@utils/types";

import { ColorSetting, ImageSetting } from "./components";

// Same presets as lilypichu.theme.css: dark base, light base, and how far the
// decoration images (drawn for the default red) turn to match
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
const DEFAULT_HUE = 346;

export type ImageKind = "background" | "home";

const IMAGE_STORE_KEY: Record<ImageKind, string> = {
    background: "LilyPichuSettings_background",
    home: "LilyPichuSettings_homeIcon",
};

const imageUrls: Record<ImageKind, string | null> = { background: null, home: null };

let style: HTMLStyleElement | null = null;

function apply() {
    if (style) style.textContent = buildCss();
}

export const settings = definePluginSettings({
    preset: {
        type: OptionType.SELECT,
        description: "Color preset. A base color below overrides it",
        options: [
            { label: "Theme file / default", value: "default", default: true },
            ...Object.keys(PRESETS).map(p => ({ label: p[0].toUpperCase() + p.slice(1), value: p })),
        ],
        onChange: apply,
    },
    baseColor: {
        type: OptionType.COMPONENT,
        default: "",
        component: () => <ColorSetting settingKey="baseColor" title="Base color" note="The whole palette, the frame and the decorations are mixed from this color" />,
    },
    accentColor: {
        type: OptionType.COMPONENT,
        default: "",
        component: () => <ColorSetting settingKey="accentColor" title="Accent color" note="Buttons, selected channels, mentions. Derived from the base color when unset" />,
    },
    gradients: {
        type: OptionType.BOOLEAN,
        description: "Gradients on the frame, the lists, the chat and the right popout",
        default: false,
        onChange: apply,
    },
    gradientShift: {
        type: OptionType.SLIDER,
        description: "Gradient hue shift (negative goes toward purple)",
        markers: makeRange(-180, 180, 45),
        default: -45,
        stickToMarkers: false,
        onChange: apply,
    },
    gradientStrength: {
        type: OptionType.SLIDER,
        description: "Gradient strength (%)",
        markers: makeRange(0, 100, 20),
        default: 60,
        stickToMarkers: false,
        onChange: apply,
    },
    gradientAngle: {
        type: OptionType.SLIDER,
        description: "Gradient angle (degrees)",
        markers: makeRange(0, 360, 45),
        default: 160,
        stickToMarkers: false,
        onChange: apply,
    },
    backgroundImage: {
        type: OptionType.COMPONENT,
        component: () => <ImageSetting kind="background" title="Background image" note="Shown around the window instead of the pink frame" />,
    },
    backgroundBlur: {
        type: OptionType.SLIDER,
        description: "Background image blur (px)",
        markers: makeRange(0, 40, 10),
        default: 0,
        stickToMarkers: false,
        onChange: apply,
    },
    backgroundDim: {
        type: OptionType.SLIDER,
        description: "Background image dim (%)",
        markers: makeRange(0, 80, 20),
        default: 0,
        stickToMarkers: false,
        onChange: apply,
    },
    decorations: {
        type: OptionType.BOOLEAN,
        description: "Flowers, sparkles and corner decorations",
        default: true,
        onChange: apply,
    },
    popoutWidth: {
        type: OptionType.SLIDER,
        description: "Right popout width (px)",
        markers: makeRange(280, 420, 20),
        default: 320,
        stickToMarkers: false,
        onChange: apply,
    },
    borderRadius: {
        type: OptionType.SLIDER,
        description: "Corner radius (px)",
        markers: makeRange(0, 32, 4),
        default: 20,
        stickToMarkers: false,
        onChange: apply,
    },
    homeIcon: {
        type: OptionType.COMPONENT,
        component: () => <ImageSetting kind="home" title="Home button icon" note="Replaces the Discord logo on the Direct Messages button. Cropped to a square" />,
    },
    font: {
        type: OptionType.STRING,
        description: "Font name from Google Fonts, e.g. Huninn. Empty keeps the theme font",
        default: "",
        isValid: (v: string) => /^[\w -]*$/.test(v) || "Letters, digits, spaces and dashes only",
        onChange: apply,
    },
    profileThemes: {
        type: OptionType.SELECT,
        description: "Nitro profile themes",
        options: [
            { label: "Recolor with the theme", value: "lily", default: true },
            { label: "Keep each user's colors", value: "keep" },
        ],
        onChange: apply,
    },
});

function hexToHsl(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l * 100];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s * 100, l * 100];
}

function buildCss() {
    const s = settings.store;
    const vars: Record<string, string> = {};

    // Only values that differ from the theme go in, so the theme file and
    // QuickCSS still decide everything the panel leaves alone
    if (s.baseColor) {
        const [h] = hexToHsl(s.baseColor);
        vars["--base-color-dark"] = s.baseColor;
        vars["--base-color-light"] = `hsl(${Math.round(h)} 95% 76%)`;
        vars["--decoration-filter"] = `hue-rotate(${Math.round(h - DEFAULT_HUE)}deg)`;
    } else if (s.preset && PRESETS[s.preset]) {
        const [dark, light, turn] = PRESETS[s.preset];
        vars["--base-color-dark"] = dark;
        vars["--base-color-light"] = light;
        vars["--decoration-filter"] = turn ? `hue-rotate(${turn}deg)` : "none";
    }
    if (s.accentColor) vars["--accent-color"] = s.accentColor;

    if (s.gradients) vars["--gradients"] = "on";
    if (s.gradientShift !== -45) vars["--gradient-shift"] = String(Math.round(s.gradientShift));
    if (s.gradientStrength !== 60) vars["--gradient-strength"] = `${Math.round(s.gradientStrength)}%`;
    if (s.gradientAngle !== 160) vars["--gradient-angle"] = `${Math.round(s.gradientAngle)}deg`;

    if (imageUrls.background) {
        vars["--background-image"] = `url("${imageUrls.background}")`;
        if (s.backgroundBlur) vars["--background-blur"] = `${Math.round(s.backgroundBlur)}px`;
        if (s.backgroundDim) vars["--background-dim"] = `${Math.round(s.backgroundDim)}%`;
    }

    if (!s.decorations) vars["--decorations"] = "off";
    if (s.popoutWidth !== 320) vars["--popout-width"] = `${Math.round(s.popoutWidth)}px`;
    if (s.borderRadius !== 20) vars["--border-radius"] = `${Math.round(s.borderRadius)}px`;
    if (imageUrls.home) vars["--home-icon"] = `url("${imageUrls.home}")`;

    const font = s.font.trim();
    if (font) vars["--lily-font"] = `"${font}"`;
    if (s.profileThemes === "keep") vars["--profile-themes"] = "keep";

    const fontImport = font
        ? `@import url("https://fonts.googleapis.com/css2?family=${encodeURIComponent(font).replace(/%20/g, "+")}&display=swap");\n`
        : "";
    const body = Object.entries(vars).map(([k, v]) => `    ${k}: ${v};`).join("\n");
    // :root:root wins over the theme file's and QuickCSS's :root blocks
    return `${fontImport}:root:root {\n${body}\n}`;
}

async function loadImages() {
    for (const kind of Object.keys(IMAGE_STORE_KEY) as ImageKind[]) {
        if (imageUrls[kind]) URL.revokeObjectURL(imageUrls[kind]!);
        const blob = await DataStore.get<Blob>(IMAGE_STORE_KEY[kind]);
        imageUrls[kind] = blob ? URL.createObjectURL(blob) : null;
    }
}

export function getImageUrl(kind: ImageKind) {
    return imageUrls[kind];
}

// Shrinks the picked file before storing it: the background to 2560px on the
// long side, the home icon to a 256px center square
async function prepareImage(file: File, kind: ImageKind): Promise<Blob> {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;

    if (kind === "home") {
        const side = Math.min(bitmap.width, bitmap.height);
        canvas.width = canvas.height = 256;
        ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
    } else {
        const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    }
    bitmap.close();

    return new Promise((resolve, reject) => canvas.toBlob(
        b => b ? resolve(b) : reject(new Error("Could not encode the image")),
        kind === "home" ? "image/png" : "image/jpeg",
        0.9,
    ));
}

export async function setImage(kind: ImageKind, file: File | null) {
    if (file) await DataStore.set(IMAGE_STORE_KEY[kind], await prepareImage(file, kind));
    else await DataStore.del(IMAGE_STORE_KEY[kind]);
    await loadImages();
    apply();
}

export { apply };

export default definePlugin({
    name: "LilyPichuSettings",
    description: "Settings panel for the LilyPichu+ theme: colors, gradients, background image, layout and decorations",
    authors: [{ name: "nlcat", id: 586502118530351114n }],
    settings,

    async start() {
        style = createAndAppendStyle("vc-lilypichu-settings", managedStyleRootNode);
        apply();
        await loadImages();
        apply();
    },

    stop() {
        style?.remove();
        style = null;
        for (const kind of Object.keys(imageUrls) as ImageKind[]) {
            if (imageUrls[kind]) URL.revokeObjectURL(imageUrls[kind]!);
            imageUrls[kind] = null;
        }
    },
});
