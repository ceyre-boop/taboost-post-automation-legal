// node --test src/fit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, ftruncateSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planFor, UPLOAD_LIMITS, lengthWords } from "./platforms/limits.ts";
import { fitFor } from "./fit.ts";

const MB = 1024 * 1024, GB = 1024 * MB;

test("which platforms need a smaller copy of a big phone video, and what the grid says", () => {
  const big = { bytes: 1.1 * GB, seconds: 90 };        // a 1.1 GB, 90-second clip
  const huge = { bytes: 3.3 * GB, seconds: 300 };      // a 3.3 GB, 5-minute 4K clip
  const skyler = { bytes: 147 * MB, seconds: 78 };     // the clip that failed on 2026-11-22
  for (const id of Object.keys(UPLOAD_LIMITS)) assert.equal(planFor(id, id, skyler).action, "as-is", `${id} takes a 147 MB, 78 s clip as it is`);

  const x = planFor("x", "X", big);
  assert.equal(x.action, "smaller");
  assert.ok(x.action === "smaller" && x.trimTo === undefined && x.maxBytes === 512 * MB);
  assert.equal(x.action === "smaller" && x.say, "X takes videos up to 512 MB and 2 min 20 s; this one got a smaller copy.");
  const x5 = planFor("x", "X", huge);
  assert.ok(x5.action === "smaller" && x5.trimTo === 140 && /cut to the first 2 min 20 s/.test(x5.say));
  assert.equal(planFor("x", "X", huge, true).action, "as-is", "X Premium takes 16 GB and 4 hours");

  for (const id of ["youtube", "facebook", "tiktok", "instagram"]) assert.equal(planFor(id, id, huge).action, "as-is", `${id} takes 3.3 GB / 5 min`);
  const li = planFor("linkedin", "LinkedIn", big); // about 105 Mbps, over LinkedIn's 30
  assert.ok(li.action === "smaller" && li.maxBitrate === 30_000_000 && /30 Mbps; this one got a lighter copy/.test(li.say));
  assert.equal(planFor("linkedin", "LinkedIn", { bytes: 40 * MB, seconds: 60 }).action, "as-is");
  const short = planFor("linkedin", "LinkedIn", { bytes: 2 * MB, seconds: 2 });
  assert.ok(short.action === "cannot" && /at least 3 seconds/.test(short.say));
  const th = planFor("threads", "Threads", { bytes: 1.5 * GB, seconds: 400 });
  assert.ok(th.action === "smaller" && th.trimTo === 300 && /up to 1 GB and 5 minutes/.test(th.say));
  assert.equal(planFor("youtube", "YouTube", { bytes: 300 * GB, seconds: 600 }).action, "smaller");
  assert.equal(lengthWords(140), "2 min 20 s");
  assert.equal(lengthWords(4 * 3600), "4 hours");
});

/** A sparse file of this size: it takes no real disk space. */
function sparse(dir: string, name: string, bytes: number): string {
  const p = join(dir, name); const fd = openSync(p, "w"); ftruncateSync(fd, bytes); closeSync(fd); return p;
}

test("the copy steps down a size until it fits, is shared between platforms, and the original stays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-"));
  const copies = join(dir, "copies");
  const video = sparse(dir, "big.mov", Math.round(1.1 * GB));
  const probe = () => ({ seconds: 300, width: 2160, height: 3840, audio: true, codec: "hvc1" });
  const calls: string[] = [];
  // Pretend 1080p comes out too big for 512 MB at 140 s, 720p fits.
  const convert = async (_src: string, out: string, preset: string, trimTo?: number) => {
    calls.push(`${preset}@${trimTo}`);
    writeFileSync(out, Buffer.alloc(preset === "Preset1920x1080" ? 600 * 1024 : 100 * 1024));
  };
  const log: string[] = [];
  const f1 = await fitFor("x", "X", video, { convert: async (s, o, p, t) => { await convert(s, o, p, t); }, dir: copies, probe, log: (m) => log.push(m) });
  // 512 MB at 140 s is about 29 Mbps: the 1080p preset is tried first and here it fits (600 KB < 512 MB).
  assert.equal(f1.copy, true);
  assert.match(f1.note, /X takes videos up to 512 MB/);
  assert.match(f1.note, /cut to the first 2 min 20 s/);
  assert.deepEqual(calls, ["Preset1920x1080@140"]);
  assert.ok(log.some((m) => /Making a smaller copy for X/.test(m)));
  // Asked again (another clip in the same batch, or Try again): the copy is reused, not remade.
  const f2 = await fitFor("x", "X", video, { convert, dir: copies, probe });
  assert.equal(f2.path, f1.path);
  assert.equal(calls.length, 1);
  // The original is what YouTube gets.
  const yt = await fitFor("youtube", "YouTube", video, { convert, dir: copies, probe });
  assert.deepEqual(yt, { path: video, note: "", copy: false });

  // Threads: 1 GB limit, so a too-big first copy steps down to the next preset.
  calls.length = 0;
  const bigFirst = async (_s: string, out: string, preset: string) => { calls.push(preset); writeFileSync(out, ""); const fd = openSync(out, "r+"); ftruncateSync(fd, Math.round(preset === "Preset1920x1080" ? 1.2 * GB : 0.5 * GB)); closeSync(fd); };
  const th = await fitFor("threads", "Threads", video, { convert: bigFirst, dir: copies, probe: () => ({ ...probe(), seconds: 200 }) });
  assert.deepEqual(calls, ["Preset1920x1080", "Preset1280x720"]);
  assert.equal(th.copy, true);
  assert.equal(readdirSync(copies).filter((n) => n.endsWith(".tmp.mp4")).length, 0, "no half-made copies left");
});

test("a clip too short for LinkedIn is refused in plain words; an unreadable file goes as it is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit2-"));
  const video = sparse(dir, "short.mov", 2 * MB);
  await assert.rejects(fitFor("linkedin", "LinkedIn", video, { probe: () => ({ seconds: 2, width: 1080, height: 1920, audio: true, codec: "avc1" }), dir }), /LinkedIn takes videos of at least 3 seconds/);
  const webm = sparse(dir, "x.webm", 2 * GB);
  assert.deepEqual(await fitFor("x", "X", webm, { probe: () => null, dir }), { path: webm, note: "", copy: false });
});
