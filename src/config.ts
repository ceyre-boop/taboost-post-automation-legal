import { homedir, platform } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

// Cross-platform per-user data dir. The Electron app sets POSTER_APP_DIR to its own
// userData path; the CLI falls back to the OS-native location.
function defaultAppDir(): string {
  if (process.env.POSTER_APP_DIR) return process.env.POSTER_APP_DIR;
  const home = homedir();
  const base =
    platform() === "win32" ? process.env.APPDATA || join(home, "AppData", "Roaming")
    : platform() === "darwin" ? join(home, "Library", "Application Support")
    : process.env.XDG_CONFIG_HOME || join(home, ".config");
  // Installs from before the rename keep their folder, so nobody is signed out by an update.
  const legacy = join(base, "TaboostPoster");
  const current = join(base, "NorthboundPoster");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

/** Everything the tool keeps lives here. No passwords, no cookies exported by us:
 *  the Chrome profile folder itself holds the user's logged-in session. */
// POSTER_ACCOUNT=<name> keeps a second, separate set of signed-in accounts (for example a
// business alongside a personal one). Each named set has its own folder and browser.
export const cleanAccountId = (name: string): string => name.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30);
const ACCOUNT = cleanAccountId(process.env.POSTER_ACCOUNT ?? "");
/** The person's app folder itself, whichever set of accounts is in use. */
export const ROOT_DIR = defaultAppDir();
export const APP_DIR = ACCOUNT ? join(ROOT_DIR, "accounts", ACCOUNT) : ROOT_DIR;
export const PROFILE_DIR = join(APP_DIR, "chrome-profile");
export const HISTORY_DB = join(APP_DIR, "history.db");
const portFor = (id: string) => 9300 + [...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 200, 0);
export const CDP_PORT = Number(process.env.POSTER_CDP_PORT ?? (ACCOUNT ? portFor(ACCOUNT) : 9226));

/** A Chrome profile folder plus the debugging port its Chrome listens on.
 *  The default one is the tool's own; each phone device gets its own (see devices.ts). */
export interface Profile { dir: string; port: number; }
export const defaultProfile: Profile = { dir: PROFILE_DIR, port: CDP_PORT };

/** The Chrome profile for a named set of accounts ("" is the main set). Same folder and
 *  port that POSTER_ACCOUNT=<id> uses, so a set made either way is the same set. */
export function accountProfile(id: string): Profile {
  const clean = cleanAccountId(id);
  if (!clean || clean === ACCOUNT) return defaultProfile;
  return { dir: join(ROOT_DIR, "accounts", clean, "chrome-profile"), port: portFor(clean) };
}

export function ensureDirs(dir: string = PROFILE_DIR): void {
  mkdirSync(dir, { recursive: true });
}
