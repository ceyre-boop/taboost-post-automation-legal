import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { CDP_PORT, PROFILE_DIR, ensureDirs } from "./config.ts";
import { sleep } from "./sleep.ts";

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

export function findChrome(): string {
  const found = CHROME_PATHS.find((p) => existsSync(p));
  if (!found) throw new Error("Google Chrome not found in /Applications. Install it from google.com/chrome.");
  return found;
}

async function cdpAlive(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Launch the user's real Chrome on OUR profile folder with a local debugging port.
 *  Same approach RnR uses: the person logs in inside this window, the profile keeps
 *  the session, we never see or store credentials. Reuses an already-running instance. */
export async function launchChrome(startUrl: string, port = CDP_PORT): Promise<void> {
  ensureDirs();
  if (await cdpAlive(port)) return;
  const bin = findChrome();
  const child = spawn(
    bin,
    [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      `--user-data-dir=${PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--start-maximized",
      startUrl,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await cdpAlive(port)) return;
    await sleep(300);
  }
  throw new Error(`Chrome opened but the debugging port ${port} never answered.`);
}

/** Kill only the Chrome running on OUR profile folder, never the user's normal Chrome. */
export function killToolChrome(): void {
  try {
    spawnSync("pkill", ["-f", `--user-data-dir=${PROFILE_DIR}`]);
  } catch {}
}

export interface Attached {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/** Attach Playwright to the running Chrome over CDP and return the first tab. */
export async function attach(port = CDP_PORT, startUrl = "about:blank"): Promise<Attached> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch (e) {
    // A Chrome left over from an earlier attach can refuse context management.
    // Same fix RnR's _repair_window uses: close ONLY our profile's Chrome and relaunch.
    if (!String((e as Error).message).includes("Browser context management")) throw e;
    killToolChrome();
    await sleep(1500);
    await launchChrome(startUrl, port);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  }
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser, context, page };
}
