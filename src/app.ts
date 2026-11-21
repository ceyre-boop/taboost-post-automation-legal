// What the "Post Everywhere" app needs on top of the posting engine: which platforms it
// shows, where a person's own posts live on each one, how to sign a platform out, the
// app's small settings file, and a plain-English fix for every way a post can fail.
// Nothing here knows a password, a token or a cookie value.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { BrowserContext } from "playwright-core";
import { APP_DIR, cleanAccountId } from "./config.ts";
import { PLATFORMS } from "./platforms/index.ts";

export const APP_NAME = "Post Everywhere";

interface PlatformMeta {
  /** The person's own list of posts on this platform. History rows link here. */
  postsUrl: string;
  /** The sites whose saved session belongs to this platform. Disconnect clears exactly these. */
  domains: string[];
}

/** The platforms the app offers, in the order it shows them. Pinterest is left out until
 *  it has posted for real (it needs a board on the account and has no delete step). */
export const APP_PLATFORMS: Record<string, PlatformMeta> = {
  tiktok: { postsUrl: "https://www.tiktok.com/tiktokstudio/content", domains: ["tiktok.com"] },
  // Instagram has no "my posts" address that works without the username; its home page
  // carries the profile link.
  instagram: { postsUrl: "https://www.instagram.com/", domains: ["instagram.com"] },
  youtube: { postsUrl: "https://studio.youtube.com/", domains: ["youtube.com", "google.com"] },
  x: { postsUrl: "https://x.com/home", domains: ["x.com", "twitter.com"] },
  facebook: { postsUrl: "https://www.facebook.com/me", domains: ["facebook.com"] },
  linkedin: { postsUrl: "https://www.linkedin.com/in/me/recent-activity/all/", domains: ["linkedin.com"] },
  threads: { postsUrl: "https://www.threads.net/", domains: ["threads.net", "threads.com"] },
};

export const appPlatformIds = (): string[] => Object.keys(APP_PLATFORMS).filter((id) => PLATFORMS[id]);
export const isAppPlatform = (id: string): boolean => appPlatformIds().includes(id);

/** Sign one platform out inside the app's own Chrome: remove that site's cookies and its
 *  stored data. The person's normal Chrome and the other platforms are untouched. */
export async function disconnect(ctx: BrowserContext, platformId: string): Promise<void> {
  const meta = APP_PLATFORMS[platformId];
  if (!meta) throw new Error(`Unknown platform "${platformId}".`);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const session = await ctx.newCDPSession(page);
  // Cookies are removed by reading the names for these sites and deleting each one. The
  // values are never looked at, kept or logged.
  const { cookies } = (await session.send("Storage.getCookies")) as { cookies: { name: string; domain: string; path: string }[] };
  for (const c of cookies) {
    const host = c.domain.replace(/^\./, "");
    if (!meta.domains.some((d) => host === d || host.endsWith(`.${d}`))) continue;
    await session.send("Network.deleteCookies", { name: c.name, domain: c.domain, path: c.path }).catch(() => {});
  }
  for (const d of meta.domains) {
    for (const origin of [`https://${d}`, `https://www.${d}`]) {
      await session.send("Storage.clearDataForOrigin", { origin, storageTypes: "local_storage,session_storage,indexeddb,cache_storage,service_workers" }).catch(() => {});
    }
  }
  await session.detach().catch(() => {});
  // Any tab still showing the signed-in site would look connected until reloaded.
  const platform = PLATFORMS[platformId];
  for (const p of ctx.pages()) {
    if (platform.host.test(p.url())) await p.goto("about:blank").catch(() => {});
  }
}

/* ---- settings: one small file in the person's own app folder ---- */

/** A separate set of signed-in accounts, with its own Chrome window: a business beside a
 *  personal set, for example. The main set has the id "". */
export interface AccountSet { id: string; name: string; }

export interface Settings {
  /** True once the first-run setup has been finished. */
  onboarded: boolean;
  /** Seconds between posts to the same account. On by default: it keeps accounts safe. */
  spaceSec: number;
  /** What the person calls the main set. */
  mainName: string;
  /** Extra sets the person has added. */
  sets: AccountSet[];
  /** The set in use: "" for the main one, otherwise a set's id. */
  activeSet: string;
}
const DEFAULTS: Settings = { onboarded: false, spaceSec: 60, mainName: "Main", sets: [], activeSet: "" };

const cleanName = (v: unknown, fallback: string): string => String(v ?? "").replace(/[^\p{L}\p{N} ._'&-]/gu, "").trim().slice(0, 30) || fallback;
function cleanSets(v: unknown): AccountSet[] {
  if (!Array.isArray(v)) return [];
  const out: AccountSet[] = [];
  for (const s of v) {
    const id = cleanAccountId(String(s?.id ?? ""));
    if (id && !out.some((o) => o.id === id)) out.push({ id, name: cleanName(s?.name, id) });
  }
  return out.slice(0, 12);
}

/** Every set, main first, for the switcher. */
export function allSets(s: Settings): AccountSet[] {
  return [{ id: "", name: s.mainName }, ...s.sets];
}

/** Add a set by name. The id is made from the name and never collides with another. */
export function addSet(name: string, dir: string = APP_DIR): { settings: Settings; set: AccountSet } {
  const s = readSettings(dir);
  const shown = cleanName(name, "");
  if (!shown) throw new Error("Give the set a name.");
  if (allSets(s).some((x) => x.name.toLowerCase() === shown.toLowerCase())) throw new Error(`You already have a set called "${shown}".`);
  if (s.sets.length >= 12) throw new Error("That's the most sets the app keeps.");
  const base = cleanAccountId(shown.replace(/\s+/g, "-")) || "set";
  let id = base;
  for (let n = 2; s.sets.some((x) => x.id === id); n++) id = `${base.slice(0, 27)}-${n}`;
  const set = { id, name: shown };
  return { settings: writeSettings({ sets: [...s.sets, set] }, dir), set };
}
const settingsFile = (dir: string = APP_DIR) => join(dir, "settings.json");

export function readSettings(dir: string = APP_DIR): Settings {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(dir), "utf8"));
    const sets = cleanSets(raw.sets);
    const active = cleanAccountId(String(raw.activeSet ?? ""));
    return { onboarded: raw.onboarded === true, spaceSec: cleanSpace(raw.spaceSec), mainName: cleanName(raw.mainName, DEFAULTS.mainName), sets, activeSet: sets.some((s) => s.id === active) ? active : "" };
  } catch {
    return { ...DEFAULTS, sets: [] };
  }
}

