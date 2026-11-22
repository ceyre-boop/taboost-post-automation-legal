// node --test src/platforms/platforms.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fitX, xWeight, captionLines, typeCaption, youtubeParts, cutCodePoints } from "./caption.ts";
import { PLATFORMS } from "./index.ts";
import { uploadTimeoutMs, waitClickable } from "./timing.ts";

test("fitX leaves captions that fit untouched, including exactly at the limit", () => {
  const exact = "a".repeat(280);
  assert.deepEqual(fitX(exact), { text: exact, shortened: false });
  assert.deepEqual(fitX("hello #tag"), { text: "hello #tag", shortened: false });
  assert.equal(fitX("a".repeat(281)).shortened, true);
});

test("fitX never splits an emoji and counts it as 2", () => {
  assert.equal(xWeight("😀"), 2);
  const text = "😀".repeat(200); // weight 400
  const r = fitX(text);
  assert.equal(r.shortened, true);
  assert.ok(xWeight(r.text) <= 280);
  assert.ok(r.text.endsWith("…"));
  assert.equal(Array.from(r.text.slice(0, -1)).every((c) => c === "😀"), true);
  const fam = "👨‍👩‍👧".repeat(150);
  const r2 = fitX(fam);
  assert.equal(r2.text.slice(0, -1).split("👨‍👩‍👧").join(""), "");
});

