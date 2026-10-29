/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { UserAreaRenderProps } from "@api/UserArea";
import { copyWithToast } from "@utils/discord";
import definePlugin from "@utils/types";
import { filters, findComponentByCodeLazy, findStoreLazy, mapMangledModuleLazy } from "@webpack";
import { AuthenticationStore, Menu, Popout, SessionsStore, useRef, useStateFromStores } from "@webpack/common";

import managedStyle from "./styles.css?managed";

const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
const IdleStore = findStoreLazy("IdleStore");
const { useStatusFillColor } = mapMangledModuleLazy([".5625*", "translate"], {
    useStatusFillColor: filters.byCode(".hex")
});

interface RawSession {
    sessionId: string;
    status: string;
    active: boolean;
    afk?: boolean;
    activities?: { name?: string; type?: number; }[];
    clientInfo?: { client?: string; os?: string; };
}

const CLIENT_LABELS: Record<string, string> = {
    desktop: "桌面版",
    web: "網頁版",
    mobile: "手機",
    embedded: "主機",
};

const STATUS_LABELS: Record<string, string> = {
    online: "線上",
    idle: "閒置",
    dnd: "請勿打擾",
    invisible: "隱形",
    offline: "離線",
};

const ICON_PATHS: Record<string, string> = {
    desktop: "M4 2.5c-1.103 0-2 .897-2 2v11c0 1.104.897 2 2 2h7v2H7v2h10v-2h-4v-2h7c1.103 0 2-.896 2-2v-11c0-1.103-.897-2-2-2H4Zm16 2v9H4v-9h16Z",
    web: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93Zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39Z",
    mobile: "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm0 2v14h10V4H7Zm5 15a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z",
    embedded: "M3.06 20.4q-1.53 0-2.37-1.065T.06 16.74l1.26-9q.27-1.8 1.605-2.97T6.06 3.6h11.88q1.8 0 3.135 1.17t1.605 2.97l1.26 9q.21 1.53-.63 2.595T20.94 20.4q-.63 0-1.17-.225T18.78 19.5l-2.7-2.7H7.92l-2.7 2.7q-.45.45-.99.675t-1.17.225Z",
};

const RADAR_PATH = "M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8V2Zm0 4a6 6 0 1 0 6 6h-2a4 4 0 1 1-4-4V6Zm0 4a2 2 0 1 0 2 2h-2v-2Z";

function useSessions() {
    const sessions = useStateFromStores([SessionsStore], () => SessionsStore.getSessions() as Record<string, RawSession>);
    // "all" is the server's aggregate entry, not a real connection
    return Object.values(sessions ?? {}).filter(s => s.sessionId !== "all");
}

function PlatformIcon({ client, status }: { client: string; status: string; }) {
    const color = useStatusFillColor(status);
    return (
        <svg className="vc-srad-platform" width="18" height="18" viewBox="0 0 24 24" aria-hidden>
            <path fill={color} d={ICON_PATHS[client] ?? ICON_PATHS.web} />
        </svg>
    );
}

function RadarIcon({ className }: { className?: string; }) {
    const count = useSessions().length;
    return (
        <span className={`vc-srad-btn-icon ${className ?? ""}`}>
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
                <path fill="currentColor" d={RADAR_PATH} />
            </svg>
            {count > 0 && <span className="vc-srad-badge">{count}</span>}
        </span>
    );
}

function describe(session: RawSession, afk: boolean | undefined) {
    const parts = [
        session.clientInfo?.os ?? "unknown",
        STATUS_LABELS[session.status] ?? session.status,
    ];
    const activity = session.activities?.find(a => a.type !== 4)?.name;
    if (activity) parts.push(activity);
    if (session.active) parts.push("ACTIVE");
    if (afk) parts.push("AFK");
    return parts.join(" · ");
}

function RadarMenu({ onClose }: { onClose(): void; }) {
    const sessions = useSessions();
    const selfId = AuthenticationStore.getSessionId();
    const selfAfk = useStateFromStores([IdleStore], () => IdleStore.isAFK() as boolean);

    const sorted = [...sessions].sort((a, b) =>
        Number(b.sessionId === selfId) - Number(a.sessionId === selfId)
        || Number(b.active) - Number(a.active)
    );

    return (
        <Menu.Menu navId="vc-session-radar" onClose={onClose} aria-label="Session Radar">
            <Menu.MenuGroup label={`${sessions.length} 個連線`}>
                {sorted.map(s => {
                    const client = s.clientInfo?.client ?? "unknown";
                    const isSelf = s.sessionId === selfId;
                    return (
                        <Menu.MenuItem
                            key={s.sessionId}
                            id={`vc-srad-${s.sessionId}`}
                            label={`${CLIENT_LABELS[client] ?? client}${isSelf ? "（這台）" : ""}`}
                            subtext={describe(s, isSelf ? selfAfk : s.afk)}
                            iconLeft={<PlatformIcon client={client} status={s.status} />}
                            action={() => copyWithToast(s.sessionId, "已複製 session ID")}
                        />
                    );
                })}
            </Menu.MenuGroup>
            <Menu.MenuSeparator />
            <Menu.MenuItem
                id="vc-srad-push"
                label={selfAfk ? "這台已回報 AFK" : "這台不是 AFK"}
                subtext={selfAfk ? "推播可以轉到手機" : "會攔下手機推播"}
                disabled
            />
        </Menu.Menu>
    );
}

function RadarButton(props: UserAreaRenderProps) {
    const buttonRef = useRef<HTMLDivElement | null>(null);
    return (
        <Popout
            position="top"
            align="left"
            targetElementRef={buttonRef}
            renderPopout={({ closePopout }) => <RadarMenu onClose={closePopout} />}
        >
            {popoutProps => (
                <PanelButton
                    ref={buttonRef}
                    tooltipText={props?.hideTooltips ? void 0 : "Session Radar"}
                    icon={RadarIcon}
                    plated={props?.nameplate != null}
                    onClick={popoutProps.onClick}
                />
            )}
        </Popout>
    );
}

export default definePlugin({
    name: "SessionRadar",
    description: "Shows your live gateway sessions (desktop / web / mobile) with status, active and AFK state",
    authors: [{ name: "nlcat", id: 586502118530351114n }],
    dependencies: ["UserAreaAPI"],
    managedStyle,
    userAreaButton: {
        icon: RadarIcon,
        render: RadarButton,
    },
});
