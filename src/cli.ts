#!/usr/bin/env node
import { resolve } from "node:path";
import { attach, launchChrome } from "./chrome.ts";
import { sleep } from "./sleep.ts";
import { CDP_PORT, PROFILE_DIR } from "./config.ts";
import { getPlatform } from "./platforms/index.ts";
import { buildBatch, runBatch, loadBatch, listBatches, videosInDir, loggedInPlatforms } from "./batch.ts";

const log = (m: string) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);

/** First value for --name. */
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
/** Every value for a repeated --name (e.g. --video a --video b). */
function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => { if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}
const has = (flag: string) => process.argv.includes(`--${flag}`);

async function cmdLogin(platformId: string): Promise<void> {
  const platform = getPlatform(platformId);
  await launchChrome(platform.loginUrl);
  const { browser, page } = await attach();
  if (await platform.isLoggedIn(page)) {
    log(`${platform.id}: already logged in. Profile: ${PROFILE_DIR}`);
  } else {
    log(`${platform.id}: log in inside the Chrome window that just opened. Waiting (up to 10 min)...`);
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline && !(await platform.isLoggedIn(page))) await sleep(2000);
    const ok = await platform.isLoggedIn(page);
    log(ok ? "Logged in. Session saved in the Chrome profile." : "Timed out waiting for login. Run login again when you are ready.");
    if (!ok) process.exitCode = 2;
  }
  await browser.close(); // detaches only; the Chrome window stays open
}

async function cmdStatus(platformId: string): Promise<void> {
  const platform = getPlatform(platformId);
  await launchChrome("about:blank");
  const { browser, page } = await attach();
  log(`${platform.id}: ${(await platform.isLoggedIn(page)) ? "logged in" : "NOT logged in"} (CDP :${CDP_PORT})`);
  await browser.close();
}

/** post: one or many videos → one or many platforms. Dry run unless --live. */
async function cmdPost(): Promise<void> {
  const dir = arg("dir");
  const videoPaths: string[] = [];
  if (dir) videoPaths.push(...videosInDir(dir));
  videoPaths.push(...args("video").map((v) => resolve(v)));
  if (!videoPaths.length) throw new Error("Give --dir <folder> and/or one or more --video <file>.");

  const platformArg = arg("platform");
  let platforms = platformArg ? platformArg.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (!platforms.length) {
    log("No --platform given — checking which platforms are logged in…");
    platforms = await loggedInPlatforms();
    if (!platforms.length) throw new Error("No platforms logged in. Run: node src/cli.ts login --platform tiktok");
    log(`Posting to: ${platforms.join(", ")}`);
  }

  const live = has("live");
  const spaceSec = Number(arg("space")) || 60;
  const sharedCaption = arg("caption") ?? "";

  const batch = buildBatch({
    videos: videoPaths.map((path) => ({ path })),
    platforms, live, spaceSec, sharedCaption,
  });
  log(`${live ? "LIVE" : "DRY RUN"} ${batch.id}: ${videoPaths.length} video(s) × ${platforms.length} platform(s) = ${batch.items.length} posts${live ? `, ~${spaceSec}s apart` : ""}.`);
  const done = await runBatch(batch, log);
  if (done.items.some((i) => i.status === "error")) process.exitCode = 1; // so callers (approve.ts) see failure
}

async function cmdBatchResume(id?: string): Promise<void> {
  if (!id) throw new Error("usage: batch:resume <id>   (see: node src/cli.ts batch:list)");
  const batch = loadBatch(id);
  const left = batch.items.filter((i) => i.status === "pending" || i.status === "error").length;
  log(`Resuming ${id}: ${left} item(s) left (${batch.live ? "LIVE" : "dry run"}).`);
  const done = await runBatch(batch, log);
  if (done.items.some((i) => i.status === "error")) process.exitCode = 1;
}

function cmdBatchList(): void {
  const bs = listBatches();
  if (!bs.length) { log("No batches yet."); return; }
  for (const b of bs) {
    const c = (s: string) => b.items.filter((i) => i.status === s).length;
    console.log(`${b.id}  ${b.live ? "LIVE" : "dry "}  ${c("done")}✓ ${c("error")}✖ ${c("pending") + c("posting")}…  (${b.items.length} posts)`);
  }
}

const [cmd, maybeId] = process.argv.slice(2);
const platformId = arg("platform", "tiktok")!.split(",")[0];
try {
  if (cmd === "login") await cmdLogin(platformId);
  else if (cmd === "status") await cmdStatus(platformId);
  else if (cmd === "post") await cmdPost();
  else if (cmd === "batch:resume") await cmdBatchResume(maybeId);
  else if (cmd === "batch:list") cmdBatchList();
  else {
    console.log(`usage:
  node src/cli.ts login  [--platform tiktok|instagram|youtube]
  node src/cli.ts status [--platform tiktok]
  node src/cli.ts post   --dir <folder> | --video <file> [--video <file> ...]
                         [--caption "text"] [--platform tiktok,instagram,youtube]
                         [--live] [--space 60]
  node src/cli.ts batch:list
  node src/cli.ts batch:resume <id>

post is a DRY RUN unless --live. No --platform = every logged-in platform.
Per-video caption: put "<name>.txt" next to "<name>.mp4". Otherwise --caption applies to all.`);
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`ERROR: ${(e as Error).message}`);
  process.exit(1);
}
