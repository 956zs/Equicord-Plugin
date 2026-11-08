/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Run from the repo root: npx tsx tests/notificationProfiles.test.mts
import assert from "node:assert/strict";

// The plugin sources load as CommonJS here (no "type": "module"), so take the exports object
import engine from "../notificationProfiles/engine";
import planner from "../notificationProfiles/planner";

const { applyJournal, ATTEMPTS, HttpError, restoreJournal } = engine;
const { diff, emptyJournal, FOCUS_DM, FOCUS_GUILD, isKept, matches, NOTIFY_NOTHING, parseIds, planFocus, planRestore, same } = planner;

const set = (...v) => new Set(v);
const normalGuild = (o = {}) => ({ muted: false, mute_config: null, mobile_push: true, message_notifications: 1, suppress_everyone: false, suppress_roles: false, ...o });
const normalDm = (o = {}) => ({ muted: false, mute_config: null, ...o });
const clone = o => JSON.parse(JSON.stringify(o));

let failures = 0;
async function test(name, fn) {
    try { await fn(); console.log("ok  ", name); } catch (e) { failures++; console.log("FAIL", name, "\n     ", e.message); }
}

// A fake Discord: keeps settings, can be told to answer 429 / 500 / drop items
function fakeServer({ guilds = {}, dms = {} } = {}) {
    const srv = {
        guilds: clone(guilds), dms: clone(dms), requests: 0, sleeps: [], saves: [],
        rateLimitNext: 0, failGuild: new Set(), ignoreGuild: new Set(), down: false, downStatus: 500,
    };
    const answer = () => {
        srv.requests++;
        if (srv.down) throw new HttpError(srv.downStatus);
        if (srv.rateLimitNext > 0) { srv.rateLimitNext--; throw new HttpError(429, 1.5); }
    };
    srv.deps = {
        async patchGuilds(batch) {
            answer();
            for (const f of Object.values(batch))
                if ("message_notifications" in f && ![0, 1, 2].includes(f.message_notifications)) throw new HttpError(400);
            for (const id of Object.keys(batch)) if (srv.failGuild.has(id)) throw new HttpError(400);
            const body = [];
            for (const [id, f] of Object.entries(batch)) {
                if (!srv.ignoreGuild.has(id)) Object.assign(srv.guilds[id], f);
                body.push({ guild_id: id, ...srv.guilds[id] });
            }
            return body;
        },
        async patchDms(overrides) {
            answer();
            for (const [id, f] of Object.entries(overrides)) Object.assign(srv.dms[id], f);
            // Discord answers mute_config keys in the other order
            const flip = c => c && { end_time: c.end_time, selected_time_window: c.selected_time_window };
            return { channel_overrides: Object.entries(srv.dms).map(([channel_id, v]) => ({ channel_id, ...v, mute_config: flip(v.mute_config) })) };
        },
        currentGuild: id => srv.guilds[id] ?? null,
        currentDm: id => srv.dms[id] ?? null,
        async save(j) { srv.saves.push(clone(j)); },
        async sleep(ms) { srv.sleeps.push(ms); },
    };
    return srv;
}

const dmInfos = [
    { id: "c1", type: 1, recipients: ["u1"] },
    { id: "c2", type: 1, recipients: ["u2"] },
    { id: "c3", type: 3, recipients: ["u1", "u3"] },
];

function scenario(guildCount = 3) {
    const guilds = {};
    for (let i = 1; i <= guildCount; i++) guilds["g" + i] = normalGuild();
    guilds.g2 = normalGuild({ muted: true, mute_config: { selected_time_window: 3600, end_time: "2026-11-09T00:00:00Z" } });
    const dms = { c1: normalDm(), c2: normalDm(), c3: normalDm() };
    return { guilds, dms };
}

const planFor = (s, extra = {}) => planFocus({
    guilds: s.guilds,
    dms: dmInfos.map(info => ({ info, prefs: s.dms[info.id] })),
    whitelist: set("u1"),
    excludedGuilds: set(),
    muteServers: true,
    muteGroupDMs: true,
    ...extra,
});

