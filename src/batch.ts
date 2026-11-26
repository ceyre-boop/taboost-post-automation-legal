// Batch posting: N user-provided videos × M platforms from one setup.
// Orchestrates the existing per-platform adapters; posts sequentially (the CDP
// engine allows one attach at a time) with human-like spacing between LIVE posts.
// Resumable: state lives in <app data folder>/batches/<id>.json.
import { basename, extname, join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { getPlatform, PLATFORMS } from "./platforms/index.ts";
import { withBrowser, pageFor } from "./browser.ts";
import { recordPost } from "./history.ts";
import { APP_DIR, defaultProfile, type Profile } from "./config.ts";
import { sleep } from "./sleep.ts";
import type { OfficialResult, Song } from "./official/types.ts";
import { postOfficial } from "./official/post.ts";
import { spawnSync } from "node:child_process";
import { markSent, maxPostsPerDay, takePost } from "./limits.ts";

export const BATCHES_DIR = join(APP_DIR, "batches");
export const MAX_BATCH_VIDEOS = 10;
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm"]);

/** "unconfirmed": the publish button was pressed but the app couldn't see the post go up
 *  (or the app stopped mid-post). It may well be live, so it is never retried by itself. */
export type ItemStatus = "pending" | "posting" | "done" | "error" | "skipped" | "unconfirmed" | "draft";
export interface BatchItem {
  video: string;
  caption: string;
  platform: string;
  status: ItemStatus;
  /** sha256 of the uploaded file, so the same video isn't sent to the same place twice in a row */
  sha?: string;
  note?: string;
  /** "official": through the platform's own API with the phone's permission; else the Mac's browser */
  via?: "official" | "browser";
  /** which Page / Instagram account / channel, and its name */
  identity?: string;
  identityName?: string;
  /** YouTube's title, when she wrote one */
  title?: string;
  song?: Song;
  /** where it went: the platform's id for it, and a link */
  remoteId?: string;
  link?: string;
}
export interface Batch {
  id: string;
  createdAt: string;
  live: boolean;
  /** Test post: once a live post is confirmed, take it straight back down. */
  deleteAfter?: boolean;
  spaceSec: number;
  items: BatchItem[];
  /** the phone that posted it (its official permissions), and a private test (nothing public) */
  device?: string;
  test?: boolean;
}

const batchFile = (id: string) => join(BATCHES_DIR, `${id}.json`);

export function batchId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `batch-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function saveBatch(b: Batch): void {
  mkdirSync(BATCHES_DIR, { recursive: true });
  writeFileSync(batchFile(b.id), JSON.stringify(b, null, 2));
}
export function loadBatch(id: string): Batch {
  const f = batchFile(id);
  if (!existsSync(f)) throw new Error(`No batch "${id}". List: node src/cli.ts batch:list`);
  return JSON.parse(readFileSync(f, "utf8")) as Batch;
}
export function listBatches(): Batch[] {
  if (!existsSync(BATCHES_DIR)) return [];
  return readdirSync(BATCHES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(BATCHES_DIR, f), "utf8")) as Batch)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** All video files directly inside a folder. */
export function videosInDir(dir: string): string[] {
  const abs = resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`Not a folder: ${abs}`);
  return readdirSync(abs)
    .filter((f) => VIDEO_EXTS.has(extname(f).toLowerCase()))
    .map((f) => join(abs, f))
    .sort();
}

/** per-video caption > sidecar "<name>.txt" > shared caption > "" */
export function resolveCaption(videoPath: string, perVideo: string | undefined, shared: string): string {
  if (perVideo !== undefined) return perVideo;
  const sidecar = videoPath.replace(/\.[^.]+$/, "") + ".txt";
  if (existsSync(sidecar)) return readFileSync(sidecar, "utf8").trim();
  return shared;
}

export interface BatchInput {
  /** `captions` gives one platform its own caption (the post maker writes one per platform). */
  videos: { path: string; caption?: string; captions?: Record<string, string>; sha?: string }[];
  platforms: string[];
  live: boolean;
  deleteAfter?: boolean;
  spaceSec?: number;
  sharedCaption?: string;
}

/** Expand videos × platforms into a persisted batch (video-major order). */
export function buildBatch(input: BatchInput): Batch {
  if (!input.videos.length) throw new Error("No videos to post.");
  if (!input.platforms.length) throw new Error("No platforms selected.");
  if (input.videos.length > MAX_BATCH_VIDEOS) throw new Error(`That's more than ${MAX_BATCH_VIDEOS} videos at once. Post them in smaller groups.`);
  input = { ...input, platforms: [...new Set(input.platforms)] }; // the same platform twice would post twice
  for (const p of input.platforms) getPlatform(p); // validate ids up front
  const items: BatchItem[] = [];
  for (const v of input.videos) {
    const abs = resolve(v.path);
    if (!existsSync(abs)) throw new Error(`Video not found: ${abs}`);
    const caption = resolveCaption(abs, v.caption, input.sharedCaption ?? "");
    for (const platform of input.platforms) items.push({ video: abs, caption: v.captions?.[platform] ?? caption, platform, status: "pending", ...(v.sha ? { sha: v.sha } : {}) });
  }
  const batch: Batch = {
    id: batchId(),
    createdAt: new Date().toISOString(),
    live: input.live,
    deleteAfter: input.live && !!input.deleteAfter,
    spaceSec: input.spaceSec ?? 60,
    items,
  };
  saveBatch(batch);
  return batch;
}

