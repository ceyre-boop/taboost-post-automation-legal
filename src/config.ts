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
const ACCOUNT = (process.env.POSTER_ACCOUNT ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30);
export const APP_DIR = ACCOUNT ? join(defaultAppDir(), "accounts", ACCOUNT) : defaultAppDir();
export const PROFILE_DIR = join(APP_DIR, "chrome-profile");
export const HISTORY_DB = join(APP_DIR, "history.db");
const accountPort = 9300 + [...ACCOUNT].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 200, 0);
export const CDP_PORT = Number(process.env.POSTER_CDP_PORT ?? (ACCOUNT ? accountPort : 9226));

/** A Chrome profile folder plus the debugging port its Chrome listens on.
 *  The default one is the tool's own; each phone device gets its own (see devices.ts). */
export interface Profile { dir: string; port: number; }
export const defaultProfile: Profile = { dir: PROFILE_DIR, port: CDP_PORT };

export function ensureDirs(dir: string = PROFILE_DIR): void {
  mkdirSync(dir, { recursive: true });
}
