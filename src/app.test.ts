// node --test src/app.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_PLATFORMS, appPlatformIds, cleanSpace, displayName, explain, isAppPlatform, readSettings, uploadName, writeSettings } from "./app.ts";
import { PLATFORMS } from "./platforms/index.ts";

test("the app offers the seven proven platforms and hides Pinterest", () => {
  assert.deepEqual(appPlatformIds(), ["tiktok", "instagram", "youtube", "x", "facebook", "linkedin", "threads"]);
  assert.equal(isAppPlatform("pinterest"), false);
  for (const id of appPlatformIds()) {
    assert.equal(PLATFORMS[id].verified, true, `${id} has posted for real`);
    assert.match(APP_PLATFORMS[id].postsUrl, /^https:\/\//);
    assert.ok(APP_PLATFORMS[id].domains.length > 0);
  }
});

test("each platform's sign-out covers the site its own login check looks at", () => {
  for (const id of appPlatformIds()) {
    const host = new URL(PLATFORMS[id].loginUrl).hostname;
    assert.ok(APP_PLATFORMS[id].domains.some((d) => host === d || host.endsWith(`.${d}`)), `${id}: ${host}`);
  }
});

test("a new person starts not set up, with spacing on", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-settings-"));
  const fresh = { onboarded: false, spaceSec: 60, mainName: "Main", sets: [], activeSet: "" };
  assert.deepEqual(readSettings(dir), fresh);
  assert.deepEqual(writeSettings({ onboarded: true }, dir), { ...fresh, onboarded: true });
  assert.deepEqual(writeSettings({ spaceSec: 120 }, dir), { ...fresh, onboarded: true, spaceSec: 120 });
  assert.deepEqual(readSettings(dir), { ...fresh, onboarded: true, spaceSec: 120 });
  assert.deepEqual(readdirSync(dir), ["settings.json"]);
  // The settings file holds preferences and set names, and nothing about any sign-in.
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).sort(), ["activeSet", "mainName", "onboarded", "sets", "spaceSec"]);
});

test("spacing is off only when asked, and otherwise 15 seconds to 30 minutes", () => {
  assert.equal(cleanSpace(0), 0);
  assert.equal(cleanSpace("0"), 0);
  assert.equal(cleanSpace(-5), 0);
  assert.equal(cleanSpace(1), 15);
  assert.equal(cleanSpace("60"), 60);
  assert.equal(cleanSpace(99999), 1800);
  assert.equal(cleanSpace("abc"), 60);
  assert.equal(cleanSpace(undefined), 60);
});

test("uploaded clips keep the name the person knows them by", () => {
  const saved = uploadName(2, "My Launch Clip (final).mp4", 1700000000000);
  assert.equal(saved, "1700000000000-2--My Launch Clip (final).mp4");
  assert.equal(displayName(`/some/folder/${saved}`), "My Launch Clip (final).mp4");
  assert.equal(displayName("/clips/holiday.mov"), "holiday.mov");
  assert.equal(displayName("/clips/a--b.mp4"), "a--b.mp4");
  assert.equal(uploadName(0, "../../etc/passwd", 1), "1-0--passwd");
  assert.equal(uploadName(0, "we/ird:na*me?.mp4", 1), "1-0--ird_na_me_.mp4");
});

