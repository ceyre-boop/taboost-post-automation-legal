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
  assert.deepEqual(readSettings(dir), { onboarded: false, spaceSec: 60 });
  assert.deepEqual(writeSettings({ onboarded: true }, dir), { onboarded: true, spaceSec: 60 });
  assert.deepEqual(writeSettings({ spaceSec: 120 }, dir), { onboarded: true, spaceSec: 120 });
  assert.deepEqual(readSettings(dir), { onboarded: true, spaceSec: 120 });
  assert.deepEqual(readdirSync(dir), ["settings.json"]);
  // The settings file holds two plain values and nothing about any account.
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).sort(), ["onboarded", "spaceSec"]);
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
