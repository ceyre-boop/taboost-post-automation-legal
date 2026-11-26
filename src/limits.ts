// Spending limits that survive a restart: how many live posts each platform may take a day,
// and a guard against the same video being sent to the same place twice in a short while.
// Both live in one small file in the app folder, so restarting the app resets nothing.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "./config.ts";

const file = () => join(APP_DIR, "post-limits.json");
/** Live posts one platform takes per day (per app folder). A person posting normally does a few. */
export const maxPostsPerDay = (): number => { const n = Number(process.env.POSTER_MAX_POSTS_PER_DAY); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30; };
/** Minutes during which the same video + caption is not sent to the same platform again. */
export const duplicateWindowMin = (): number => { const n = Number(process.env.POSTER_DUPLICATE_WINDOW_MIN); return Number.isFinite(n) && n >= 0 ? n : 30; };

interface State { day: string; counts: Record<string, number>; sent: { key: string; at: number }[]; }
let clock = (): number => Date.now();
/** Tests move the clock. */
export function setLimitsClock(fn: (() => number) | null): void { clock = fn ?? (() => Date.now()); }
const dayOf = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function load(): State {
  const today = dayOf(clock());
  let s: Partial<State> = {};
  try { s = JSON.parse(readFileSync(file(), "utf8")); } catch { /* none yet */ }
  const fresh = s.day === today && s.counts && typeof s.counts === "object";
  const horizon = clock() - Math.max(duplicateWindowMin(), 1) * 60_000;
  return { day: today, counts: fresh ? (s.counts as Record<string, number>) : {}, sent: Array.isArray(s.sent) ? s.sent.filter((x) => x && typeof x.key === "string" && x.at > horizon) : [] };
}
function save(s: State): void {
  try {
    mkdirSync(APP_DIR, { recursive: true });
    writeFileSync(file() + ".tmp", JSON.stringify(s), { mode: 0o600 });
    renameSync(file() + ".tmp", file());
  } catch { /* a full or read-only disk must not make posting unsafe: the in-run check still ran */ }
}

export const postsToday = (platform: string): number => load().counts[platform] ?? 0;

/** Take one of today's live posts for this platform. false = the day's limit is used up. */
export function takePost(platform: string): boolean {
  const s = load();
  if ((s.counts[platform] ?? 0) >= maxPostsPerDay()) return false;
  s.counts[platform] = (s.counts[platform] ?? 0) + 1;
  save(s);
  return true;
}

/** Would `n` more live posts to this platform fit in today's limit? */
export const roomToday = (platform: string, n = 1): boolean => postsToday(platform) + n <= maxPostsPerDay();

const dupKey = (platform: string, sha: string, caption: string) => `${platform}|${sha}|${caption.length}:${caption.slice(0, 200)}`;
/** Was this exact video and caption already sent to this platform within the window? */
export function recentlySent(platform: string, sha: string, caption: string): boolean {
  if (!sha || duplicateWindowMin() === 0) return false;
  const k = dupKey(platform, sha, caption);
  return load().sent.some((x) => x.key === k);
}
export function markSent(platform: string, sha: string, caption: string): void {
  if (!sha || duplicateWindowMin() === 0) return;
  const s = load();
  s.sent.push({ key: dupKey(platform, sha, caption), at: clock() });
  save(s);
}
export const limitsFileExists = (): boolean => existsSync(file());
