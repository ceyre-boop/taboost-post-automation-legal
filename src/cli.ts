#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { attach, launchChrome } from "./chrome.ts";
import { sleep } from "./sleep.ts";
import { CDP_PORT, PROFILE_DIR } from "./config.ts";
import { recordPost } from "./history.ts";
import { getPlatform } from "./platforms/index.ts";

const log = (m: string) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
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
    log((await platform.isLoggedIn(page)) ? "Logged in. Session saved in the Chrome profile." : "Timed out waiting for login.");
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

async function cmdPost(platformId: string): Promise<void> {
  const platform = getPlatform(platformId);
  const video = arg("video");
  const caption = arg("caption", "") ?? "";
  if (!video) throw new Error("--video <file> is required");
  const abs = resolve(video);
  if (!existsSync(abs)) throw new Error(`Video not found: ${abs}`);
  const dryRun = !has("live");

  await launchChrome(platform.loginUrl);
  const { browser, page } = await attach();
  if (!(await platform.isLoggedIn(page))) throw new Error(`Not logged in to ${platform.id}. Run: bun run login --platform ${platform.id}`);
  try {
    await platform.post(page, { video: abs, caption, dryRun }, log);
    recordPost(platform.id, abs, caption, dryRun ? "dry-run" : "posted");
  } catch (e) {
    recordPost(platform.id, abs, caption, `error: ${(e as Error).message}`);
    throw e;
  } finally {
    await browser.close();
  }
}

const [cmd] = process.argv.slice(2);
const platformId = arg("platform", "tiktok")!;
try {
  if (cmd === "login") await cmdLogin(platformId);
  else if (cmd === "status") await cmdStatus(platformId);
  else if (cmd === "post") await cmdPost(platformId);
  else {
    console.log(`usage:
  bun run login  [--platform tiktok]
  bun run status [--platform tiktok]
  bun run post   --video <file> --caption "text" [--platform tiktok] [--live]
(default is a dry run that fills everything but never clicks Post)`);
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`ERROR: ${(e as Error).message}`);
  process.exit(1);
}
