import { homedir, platform } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// Cross-platform per-user data dir. The Electron app sets POSTER_APP_DIR to its own
// userData path; the CLI falls back to the OS-native location.
function defaultAppDir(): string {
  if (process.env.POSTER_APP_DIR) return process.env.POSTER_APP_DIR;
  const home = homedir();
  switch (platform()) {
    case "win32":
      return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "TaboostPoster");
    case "darwin":
      return join(home, "Library", "Application Support", "TaboostPoster");
    default:
      return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "TaboostPoster");
  }
}

/** Everything the tool keeps lives here. No passwords, no cookies exported by us:
 *  the Chrome profile folder itself holds the user's logged-in session. */
export const APP_DIR = defaultAppDir();
export const PROFILE_DIR = join(APP_DIR, "chrome-profile");
export const HISTORY_DB = join(APP_DIR, "history.db");
export const CDP_PORT = Number(process.env.POSTER_CDP_PORT ?? 9226);

export function ensureDirs(): void {
  mkdirSync(PROFILE_DIR, { recursive: true });
}