/** Which registered platforms currently have a signed-in session. */
export async function loggedInPlatforms(profile: Profile = defaultProfile): Promise<string[]> {
  return withBrowser(async (ctx) => {
    const out: string[] = [];
    for (const p of Object.values(PLATFORMS)) {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      if (await p.isLoggedIn(page).catch(() => false)) out.push(p.id);
    }
    return out;
  }, "about:blank", profile);
}

/** Take down the post carrying this caption on one platform. */
export async function removeOnPage(
  ctx: import("playwright-core").BrowserContext,
  platformId: string,
  caption: string,
  log: (m: string) => void,
): Promise<void> {
  const platform = getPlatform(platformId);
  if (!platform.remove) throw new Error(`${platform.label} has no delete step yet. Delete it by hand.`);
  const page = await pageFor(ctx, platform.host);
  // A post that just went up can take a minute to show in the account's own list. Look
  // again a couple of times before calling it a failure; remove() never deletes anything
  // it can't match to the caption, so trying again is safe.
  for (let attempt = 1; ; attempt++) {
    try { await platform.remove(page, caption, log); return; }
    catch (e) {
      if (attempt >= 3) throw e;
      log(`Couldn't delete it yet (${(e as Error).message.split("\n")[0]}). Trying again in 20 seconds…`);
      await sleep(20_000);
    }
  }
}

async function postOnPage(
  ctx: import("playwright-core").BrowserContext,
  item: BatchItem,
  live: boolean,
  log: (m: string) => void,
  clicked: () => void,
): Promise<void> {
  const platform = getPlatform(item.platform);
  const page = await pageFor(ctx, platform.host);
  if (!(await platform.isLoggedIn(page))) throw new Error(`Not logged in to ${platform.label}. Connect it first.`);
  await page.bringToFront().catch(() => {}); // cosmetic; harmless if another tab is also fronting
  await platform.post(page, { video: item.video, caption: item.caption, dryRun: !live, clicked }, log);
}

/** When each account last posted live, across batches (so a second batch, or "Try failed
 *  again", still keeps its distance). Keyed by Chrome profile and platform. */
const lastPost = new Map<string, number>();
/** At most this many uploads at once for one clip: seven big uploads over one home
 *  connection would all time out together. */
export const PARALLEL_UPLOADS = 2;

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/** Clips whose every post is finished one way or another (nothing left to try again). */
export function finishedVideos(batch: Batch): string[] {
  const videos = [...new Set(batch.items.map((i) => i.video))];
  return videos.filter((v) => batch.items.filter((i) => i.video === v).every((i) => i.status === "done" || i.status === "skipped" || i.status === "unconfirmed" || i.status === "draft"));
}

