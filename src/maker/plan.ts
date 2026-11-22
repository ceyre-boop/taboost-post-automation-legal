// Plan my week: the app decides what to post this week, makes it, and waits for the person.
//
// A plan is 3 to 5 posts on set days and times over the next 7 days, in as many different
// formats as it can, with the person's own unused clips first. Each one is made in turn
// and lands in "Made for you". Nothing in a plan posts until the person approves it; an
// approved post goes out at its time while the app is open. One that missed its time by
// more than MISSED_AFTER_MS waits for the person again instead of going out late.
//
// With "every week" on, a new plan is made when the last one's days are over.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makerDir } from "./brief.ts";
import type { MadePost } from "./store.ts";
import type { Idea } from "./write.ts";

export const PLAN_PER_WEEK = { min: 3, max: 5, default: 4 };
export const MISSED_AFTER_MS = 6 * 60 * 60 * 1000;
/** Days (from tomorrow) and hours each size of plan uses: spread out, alternating midday and evening. */
const DAYS: Record<number, number[]> = { 3: [0, 2, 4], 4: [0, 2, 4, 6], 5: [0, 1, 3, 4, 6] };
const HOURS = [12, 18];

export interface PlanSlot {
  /** When it posts, if approved. */
  at: string;
  idea: Idea;
  madeId: string;
  approved: boolean;
  /** Why it couldn't be made (it's skipped until the person replaces it). */
  problem?: string;
}
export interface WeekPlan {
  /** Plan a new week by itself when this one is over. */
  every: boolean;
  perWeek: number;
  platforms: string[];
  slots: PlanSlot[];
  plannedAt: string;
}
const EMPTY: WeekPlan = { every: false, perWeek: PLAN_PER_WEEK.default, platforms: [], slots: [], plannedAt: "" };

let clock = (): number => Date.now();
/** Tests move the clock. */
export function setPlanClock(fn: (() => number) | null): void { clock = fn ?? (() => Date.now()); }
export const planNow = (): number => clock();

const file = (set: string) => join(makerDir(set), "plan.json");

export function readPlan(set: string): WeekPlan {
  try {
    const p = JSON.parse(readFileSync(file(set), "utf8"));
    return {
      every: p.every === true,
      perWeek: Math.min(PLAN_PER_WEEK.max, Math.max(PLAN_PER_WEEK.min, Math.round(Number(p.perWeek) || PLAN_PER_WEEK.default))),
      platforms: Array.isArray(p.platforms) ? p.platforms.filter((x: unknown) => typeof x === "string").slice(0, 10) : [],
      slots: Array.isArray(p.slots) ? p.slots.filter((s: PlanSlot) => s && typeof s.at === "string" && s.idea && typeof s.idea.title === "string")
        .map((s: PlanSlot) => ({ at: s.at, idea: s.idea, madeId: typeof s.madeId === "string" ? s.madeId : "", approved: s.approved === true, ...(typeof s.problem === "string" && s.problem ? { problem: s.problem } : {}) })) : [],
      plannedAt: typeof p.plannedAt === "string" ? p.plannedAt : "",
    };
  } catch { return structuredClone(EMPTY); }
}

export function savePlan(set: string, p: WeekPlan): WeekPlan {
  mkdirSync(makerDir(set), { recursive: true });
  writeFileSync(file(set) + ".tmp", JSON.stringify(p, null, 2));
  renameSync(file(set) + ".tmp", file(set));
  return p;
}

/** The posting times for a plan of `n` posts, starting tomorrow, in this Mac's time zone. */
export function slotTimes(n: number, now = planNow()): string[] {
  const days = DAYS[n] ?? DAYS[PLAN_PER_WEEK.default];
  const d = new Date(now);
  return days.map((off, i) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1 + off, HOURS[i % HOURS.length], 0, 0).toISOString());
}

/** A new plan from ideas already chosen (clips first, then varied formats). */
export function newPlan(set: string, ideas: Idea[], settings: { perWeek: number; platforms: string[]; every: boolean }): WeekPlan {
  const times = slotTimes(settings.perWeek);
  const slots = ideas.slice(0, times.length).map((idea, i) => ({ at: times[i], idea, madeId: "", approved: false }));
  return savePlan(set, { ...settings, slots, plannedAt: new Date(planNow()).toISOString() });
}

/** Is the plan finished with (every day in it has passed)? An empty plan is. */
export const planOver = (p: WeekPlan, now = planNow()): boolean => !p.slots.length || p.slots.every((s) => Date.parse(s.at) + MISSED_AFTER_MS < now);

export type SlotState = "waiting" | "making" | "ready" | "approved" | "posting" | "posted" | "failed" | "tossed" | "missed";

/** Where one slot stands, from its made post. */
export function slotState(s: PlanSlot, made: MadePost | null, now = planNow()): SlotState {
  if (s.problem) return "failed";
  if (!s.madeId) return "waiting";
  if (!made) return "tossed";
  if (made.status === "discarded") return "tossed";
  if (made.status === "writing" || made.status === "rendering") return "making";
  if (made.status === "posting") return "posting";
  if (made.status === "posted") return "posted";
  if (made.status === "failed") return "failed";
  if (s.approved) return now > Date.parse(s.at) + MISSED_AFTER_MS ? "missed" : "approved";
  return "ready";
}

/** Should the approved slot go out right now? */
export const slotDue = (s: PlanSlot, made: MadePost | null, now = planNow()): boolean =>
  s.approved && !!made && made.status === "ready" && now >= Date.parse(s.at) && now <= Date.parse(s.at) + MISSED_AFTER_MS;
