// Batch posting: N user-provided videos × M platforms from one setup.
// Orchestrates the existing per-platform adapters; posts sequentially (the CDP
// engine allows one attach at a time) with human-like spacing between LIVE posts.
// Resumable: state lives in ~/Library/Application Support/TaboostPoster/batches/<id>.json.
import { basename, extname, join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { getPlatform, PLATFORMS } from "./platforms/index.ts";
import { withBrowser, pageFor } from "./browser.ts";
import { recordPost } from "./history.ts";
import { APP_DIR } from "./config.ts";
import { sleep } from "./sleep.ts";

export const BATCHES_DIR = join(APP_DIR, "batches");
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm"]);

export type ItemStatus = "pending" | "posting" | "done" | "error" | "skipped";
export interface BatchItem {
  video: string;
  caption: string;
  platform: string;
  status: ItemStatus;
  note?: string;
}
export interface Batch {
  id: string;
  createdAt: string;
  live: boolean;
  spaceSec: number;
  items: BatchItem[];
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
  mkdirSync(BATCHES_DIR, { recursive: true });
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
  videos: { path: string; caption?: string }[];
  platforms: string[];
  live: boolean;
  spaceSec?: number;
  sharedCaption?: string;
}

/** Expand videos × platforms into a persisted batch (video-major order). */
export function buildBatch(input: BatchInput): Batch {
  if (!input.videos.length) throw new Error("No videos to post.");
  if (!input.platforms.length) throw new Error("No platforms selected.");
  for (const p of input.platforms) getPlatform(p); // validate ids up front
  const items: BatchItem[] = [];
  for (const v of input.videos) {
    const abs = resolve(v.path);
    if (!existsSync(abs)) throw new Error(`Video not found: ${abs}`);
    const caption = resolveCaption(abs, v.caption, input.sharedCaption ?? "");
    for (const platform of input.platforms) items.push({ video: abs, caption, platform, status: "pending" });
  }
  const batch: Batch = {
    id: batchId(),
    createdAt: new Date().toISOString(),
    live: input.live,
    spaceSec: input.spaceSec ?? 60,
    items,
  };
  saveBatch(batch);
  return batch;
}

/** Which registered platforms currently have a signed-in session. */
export async function loggedInPlatforms(): Promise<string[]> {
  return withBrowser(async (ctx) => {
    const out: string[] = [];
    for (const p of Object.values(PLATFORMS)) {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      if (await p.isLoggedIn(page).catch(() => false)) out.push(p.id);
    }
    return out;
  });
}

async function postOnPage(
  ctx: import("playwright-core").BrowserContext,
  item: BatchItem,
  live: boolean,
  log: (m: string) => void,
): Promise<void> {
  const platform = getPlatform(item.platform);
  const page = await pageFor(ctx, platform.host);
  if (!(await platform.isLoggedIn(page))) throw new Error(`Not logged in to ${platform.label}. Connect it first.`);
  await page.bringToFront().catch(() => {}); // cosmetic; harmless if another tab is also fronting
  await platform.post(page, { video: item.video, caption: item.caption, dryRun: !live }, log);
}

/**
 * Run (or resume) a batch. For speed, every platform for a given clip is posted
 * IN PARALLEL (one tab each, within one Chrome session); clips are processed in
 * order. LIVE posts are paced PER-PLATFORM: we only wait if the same account
 * posted less than `spaceSec` ago — time spent on other platforms counts, so
 * multi-platform batches rarely wait at all.
 */
export async function runBatch(
  batch: Batch,
  log: (m: string) => void = () => {},
  onUpdate: (b: Batch) => void = () => {},
): Promise<Batch> {
  const todo = batch.items.filter((i) => i.status === "pending" || i.status === "error");
  if (!todo.length) { log("Nothing to do — all items already done."); return batch; }

  // Group remaining items by clip, preserving order.
  const groups: { video: string; items: BatchItem[] }[] = [];
  for (const it of todo) {
    let g = groups.find((x) => x.video === it.video);
    if (!g) { g = { video: it.video, items: [] }; groups.push(g); }
    g.items.push(it);
  }
  const lastPost: Record<string, number> = {}; // platform -> ms of last live post

  await withBrowser(async (ctx) => {
    for (const group of groups) {
      const name = basename(group.video);
      await Promise.all(group.items.map(async (item) => {
        // Pace repeats to the SAME account only (live).
        if (batch.live && lastPost[item.platform]) {
          const jitter = 0.75 + Math.random() * 0.5; // 0.75×–1.25×
          const wait = Math.round(batch.spaceSec * 1000 * jitter) - (Date.now() - lastPost[item.platform]);
          if (wait > 0) { log(`   …pacing ${item.platform}: ${Math.round(wait / 1000)}s`); await sleep(wait); }
        }
        item.status = "posting"; item.note = undefined;
        saveBatch(batch); onUpdate(batch);
        log(`▶ ${batch.live ? "" : "(dry) "}${name} → ${item.platform}`);
        if (batch.live && !getPlatform(item.platform).verified) log(`   ⚠ ${item.platform} is unverified — keep an eye on this one.`);
        try {
          await postOnPage(ctx, item, batch.live, (m) => log(`   [${item.platform}] ${m}`));
          item.status = "done";
          recordPost(item.platform, item.video, item.caption, batch.live ? "posted" : "dry-run");
          if (batch.live) lastPost[item.platform] = Date.now();
          log(`✓ ${name} → ${item.platform}`);
        } catch (e) {
          item.status = "error";
          item.note = (e as Error).message.split("\n")[0];
          recordPost(item.platform, item.video, item.caption, `error: ${item.note}`);
          log(`✖ ${name} → ${item.platform} — ${item.note}`);
        }
        saveBatch(batch); onUpdate(batch);
      }));
    }
  });

  const done = batch.items.filter((i) => i.status === "done").length;
  const err = batch.items.filter((i) => i.status === "error").length;
  log(`Finished: ${done} done, ${err} error${err === 1 ? "" : "s"} of ${batch.items.length}.`);
  return batch;
}
