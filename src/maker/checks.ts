// The hard rules a made post must pass before anyone sees it. No model involved.
//
//   - every number anywhere in the post appears in the person's own facts (or their
//     business name or call to action), exactly
//   - none of their "never say" words, and no claims the brief doesn't back up
//   - the on-screen text fits on screen and reads in time
//   - a caption for every chosen platform, inside that platform's limit
import { normNum, numbersIn } from "../pipeline/facts.ts";
import type { ClientBrief } from "./brief.ts";

export interface Card { text: string; }
export interface PlatformCaption { caption: string; hashtags: string[]; }
export interface MadeScript {
  hook: string;
  points: string[];
  cta: string;
  platforms: Record<string, PlatformCaption>;
}

/** What each platform takes, including the hashtags the app adds after the caption. */
export const CAPTION_LIMITS: Record<string, number> = {
  tiktok: 2200, instagram: 2200, youtube: 5000, x: 280, facebook: 2200, linkedin: 3000, threads: 500,
};
export const LIMITS = { hookWords: 6, pointWords: 14, ctaWords: 8, points: { min: 1, max: 3 }, hashtags: { min: 1, max: 5 }, youtubeTitle: 100 };

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** The caption exactly as it will be posted. */
export function fullCaption(c: PlatformCaption): string {
  const tags = (c.hashtags ?? []).map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
  return [c.caption.trim(), tags].filter(Boolean).join("\n\n");
}

/** Claims nobody should make unless their own facts say so. */
const UNBACKED = [/\bguarantee[ds]?\b/i, /#1\b|\bnumber one\b/i, /\bbest in (town|the|[a-z]+)\b/i, /\bcheapest\b/i, /\blowest price/i, /\bfree\b(?!\s+to\b)/i, /\baward[- ]winning\b/i, /\blicensed\b/i, /\binsured\b/i, /\bcertified\b/i];

export function scriptTexts(s: MadeScript): string[] {
  return [s.hook, ...s.points, s.cta, ...Object.values(s.platforms ?? {}).flatMap((p) => [p.caption, ...(p.hashtags ?? [])])];
}

export function scriptProblems(s: MadeScript, brief: ClientBrief, platforms: string[]): string[] {
  const out: string[] = [];
  const texts = scriptTexts(s).filter((t) => typeof t === "string");
  const sources = [...brief.facts, brief.business, brief.cta].join("\n");

  const allowed = new Set(numbersIn(sources).map(normNum));
  for (const t of texts) for (const n of numbersIn(t)) {
    if (!allowed.has(normNum(n))) out.push(`"${n}" is not in the business's facts. Only use numbers that appear in the facts, written the same way.`);
  }
  const all = texts.join("\n").toLowerCase();
  for (const a of brief.avoid) if (a && all.includes(a.toLowerCase())) out.push(`It uses "${a}", which the business said never to use.`);
  for (const re of UNBACKED) {
    const hit = texts.join("\n").match(re);
    if (hit && !re.test(sources)) out.push(`It claims "${hit[0]}", but the facts don't say that.`);
  }
  if (/\[[^\]]{1,40}\]|\{\{[^}]+\}\}|\bas an ai\b|\bai[- ]generated\b/i.test(texts.join("\n"))) out.push("It has a blank like [Name] or mentions AI. Write only finished words.");

  if (!s.hook?.trim()) out.push("The hook is empty.");
  else if (words(s.hook) > LIMITS.hookWords) out.push(`The hook is ${words(s.hook)} words; at most ${LIMITS.hookWords}, so it reads in 2 seconds.`);
  const pts = Array.isArray(s.points) ? s.points.filter((p) => typeof p === "string" && p.trim()) : [];
  if (pts.length < LIMITS.points.min || pts.length > LIMITS.points.max) out.push(`Give ${LIMITS.points.min} to ${LIMITS.points.max} points; there are ${pts.length}.`);
  for (const p of pts) if (words(p) > LIMITS.pointWords) out.push(`The point "${p}" is ${words(p)} words; at most ${LIMITS.pointWords} so it fits on screen.`);
  if (!s.cta?.trim()) out.push("The call to action is empty.");
  else if (words(s.cta) > LIMITS.ctaWords) out.push(`The call to action is ${words(s.cta)} words; at most ${LIMITS.ctaWords}.`);

  for (const id of platforms) {
    const c = s.platforms?.[id];
    if (!c || !c.caption?.trim()) { out.push(`There's no caption for ${id}.`); continue; }
    const tags = c.hashtags ?? [];
    if (tags.length < LIMITS.hashtags.min || tags.length > LIMITS.hashtags.max) out.push(`${id}: give ${LIMITS.hashtags.min} to ${LIMITS.hashtags.max} hashtags.`);
    for (const h of tags) if (!/^#?[\p{L}\p{N}_]{2,40}$/u.test(h)) out.push(`${id}: "${h}" isn't a usable hashtag (letters, numbers and _ only).`);
    const full = fullCaption(c);
    const limit = CAPTION_LIMITS[id] ?? 2200;
    if (full.length > limit) out.push(`${id}: the caption with hashtags is ${full.length} characters; ${id} allows ${limit}.`);
    if (id === "youtube" && c.caption.split("\n")[0].trim().length > LIMITS.youtubeTitle) out.push(`youtube: the first line is the video title and must be ${LIMITS.youtubeTitle} characters or fewer.`);
  }
  return [...new Set(out)];
}

/** How long each card stays on screen, in seconds: long enough to read, short enough to keep moving. */
export function cardSeconds(text: string, kind: "hook" | "point" | "end"): number {
  if (kind === "hook") return 2.8;
  if (kind === "end") return 3.2;
  return Math.min(5.5, Math.max(3, 1.4 + words(text) / 3));
}

export function videoSeconds(s: MadeScript): number {
  return cardSeconds(s.hook, "hook") + s.points.reduce((n, p) => n + cardSeconds(p, "point"), 0) + cardSeconds(s.cta, "end");
}
