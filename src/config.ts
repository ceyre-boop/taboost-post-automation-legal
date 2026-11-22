import { homedir, platform } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

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
/** The port a name hashes to. Sets made before ports were saved used this, so it is still
 *  the first choice for a set (its Chrome keeps the port it already had). */
export const hashPort = (id: string) => 9300 + [...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 200, 0);
const PORTS_FILE = join(ROOT_DIR, "set-ports.json");
/** Each set of accounts gets its own Chrome debugging port, saved, and never shared: two
 *  sets on one port would share one Chrome and post from the wrong accounts. */
export function portFor(id: string): number {
  let saved: Record<string, number> = {};
  try { saved = JSON.parse(readFileSync(PORTS_FILE, "utf8")); } catch { /* none yet */ }
  if (saved[id]) return saved[id];
  const taken = new Set(Object.values(saved));
  let port = hashPort(id);
  for (let p = port, n = 0; n < 200; n++, p = 9300 + ((p - 9300 + 1) % 200)) { if (!taken.has(p)) { port = p; break; } }
  saved[id] = port;
  try {
    mkdirSync(ROOT_DIR, { recursive: true });
    writeFileSync(PORTS_FILE + ".tmp", JSON.stringify(saved, null, 2));
    renameSync(PORTS_FILE + ".tmp", PORTS_FILE);
  } catch { /* read-only folder: the port still works for this run */ }
  return port;
}
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
