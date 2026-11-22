import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { platform, homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { defaultProfile, ensureDirs, type Profile } from "./config.ts";
import { sleep } from "./sleep.ts";

function chromeCandidates(): string[] {
  const env = process.env.POSTER_CHROME_PATH; // explicit override always wins
  const home = homedir();
  switch (platform()) {
    case "win32": {
      const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
      const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
      const local = process.env["LOCALAPPDATA"] || join(home, "AppData", "Local");
      return [
        env,
        join(pf, "Google\\Chrome\\Application\\chrome.exe"),
        join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
        join(local, "Google\\Chrome\\Application\\chrome.exe"),
        join(pf, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
        join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
      ].filter(Boolean) as string[];
    }
    case "darwin":
      return [
        env,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ].filter(Boolean) as string[];
    default: // linux
      return [
        env,
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/opt/google/chrome/chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/brave-browser",
        "/usr/bin/microsoft-edge",
      ].filter(Boolean) as string[];
  }
}

/** The --user-data-dir of the Chrome listening on this port, or null if it can't be told. */
export function chromeProfileOn(port: number): string | null {
  if (platform() === "win32") return null;
  try {
    const pids = spawnSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim().split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      const cmd = spawnSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).stdout;
      const m = cmd.match(/--user-data-dir=(.+?)(?= --|$)/);
      if (m) return m[1].trim();
    }
  } catch { /* no lsof or ps: can't tell */ }
  return null;
}

export function findChrome(): string {
  const found = chromeCandidates().find((p) => existsSync(p));
  if (!found) {
    throw new Error("Google Chrome not found. Install it from google.com/chrome (or set POSTER_CHROME_PATH to its location).");
  }
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
export async function launchChrome(startUrl: string, profile: Profile = defaultProfile): Promise<void> {
  const { dir, port } = profile;
  ensureDirs(dir);
  if (await cdpAlive(port)) {
    // Something answers on this port. Only reuse it if it is this profile's own Chrome:
    // another set's Chrome would post from the wrong accounts.
    const owner = chromeProfileOn(port);
    if (owner === null || owner === dir) return;
    throw new Error(`Another Chrome window (not this set of accounts) is using port ${port}. Quit the app's other Chrome windows and try again.`);
  }
  const bin = findChrome();
  const child = spawn(
    bin,
    [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      // Only a page served from this debugging port itself may open a debugging socket.
      // (It used to be "*", which let any web page try.) The app's own connections are
      // made from Node, which sends no Origin and is always allowed.
      `--remote-allow-origins=http://127.0.0.1:${port}`,
      `--user-data-dir=${dir}`,
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
export function killToolChrome(profile: Profile = defaultProfile): void {
  const PROFILE_DIR = profile.dir;
  try {
    if (platform() === "win32") {
      // Match our profile dir in the command line via WMIC, then kill by PID.
      spawnSync("powershell", [
        "-NoProfile", "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${PROFILE_DIR.replace(/\\/g, "\\\\")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
      ]);
    } else {
      // The "--" matters: without it pkill reads the pattern itself as an option, refuses
      // it, and kills nothing, so a stuck Chrome was never actually closed and the
      // "close ours and reopen" recovery in attach() could not work.
      spawnSync("pkill", ["-f", "--", `--user-data-dir=${PROFILE_DIR}`]);
    }
  } catch {}
}

/** Close OUR Chrome, wait until it has really gone, open it again and connect. Chrome
 *  takes a moment to exit; launching while its port still answers just reconnects to the
 *  window that is closing, which fails the same way. Tried twice before giving up. */
async function reopenAndConnect(profile: Profile, startUrl: string): Promise<Browser> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    killToolChrome(profile);
    const gone = Date.now() + 10_000;
    while (Date.now() < gone && (await cdpAlive(profile.port))) await sleep(250);
    await sleep(400);
    await launchChrome(startUrl, profile);
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${profile.port}`); }
    catch (e) { last = e; }
  }
  throw last;
}

export interface Attached {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/** Attach Playwright to the running Chrome over CDP and return the first tab. */
export async function attach(profile: Profile = defaultProfile, startUrl = "about:blank"): Promise<Attached> {
  const { port } = profile;
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch (e) {
    // A Chrome left over from an earlier attach can refuse context management.
    // Same fix RnR's _repair_window uses: close ONLY our profile's Chrome and relaunch.
    if (!String((e as Error).message).includes("Browser context management")) throw e;
    browser = await reopenAndConnect(profile, startUrl);
  }
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser, context, page };
}
