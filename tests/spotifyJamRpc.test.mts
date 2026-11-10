/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Run from the repo root: npx tsx tests/spotifyJamRpc.test.mts
import assert from "node:assert/strict";

// The plugin sources load as CommonJS here (no "type": "module"), so take the exports object
import jam from "../spotifyJamRpc/jam";

const { activityKey, buildActivity, DEFAULT_TEXT, MAX_BUTTON_LABEL, MAX_TEXT, parseJamUrl, renderTemplate, truncate } = jam;

let failures = 0;
function test(name, fn) {
    try { fn(); console.log("ok  ", name); } catch (e) { failures++; console.log("FAIL", name, "\n     ", e.message); }
}

const JAM = "https://open.spotify.com/socialsession/AbC123xyz";
const opts = (o = {}) => ({ appId: "1108588077900898414", activityName: "Spotify Jam", details: "{song}", state: "{artist}", imageText: "{album}", buttonLabel: "join", showAlbumArt: true, ...o });
const track = (o = {}) => ({ id: "t1", name: "Song", artists: ["A", "B"], album: "Album", ...o });

// parseJamUrl: normal
test("accepts socialsession link and keeps query", () => {
    const r = parseJamUrl(`  ${JAM}?si=abc  `);
    assert.deepEqual(r, { ok: true, url: `${JAM}?si=abc` });
});
test("accepts intl- prefixed socialsession link", () => {
    assert.equal(parseJamUrl("https://open.spotify.com/intl-ja/socialsession/AbC123").ok, true);
});
test("accepts trailing slash", () => {
    assert.equal(parseJamUrl(`${JAM}/`).ok, true);
});
test("accepts spotify.link and spotify.app.link short links", () => {
    assert.equal(parseJamUrl("https://spotify.link/aBcD_12-3").ok, true);
    assert.equal(parseJamUrl("https://spotify.app.link/aBcD123").ok, true);
});
test("host match is case-insensitive", () => {
    assert.equal(parseJamUrl("https://OPEN.SPOTIFY.COM/socialsession/AbC").ok, true);
});

// parseJamUrl: null / empty
test("rejects empty, whitespace and non-strings", () => {
    for (const v of ["", "   ", null, undefined, 42, {}]) assert.equal(parseJamUrl(v).ok, false, String(v));
});

// parseJamUrl: errors
test("rejects non-URL text", () => assert.equal(parseJamUrl("not a url").ok, false));
test("rejects http", () => assert.equal(parseJamUrl("http://open.spotify.com/socialsession/AbC").ok, false));
test("rejects other hosts and lookalikes", () => {
    for (const u of ["https://evil.com/socialsession/AbC", "https://open.spotify.com.evil.com/socialsession/AbC", "https://spotify.com/socialsession/AbC", "javascript:alert(1)"])
        assert.equal(parseJamUrl(u).ok, false, u);
});
test("rejects non-Jam spotify pages", () => {
    for (const u of ["https://open.spotify.com/track/AbC", "https://open.spotify.com/socialsession/", "https://open.spotify.com/socialsession/a/b", "https://spotify.link/", "https://spotify.link/a/b"])
        assert.equal(parseJamUrl(u).ok, false, u);
});
test("rejects credentials in URL", () => assert.equal(parseJamUrl("https://u:p@open.spotify.com/socialsession/AbC").ok, false));
test("boundary: rejects URLs over 512 chars, accepts at limit", () => {
    const base = `${JAM}?q=`;
    assert.equal(parseJamUrl(base + "a".repeat(512 - base.length)).ok, true);
    assert.equal(parseJamUrl(base + "a".repeat(513 - base.length)).ok, false);
});
test("error results carry a message", () => {
    const r = parseJamUrl("https://evil.com/x");
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.length > 0);
});

// truncate
test("truncate keeps short text", () => assert.equal(truncate("abc", 3), "abc"));
test("truncate cuts with ellipsis at limit", () => assert.equal(truncate("abcd", 3), "ab…"));
test("truncate counts code points, not UTF-16 units", () => {
    assert.equal(truncate("😀😀😀", 3), "😀😀😀");
    assert.equal(truncate("😀😀😀😀", 3), "😀😀…");
});
test("truncate handles empty and zero", () => {
    assert.equal(truncate("", 5), "");
    assert.equal(truncate("abc", 0), "…");
});

// renderTemplate
test("fills all placeholders, repeated ones too", () => {
    assert.equal(renderTemplate("{song} - {artist} ({album}) {song}", track()), "Song - A, B (Album) Song");
});
test("leaves unknown braces and plain text alone", () => {
    assert.equal(renderTemplate("♱ {mood} {Song} ♱", track()), "♱ {mood} {Song} ♱");
});
test("missing values render empty and the result is trimmed", () => {
    assert.equal(renderTemplate("  {album}  ", track({ album: undefined })), "");
    assert.equal(renderTemplate("{artist}", track({ artists: [] })), "");
    assert.equal(renderTemplate("", track()), "");
});
test("replacement text with $ patterns is inserted literally", () => {
    assert.equal(renderTemplate("{song}", track({ name: "$& $1 $$" })), "$& $1 $$");
});

