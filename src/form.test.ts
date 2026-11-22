// node --test src/form.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { songFromForm, videosFromForm } from "./form.ts";
import { buildBatch } from "./batch.ts";
import { pickSong, tiktokResult } from "./platforms/song.ts";
import { CREDIT_NOTE, MUSIC_HELP } from "./music.ts";
import { xWeight } from "./platforms/caption.ts";
import type { UploadedFile } from "./multipart.ts";

const form = (pairs: [string, string][]) => { const m = new Map<string, string[]>(); for (const [k, v] of pairs) m.set(k, [...(m.get(k) ?? []), v]); return m; };
const file = (index: number, size = 10): UploadedFile => ({ field: "videos", index, filename: `c${index}.mov`, contentType: "video/quicktime", path: size ? `/tmp/c${index}.mov` : "", size });

test("one shared caption, changed for some platforms; untouched platforms keep the shared one", () => {
  const v = videosFromForm(form([["caption", "The Final Countdown\n#drums"], ["caption@x", "Short one for X #drums"], ["caption@youtube", "Final Countdown drum cover\nFull take, one go."]]), [file(0)], ["x", "youtube", "tiktok"]);
  assert.deepEqual(v, [{ path: "/tmp/c0.mov", caption: undefined, captions: { x: "Short one for X #drums", youtube: "Final Countdown drum cover\nFull take, one go." } }]);
});

test("each clip's own caption and number stay together, an empty file input is skipped", () => {
  const v = videosFromForm(form([["caption0", "first"], ["caption2", "third"], ["caption2@x", "third on X"]]), [file(0), file(1, 0), file(2)], ["x", "facebook"]);
  assert.equal(v.length, 2);
  assert.deepEqual(v[0], { path: "/tmp/c0.mov", caption: "first" });
  assert.deepEqual(v[1], { path: "/tmp/c2.mov", caption: "third", captions: { x: "third on X" } });
});

test("the song credit goes only to the platforms chosen, once, after the caption", () => {
  const f = form([["caption", "Playing along #drums"], ["song_title", "The Final Countdown"], ["song_artist", "Europe"], ["song@tiktok", "on"], ["song@youtube", "on"]]);
  const [v] = videosFromForm(f, [file(0)], ["tiktok", "youtube", "facebook"]);
  // The same credit line the phone's song card adds (withSongCredit).
  assert.equal(v.captions?.tiktok, "Playing along #drums\n\n🎵 The Final Countdown by Europe");
  assert.equal(v.captions?.youtube, "Playing along #drums\n\n🎵 The Final Countdown by Europe", "YouTube's first line stays the title");
  assert.equal(v.captions?.facebook, undefined, "not chosen: the shared caption as it is");
});

test("on X a long caption with the credit still fits in 280; markup in the song name is dropped", () => {
  const f = form([["caption", "drum ".repeat(70).trim()], ["song_title", "The <b>Final</b> Countdown"], ["song_artist", "Europe"], ["song@x", "on"]]);
  const [v] = videosFromForm(f, [file(0)], ["x"]);
  assert.ok(xWeight(v.captions!.x) <= 280, `X weight ${xWeight(v.captions!.x)}`);
  assert.doesNotMatch(v.captions!.x, /[<>]/);
});

test("the app never claims a credit line prevents a copyright claim", () => {
  assert.match(CREDIT_NOTE, /doesn't license the song/);
  for (const text of [CREDIT_NOTE, ...Object.values(MUSIC_HELP)]) assert.doesNotMatch(text, /prevent|avoid (a )?(copyright|claim)|won't be (flagged|claimed)|safe from/i);
  assert.deepEqual(Object.keys(MUSIC_HELP).sort(), ["facebook", "instagram", "linkedin", "threads", "tiktok", "x", "youtube"]);
});

test("TikTok song search: the artist's own recording, exact title first, never someone's 'original sound'", () => {
  // What TikTok listed for "The Final Countdown Europe" on 2026-11-22.
  const results = ["The Final Countdown\n01:00 · Europe", "original sound - tayryder\n00:21 · amelie", "The Final Countdown\n00:30 · Europe", "The Final Countdown 2025\n01:00 · David Guetta & Hypaton"].map(tiktokResult);
  assert.deepEqual(results[0], { title: "The Final Countdown", artist: "Europe" });
  assert.equal(pickSong(results, "The Final Countdown", "Europe"), 0);
  assert.equal(pickSong(results, "the final countdown", ""), 0);
  assert.equal(pickSong(results, "The Final Countdown 2025", "David Guetta"), 3);
  assert.equal(pickSong(results, "The Final Countdown", "Metallica"), -1, "wrong artist: no song rather than the wrong credit");
  assert.equal(pickSong([tiktokResult("original sound - The Final Countdown\n00:21 · someone")], "The Final Countdown", ""), -1);
  assert.equal(pickSong(results, "", "Europe"), -1);
});

test("the song from the library goes only to platforms whose website can add one, with the 0% choice", () => {
  const f = form([["song_title", "The Final Countdown"], ["song_artist", "Europe"], ["songlib@tiktok", "on"], ["songlib@x", "on"], ["song_mute", "on"]]);
  const librarySong = songFromForm(f, ["tiktok", "x", "youtube"]);
  assert.deepEqual(librarySong, { title: "The Final Countdown", artist: "Europe", mute: true, platforms: ["tiktok", "x"] });
  assert.equal(songFromForm(form([["song_title", "Solo"]]), ["tiktok"]), undefined, "no platform chose the library");
  const dir = mkdtempSync(join(tmpdir(), "song-"));
  const clip = join(dir, "c.mov"); writeFileSync(clip, "x");
  const b = buildBatch({ videos: [{ path: clip }], platforms: ["tiktok", "x", "youtube"], live: false, librarySong });
  assert.deepEqual(b.items.find((i) => i.platform === "tiktok")?.librarySong, { title: "The Final Countdown", artist: "Europe", mute: true });
  assert.equal(b.items.find((i) => i.platform === "x")?.librarySong, undefined, "X's website can't add songs");
  assert.equal(b.items.find((i) => i.platform === "youtube")?.librarySong, undefined);
});
