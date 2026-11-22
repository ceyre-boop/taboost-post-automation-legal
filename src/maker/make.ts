// Making one post: write the script, plan the cards, render the video. Runs in the
// background; the dashboard polls the made post's status.
//
// Rendering happens in a headless copy of the person's own Chrome (the same Chrome the
// app already needs), started with a throwaway profile, so it never touches their
// sign-ins and never shows a window. The render page is served by this app.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { findChrome } from "../chrome.ts";
import { AiError } from "./ai.ts";
import { listPhotos, logoName, notReady, readBrief, type ClientBrief } from "./brief.ts";
import { cardSeconds, hookSeconds, type MadeScript } from "./checks.ts";
import { listClips, readClip, type Clip } from "./clips.ts";
import type { Format } from "./formats.ts";
import { newMade, readMade, saveMade, videoBytes, type MadePost, type Media } from "./store.ts";
import { writeScript, type Idea } from "./write.ts";

/** What fills the back of a card: one of the person's photos, or a stretch of one of their clips (muted). */
export type { Media };
export interface JobCard {
  kind: "hook" | "point" | "end" | "stat" | "clip";
  text: string; seconds: number;
  /** Old jobs name a photo here; new ones use `media`. */
  photo?: string; media?: Media;
  index?: number; count?: number;
  /** "One number": the number. "clip": the captions and when each shows, in seconds from the card's start. */
  stat?: string; lines?: { text: string; from: number; to: number }[];
}
export interface ClipJob { name: string; start: number; end: number; width: number; height: number; audio: boolean; bytes: number; }
export interface RenderJob { format: Format; cards: JobCard[]; color: string; mood: string; business: string; logo: string; seed: number; clip?: ClipJob; }