export function writeSettings(patch: Partial<Settings>, dir: string = APP_DIR): Settings {
  const next: Settings = { ...readSettings(dir) };
  if (typeof patch.onboarded === "boolean") next.onboarded = patch.onboarded;
  if (patch.spaceSec !== undefined) next.spaceSec = cleanSpace(patch.spaceSec);
  if (patch.mainName !== undefined) next.mainName = cleanName(patch.mainName, next.mainName);
  if (patch.sets !== undefined) next.sets = cleanSets(patch.sets);
  if (patch.activeSet !== undefined) {
    const want = cleanAccountId(String(patch.activeSet));
    next.activeSet = next.sets.some((s) => s.id === want) ? want : "";
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(settingsFile(dir), JSON.stringify(next, null, 2));
  return next;
}

/** Spacing is 0 (off, the person's explicit choice) or 15 seconds to 30 minutes. */
export function cleanSpace(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULTS.spaceSec;
  if (n <= 0) return 0;
  return Math.min(1800, Math.max(15, n));
}

/* ---- names ---- */

/** Uploaded clips are saved as "<time>-<n>--<original name>" so two clips with the same
 *  name never collide. This gives back the name the person knows the clip by. */
export function uploadName(index: number, original: string, now: number = Date.now()): string {
  const safe = basename(original).replace(/[^\w.\- ()]+/g, "_").slice(-80) || "clip.mp4";
  return `${now}-${index}--${safe}`;
}
export function displayName(path: string): string {
  const base = basename(path);
  const cut = base.indexOf("--");
  return cut > 0 && /^\d+-\d+$/.test(base.slice(0, cut)) ? base.slice(cut + 2) : base;
}

/* ---- failures, in plain English ---- */

export interface Fix {
  /** What went wrong, in one short sentence. */
  problem: string;
  /** What the person should do about it. */
  fix: string;
  /** "connect" sends them to Accounts; "retry" offers Try again. */
  action: "connect" | "retry" | "add-clip" | "chrome";
}

/** Turn an engine error into something a non-technical person can act on. The raw
 *  message is still kept alongside it, under "Details". */
export function explain(note: string, platformLabel: string): Fix {
  const n = note || "";
  const P = platformLabel;
  if (/not logged in|log ?in again|signed out|session expired/i.test(n)) {
    return { problem: `You're signed out of ${P}.`, fix: `Open Accounts, click Connect next to ${P}, sign in, then press Try again.`, action: "connect" };
  }
  if (/Chrome not found/i.test(n)) {
    return { problem: "Google Chrome isn't installed.", fix: "Install Chrome from google.com/chrome, then press Try again.", action: "chrome" };
  }
  if (/debugging port|Browser context management|Target (page|closed)|browser has been closed|ECONNREFUSED/i.test(n)) {
    return { problem: "The app's Chrome window was closed or didn't open properly.", fix: "Press Try again. The app reopens its window by itself.", action: "retry" };
  }
  if (/captcha|verify (it'?s|that) you|are you human|unusual activity|challenge|checkpoint|suspicious/i.test(n)) {
    return { problem: `${P} wants to check it's really you.`, fix: `Finish the check in the app's Chrome window, then press Try again.`, action: "retry" };
  }
  if (/Video not found|no such file|ENOENT/i.test(n)) {
    return { problem: "The clip file can't be found any more.", fix: "Add the clip again from the Post screen.", action: "add-clip" };
  }
  if (/too (long|large|big)|file size|duration|unsupported|format|codec/i.test(n)) {
    return { problem: `${P} didn't accept this clip.`, fix: `Check the clip's length, size and format against ${P}'s limits, then add it again.`, action: "add-clip" };
  }
  if (/board/i.test(n)) {
    return { problem: `${P} needs a board to post to.`, fix: `Create a board on your ${P} account, then press Try again.`, action: "retry" };
  }
  if (/Timeout|exceeded|waiting for|locator|not visible|never (appeared|enabled|answered)|did not (appear|enable)/i.test(n)) {
    return { problem: `${P} took too long, or its page wasn't where the app expected.`, fix: `Look at the ${P} tab in the app's Chrome window. Close any pop-up or notice it's showing, then press Try again.`, action: "retry" };
  }
  if (/POSTED BUT NOT DELETED/i.test(n)) {
    return { problem: `The test post went up on ${P} but couldn't be taken down.`, fix: `Open ${P} and delete the post yourself.`, action: "retry" };
  }
  return { problem: `${P} didn't finish the post.`, fix: `Press Try again. If it keeps failing, disconnect and reconnect ${P} in Accounts.`, action: "retry" };
}
