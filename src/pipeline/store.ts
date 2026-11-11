// Where each business's pipeline keeps its files. Every stage reads and writes
// plain JSON in a run folder, so any stage can be re-run or inspected by hand.
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { APP_DIR } from "../config.ts";

export const PIPE_DIR = join(APP_DIR, "pipeline");
export const bizDir = (b: string) => join(PIPE_DIR, b);
export const runsDir = (b: string) => join(bizDir(b), "runs");
export const runDir = (b: string, run: string) => join(runsDir(b), run);
/** Everything ever published for this business: what the idea bank must not repeat. */
export const postedFile = (b: string) => join(bizDir(b), "posted.json");

export function newRunId(): string {
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function writeJson(file: string, data: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
export function readJson<T>(file: string, fallback?: T): T {
  if (!existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing ${file}`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function latestRun(b: string): string {
  const d = runsDir(b);
  const runs = existsSync(d) ? readdirSync(d).filter((f) => /^\d{8}-\d{6}$/.test(f)).sort() : [];
  if (!runs.length) throw new Error(`No runs yet for ${b}. Run: node src/pipeline/run.ts ideas --brief ${b}`);
  return runs[runs.length - 1];
}

export interface PostedItem { factId: string; title: string; hook: string; postedAt: string; platform?: string; url?: string; }
export function loadPosted(b: string): PostedItem[] { return readJson<PostedItem[]>(postedFile(b), []); }
