/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Margins } from "@utils/margins";
import { ColorPicker, useState } from "@webpack/common";

import { apply, getImageUrl, ImageKind, setImage, settings } from ".";
import { PRESETS } from "./constants";

const suggestedColors = Object.values(PRESETS).map(([dark]) => dark);

const rowStyle = { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" } as const;

export function ColorSetting({ settingKey, title, note }: { settingKey: "baseColor" | "accentColor"; title: string; note: string; }) {
    const value = settings.use([settingKey])[settingKey];

    return (
        <div className={Margins.bottom16}>
            <Heading className={Margins.bottom8}>{title}</Heading>
            <Paragraph className={Margins.bottom8}>{note}</Paragraph>
            <div style={rowStyle}>
                <ColorPicker
                    color={value ? parseInt(value.slice(1), 16) : 0x6e3f4a}
                    onChange={(color: number) => {
                        settings.store[settingKey] = "#" + color.toString(16).padStart(6, "0");
                        apply();
                    }}
                    showEyeDropper={false}
                    suggestedColors={suggestedColors}
                />
                <Paragraph>{value || "Not set"}</Paragraph>
                {value && (
                    <Button
                        variant="secondary"
                        size="small"
                        onClick={() => {
                            settings.store[settingKey] = "";
                            apply();
                        }}
                    >
                        Reset
                    </Button>
                )}
            </div>
        </div>
    );
}

export function ImageSetting({ kind, title, note }: { kind: ImageKind; title: string; note: string; }) {
    const [url, setUrl] = useState(() => getImageUrl(kind));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function update(file: File | null) {
        setBusy(true);
        setError(null);
        try {
            await setImage(kind, file);
            setUrl(getImageUrl(kind));
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(false);
        }
    }

    function pick() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = () => {
            const file = input.files?.[0];
            if (file) update(file);
        };
        input.click();
    }

    return (
        <div className={Margins.bottom16}>
            <Heading className={Margins.bottom8}>{title}</Heading>
            <Paragraph className={Margins.bottom8}>{note}</Paragraph>
            <div style={rowStyle}>
                {url && (
                    <img
                        src={url}
                        alt=""
                        style={{
                            width: kind === "home" ? 48 : 96,
                            height: 48,
                            objectFit: "cover",
                            borderRadius: kind === "home" ? 16 : 8,
                        }}
                    />
                )}
                <Button variant="primary" size="small" disabled={busy} onClick={pick}>
                    {url ? "Change image" : "Choose image"}
                </Button>
                {url && (
                    <Button variant="secondary" size="small" disabled={busy} onClick={() => update(null)}>
                        Remove
                    </Button>
                )}
            </div>
            {error && <Paragraph style={{ color: "var(--text-feedback-critical)", marginTop: 8 }}>{error}</Paragraph>}
        </div>
    );
}