/** A stable number from the post's id, so a re-render looks the same. */
const seedOf = (id: string) => [...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Pick a different photo for each card, in an order that differs from post to post. */
export function pickPhotos(all: string[], n: number, seed: number): string[] {
  const order = [...all];
  let s = seed || 1;
  for (let i = order.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) >>> 0; const j = s % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  return Array.from({ length: n }, (_, i) => order[i % order.length]);
}

/** Backgrounds for a photo-format post: the person's photos, with stretches of their clips mixed in. */
export function pickMedia(photos: string[], clips: Clip[], n: number, seed: number, seconds = 5): Media[] {
  const pool: Media[] = photos.map((name) => ({ type: "photo", name }));
  for (const c of clips) {
    const span = Math.max(0, c.end - c.start - seconds);
    for (const k of [0.15, 0.6]) pool.push({ type: "clip", name: c.name, from: Math.round((c.start + span * k) * 100) / 100 });
  }
  if (!pool.length) return [];
  const names = pickPhotos(pool.map((_, i) => String(i)), Math.min(n, pool.length), seed).map(Number);
  return Array.from({ length: n }, (_, i) => pool[names[i % names.length]]);
}

export function buildJob(p: MadePost, brief: ClientBrief, logo: string, clip?: Clip | null): RenderJob {
  const s = p.script as MadeScript;
  const format: Format = s.format ?? "tips";
  const base = { format, color: brief.color, mood: brief.mood, business: brief.business, logo, seed: seedOf(p.id) };
  const end: JobCard = { kind: "end", text: s.cta, seconds: cardSeconds(s.cta, "end") };

  if (format === "clip" && clip) {
    // The whole clip is one card: the title stays up, the captions take turns below it.
    const len = Math.max(1, clip.end - clip.start);
    const lead = Math.min(2.5, len / 4), each = (len - lead) / Math.max(1, s.points.length);
    const lines = s.points.map((t, i) => ({ text: t, from: Math.round((lead + i * each) * 100) / 100, to: Math.round((lead + (i + 1) * each) * 100) / 100 }));
    return { ...base, clip: { name: clip.name, start: clip.start, end: clip.end, width: clip.width, height: clip.height, audio: clip.audio, bytes: clip.bytes },
      cards: [{ kind: "clip", text: s.hook, seconds: len, media: { type: "clip", name: clip.name, from: clip.start }, lines }, end] };
  }

  const head: JobCard = format === "number"
    ? { kind: "stat", text: s.hook, stat: s.stat ?? "", seconds: hookSeconds(s) }
    : { kind: "hook", text: s.hook, seconds: hookSeconds(s) };
  const cards: JobCard[] = [head, ...s.points.map((t, i) => ({ kind: "point" as const, text: t, seconds: cardSeconds(t, "point"), index: i + 1, count: s.points.length })), end];
  const media: Media[] = p.media ?? (p.photos ?? []).map((name) => ({ type: "photo" as const, name }));
  cards.forEach((c, i) => {
    if (c.kind === "end" || !media.length) return;
    c.media = media[i % media.length];
    if (c.media.type === "photo") c.photo = c.media.name;
  });
  return { ...base, cards };
}

/** Open the render page in headless Chrome and wait for the video. */
export async function renderVideo(baseUrl: string, set: string, id: string, key = ""): Promise<{ seconds: number; bytes: number; ownSound?: boolean }> {
  const profile = mkdtempSync(join(tmpdir(), "post-everywhere-render-"));
  const browser = await chromium.launchPersistentContext(profile, { executablePath: findChrome(), headless: true, args: ["--mute-audio", "--no-first-run"] });
  try {
    const page = await browser.newPage();
    const url = `${baseUrl}/render?set=${encodeURIComponent(set)}&id=${encodeURIComponent(id)}${key ? `&rk=${encodeURIComponent(key)}` : ""}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const r = await Promise.race([
      page.evaluate(() => (window as unknown as { renderPost: () => Promise<{ seconds: number; bytes: number; ownSound?: boolean }> }).renderPost()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("rendering took longer than 8 minutes")), 480_000)),
    ]);
    return r;
  } finally {
    await browser.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}

const running = new Set<string>();
export const isMaking = () => running.size > 0;

/** Start making a post from one idea. Returns at once; the work continues in the background. */
/** `keyFor` makes the one-time key the render page must show for this post. */
export function startMake(set: string, idea: Idea, platforms: string[], baseUrl: string, keyFor: (id: string) => string = () => "", auto = false): MadePost {
  const clip = idea.format === "clip" ? (idea.clip ? readClip(set, idea.clip) : null) : null;
  if (idea.format === "clip") {
    if (!clip) throw new AiError("That clip isn't there any more. Add it again.", true);
    if (!readBrief(set)) throw new AiError("Fill in your business details first.", true);
    if (clip.note.trim().length < 3) throw new AiError("Say in a few words what the clip shows first. The title and captions are written from it.", true);
  } else {
    const missing = notReady(set, listClips(set).length);
    if (missing) throw new AiError(missing, true);
  }
  const brief = readBrief(set)!;
  const p = newMade(set, idea, platforms, auto);
  const key = keyFor(p.id);
  running.add(p.id);
  void (async () => {
    try {
      p.script = await writeScript(brief, idea, platforms, clip ?? undefined);
      p.captions = structuredClone(p.script.platforms);
      if (clip) p.media = [{ type: "clip", name: clip.name, from: clip.start }];
      else {
        p.media = pickMedia(listPhotos(set), listClips(set), 1 + p.script.points.length, seedOf(p.id));
        p.photos = p.media.filter((m) => m.type === "photo").map((m) => m.name);
      }
      p.status = "rendering";
      saveMade(p);
      const r = await renderVideo(baseUrl, set, p.id, key);
      const fresh = readMade(set, p.id) ?? p;
      if (!videoBytes(set, p.id)) throw new Error("the video wasn't saved");
      fresh.seconds = Math.round(r.seconds * 10) / 10;
      if (clip?.audio && !r.ownSound) fresh.problem = "The clip's own sound couldn't be added, so this has music only. Watch it before posting.";
      fresh.status = "ready";
      saveMade(fresh);
    } catch (e) {
      const fresh = readMade(set, p.id) ?? p;
      fresh.status = "failed";
      fresh.problem = e instanceof AiError ? e.plain : /Chrome not found/i.test(String(e)) ? "Google Chrome isn't installed. Install it from google.com/chrome and try again." : "The video couldn't be made. Try again; if it keeps failing, try another idea.";
      saveMade(fresh);
      console.error(`[maker] ${p.id} failed:`, String((e as Error).message ?? e).split("\n")[0]);
    } finally {
      running.delete(p.id);
    }
  })();
  return p;
}

export { logoName };