test("every failure gets a plain-English problem and fix", () => {
  const cases: [string, RegExp, string][] = [
    ["Not logged in to TikTok. Connect it first.", /signed out of TikTok/, "connect"],
    ["Google Chrome not found. Install it from google.com/chrome", /Chrome isn't installed/, "chrome"],
    ["Chrome opened but the debugging port 9226 never answered.", /Chrome window was closed/, "retry"],
    ["locator.click: Timeout 30000ms exceeded.", /took too long/, "retry"],
    ["page.waitForSelector: Timeout 15000ms exceeded", /took too long/, "retry"],
    ["Instagram is asking: are you human?", /check it's really you/, "retry"],
    ["Video not found: /x/y.mp4", /can't be found/, "add-clip"],
    ["POSTED BUT NOT DELETED: no post matched", /couldn't be taken down/, "retry"],
    ["something nobody predicted", /didn't finish the post/, "retry"],
    ["", /didn't finish the post/, "retry"],
  ];
  for (const [note, problem, action] of cases) {
    const f = explain(note, "TikTok");
    assert.match(f.problem, problem, note);
    assert.equal(f.action, action, note);
    assert.ok(f.fix.length > 10);
    // Plain words only: no code terms leak into what the person reads.
    assert.doesNotMatch(f.problem + f.fix, /locator|selector|timeout|CDP|exception|undefined|null/i, note);
  }
});

import { addSet, allSets } from "./app.ts";
import { accountProfile, defaultProfile } from "./config.ts";

test("sets of accounts: the main one, plus any the person adds, each with its own Chrome", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-sets-"));
  assert.deepEqual(allSets(readSettings(dir)), [{ id: "", name: "Main" }]);
  const { set } = addSet("Northbound", dir);
  assert.deepEqual(set, { id: "northbound", name: "Northbound" });
  assert.equal(addSet("My Business & Co.", dir).set.id, "my-business--co");
  assert.throws(() => addSet("northbound", dir), /already have a set/);
  assert.throws(() => addSet("   ", dir), /Give the set a name/);
  assert.deepEqual(allSets(readSettings(dir)).map((s) => s.name), ["Main", "Northbound", "My Business & Co."]);
  // Switching to a set that exists sticks; a made-up id falls back to the main set.
  assert.equal(writeSettings({ activeSet: "northbound" }, dir).activeSet, "northbound");
  assert.equal(writeSettings({ activeSet: "nope" }, dir).activeSet, "");
  assert.equal(writeSettings({ mainName: "Personal" }, dir).mainName, "Personal");
  // Different sets never share a Chrome profile folder or a port.
  const a = accountProfile("northbound"), b = accountProfile("my-business--co");
  assert.equal(accountProfile(""), defaultProfile);
  assert.notEqual(a.dir, defaultProfile.dir); assert.notEqual(a.dir, b.dir);
  assert.notEqual(a.port, defaultProfile.port);
  assert.match(a.dir, /accounts\/northbound\/chrome-profile$/);
});

test("explain recognises every adapter's own signed-out, missing-file and never-clickable messages", () => {
  const signedOut: [string, string][] = [
    ["TikTok", "TikTok asked for login. Log in in the Chrome window, then run again."],
    ["Instagram", "Instagram asked for login. Log in in the Chrome window, then run again."],
    ["YouTube", "YouTube asked for Google login. Log in in the Chrome window, then run again."],
    ["X (Twitter)", "X asked for login. Log in in the Chrome window, then run again."],
    ["Facebook", "Facebook asked for login. Log in in the Chrome window, then run again."],
    ["LinkedIn", "LinkedIn asked for login. Log in in the Chrome window, then run again."],
    ["Pinterest", "Pinterest asked for login. Log in in the Chrome window, then run again."],
    ["Threads", "Threads asked for login (via Instagram). Log in in the Chrome window, then run again."],
  ];
  for (const [label, msg] of signedOut) assert.equal(explain(msg, label).action, "connect", msg);
  assert.equal(explain("locator.setInputFiles: Error: File not found: /tmp/clip.mp4", "TikTok").action, "add-clip");
  assert.equal(explain("ENOENT: no such file or directory, open '/tmp/clip.mp4'", "TikTok").action, "add-clip");
  for (const label of ["TikTok", "Instagram", "YouTube", "X (Twitter)", "Facebook", "LinkedIn", "Pinterest", "Threads"]) {
    const f = explain(`${label}'s Post button never became clickable (the upload may still be processing)`, label);
    assert.equal(f.action, "retry");
    assert.equal(f.problem, `${label} was still processing the video`);
    assert.equal(f.fix, `Wait a minute, check the ${label} tab in the app's Chrome window, then press Try again`);
  }
});