// ---------- planner ----------
await test("diff keeps only changed fields with their old values", () => {
    assert.equal(diff(FOCUS_GUILD, FOCUS_GUILD), null);
    const d = diff(normalGuild({ muted: true }), FOCUS_GUILD);
    assert.equal("muted" in d.next, false);
    assert.equal(d.prev.mobile_push, true);
    assert.equal(d.next.message_notifications, 2);
});

await test("focus plan: whitelist kept, group DMs muted, excluded server untouched", () => {
    const s = scenario();
    const j = planFor(s, { excludedGuilds: set("g3") });
    assert.deepEqual(Object.keys(j.guilds).sort(), ["g1", "g2"]);
    assert.deepEqual(Object.keys(j.channels).sort(), ["c2", "c3"]);
    assert.deepEqual(j.guilds.g2.prev.mute_config, s.guilds.g2.mute_config, "timed mute remembered");
});

await test("focus plan: servers off and group DMs kept", () => {
    const j = planFor(scenario(), { muteServers: false, muteGroupDMs: false });
    assert.deepEqual(Object.keys(j.guilds), []);
    assert.deepEqual(Object.keys(j.channels), ["c2"]);
    assert.equal(isKept(dmInfos[2], set("u1"), true), false);
});

await test("restore plan skips fields changed by hand during focus", () => {
    const s = scenario();
    const j = planFor(s);
    const now = clone(s.guilds);
    for (const id of Object.keys(j.guilds)) Object.assign(now[id], j.guilds[id].next);
    now.g1.muted = false; // user unmuted g1 by hand
    const p = planRestore(j, id => now[id], () => null);
    assert.equal("muted" in p.guilds.g1, false);
    assert.equal(p.guilds.g1.mobile_push, true);
});

await test("same() ignores key order", () => {
    assert.ok(same({ selected_time_window: -1, end_time: null }, { end_time: null, selected_time_window: -1 }));
    assert.ok(!same({ a: 1 }, { a: 2 }));
    assert.ok(same(null, undefined));
});

await test("focus uses Discord's 'nothing' value (2)", () => {
    assert.equal(NOTIFY_NOTHING, 2);
    assert.equal(FOCUS_GUILD.message_notifications, 2);
});

await test("parseIds", () => {
    assert.deepEqual(parseIds("123456789012345678, 987654321098765432 ;123456789012345678 abc 12"), ["123456789012345678", "987654321098765432"]);
    assert.deepEqual(parseIds(""), []);
});

// ---------- engine ----------
await test("apply then restore returns every setting to the original", async () => {
    const s = scenario(60);
    const srv = fakeServer(s);
    const j = planFor(s);
    const r = await applyJournal(j, srv.deps);
    assert.equal(r.guilds.failed.length, 0);
    assert.equal(srv.requests, 3 + 1, "60 guilds in batches of 25 + one DM request");
    assert.ok(matches(srv.guilds.g1, FOCUS_GUILD) && matches(srv.dms.c2, FOCUS_DM));
    assert.ok(matches(srv.dms.c1, normalDm()), "whitelisted DM untouched");
    await restoreJournal(j, srv.deps);
    assert.deepEqual(srv.guilds, s.guilds);
    assert.deepEqual(srv.dms, s.dms);
    assert.equal(j.profile, "normal");
});

await test("journal is saved with old values before the first request", async () => {
    const s = scenario();
    const srv = fakeServer(s);
    const j = planFor(s);
    const before = srv.requests;
    await applyJournal(j, srv.deps);
    assert.equal(before, 0);
    assert.equal(srv.saves[0].guilds.g1.status, "pending");
    assert.equal(srv.saves[0].guilds.g1.prev.mobile_push, true);
});

await test("429 waits retry_after and succeeds", async () => {
    const s = scenario();
    const srv = fakeServer(s);
    srv.rateLimitNext = 2;
    const j = planFor(s);
    const r = await applyJournal(j, srv.deps);
    assert.equal(r.guilds.failed.length + r.channels.failed.length, 0);
    assert.deepEqual(srv.sleeps, [1750, 1750]);
});

