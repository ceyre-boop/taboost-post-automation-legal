// Auto-make: the app makes and posts N posts a week by itself.
//
// The same rule as Inbox Autopilot's auto-send: it can't be switched on during the first
// 24 hours after a set of accounts is first connected, so the person sees what the maker
// writes (and posts a few by hand) before anything goes out unreviewed. After that it
// stays off until they switch it on, and even then it makes at most AUTO_DAILY_CAP a day,
// spaced through the week. Switching accounts or turning it off stops it at once.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makerDir } from "./brief.ts";
import type { MadePost } from "./store.ts";

export const AUTO_WAIT_MS = 24 * 60 * 60 * 1000;
export const AUTO_DAILY_CAP = 2;
export const PER_WEEK = { min: 1, max: 14 };

export interface AutoSettings {
  on: boolean;
  perWeek: number;
  platforms: string[];
  /** When it was switched on. */
  since: string;
  /** When a platform in this set was first seen connected. The 24 hours count from here. */
  firstConnectedAt: string;
  lastMadeAt: string;
}
const DEFAULTS: AutoSettings = { on: false, perWeek: 3, platforms: [], since: "", firstConnectedAt: "", lastMadeAt: "" };

let clock = (): number => Date.now();
/** Tests move the clock. */
export function setAutoClock(fn: (() => number) | null): void { clock = fn ?? (() => Date.now()); }
export const autoNow = (): number => clock();

const file = (set: string) => join(makerDir(set), "auto.json");

export function readAuto(set: string): AutoSettings {
  try {
    const s = JSON.parse(readFileSync(file(set), "utf8"));
    return {
      on: s.on === true,
      perWeek: Math.min(PER_WEEK.max, Math.max(PER_WEEK.min, Math.round(Number(s.perWeek) || DEFAULTS.perWeek))),
      platforms: Array.isArray(s.platforms) ? s.platforms.filter((p: unknown) => typeof p === "string").slice(0, 10) : [],
      since: typeof s.since === "string" ? s.since : "",
      firstConnectedAt: typeof s.firstConnectedAt === "string" ? s.firstConnectedAt : "",
      lastMadeAt: typeof s.lastMadeAt === "string" ? s.lastMadeAt : "",
    };
  } catch { return { ...DEFAULTS, platforms: [] }; }
}

function save(set: string, a: AutoSettings): AutoSettings {
  mkdirSync(makerDir(set), { recursive: true });
  writeFileSync(file(set) + ".tmp", JSON.stringify(a, null, 2));
  renameSync(file(set) + ".tmp", file(set));
  return a;
}

export const autoUnlocksAt = (a: AutoSettings): number => (a.firstConnectedAt ? Date.parse(a.firstConnectedAt) + AUTO_WAIT_MS : 0);
export const autoUnlocked = (a: AutoSettings): boolean => !!a.firstConnectedAt && autoNow() >= autoUnlocksAt(a);

/** The first time any platform in this set shows as connected, the 24 hours start. */
export function markSetConnected(set: string): void {
  const a = readAuto(set);
  if (a.firstConnectedAt) return;
  if (!existsSync(makerDir(set))) mkdirSync(makerDir(set), { recursive: true });
  save(set, { ...a, firstConnectedAt: new Date(autoNow()).toISOString(), on: false, since: "" });
}

export class AutoLocked extends Error {
  unlocksAt: number;
  constructor(unlocksAt: number) { super("auto-make is locked"); this.unlocksAt = unlocksAt; }
}

export function writeAuto(set: string, patch: { on?: unknown; perWeek?: unknown; platforms?: unknown }, allowed: string[]): AutoSettings {
  const a = readAuto(set);
  if (patch.perWeek !== undefined) a.perWeek = Math.min(PER_WEEK.max, Math.max(PER_WEEK.min, Math.round(Number(patch.perWeek) || a.perWeek)));
  if (Array.isArray(patch.platforms)) a.platforms = [...new Set(patch.platforms.map(String).filter((p) => allowed.includes(p)))];
  if (patch.on === false) { a.on = false; a.since = ""; }
  if (patch.on === true) {
    if (!autoUnlocked(a)) throw new AutoLocked(autoUnlocksAt(a));
    if (!a.platforms.length) throw new Error("Choose at least one account for auto-made posts first.");
    if (!a.on) { a.on = true; a.since = new Date(autoNow()).toISOString(); }
  }
  return save(set, a);
}

export function noteMade(set: string): void { const a = readAuto(set); save(set, { ...a, lastMadeAt: new Date(autoNow()).toISOString() }); }

/** Should the app make a new auto post for this set right now? "" means yes; otherwise why not. */
export function autoDue(a: AutoSettings, made: MadePost[]): string {
  if (!a.on) return "off";
  if (!autoUnlocked(a)) return "locked";
  if (!a.platforms.length) return "no accounts chosen";
  if (made.some((m) => m.auto && (m.status === "writing" || m.status === "rendering" || m.status === "ready" || m.status === "posting"))) return "one is already on its way";
  const day = autoNow() - 24 * 60 * 60 * 1000;
  if (made.filter((m) => m.auto && Date.parse(m.createdAt) >= day).length >= AUTO_DAILY_CAP) return "daily cap";
  const gap = (7 * 24 * 60 * 60 * 1000) / a.perWeek;
  if (a.lastMadeAt && autoNow() - Date.parse(a.lastMadeAt) < gap) return "not yet";
  return "";
}