/** After a crash or restart: the newest batch, with anything that was mid-post marked
 *  unconfirmed (it may have gone out), so nothing is posted twice by a blind retry. */
export function recoverLatestBatch(): Batch | null {
  let latest: Batch | undefined;
  try { latest = listBatches()[0]; } catch { return null; }
  if (!latest) return null;
  let changed = false;
  for (const i of latest.items) {
    if (i.status === "posting") {
      i.status = latest.live ? "unconfirmed" : "error";
      i.note = latest.live ? "The app stopped while this was posting. It may have gone out: check before posting it again." : "The app stopped during this preview.";
      changed = true;
    }
  }
  if (changed) saveBatch(latest);
  return latest;
}

/** Seconds of video, when ffprobe can tell (Facebook Reels must be 3-90 s). */
function durationOf(file: string): number | undefined {
  try {
    const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { encoding: "utf8", timeout: 15_000 });
    const n = Number(r.stdout?.trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch { return undefined; }
}

/**
 * Run (or resume) a batch. Official posts (the platform's own API, with the phone's permission)
 * need no browser and go first; the rest are posted on the Mac's logged-in Chrome. For speed, every
 * platform for a given clip is posted IN PARALLEL (two at a time); clips are processed in order.
 * LIVE posts are paced PER-PLATFORM: we only wait if the same account posted less than `spaceSec`
 * ago. A private test (`batch.test`) posts nothing public: YouTube private, Facebook draft, TikTok
 * inbox, Instagram and LinkedIn skipped, browser platforms as a preview.
 */
export async function runBatch(
  batch: Batch,
  log: (m: string) => void = () => {},
  onUpdate: (b: Batch) => void = () => {},
  profile: Profile = defaultProfile,
): Promise<Batch> {
  const todo = batch.items.filter((i) => i.status === "pending" || i.status === "error");
  if (!todo.length) { log("Nothing to do — all items already done."); return batch; }
  const browserLive = batch.live && !batch.test;

  const groupsOf = (items: BatchItem[]) => {
    const groups: { video: string; items: BatchItem[] }[] = [];
    for (const it of items) {
      let g = groups.find((x) => x.video === it.video);
      if (!g) { g = { video: it.video, items: [] }; groups.push(g); }
      g.items.push(it);
    }
    return groups;
  };
  const extra = (item: BatchItem) => ({ via: item.via ?? "browser", identity: item.identityName ?? item.identity ?? "", remote_id: item.remoteId ?? "", link: item.link ?? "", song: item.song?.title ? `${item.song.title}${item.song.artist ? ` by ${item.song.artist}` : ""}` : "", device: batch.device ?? "" });

  /** One item: pacing, status, history, and the "pressed post but couldn't confirm" rule. */
  const runItem = async (item: BatchItem, post: (log: (m: string) => void, clicked: () => void) => Promise<OfficialResult | void>, ctx?: import("playwright-core").BrowserContext) => {
    const name = basename(item.video);
    const live = item.via === "official" ? batch.live : browserLive;
    const key = `${item.via === "official" ? `official:${batch.device ?? ""}:${item.identity ?? ""}` : profile.dir}|${item.platform}`;
    if (live && lastPost.has(key)) {
      const jitter = 0.75 + Math.random() * 0.5; // 0.75×–1.25×
      const wait = Math.round(batch.spaceSec * 1000 * jitter) - (Date.now() - lastPost.get(key)!);
      if (wait > 0) { log(`   …pacing ${item.platform}: ${Math.round(wait / 1000)}s`); await sleep(wait); }
    }
    // The day's limit for this platform holds however the post got here (phone, dashboard, auto-make, plan, retry).
    if (live && !takePost(item.platform)) {
      item.status = "error";
      item.note = `Daily limit reached: ${item.platform} takes at most ${maxPostsPerDay()} posts a day from this app. It resets at midnight.`;
      recordPost(item.platform, item.video, item.caption, `error: ${item.note}`, extra(item));
      log(`✖ ${name} → ${item.platform} — ${item.note}`);
      saveBatch(batch); onUpdate(batch);
      return;
    }
    item.status = "posting"; item.note = undefined;
    saveBatch(batch); onUpdate(batch);
    log(`▶ ${live ? "" : "(dry) "}${name} → ${item.platform}${item.via === "official" ? " (official)" : ""}${item.identityName ? ` as ${item.identityName}` : ""}`);
    if (live && item.via !== "official" && !getPlatform(item.platform).verified) log(`   ⚠ ${item.platform} is unverified — keep an eye on this one.`);
    let clicked = false;
    try {
      const r = await post((m) => log(`   [${item.platform}] ${m}`), () => { clicked = true; });
      item.status = r?.status ?? "done";
      if (r?.remoteId) item.remoteId = r.remoteId;
      if (r?.link) item.link = r.link;
      if (r?.note) item.note = r.note;
      recordPost(item.platform, item.video, item.caption, item.status === "draft" ? "draft" : item.status === "skipped" ? `skipped: ${item.note ?? ""}` : live ? "posted" : "dry-run", extra(item));
      if (live && item.status === "done") { lastPost.set(key, Date.now()); if (item.sha) markSent(item.platform, item.sha, item.caption); }
      log(`${item.status === "draft" ? "✎" : "✓"} ${name} → ${item.platform}${item.note ? ` (${item.note})` : ""}`);
      if (live && batch.deleteAfter && ctx && item.via !== "official" && item.status === "done") {
        // The post is up either way, so a failed delete is a note, not a failed post
        // (a failed item would be posted a second time on resume).
        try {
          await removeOnPage(ctx, item.platform, item.caption, (m) => log(`   [${item.platform}] ${m}`));
          item.note = "posted, then deleted";
          recordPost(item.platform, item.video, item.caption, "deleted", extra(item));
        } catch (e) {
          item.note = `POSTED BUT NOT DELETED: ${(e as Error).message.split("\n")[0]}`;
          log(`✖ ${name} → ${item.platform} — ${item.note}`);
        }
      }
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      if (live && clicked) {
        // The publish step ran. It has probably gone out; a retry would post it twice.
        item.status = "unconfirmed";
        item.note = `UNCONFIRMED: ${msg}`;
        lastPost.set(key, Date.now());
        if (item.sha) markSent(item.platform, item.sha, item.caption);
        recordPost(item.platform, item.video, item.caption, `unconfirmed: ${msg}`, extra(item));
      } else {
        item.status = "error";
        item.note = msg;
        recordPost(item.platform, item.video, item.caption, `error: ${item.note}`, extra(item));
      }
      log(`✖ ${name} → ${item.platform} — ${item.note}`);
    }
    saveBatch(batch); onUpdate(batch);
  };

  const official = todo.filter((i) => i.via === "official");
  const browser = todo.filter((i) => i.via !== "official");
  const seconds = new Map<string, number | undefined>();
  for (const group of groupsOf(official)) {
    if (!seconds.has(group.video)) seconds.set(group.video, durationOf(group.video));
    await pool(group.items, PARALLEL_UPLOADS, (item) => runItem(item, (l, clicked) => postOfficial(batch.device ?? "mac", item.platform, {
      file: item.video, caption: item.caption, title: item.title, identity: item.identity ?? "", test: !!batch.test, live: batch.live, song: item.song, duration: seconds.get(item.video),
    }, l, clicked)));
  }
  if (browser.length) {
    await withBrowser(async (ctx) => {
      for (const group of groupsOf(browser)) await pool(group.items, PARALLEL_UPLOADS, (item) => runItem(item, (l, clicked) => postOnPage(ctx, item, browserLive, l, clicked), ctx));
    }, "about:blank", profile);
  }

  const count = (s: ItemStatus) => batch.items.filter((i) => i.status === s).length;
  log(`Finished: ${count("done")} done${count("draft") ? `, ${count("draft")} draft${count("draft") === 1 ? "" : "s"}` : ""}, ${count("error")} error${count("error") === 1 ? "" : "s"}${count("unconfirmed") ? `, ${count("unconfirmed")} unconfirmed` : ""} of ${batch.items.length}.`);
  return batch;
}
