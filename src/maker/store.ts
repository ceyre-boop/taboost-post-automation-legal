// Made posts, kept per set of accounts in <set>/maker/made/<id>/:
//   post.json   the idea, the script, the captions (as edited), status
//   video.mp4   the rendered video
//   thumb.jpg   a still for the queue
// Plus ideas.json: the last ideas suggested, so a refresh doesn't lose them.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makerDir } from "./brief.ts";
import type { MadeScript, PlatformCaption } from "./checks.ts";
import type { Idea } from "./write.ts";

export type MadeStatus = "writing" | "rendering" | "ready" | "posting" | "posted" | "failed" | "discarded";

/** The back of one card: a photo, or a clip starting `from` seconds in. */
export interface Media { type: "photo" | "clip"; name: string; from?: number; }

export interface MadePost {
  id: string;
  set: string;
  createdAt: string;
  status: MadeStatus;
  idea: Idea;
  platforms: string[];
  script?: MadeScript;
  /** Captions as the person last edited them (starts as the script's). */
  captions?: Record<string, PlatformCaption>;
  seconds?: number;
  /** Photos used, in card order (older posts; newer ones also have `media`). */
  photos?: string[];
  /** What fills each card, in order: photos and stretches of clips. */
  media?: Media[];
  problem?: string;
  batchId?: string;
  postedAt?: string;
  /** Made by the auto-make schedule rather than by hand. */
  auto?: boolean;
}

const ID_RE = /^m-[a-f0-9]{10}$/;
export const isMadeId = (id: string): boolean => ID_RE.test(id);
export const madeDir = (set: string, id: string) => join(makerDir(set), "made", id);
export const videoPath = (set: string, id: string) => join(madeDir(set, id), "video.mp4");
export const thumbPath = (set: string, id: string) => join(madeDir(set, id), "thumb.jpg");

export function newMade(set: string, idea: Idea, platforms: string[], auto = false): MadePost {
  const p: MadePost = { id: `m-${randomBytes(5).toString("hex")}`, set, createdAt: new Date().toISOString(), status: "writing", idea, platforms, auto };
  saveMade(p);
  return p;
}

export function saveMade(p: MadePost): void {
  const dir = madeDir(p.set, p.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "post.json.tmp"), JSON.stringify(p, null, 2));
  renameSync(join(dir, "post.json.tmp"), join(dir, "post.json"));
}

export function readMade(set: string, id: string): MadePost | null {
  if (!isMadeId(id)) return null;
  try { return JSON.parse(readFileSync(join(madeDir(set, id), "post.json"), "utf8")) as MadePost; } catch { return null; }
}

export function listMade(set: string): MadePost[] {
  const dir = join(makerDir(set), "made");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(isMadeId).map((id) => readMade(set, id)).filter((p): p is MadePost => !!p)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Discarding deletes the video and its still; the record stays, so the idea isn't suggested again. */
export function discardMade(set: string, id: string): MadePost | null {
  const p = readMade(set, id);
  if (!p) return null;
  p.status = "discarded";
  rmSync(videoPath(set, id), { force: true });
  rmSync(thumbPath(set, id), { force: true });
  saveMade(p);
  return p;
}

/** Titles that should not be suggested again: posted, or thrown away. */
export function usedTitles(set: string): string[] {
  return listMade(set).filter((p) => p.status === "posted" || p.status === "discarded").map((p) => p.idea.title);
}

export const videoBytes = (set: string, id: string): number => { try { return statSync(videoPath(set, id)).size; } catch { return 0; } };

const ideasFile = (set: string) => join(makerDir(set), "ideas.json");
export function saveIdeas(set: string, ideas: Idea[]): void {
  mkdirSync(makerDir(set), { recursive: true });
  writeFileSync(ideasFile(set), JSON.stringify({ at: new Date().toISOString(), ideas }, null, 2));
}
export function readIdeas(set: string): Idea[] {
  try { return (JSON.parse(readFileSync(ideasFile(set), "utf8")).ideas ?? []) as Idea[]; } catch { return []; }
}
