/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Run from the repo root: npx tsx tests/notificationProfiles.test.mts
import assert from "node:assert/strict";

// The plugin sources load as CommonJS here (no "type": "module"), so take the exports object
import controller from "../notificationProfiles/controller";
import engine from "../notificationProfiles/engine";
import flagMod from "../notificationProfiles/flag";
import planner from "../notificationProfiles/planner";
import syncMod from "../notificationProfiles/sync";

const { clearFlag, enter, leave, reconcile, syncItems } = controller;
const { applyJournal, ATTEMPTS, HttpError, restoreJournal } = engine;
const { canEnter, canLeave, encodeFlag, isForeignNote, isShared, parseFlag } = flagMod;
const { CHUNK_DATA, checksum, chunkMessageIds, decodeJournal, encodeJournal, fromChunks, toChunks } = syncMod;
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

// ---------- cross-device flag ----------
const phone = { device: "ph0ne123", label: "phone", at: "2026-11-08T13:40:00.000Z" };

await test("flag round-trips through the note text", () => {
    const note = encodeFlag(phone);
    assert.ok(note.length <= 256);
    assert.deepEqual(parseFlag(note), phone);
    assert.deepEqual(parseFlag(encodeFlag({ ...phone, label: "my desktop pc" })).label, "my_desktop_pc");
});

await test("unrelated or broken notes are not flags", () => {
    assert.equal(parseFlag(null), null);
    assert.equal(parseFlag(""), null);
    assert.equal(parseFlag("remember to buy milk"), null);
    assert.equal(parseFlag("NP1 focus ph0ne123 phone not-a-date"), null);
    assert.equal(parseFlag("NP1 focus"), null);
    assert.equal(isForeignNote("remember to buy milk"), true);
    assert.equal(isForeignNote(encodeFlag(phone)), false);
    assert.equal(isForeignNote(""), false);
});

await test("only the device that turned focus on may turn it off", () => {
    const note = encodeFlag(phone);
    assert.deepEqual(canLeave(note, "ph0ne123"), { ok: true });
    const d = canLeave(note, "desk0001");
    assert.equal(d.ok, false);
    assert.equal(d.reason, "otherDevice");
    assert.equal(d.flag.label, "phone");
    assert.deepEqual(canLeave(null, "desk0001"), { ok: true }, "no flag: local journal decides");
});

await test("another device cannot turn focus on over an active flag", () => {
    const note = encodeFlag(phone);
    assert.equal(canEnter(note, "desk0001").ok, false);
    assert.deepEqual(canEnter(note, "ph0ne123"), { ok: true }, "same device may retry");
    assert.deepEqual(canEnter(null, "desk0001"), { ok: true });
    assert.equal(canEnter("my own note", "desk0001").reason, "foreignNote", "never overwrite a real note");
});

await test("v2 flag carries the sync channel and journal id; any device may leave", () => {
    const v2 = { ...phone, channel: "1569055004667682886", journal: "j0urnal1" };
    const note = encodeFlag(v2);
    assert.ok(note.startsWith("NP2 focus") && note.length <= 256);
    assert.deepEqual(parseFlag(note), v2);
    assert.ok(isShared(parseFlag(note)));
    assert.ok(!isShared(parseFlag(encodeFlag(phone))), "v1 stays device-only");
    assert.deepEqual(canLeave(note, "desk0001"), { ok: true });
    assert.equal(canEnter(note, "desk0001").ok, false, "still one focus at a time");
    assert.equal(parseFlag("NP2 focus ph0ne123 phone 2026-11-08T13:40:00.000Z notanid j1"), null);
});

// ---------- shared journal ----------
function bigScenario() {
    const guilds = {}, dms = [];
    for (let i = 0; i < 167; i++) guilds[String(1000000000000000000n + BigInt(i) * 7919n)] = normalGuild(i % 9 === 0 ? { muted: true, message_notifications: 0 } : {});
    guilds["1000000000000000000"] = normalGuild({ muted: true, mute_config: { end_time: "2026-09-26T09:51:43.540000+00:00", selected_time_window: 28800 } });
    for (let i = 0; i < 144; i++) dms.push({ info: { id: String(1100000000000000000n + BigInt(i) * 104729n), type: i % 20 ? 1 : 3, recipients: ["u" + i] }, prefs: normalDm(i === 5 ? { muted: true } : {}) });
    return planFocus({ guilds, dms, whitelist: set("u7"), excludedGuilds: set(), muteServers: true, muteGroupDMs: true });
}

