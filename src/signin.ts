// Signing in, the way the person normally does. Google refuses to sign anyone in to a Chrome
// that a program is driving ("This browser or app may not be secure"), and other sites are
// warier of one too. So Connect opens the set's own Chrome profile as a plain Chrome window:
// no debugging port, no automation, nothing attached. Chrome fills in saved passwords there
// as it always does. When the person is done (they close the window, or press Done in the
// app), the app reopens the same profile for posting, still signed in.
//
// While that plain window is open the app can't look inside Chrome, so it reads the profile's
// cookie file instead: only the names of the sign-in cookies and when they expire. Values are
// never read (they're encrypted by macOS anyway).
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cdpAlive, chromeProfileOn, findChrome, killToolChrome, profileInUse } from "./chrome.ts";
import { ensureDirs, type Profile } from "./config.ts";
import { sleep } from "./sleep.ts";

/** The cookie that means "signed in", per platform (the same ones each adapter's isLoggedIn checks). */
export const SESSION_COOKIES: Record<string, { hosts: string[]; names: string[] }> = {
  tiktok: { hosts: ["tiktok.com"], names: ["sessionid", "sid_tt"] },
  instagram: { hosts: ["instagram.com"], names: ["sessionid"] },
  youtube: { hosts: ["youtube.com"], names: ["SID", "__Secure-3PSID"] },
  x: { hosts: ["x.com"], names: ["auth_token"] },
  facebook: { hosts: ["facebook.com"], names: ["c_user"] },
  linkedin: { hosts: ["linkedin.com"], names: ["li_at"] },
  threads: { hosts: ["threads.net", "threads.com"], names: ["sessionid"] },
  pinterest: { hosts: ["pinterest.com"], names: ["_pinterest_sess"] },
};

export interface Session { signedIn: boolean; /** When the sign-in cookie runs out (ISO date), if signed in. */ until: string | null; }

/**
 * Which platforms this profile is signed in to, from its cookie file on disk, and until when.
 * Chrome writes new cookies to disk within about 30 seconds, so a sign-in just finished shows
 * up shortly after. Works whether or not Chrome is running (a copy of the file is read).
 */
export async function sessionsOnDisk(profileDir: string, now = Date.now()): Promise<Record<string, Session>> {
  const out: Record<string, Session> = {};
  for (const id of Object.keys(SESSION_COOKIES)) out[id] = { signedIn: false, until: null };
  const src = join(profileDir, "Default", "Cookies");
  if (!existsSync(src)) return out;
  let tmp = "";
  try {
    const { DatabaseSync } = await import("node:sqlite");
    tmp = mkdtempSync(join(tmpdir(), "pe-cookies-"));
    copyFileSync(src, join(tmp, "Cookies"));
    for (const extra of ["-journal", "-wal"]) if (existsSync(src + extra)) copyFileSync(src + extra, join(tmp, "Cookies" + extra));
    const db = new DatabaseSync(join(tmp, "Cookies"), { readOnly: true });
    // Chrome counts time in microseconds since 1601. Only names, hosts and expiry are selected.
    const rows = db.prepare("SELECT host_key AS host, name, (expires_utc / 1000000 - 11644473600) AS exp FROM cookies").all() as { host: string; name: string; exp: number }[];
    db.close();
    for (const [id, want] of Object.entries(SESSION_COOKIES)) {
      let best = 0;
      for (const r of rows) {
        const host = r.host.replace(/^\./, "");
        if (!want.names.includes(r.name) || !want.hosts.some((h) => host === h || host.endsWith(`.${h}`))) continue;
        const exp = Number(r.exp) * 1000;
        if (exp > now) best = Math.max(best, exp);
      }
      if (best) out[id] = { signedIn: true, until: new Date(best).toISOString() };
    }
  } catch { /* no sqlite in this runtime, or a file mid-write: report nothing rather than guess */ }
  finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
  return out;
}

interface Open { platform: string; pid: number; startedAt: number; }
const open = new Map<string, Open>();

/** Is any Chrome running on this profile folder? (The plain window has no port to ask.) */
export const chromeRunningOn = profileInUse;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The plain sign-in window open on this profile, if there is one. */
export function signingIn(profile: Profile): { platform: string; startedAt: number } | null {
  const o = open.get(profile.dir);
  if (!o) return null;
  if (!alive(o.pid)) { open.delete(profile.dir); return null; }
  return { platform: o.platform, startedAt: o.startedAt };
}

/** Close this profile's Chrome (the posting one) and wait until it has really gone, so the
 *  plain window gets the profile to itself. Never touches the person's own Chrome. */
async function closeProfileChrome(profile: Profile): Promise<void> {
  if (!chromeRunningOn(profile.dir)) return;
  killToolChrome(profile); // a polite quit: Chrome saves its cookies on the way out
  const end = Date.now() + 15_000;
  while (Date.now() < end && (chromeRunningOn(profile.dir) || (await cdpAlive(profile.port)))) await sleep(300);
  if (chromeRunningOn(profile.dir)) throw new Error("The app's Chrome window didn't close. Quit it (Cmd-Q), then press Connect again.");
}

/**
 * Open the platform's sign-in page in a plain Chrome window on this profile. Pressing Connect
 * again while it's open just shows the page again in that window.
 */
export async function openSignIn(profile: Profile, platformId: string, url: string): Promise<void> {
  ensureDirs(profile.dir);
  const bin = findChrome();
  const already = signingIn(profile);
  if (!already) {
    // Another set's Chrome on this profile's port would be a different person's accounts: leave it alone.
    const owner = (await cdpAlive(profile.port)) ? chromeProfileOn(profile.port) : null;
    if (owner && owner !== profile.dir) throw new Error("Another Chrome window (not this set of accounts) is using this set's port. Quit the app's other Chrome windows and try again.");
    await closeProfileChrome(profile);
  }
  // No --remote-debugging-port, no --enable-automation: an ordinary Chrome window. With the
  // window already open, Chrome passes the address to it and this second process exits.
  const child = spawn(bin, [`--user-data-dir=${profile.dir}`, "--no-first-run", "--no-default-browser-check", url], { detached: true, stdio: "ignore" });
  child.unref();
  if (!already && child.pid) open.set(profile.dir, { platform: platformId, pid: child.pid, startedAt: Date.now() });
  else if (already) open.set(profile.dir, { ...open.get(profile.dir)!, platform: platformId });
}

/** The person is done signing in: close the plain window politely (Chrome saves its cookies
 *  as it quits). The next check or post reopens the profile for posting. */
export async function finishSignIn(profile: Profile): Promise<void> {
  const o = open.get(profile.dir);
  open.delete(profile.dir);
  if (o && alive(o.pid)) { try { process.kill(o.pid, "SIGTERM"); } catch { /* already gone */ } }
  const end = Date.now() + 15_000;
  while (Date.now() < end && chromeRunningOn(profile.dir) && !(await cdpAlive(profile.port))) await sleep(300);
}
