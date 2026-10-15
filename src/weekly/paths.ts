import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { APP_DIR } from "../config.ts";
import { VIDEO_PUBLIC } from "./render.ts";

export const WEEKLY_DIR = join(APP_DIR, "weekly");
export const JOBS_DIR = join(WEEKLY_DIR, "jobs");
export const FEATURED_FILE = join(WEEKLY_DIR, "featured.json");
/** public/ of the Remotion project, where the product photo is staged (re-exported). */
export { VIDEO_PUBLIC };

export type JobStatus = "awaiting_approval" | "posted" | "skipped" | "error";

export interface Job {
  id: string;
  createdAt: string;
  productId: string;
  productName: string;
  brand: string;
  caption: string;
  videoPath: string;
  status: JobStatus;
  note?: string;
  postedAt?: string;
}

export function ensureWeeklyDirs(): void {
  mkdirSync(JOBS_DIR, { recursive: true });
  mkdirSync(VIDEO_PUBLIC, { recursive: true });
}

export function loadFeatured(): Set<string> {
  if (!existsSync(FEATURED_FILE)) return new Set();
  try { return new Set(JSON.parse(readFileSync(FEATURED_FILE, "utf8")) as string[]); }
  catch { return new Set(); }
}

export function addFeatured(id: string): void {
  ensureWeeklyDirs();
  const s = loadFeatured();
  s.add(id);
  writeFileSync(FEATURED_FILE, JSON.stringify([...s], null, 2));
}

const jobFile = (id: string) => join(JOBS_DIR, `${id}.json`);

export function saveJob(job: Job): void {
  ensureWeeklyDirs();
  writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2));
}

export function loadJob(id: string): Job {
  const f = jobFile(id);
  if (!existsSync(f)) throw new Error(`No staged job "${id}". Run: node src/weekly/list.ts`);
  return JSON.parse(readFileSync(f, "utf8")) as Job;
}

export function listJobs(): Job[] {
  ensureWeeklyDirs();
  return readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(JOBS_DIR, f), "utf8")) as Job)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