test("fitX keeps trailing hashtags and cuts the body at a word boundary", () => {
  const body = "word ".repeat(80).trim();
  const r = fitX(`${body} #one #two`);
  assert.equal(r.shortened, true);
  assert.ok(r.text.endsWith("… #one #two"));
  assert.ok(xWeight(r.text) <= 280);
  assert.ok(/word… #one/.test(r.text));
});

test("fitX counts URLs as 23", () => {
  const url = "https://example.com/" + "x".repeat(200);
  assert.equal(xWeight(url), 23);
  assert.equal(xWeight(`hi ${url}`), 26);
  const text = "a".repeat(250) + " " + url; // 250 + 1 + 23 = 274
  assert.deepEqual(fitX(text), { text, shortened: false });
});

test("line breaks get a space after a #tag or @mention", () => {
  assert.deepEqual(captionLines("hi #tag\nnext @bob\nplain\nend #last"), ["hi #tag ", "next @bob ", "plain", "end #last "]);
  assert.deepEqual(captionLines("a\r\nb"), ["a", "b"]);
});

test("typeCaption types lines and presses Enter between them", async () => {
  const log: string[] = [];
  const page = { keyboard: { type: async (t: string) => { log.push("T:" + t); }, press: async (k: string) => { log.push("K:" + k); } } };
  await typeCaption(page, "one #a\n\ntwo", 1);
  assert.deepEqual(log, ["T:one #a ", "K:Enter", "K:Enter", "T:two"]);
});

test("YouTube title and description drop < and > and never split a code point", () => {
  const r = youtubeParts("Hello <b>world</b>\nline <2> here\n#tag");
  assert.equal(r.title, "Hello bworld/b");
  assert.equal(r.description, "line 2 here\n#tag");
  assert.equal(youtubeParts("<>\nbody").title, "Untitled");
  const t = youtubeParts("😀".repeat(150)).title;
  assert.equal(Array.from(t).length, 100);
  assert.equal(t, "😀".repeat(100));
  assert.equal(cutCodePoints("a😀b", 2), "a😀");
});

test("host patterns are anchored and match their own login URL", () => {
  for (const p of Object.values(PLATFORMS)) {
    assert.ok(p.host.test(p.loginUrl), `${p.id} host must match ${p.loginUrl}`);
    assert.equal(p.host.test(`https://www.dropbox.com/x.com`), false, p.id);
    assert.equal(p.host.test(`https://evil.example/?u=https://${new URL(p.loginUrl).hostname}/`), false, p.id);
  }
  assert.equal(PLATFORMS.x.host.test("https://www.dropbox.com/"), false);
  assert.equal(PLATFORMS.x.host.test("https://twitter.com/home"), true);
  assert.equal(PLATFORMS.x.host.test("https://x.com/compose/post"), true);
  assert.equal(PLATFORMS.tiktok.host.test("https://www.tiktok.com/tiktokstudio/upload"), true);
  assert.equal(PLATFORMS.threads.host.test("https://www.threads.com/"), true);
  assert.equal(PLATFORMS.youtube.host.test("https://studio.youtube.com/channel/abc"), true);
});

test("uploadTimeoutMs scales with file size within 5 minutes to 6 hours", () => {
  const dir = mkdtempSync(join(tmpdir(), "timing-"));
  const small = join(dir, "s.bin");
  writeFileSync(small, "x");
  assert.equal(uploadTimeoutMs(small), 300_000);
  assert.equal(uploadTimeoutMs(join(dir, "missing.mp4")), 300_000);
});

test("waitClickable throws the never-clickable error instead of forcing", async () => {
  const disabled = { isEnabled: async () => false, getAttribute: async () => null };
  await assert.rejects(
    waitClickable(disabled, "Threads", 3000, async () => {}, 1000),
    /Threads's Post button never became clickable \(the upload may still be processing\)/,
  );
  let n = 0;
  const later = { isEnabled: async () => ++n > 2, getAttribute: async () => null };
  await waitClickable(later, "Threads", 10_000, async () => {}, 1000);
});

test("a YouTube Studio row is only acted on when it carries exactly one video id", async () => {
  const { videoIdIn } = await import("./youtube.ts");
  assert.equal(videoIdIn('<img src="https://i.ytimg.com/vi/Tj7aHUXIHZs/mqdefault.jpg">'), "Tj7aHUXIHZs");
  assert.equal(videoIdIn('<img src="https://i.ytimg.com/vi/Tj7aHUXIHZs/a.jpg"><img src="https://i.ytimg.com/vi/Tj7aHUXIHZs/b.jpg">'), "Tj7aHUXIHZs");
  assert.equal(videoIdIn('<img src="https://i.ytimg.com/vi/Tj7aHUXIHZs/a.jpg"><img src="https://i.ytimg.com/vi/L_TUAEAOMjA/b.jpg">'), null, "two videos in one block: refuse");
  assert.equal(videoIdIn("<div>no picture yet</div>"), null);
});

test("a preview or post waits until the site has the whole video, and gives up only when the upload stalls", async () => {
  const { waitUploaded } = await import("./timing.ts");
  const said: string[] = [];
  // 0% → 100% in steps, then the bar goes away: waits it out and says how far along it is.
  const steps = [0, 10, 10, 35, 60, 99, 100];
  let i = 0;
  await waitUploaded(async () => { const p = steps[Math.min(i++, steps.length - 1)]; return { uploading: p < 100, pct: p }; }, "Facebook", 6 * 3600_000, (m) => said.push(m), async () => {}, 15_000);
  assert.ok(i >= steps.length, "kept looking until 100%");
  assert.ok(said.some((m) => /Sending the video to Facebook: \d+%/.test(m)));
  assert.equal(said.at(-1), "Facebook has the whole video.");
  // Stuck at 42% for over 10 minutes: a plain reason, not a silent wait for hours.
  await assert.rejects(waitUploaded(async () => ({ uploading: true, pct: 42 }), "YouTube", 6 * 3600_000, () => {}, async () => {}, 60_000), /stopped receiving the video at 42%/);
  // A site with nothing to show (no bar at all) isn't waited on.
  await waitUploaded(async () => ({ uploading: false, pct: null }), "X", 1000, () => {}, async () => {});
});

test("Facebook's one-time 'Review audience' notice (2026-11-22) is recognised, so the post isn't left waiting on it", async () => {
  const { FB_NOTICE } = await import("./facebook.ts");
  assert.match("Review audience\nChoose who can see this and future posts and reels\nAll video posts are now reels", FB_NOTICE);
  assert.doesNotMatch("Create post\nColin Eyre\nWhat's on your mind, Colin?\nPost", FB_NOTICE);
});
