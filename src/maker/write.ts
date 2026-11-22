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

export interface Idea { title: string; angle: string; fact: number; }

const LABELS: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram Reels", youtube: "YouTube Shorts", x: "X", facebook: "Facebook", linkedin: "LinkedIn", threads: "Threads" };

const briefText = (b: ClientBrief) => `BUSINESS: ${b.business}
WHAT THEY DO: ${b.whatYouDo}
CUSTOMERS: ${b.audience}
CALL TO ACTION: ${b.cta}
NEVER SAY: ${b.avoid.length ? b.avoid.join("; ") : "(nothing listed)"}
FACTS (numbered; these are the only things a post may claim):
${b.facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;

export async function suggestIdeas(brief: ClientBrief, posted: string[], want = 6): Promise<Idea[]> {
  const system = "You plan short vertical videos for a small business's social media accounts. Each video is a few lines of big text over the business's own photos. Reply with JSON only.";
  const user = `${briefText(brief)}

ALREADY POSTED (do not repeat these):
${posted.length ? posted.slice(-30).map((t) => `- ${t}`).join("\n") : "(nothing yet)"}

Suggest ${want + 2} different post ideas. Each one:
- is built on exactly one fact above (give its number)
- would make a customer stop scrolling: a tip, a common mistake, a before-and-after, a question people ask, a quick story
- claims nothing the fact doesn't say

Reply with JSON only: {"ideas": [{"title": "<5 to 9 words>", "angle": "<one sentence: what the video says>", "fact": <number>}]}`;
  const j = parseJson<{ ideas?: { title?: string; angle?: string; fact?: number }[] }>(await think("ideas", system, user));
  const out: Idea[] = [];
  for (const raw of j.ideas ?? []) {
    const title = String(raw.title ?? "").trim().slice(0, 90);
    const angle = String(raw.angle ?? "").trim().slice(0, 240);
    const fact = Number(raw.fact) - 1;
    if (!title || !angle || !Number.isInteger(fact) || fact < 0 || fact >= brief.facts.length) continue;
    if ([...posted, ...out.map((o) => o.title)].some((p) => jaccard(title, p) >= TOO_CLOSE)) continue;
    out.push({ title, angle, fact });
    if (out.length >= want) break;
  }
  if (!out.length) throw new AiError("No fresh ideas came back. Add a few more facts about your business and try again.");
  return out;
}

export async function writeScript(brief: ClientBrief, idea: Idea, platforms: string[]): Promise<MadeScript> {
  const system = "You write short vertical videos for a small business: a few lines of big on-screen text over their photos, and a caption for each social platform. Every number and claim comes from the business's facts. Reply with JSON only.";
  const base = `${briefText(brief)}

THE IDEA: ${idea.title}
WHAT IT SAYS: ${idea.angle}
BUILT ON FACT ${idea.fact + 1}: ${brief.facts[idea.fact]}

ON-SCREEN TEXT (shown one card at a time over the photos)
- hook: at most ${LIMITS.hookWords} words. Stops the scroll in 2 seconds.
- points: ${LIMITS.points.min} to ${LIMITS.points.max} short lines, at most ${LIMITS.pointWords} words each.
- cta: at most ${LIMITS.ctaWords} words, close to "${brief.cta}".

CAPTIONS: one per platform (${platforms.map((p) => `${p} = ${LABELS[p] ?? p}`).join(", ")}), written for how people use that platform, plus ${LIMITS.hashtags.min} to ${LIMITS.hashtags.max} hashtags (no spaces). x: under 200 characters before the hashtags. threads: under 350. youtube: the first line is the video title (under 90 characters), then a short description.

RULES
- Only numbers that appear in the facts, written exactly the same way. No prices, dates or promises the facts don't give.
- Plain, warm, true. No hype words. Never mention AI. No placeholders.

Reply with JSON only:
{"hook": "...", "points": ["..."], "cta": "...", "platforms": {${platforms.map((p) => `"${p}": {"caption": "...", "hashtags": ["#..."]}`).join(", ")}}}`;

  let prompt = base;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = parseJson<MadeScript>(await think("script", system, prompt));
    const s: MadeScript = {
      hook: String(r.hook ?? "").trim(),
      points: (Array.isArray(r.points) ? r.points : []).map((p) => String(p).trim()).filter(Boolean),
      cta: String(r.cta ?? "").trim(),
      platforms: Object.fromEntries(platforms.map((p) => {
        const c = (r.platforms ?? {})[p] ?? { caption: "", hashtags: [] };
        return [p, { caption: String(c.caption ?? "").trim(), hashtags: (Array.isArray(c.hashtags) ? c.hashtags : []).map((h) => String(h).trim().replace(/^#?/, "#")).filter((h) => h.length > 1) }];
      })),
    };
    problems = scriptProblems(s, brief, platforms);
    if (!problems.length) return s;
    prompt = `${base}\n\nYOUR LAST DRAFT FAILED THESE CHECKS. Fix every one:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nLast draft:\n${JSON.stringify(s)}`;
  }
  throw new AiError(`The app couldn't write a post that passed its checks, so nothing was made. Try another idea, or add facts. (${problems[0]})`);
}