// buildActivity
test("builds listening activity with button and track", () => {
    const a = buildActivity(JAM, track(), opts(), "mp:external/x");
    assert.deepEqual(a, {
        application_id: "1108588077900898414",
        name: "Spotify Jam",
        type: 2,
        flags: 1,
        buttons: ["join"],
        metadata: { button_urls: [JAM] },
        details: "Song",
        state: "A, B",
        assets: { large_image: "mp:external/x", large_text: "Album" },
    });
});
test("custom templates in every field", () => {
    const a = buildActivity(JAM, track(), opts({ activityName: "♱ {artist} ♱", details: "now: {song}", state: "come listen w me <3", imageText: "{song} / {album}", buttonLabel: "join {song} ♡" }), "img");
    assert.equal(a.name, "♱ A, B ♱");
    assert.equal(a.details, "now: Song");
    assert.equal(a.state, "come listen w me <3");
    assert.deepEqual(a.assets, { large_image: "img", large_text: "Song / Album" });
    assert.deepEqual(a.buttons, ["join Song ♡"]);
});
test("hidden when nothing is playing", () => assert.equal(buildActivity(JAM, null, opts()), null));
test("hidden when link is empty or invalid", () => {
    assert.equal(buildActivity("", track(), opts()), null);
    assert.equal(buildActivity("https://evil.com/x", track(), opts()), null);
});
test("hidden when name, label or app id is unusable", () => {
    assert.equal(buildActivity(JAM, track(), opts({ activityName: "  " })), null);
    assert.equal(buildActivity(JAM, track(), opts({ buttonLabel: "" })), null);
    assert.equal(buildActivity(JAM, track({ album: undefined }), opts({ buttonLabel: "{album}" })), null);
    assert.equal(buildActivity(JAM, track(), opts({ appId: "abc" })), null);
});
test("empty line templates leave the fields out", () => {
    const a = buildActivity(JAM, track(), opts({ details: "", state: " " }));
    assert.equal("details" in a, false);
    assert.equal("state" in a, false);
});
test("album art off or missing image means no assets", () => {
    assert.equal(buildActivity(JAM, track(), opts({ showAlbumArt: false }), "img").assets, undefined);
    assert.equal(buildActivity(JAM, track(), opts()).assets, undefined);
});
test("image with empty tooltip has no large_text", () => {
    assert.deepEqual(buildActivity(JAM, track({ album: undefined }), opts(), "img").assets, { large_image: "img" });
});
test("boundary: long rendered fields are truncated to Discord limits", () => {
    const a = buildActivity(JAM, track({ name: "x".repeat(300) }), opts({ buttonLabel: "{song}", activityName: "z".repeat(200) }));
    assert.equal(Array.from(a.details).length, MAX_TEXT);
    assert.equal(Array.from(a.buttons[0]).length, MAX_BUTTON_LABEL);
    assert.equal(Array.from(a.name).length, MAX_TEXT);
});

// default texts
test("default texts fit Discord limits in both code points and UTF-16 units", () => {
    const limits = { activityName: MAX_TEXT, details: MAX_TEXT, state: MAX_TEXT, imageText: MAX_TEXT, buttonLabel: MAX_BUTTON_LABEL };
    for (const [k, max] of Object.entries(limits)) {
        const v = DEFAULT_TEXT[k];
        assert.ok(v.trim().length > 0, k);
        assert.ok(v.length <= max, `${k} is ${v.length} UTF-16 units`);
        assert.equal(truncate(v, max), v, k);
    }
});
test("default texts produce the expected activity", () => {
    const a = buildActivity(JAM, track(), opts(DEFAULT_TEXT), "img");
    assert.equal(a.name, DEFAULT_TEXT.activityName);
    assert.deepEqual(a.buttons, [DEFAULT_TEXT.buttonLabel]);
    assert.equal(a.details, "Song");
    assert.equal(a.state, "A, B");
    assert.equal(a.assets.large_text, "Album");
});

// activityKey
test("key changes with track, link and options; stable otherwise", () => {
    const k = activityKey(JAM, track(), opts());
    assert.equal(activityKey(JAM, track(), opts()), k);
    assert.notEqual(activityKey(JAM, track({ id: "t2" }), opts()), k);
    assert.notEqual(activityKey("", track(), opts()), k);
    assert.notEqual(activityKey(JAM, null, opts()), k);
    assert.notEqual(activityKey(JAM, track({ name: "Other" }), opts()), k);
    assert.notEqual(activityKey(JAM, track(), opts({ details: "x" })), k);
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log("\nall passed");
