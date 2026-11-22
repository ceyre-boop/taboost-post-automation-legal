// A smaller copy of a video for a platform that takes less than the person's original
// (X takes 512 MB and 2 min 20 s, for example). Made with macOS's own /usr/bin/avconvert,
// which every Mac has, so there is nothing to install. The original is never changed and
// is still what goes to every other platform.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "./config.ts";
import { probeFile } from "./maker/clips.ts";
import { planFor, type FitPlan } from "./platforms/limits.ts";

export const COPIES_DIR = join(APP_DIR, "copies");
export const AVCONVERT = process.env.POSTER_AVCONVERT || "/usr/bin/avconvert";

/** avconvert's H.264 presets, best first, with the bit rate each came out at on a busy,
 *  noisy upright test clip (the worst case), so a size can be guessed before encoding. */
export const PRESETS = [
  { name: "Preset1920x1080", longSide: 1920, bitrate: 11_000_000 },
  { name: "Preset1280x720", longSide: 1280, bitrate: 7_700_000 },
  { name: "Preset960x540", longSide: 960, bitrate: 4_800_000 },
  { name: "Preset640x480", longSide: 640, bitrate: 3_000_000 },
] as const;

export type Convert = (src: string, out: string, preset: string, trimTo?: number) => Promise<void>;

/** Run avconvert. A clip takes roughly a fifth of its length to convert on Apple silicon. */
export const avconvert: Convert = (src, out, preset, trimTo) => new Promise((resolve, reject) => {
  if (!existsSync(AVCONVERT)) return reject(new Error("This Mac has no avconvert, so a smaller copy can't be made."));
  const args = ["--source", src, "--output", out, "--preset", preset, "--replace"];
  if (trimTo) args.push("--duration", String(trimTo));
  const p = spawn(AVCONVERT, args, { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  p.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
  p.on("error", reject);
  p.on("exit", (code) => (code === 0 && existsSync(out) ? resolve() : reject(new Error(`avconvert couldn't make the copy (${code}): ${err.trim().split("\n").pop() ?? ""}`))));
});

export interface Fitted {
  /** The file to post: the original, or a smaller copy. */
  path: string;
  /** What was done, in the app's words, for the progress grid. Empty when nothing was. */
  note: string;
  /** True when `path` is a copy the app made (deleted when the batch is finished). */
  copy: boolean;
}

const inFlight = new Map<string, Promise<Fitted>>();

/** The copy settings that matter, so two platforms with the same limits share one copy. */
function copyKey(video: string, plan: Extract<FitPlan, { action: "smaller" }>): string {
  const s = statSync(video);
  return createHash("sha1").update([video, s.size, s.mtimeMs, plan.maxBytes ?? 0, plan.maxBitrate ?? 0, plan.trimTo ?? 0].join("|")).digest("hex").slice(0, 16);
}

/**
 * The video to post on this platform. Most of the time that's the original. When the
 * platform takes less (size, length or bit rate), a smaller copy is made once and reused
 * for any other platform with the same limits. Throws, in plain words, only when no copy
 * can help (a clip shorter than the platform's minimum).
 */
export async function fitFor(
  platformId: string, label: string, video: string,
  opts: { log?: (m: string) => void; premium?: boolean; convert?: Convert; dir?: string; probe?: typeof probeFile } = {},
): Promise<Fitted> {
  const log = opts.log ?? (() => {});
  let bytes = 0;
  try { bytes = statSync(video).size; } catch { return { path: video, note: "", copy: false }; }
  let probe: ReturnType<typeof probeFile> = null;
  try { probe = (opts.probe ?? probeFile)(video); } catch { probe = null; }
  // A file the app can't read the length of (WebM, for one) goes as it is: the platform decides.
  if (!probe) return { path: video, note: "", copy: false };
  const plan = planFor(platformId, label, { bytes, seconds: probe.seconds }, opts.premium);
  if (plan.action === "as-is") return { path: video, note: "", copy: false };
  if (plan.action === "cannot") throw new Error(plan.say);

  const dir = opts.dir ?? COPIES_DIR;
  mkdirSync(dir, { recursive: true });
  const key = copyKey(video, plan);
  const out = join(dir, `${key}.mp4`);
  if (existsSync(out)) return { path: out, note: plan.say, copy: true };
  const running = inFlight.get(out);
  if (running) return running.then((f) => ({ ...f, note: plan.say }));

  const job = (async (): Promise<Fitted> => {
    const convert = opts.convert ?? avconvert;
    const seconds = plan.trimTo ? Math.min(plan.trimTo, probe!.seconds) : probe!.seconds;
    const longSide = Math.max(probe!.width, probe!.height);
    // Start at the source's own size (never larger) and at the first preset that should fit.
    const budget = plan.maxBytes ? (plan.maxBytes * 8 * 0.92) / Math.max(1, seconds) : Infinity;
    const rate = Math.min(budget, plan.maxBitrate ? plan.maxBitrate * 0.95 : Infinity);
    let ladder: typeof PRESETS[number][] = PRESETS.filter((p) => p.longSide <= Math.max(longSide, 640));
    const first = ladder.findIndex((p) => p.bitrate <= rate);
    ladder = ladder.slice(first < 0 ? ladder.length - 1 : first);
    log(`Making a smaller copy for ${label}${plan.trimTo ? ` (the first ${Math.round(plan.trimTo)} seconds)` : ""}. This takes a moment…`);
    const tmp = `${out}.tmp.mp4`;
    for (const p of ladder) {
      await convert(video, tmp, p.name, plan.trimTo);
      const got = statSync(tmp).size;
      const gotRate = (got * 8) / Math.max(1, seconds);
      if ((!plan.maxBytes || got <= plan.maxBytes) && (!plan.maxBitrate || gotRate <= plan.maxBitrate)) {
        renameSync(tmp, out);
        log(`Smaller copy ready for ${label}: ${Math.round(got / 1024 / 1024)} MB.`);
        return { path: out, note: plan.say, copy: true };
      }
    }
    rmSync(tmp, { force: true });
    throw new Error(`${label} takes less than this video, and even the smallest copy was too big. Trim the clip and add it again.`);
  })();
  inFlight.set(out, job);
  try { return await job; } finally { inFlight.delete(out); }
}