await test("server down: everything marked failed, nothing claimed done", async () => {
    const s = scenario();
    const srv = fakeServer(s);
    srv.down = true;
    const j = planFor(s);
    const r = await applyJournal(j, srv.deps);
    assert.deepEqual(r.guilds.ok, []);
    assert.equal(Object.values(j.guilds).every(c => c.status === "failed"), true);
    assert.equal(srv.requests, ATTEMPTS * 2, "retried each batch");
    assert.deepEqual(srv.guilds, s.guilds, "nothing changed");
});

await test("400 is not retried", async () => {
    const s = scenario();
    const srv = fakeServer(s);
    srv.failGuild.add("g1");
    const r = await applyJournal(planFor(s), srv.deps);
    // the whole batch is rejected, so all three are reported, and nothing is retried
    assert.deepEqual(r.guilds.failed.sort(), ["g1", "g2", "g3"]);
    assert.equal(srv.sleeps.length, 0);
});

await test("a guild the server ignored is reported failed from the response", async () => {
    const s = scenario();
    const srv = fakeServer(s);
    srv.ignoreGuild.add("g3");
    const j = planFor(s);
    const r = await applyJournal(j, srv.deps);
    assert.deepEqual(r.guilds.failed, ["g3"]);
    assert.equal(j.guilds.g3.status, "failed");
});

await test("restore failure keeps the item for a retry, retry finishes it", async () => {
    const s = scenario();
    const srv = fakeServer(s);
    const j = planFor(s);
    await applyJournal(j, srv.deps);
    srv.down = true;
    const r1 = await restoreJournal(j, srv.deps);
    assert.ok(r1.guilds.failed.length > 0);
    assert.equal(j.profile, "focus", "still focus while something is not back");
    assert.ok(srv.saves.at(-1).guilds.g1, "failed item persisted");
    srv.down = false;
    await restoreJournal(j, srv.deps);
    assert.equal(j.profile, "normal");
    assert.deepEqual(srv.guilds, s.guilds);
});

await test("crash after sending, before saving 'done': restore still puts it back", async () => {
    const s = scenario();
    const srv = fakeServer(s);
    const j = planFor(s);
    await srv.deps.save(j);
    // the request lands but the app dies before recording the result
    await srv.deps.patchGuilds(Object.fromEntries(Object.entries(j.guilds).map(([id, c]) => [id, c.next])));
    const reloaded = clone(srv.saves[0]);
    assert.equal(reloaded.guilds.g1.status, "pending");
    await restoreJournal(reloaded, srv.deps);
    assert.deepEqual(srv.guilds, s.guilds);
});

await test("restore leaves alone what the user changed by hand", async () => {
    const s = scenario();
    const srv = fakeServer(s);
    const j = planFor(s);
    await applyJournal(j, srv.deps);
    srv.guilds.g1.muted = false;
    srv.guilds.g1.message_notifications = 0;
    await restoreJournal(j, srv.deps);
    assert.equal(srv.guilds.g1.message_notifications, 0, "hand change kept");
    assert.equal(srv.guilds.g1.mobile_push, true, "untouched focus field restored");
});

await test("DMs confirmed even when Discord reorders mute_config keys", async () => {
    const s = scenario();
    const srv = fakeServer(s);
    const j = planFor(s);
    const r = await applyJournal(j, srv.deps);
    assert.deepEqual(r.channels.failed, []);
    assert.deepEqual(r.channels.ok.sort(), ["c2", "c3"]);
});

await test("empty journal restore is a no-op", async () => {
    const srv = fakeServer();
    const j = emptyJournal();
    const r = await restoreJournal(j, srv.deps);
    assert.equal(srv.requests, 0);
    assert.deepEqual(r.guilds, { ok: [], failed: [] });
    assert.equal(j.profile, "normal");
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log("\nall tests passed");
