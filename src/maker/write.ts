// The two thinking steps of the post maker.
//
//   ideas   (cheap model)   six short post ideas, each built on one of the person's facts,
//                            none too close to what was already posted
//   script  (better model)  for one idea: the on-screen hook, points and call to action,
//                            plus a caption and hashtags for each platform
//
// Everything the model writes goes through checks.ts. A script that fails goes back once
// with the problems listed; if it fails again, nothing is made.
import { jaccard, TOO_CLOSE } from "../pipeline/similar.ts";
import { AiError, parseJson, think } from "./ai.ts";
import type { ClientBrief } from "./brief.ts";
import { LIMITS, scriptProblems, type MadeScript } from "./checks.ts";
import type { Clip } from "./clips.ts";
import { FORMATS, isFormat, PHOTO_FORMATS, type Format } from "./formats.ts";

/** One post to make. `fact` is the index of the fact it's built on (-1 for a clip post).
 *  A clip post also names the clip and carries what the person said it shows. */
export interface Idea { title: string; angle: string; fact: number; format?: Format; clip?: string; }

/** A clip post's idea, straight from what the person said the clip shows. */
export function clipIdea(c: Clip): Idea {
  const words = c.note.split(/\s+/).filter(Boolean);
  const title = words.length ? words.slice(0, 9).join(" ") + (words.length > 9 ? "…" : "") : c.file;
  return { title: `Your clip: ${title}`, angle: c.note, fact: -1, format: "clip", clip: c.name };
}

const LABELS: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram Reels", youtube: "YouTube Shorts", x: "X", facebook: "Facebook", linkedin: "LinkedIn", threads: "Threads" };

const briefText = (b: ClientBrief) => `BUSINESS: ${b.business}
WHAT THEY DO: ${b.whatYouDo}
CUSTOMERS: ${b.audience}
CALL TO ACTION: ${b.cta}
NEVER SAY: ${b.avoid.length ? b.avoid.join("; ") : "(nothing listed)"}
FACTS (numbered; these are the only things a post may claim):
${b.facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;

const hasNumber = (t: string) => /\d/.test(t);
/** The video draws "MYTH", "THE FIX", "STEP 2"… itself, so a line that starts with one loses it. */
export const stripLabel = (t: string): string => t.replace(/^(myth|fact|the problem|problem|the fix|fix|step \d+|tip \d+|answer)\s*[:.\-–—]\s*/i, "").trim();

export async function suggestIdeas(brief: ClientBrief, posted: string[], want = 6): Promise<Idea[]> {
  const system = "You plan short vertical videos for a small business's social media accounts. Each video is a few lines of big text over the business's own photos. Reply with JSON only.";
  const user = `${briefText(brief)}

ALREADY POSTED (do not repeat these):
${posted.length ? posted.slice(-30).map((t) => `- ${t}`).join("\n") : "(nothing yet)"}

KINDS OF POST (each has its own look):
${PHOTO_FORMATS.map((f) => `- ${f}: ${FORMATS[f].idea}`).join("\n")}

Suggest ${want + 2} different post ideas. Each one:
- is built on exactly one fact above (give its number)
- is one of the kinds above; use as many different kinds as you can, and "number" only for a fact with a number in it
- spread the ideas across the facts: no more than two on the same fact
- would make a customer stop scrolling
- claims nothing the fact doesn't say

Reply with JSON only: {"ideas": [{"title": "<5 to 9 words>", "angle": "<one sentence: what the video says>", "fact": <number>, "format": "<kind>"}]}`;
  const j = parseJson<{ ideas?: { title?: string; angle?: string; fact?: number; format?: string }[] }>(await think("ideas", system, user));
  const out: Idea[] = [];
  for (const raw of j.ideas ?? []) {
    const title = String(raw.title ?? "").trim().slice(0, 90);
    const angle = String(raw.angle ?? "").trim().slice(0, 240);
    const fact = Number(raw.fact) - 1;
    if (!title || !angle || !Number.isInteger(fact) || fact < 0 || fact >= brief.facts.length) continue;
    if ([...posted, ...out.map((o) => o.title)].some((p) => jaccard(title, p) >= TOO_CLOSE)) continue;
    let format: Format = isFormat(raw.format) && raw.format !== "clip" ? raw.format : "tips";
    if (format === "number" && !hasNumber(brief.facts[fact])) format = "tips";
    out.push({ title, angle, fact, format });
    if (out.length >= want) break;
  }
  if (!out.length) throw new AiError("No fresh ideas came back. Add a few more facts about your business and try again.");
  return out;
}

export async function writeScript(brief: ClientBrief, idea: Idea, platforms: string[], clip?: Clip): Promise<MadeScript> {
  const format: Format = idea.format && isFormat(idea.format) ? idea.format : "tips";
  const spec = FORMATS[format];
  const isClip = format === "clip" && !!clip;
  const system = isClip
    ? "You finish short vertical videos for a small business from their own clip: a title and a few captions shown over it, and a caption for each social platform. Every number and claim comes from the business's facts or what they said the clip shows. Reply with JSON only."
    : "You write short vertical videos for a small business: a few lines of big on-screen text over their photos, and a caption for each social platform. Every number and claim comes from the business's facts. Reply with JSON only.";
  const what = isClip
    ? `THE CLIP: ${clip!.note || "(they didn't say)"}