await test("journal survives encode/decode exactly", () => {
    const j = bigScenario();
    j.guilds[Object.keys(j.guilds)[3]].status = "failed";
    j.channels[Object.keys(j.channels)[0]].status = "done";
    assert.deepEqual(clone(decodeJournal(encodeJournal(j))), clone(j));
    assert.deepEqual(decodeJournal(encodeJournal(emptyJournal())), emptyJournal());
});

await test("a full journal fits in a few messages", () => {
    const j = bigScenario();
    const text = encodeJournal(j);
    const chunks = toChunks("j0urnal1", 1, text);
    assert.ok(chunks.every(c => c.length <= 2000), "every chunk under Discord's limit");
    assert.ok(chunks.length <= 5, `${chunks.length} chunks for ${text.length} chars`);
    console.log(`     (${Object.keys(j.guilds).length} servers + ${Object.keys(j.channels).length} DMs -> ${text.length} chars, ${chunks.length} messages)`);
});

await test("chunks reassemble in any order, other journals ignored", () => {
    const text = encodeJournal(bigScenario());
    const msgs = toChunks("j0urnal1", 1, text).map((content, i) => ({ id: "m" + i, content })).reverse();
    msgs.splice(1, 0, { id: "x", content: "NPJ other123 r1 1/1 5:abc:hello" }, { id: "y", content: "unrelated" });
    assert.equal(fromChunks(msgs, "j0urnal1").text, text);
    assert.deepEqual(chunkMessageIds(msgs, "j0urnal1").sort(), msgs.filter(m => m.id.startsWith("m")).map(m => m.id).sort());
});

await test("missing, damaged or mixed chunks are rejected", () => {
    const text = encodeJournal(bigScenario());
    const chunks = toChunks("j0urnal1", 1, text);
    assert.ok(chunks.length >= 2);
    const msgs = chunks.map((content, i) => ({ id: "m" + i, content }));
    assert.throws(() => fromChunks(msgs.slice(1), "j0urnal1"), /missing/);
    const damaged = clone(msgs);
    damaged[1].content = damaged[1].content.slice(0, -1) + "#";
    assert.throws(() => fromChunks(damaged, "j0urnal1"), /checksum/);
    const mixed = [...msgs, { id: "z", content: toChunks("j0urnal1", 1, "{}")[0] }];
    assert.throws(() => fromChunks(mixed, "j0urnal1"), /different writes|conflicting/);
    assert.throws(() => fromChunks([], "j0urnal1"), /no journal/);

    // newest complete revision wins; an interrupted newer write falls back to the older one
    const v1 = encodeJournal(emptyJournal());
    const r1 = toChunks("j0urnal1", 1, v1).map((content, i) => ({ id: "a" + i, content }));
    const r2 = toChunks("j0urnal1", 2, text).map((content, i) => ({ id: "b" + i, content }));
    assert.deepEqual(fromChunks([...r1, ...r2], "j0urnal1"), { revision: 2, text });
    assert.deepEqual(fromChunks([...r1, ...r2.slice(1)], "j0urnal1"), { revision: 1, text: v1 }, "half-written r2 ignored");
    assert.deepEqual(chunkMessageIds([...r1, ...r2], "j0urnal1", 2), r1.map(m => m.id), "only older revisions to delete");
    assert.equal(checksum("a"), checksum("a"));
    assert.notEqual(checksum("a"), checksum("b"));
    assert.ok(CHUNK_DATA < 2000);
});

// ---------- two devices taking turns ----------

