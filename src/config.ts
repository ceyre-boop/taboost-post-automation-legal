import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/** Everything the tool keeps lives here. No passwords, no cookies exported by us:
 *  the Chrome profile folder itself holds the user's logged-in session. */
export const APP_DIR = join(homedir(), "Library", "Application Support", "TaboostPoster");
export const PROFILE_DIR = join(APP_DIR, "chrome-profile");
export const HISTORY_DB = join(APP_DIR, "history.db");
export const CDP_PORT = Number(process.env.POSTER_CDP_PORT ?? 9226);

export function ensureDirs(): void {
  mkdirSync(PROFILE_DIR, { recursive: true });
}