IT IS ${Math.round(clip!.end - clip!.start)} SECONDS LONG, ${clip!.width > clip!.height ? "wide (landscape)" : "upright"}, ${clip!.audio ? "with its own sound" : "with no sound (music is added)"}.`
    : `THE IDEA: ${idea.title}
WHAT IT SAYS: ${idea.angle}
BUILT ON FACT ${idea.fact + 1}: ${brief.facts[idea.fact]}`;
  const base = `${briefText(brief)}

${what}

KIND OF POST: ${spec.label}. ${spec.write}

ON-SCREEN TEXT (${isClip ? "shown over the clip" : "shown one card at a time over the photos"})
- hook: at most ${spec.hookWords} words. Stops the scroll in 2 seconds.
- points: ${spec.points.min === spec.points.max ? `exactly ${spec.points.min}` : `${spec.points.min} to ${spec.points.max}`} short lines, at most ${spec.pointWords} words each.
- cta: at most ${LIMITS.ctaWords} words, close to "${brief.cta}".${format === "number" ? "\n- stat: just the number, exactly as the fact writes it." : ""}

CAPTIONS: one per platform (${platforms.map((p) => `${p} = ${LABELS[p] ?? p}`).join(", ")}), written for how people use that platform, plus ${LIMITS.hashtags.min} to ${LIMITS.hashtags.max} hashtags (no spaces). x: under 200 characters before the hashtags. threads: under 350. youtube: the first line is the video title (under 90 characters), then a short description.

RULES
- Only numbers that appear in the facts, written exactly the same way. No prices, dates or promises the facts don't give.
- Plain, warm, true. No hype words. Never mention AI. No placeholders.
- Don't start a line with a label like "Myth:", "Fact:", "Problem:", "Fix:" or "Step 1:". The video adds those.

Reply with JSON only:
{"hook": "...", "points": ["..."], "cta": "...",${format === "number" ? ' "stat": "...",' : ""} "platforms": {${platforms.map((p) => `"${p}": {"caption": "...", "hashtags": ["#..."]}`).join(", ")}}}`;

  let prompt = base;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = parseJson<MadeScript>(await think("script", system, prompt));
    const s: MadeScript = {
      format,
      ...(format === "number" ? { stat: String(r.stat ?? "").trim() } : {}),
      hook: String(r.hook ?? "").trim(),
      points: (Array.isArray(r.points) ? r.points : []).map((p) => stripLabel(String(p).trim())).filter(Boolean),
      cta: String(r.cta ?? "").trim(),
      platforms: Object.fromEntries(platforms.map((p) => {
        const c = (r.platforms ?? {})[p] ?? { caption: "", hashtags: [] };
        return [p, { caption: String(c.caption ?? "").trim(), hashtags: (Array.isArray(c.hashtags) ? c.hashtags : []).map((h) => String(h).trim().replace(/^#?/, "#")).filter((h) => h.length > 1) }];
      })),
    };
    problems = scriptProblems(s, brief, platforms, isClip ? clip!.note : "");
    if (!problems.length) return s;
    prompt = `${base}\n\nYOUR LAST DRAFT FAILED THESE CHECKS. Fix every one:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nLast draft:\n${JSON.stringify(s)}`;
  }
  throw new AiError(`The app couldn't write a post that passed its checks, so nothing was made. Try another idea, or add facts. (${problems[0]})`);
}