// One fake Discord account (settings, note, sync channel) seen by several devices
function world(guildCount = 40) {
    const s = scenario(guildCount);
    const srv = fakeServer(s);
    const w = { srv, original: clone(s), note: null, messages: [], nextId: 1, sendFails: 0, listDown: false, channelsMade: 0 };
    w.device = (deviceId, deviceLabel, opts = {}) => {
        const dev = { local: { journal: emptyJournal() } };
        dev.p = {
            deviceId, deviceLabel,
            deps: { ...srv.deps },
            guildIds: () => Object.keys(srv.guilds),
            privateChannels: () => dmInfos.filter(d => srv.dms[d.id]),
            options: () => ({ whitelist: set("u1"), excluded: set(), muteServers: true, muteGroupDMs: true, ...opts }),
            readNote: async () => w.note,
            writeNote: async t => { w.note = t || null; },
            syncChannel: async () => { w.channelsMade++; return "1569055004667682886"; },
            listMessages: async () => {
                if (w.listDown) throw new HttpError(500);
                return w.messages.slice(-100).reverse().map(m => ({ ...m }));
            },
            sendMessage: async (_ch, content) => {
                if (w.sendFails > 0) { w.sendFails--; throw new HttpError(403); }
                assert.ok(content.length <= 2000, "message over Discord's limit");
                w.messages.push({ id: String(w.nextId++), content });
            },
            deleteMessage: async (_ch, id) => { w.messages = w.messages.filter(m => m.id !== id); },
            loadLocal: () => clone(dev.local),
            saveLocal: async st => { dev.local = clone(st); },
            now: () => 1793900000000 + w.nextId,
        };
        return dev;
    };
    w.isOriginal = () => same(srv.guilds, w.original.guilds) && same(srv.dms, w.original.dms);
    w.isFocus = () => Object.keys(srv.guilds).every(id => matches(srv.guilds[id], FOCUS_GUILD))
        && matches(srv.dms.c2, FOCUS_DM) && matches(srv.dms.c3, FOCUS_DM) && matches(srv.dms.c1, normalDm());
    w.chunks = () => w.messages.filter(m => m.content.startsWith("NPJ "));
    return w;
}

await test("desktop turns focus on, phone turns it off (desktop offline)", async () => {
    const w = world();
    const desk = w.device("desk0001", "desktop");
    const phone = w.device("ph0ne123", "phone");
    const on = await enter(desk.p);
    assert.equal(on.kind, "applied");
    assert.equal(on.syncError, undefined);
    assert.ok(w.isFocus());
    const flag = parseFlag(w.note);
    assert.ok(isShared(flag) && flag.device === "desk0001");
    assert.equal(desk.local.journalId, flag.journal);
    assert.equal(fromChunks(w.chunks(), flag.journal).revision > 0, true);
    assert.equal(new Set(w.chunks().map(m => m.content.split(" ")[2])).size, 1, "older revisions deleted");

    const off = await leave(phone.p);
    assert.equal(off.kind, "restored");
    assert.equal(off.complete, true);
    assert.ok(w.isOriginal(), "every setting back");
    assert.equal(w.note, null, "flag released");
    assert.equal(w.chunks().length, 0, "journal removed");
    assert.equal(phone.local.journal.profile, "normal", "phone never kept a copy");

    // desktop comes back online and sees the empty note
    await reconcile(desk.p, w.note);
    assert.equal(desk.local.journal.profile, "normal", "stale desktop copy dropped");
});

await test("phone turns focus on, desktop turns it off", async () => {
    const w = world();
    const desk = w.device("desk0001", "desktop");
    const phone = w.device("ph0ne123", "phone");
    await enter(phone.p);
    assert.ok(w.isFocus());
    assert.equal((await enter(desk.p)).kind, "other-device", "one focus at a time");
    const off = await leave(desk.p);
    assert.equal(off.complete, true);
    assert.ok(w.isOriginal());
    assert.equal(w.note, null);
});

await test("owner restores from its own copy when the shared journal is gone", async () => {
    const w = world();
    const desk = w.device("desk0001", "desktop");
    const phone = w.device("ph0ne123", "phone");
    await enter(desk.p);
    w.messages = [];
    const r = await leave(phone.p);
    assert.equal(r.kind, "journal-unreadable");
    assert.ok(w.isFocus(), "nothing touched without the journal");
    const off = await leave(desk.p);
    assert.equal(off.complete, true);
    assert.ok(w.isOriginal());
    assert.equal(w.note, null);
});

await test("partial restore leaves the rest in the shared journal for any device", async () => {
    const w = world(60);
    const desk = w.device("desk0001", "desktop");
    const phone = w.device("ph0ne123", "phone");
    await enter(desk.p);
    w.srv.failGuild.add("g5");
    const r1 = await leave(phone.p);
    assert.equal(r1.kind, "restored");
    assert.equal(r1.complete, false);
    assert.ok(r1.result.guilds.failed.includes("g5"));
    assert.ok(w.note, "flag kept while something is not back");
    const left = decodeJournal(fromChunks(w.chunks(), parseFlag(w.note).journal).text);
    assert.ok(left.guilds.g5 && !left.guilds.g30, "only the failed batch is left");
    w.srv.failGuild.clear();
    const r2 = await leave(desk.p);
    assert.equal(r2.complete, true);
    assert.ok(w.isOriginal());
    assert.equal(w.chunks().length, 0);
});

