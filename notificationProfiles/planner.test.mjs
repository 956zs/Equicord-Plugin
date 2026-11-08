/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Run: node --experimental-strip-types planner.test.mjs
import assert from "node:assert/strict";

import { emptyState, isKept, parseIds, planFocus, planRestore } from "./planner.ts";

const set = (...v) => new Set(v);
const dms = [
    { id: "c1", type: 1, recipients: ["u1"] },
    { id: "c2", type: 1, recipients: ["u2"] },
    { id: "c3", type: 3, recipients: ["u1", "u3"] },
    { id: "c4", type: 1, recipients: ["u4"] },
];
const base = { guildIds: ["g1", "g2", "g3"], mutedGuilds: set("g2"), dms, mutedChannels: set("c4"), whitelist: set("u1"), muteServers: true, muteGroupDMs: true };

// whitelisted DM kept, others muted, already muted ones skipped
let p = planFocus(base);
assert.deepEqual(p.guilds, ["g1", "g3"]);
assert.deepEqual(p.channels, ["c2", "c3"]);
assert.deepEqual(p.kept, ["c1"]);

// servers off, group DMs kept
p = planFocus({ ...base, muteServers: false, muteGroupDMs: false });
assert.deepEqual(p.guilds, []);
assert.deepEqual(p.channels, ["c2"]);
assert.deepEqual(p.kept, ["c1", "c3"]);

// empty whitelist mutes every unmuted DM
p = planFocus({ ...base, whitelist: set() });
assert.deepEqual(p.channels, ["c1", "c2", "c3"]);

// nothing to do
p = planFocus({ guildIds: [], mutedGuilds: set(), dms: [], mutedChannels: set(), whitelist: set(), muteServers: true, muteGroupDMs: true });
assert.deepEqual(p, { guilds: [], channels: [], kept: [] });

// a group DM is never kept by a whitelisted member when group DMs are muted
assert.equal(isKept(dms[2], set("u1"), true), false);
assert.equal(isKept(dms[0], set("u1"), true), true);

// restore: only what Focus muted and is still muted
const state = { guilds: ["g1", "g3"], channels: ["c2", "c3"] };
assert.deepEqual(planRestore(state, set("g1", "g2"), set("c2", "c3", "c4")), { guilds: ["g1"], channels: ["c2", "c3"] });
assert.deepEqual(planRestore(state, set(), set()), emptyState());

// id parsing
assert.deepEqual(parseIds("123456789012345678, 987654321098765432 ;123456789012345678 abc 12"), ["123456789012345678", "987654321098765432"]);
assert.deepEqual(parseIds(""), []);

console.log("planner tests ok");
