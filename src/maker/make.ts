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
import { cardSeconds, type MadeScript } from "./checks.ts";
import { newMade, readMade, saveMade, videoBytes, type MadePost } from "./store.ts";
import { writeScript, type Idea } from "./write.ts";

export interface JobCard { kind: "hook" | "point" | "end"; text: string; seconds: number; photo?: string; index?: number; count?: number; }
export interface RenderJob { cards: JobCard[]; color: string; mood: string; business: string; logo: string; seed: number; }

/** A stable number from the post's id, so a re-render looks the same. */
const seedOf = (id: string) => [...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Pick a different photo for each card, in an order that differs from post to post. */
export function pickPhotos(all: string[], n: number, seed: number): string[] {
  const order = [...all];
  let s = seed || 1;
  for (let i = order.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) >>> 0; const j = s % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  return Array.from({ length: n }, (_, i) => order[i % order.length]);
}

export function buildJob(p: MadePost, brief: ClientBrief, logo: string): RenderJob {
  const s = p.script as MadeScript;
  const cards: JobCard[] = [
    { kind: "hook", text: s.hook, seconds: cardSeconds(s.hook, "hook") },
    ...s.points.map((t, i) => ({ kind: "point" as const, text: t, seconds: cardSeconds(t, "point"), index: i + 1, count: s.points.length })),
    { kind: "end", text: s.cta, seconds: cardSeconds(s.cta, "end") },
  ];
  const photos = p.photos ?? [];
  cards.forEach((c, i) => { if (c.kind !== "end") c.photo = photos[i % Math.max(1, photos.length)]; });
  return { cards, color: brief.color, mood: brief.mood, business: brief.business, logo, seed: seedOf(p.id) };
}

/** Open the render page in headless Chrome and wait for the video. */
export async function renderVideo(baseUrl: string, set: string, id: string, key = ""): Promise<{ seconds: number; bytes: number }> {
  const profile = mkdtempSync(join(tmpdir(), "post-everywhere-render-"));
  const browser = await chromium.launchPersistentContext(profile, { executablePath: findChrome(), headless: true, args: ["--mute-audio", "--no-first-run"] });
  try {
    const page = await browser.newPage();
    const url = `${baseUrl}/render?set=${encodeURIComponent(set)}&id=${encodeURIComponent(id)}${key ? `&k=${encodeURIComponent(key)}` : ""}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const r = await Promise.race([
      page.evaluate(() => (window as unknown as { renderPost: () => Promise<{ seconds: number; bytes: number }> }).renderPost()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("rendering took longer than 4 minutes")), 240_000)),
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
export function startMake(set: string, idea: Idea, platforms: string[], baseUrl: string, key = "", auto = false): MadePost {
  const missing = notReady(set);
  if (missing) throw new AiError(missing, true);
  const brief = readBrief(set)!;
  const p = newMade(set, idea, platforms, auto);
  running.add(p.id);
  void (async () => {
    try {
      p.script = await writeScript(brief, idea, platforms);
      p.captions = structuredClone(p.script.platforms);
      p.photos = pickPhotos(listPhotos(set), 1 + p.script.points.length, seedOf(p.id));
      p.status = "rendering";
      saveMade(p);
      const r = await renderVideo(baseUrl, set, p.id, key);
      const fresh = readMade(set, p.id) ?? p;
      if (!videoBytes(set, p.id)) throw new Error("the video wasn't saved");
      fresh.seconds = Math.round(r.seconds * 10) / 10;
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