await test("retrying focus on the owner keeps the same journal and finishes failed items", async () => {
    const w = world();
    const desk = w.device("desk0001", "desktop");
    w.srv.failGuild.add("g1");
    const r1 = await enter(desk.p);
    assert.ok(r1.result.guilds.failed.includes("g1"));
    const id = parseFlag(w.note).journal;
    w.srv.failGuild.clear();
    const r2 = await enter(desk.p);
    assert.deepEqual(r2.result.guilds.failed, []);
    assert.equal(parseFlag(w.note).journal, id);
    assert.equal(w.channelsMade, 1);
    assert.ok(w.isFocus());
    assert.equal(decodeJournal(fromChunks(w.chunks(), id).text).guilds.g1.status, "done", "shared copy updated");
});

await test("a failed journal write changes nothing", async () => {
    const w = world();
    const desk = w.device("desk0001", "desktop");
    w.sendFails = 1;
    await assert.rejects(enter(desk.p));
    assert.equal(w.note, null, "no flag without a journal");
    assert.ok(w.isOriginal(), "no setting changed");
    const r = await enter(desk.p);
    assert.equal(r.kind, "applied");
    assert.ok(w.isFocus());
});

await test("a flag cleared by hand does not lose the owner's copy", async () => {
    const w = world();
    const desk = w.device("desk0001", "desktop");
    const phone = w.device("ph0ne123", "phone");
    await enter(desk.p);
    w.messages = [];
    await clearFlag(phone.p);
    await reconcile(desk.p, w.note);
    assert.equal(desk.local.journal.profile, "focus", "copy kept: settings still at focus");
    assert.equal((await enter(desk.p)).kind, "unrestored", "no new focus over the old one");
    const off = await leave(desk.p);
    assert.equal(off.complete, true);
    assert.ok(w.isOriginal());
});

await test("a v1 focus from the old version moves to a shared journal, then the phone can restore", async () => {
    const w = world();
    const desk = w.device("desk0001", "desktop");
    const phone = w.device("ph0ne123", "phone");
    // what the previous version left: v1 flag + bare local journal, settings applied
    const j = planFor(w.original);
    await applyJournal(j, w.srv.deps);
    desk.local = { journal: clone(j) };
    w.note = encodeFlag({ device: "desk0001", label: "desktop", at: "2026-11-08T16:07:19.609Z" });
    assert.equal((await leave(phone.p)).kind, "other-device", "v1: only the desktop can leave");
    await reconcile(desk.p, w.note);
    assert.equal(desk.local.journal.profile, "focus", "v1 copy is current");

    const requests = w.srv.requests;
    const up = await enter(desk.p);
    assert.equal(up.kind, "applied");
    assert.equal(w.srv.requests, requests, "nothing re-sent: all were done");
    assert.ok(isShared(parseFlag(w.note)));
    assert.equal(parseFlag(w.note).at, "2026-11-08T16:07:19.609Z", "keeps when focus started");
    assert.deepEqual(clone(decodeJournal(fromChunks(w.chunks(), parseFlag(w.note).journal).text)), clone(j), "same old values");

    const off = await leave(phone.p);
    assert.equal(off.complete, true);
    assert.ok(w.isOriginal());
    assert.equal(w.note, null);
});

await test("a foreign note blocks focus and is never overwritten", async () => {
    const w = world();
    const desk = w.device("desk0001", "desktop");
    w.note = "remember to buy milk";
    assert.equal((await enter(desk.p)).kind, "foreign-note");
    assert.equal((await leave(desk.p)).kind, "already-normal");
    assert.equal(w.note, "remember to buy milk");
    assert.ok(w.isOriginal());
});

await test("a new DM during focus is muted and restored from the other device", async () => {
    const w = world();
    const desk = w.device("desk0001", "desktop");
    const phone = w.device("ph0ne123", "phone");
    w.srv.dms.c2 = normalDm();
    const hidden = dmInfos.pop(); // c3 appears later
    delete w.srv.dms.c3;
    await enter(desk.p);
    dmInfos.push(hidden);
    w.srv.dms.c3 = normalDm();
    await syncItems(desk.p, [], ["c3"]);
    assert.ok(matches(w.srv.dms.c3, FOCUS_DM));
    await syncItems(phone.p, [], ["c1"]); // not the owner: does nothing
    const off = await leave(phone.p);
    assert.equal(off.complete, true);
    assert.ok(w.isOriginal());
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log("\nall tests passed");
