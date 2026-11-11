// Stage 3: script. Input = one idea. Output = script.json: a ~2-second hook, one
// point, one number, one call to action, at the brief's length, plus one variant
// per platform. Checked deterministically; one retry with the problems fed back.
import type { Brief } from "./brief.ts";
import { wordBudget } from "./brief.ts";
import type { Fact } from "./facts.ts";
import type { Idea } from "./ideas.ts";
import { askClaude, extractJson } from "./llm.ts";
import { scriptProblems, spokenWords } from "./checks.ts";

export interface PlatformVariant { hook: string; caption: string; hashtags: string[]; }
export interface Script {
  idea: Idea;
  seconds: number;
  hook: string;     // default hook (≈2 s)
  point: string;    // the one point, spoken
  number: string;   // the one number, verbatim from source
  cta: string;      // the one call to action
  platforms: Record<string, PlatformVariant>;
  checks: { ok: boolean; problems: string[]; spokenWords: number; budget: number; attempts: number };
}

export async function writeScript(brief: Brief, idea: Idea, fact: Fact): Promise<Script> {
  const budget = wordBudget(brief);
  const system = "You write short-form video scripts. Every number you use is copied exactly from the given fact. Reply with JSON only.";
  const base = `BRIEF
Audience: ${brief.audience}
Promise: ${brief.promise}
Tone: ${brief.tone}
Never say (or imply): ${brief.banned_claims.join("; ")}
Call to action to use: ${brief.call_to_action}

IDEA: ${idea.title}
WHY IT MATTERS: ${idea.angle}
THE ONE FACT (the only numbers allowed are in here): ${fact.text}
THE ONE NUMBER: ${idea.number}

RULES
- hook: at most ${brief.script.hook_max_words} words (spoken in ~2 seconds). Stops the scroll.
- point: the one point, spoken, built around "${idea.number}". No other numbers except ones in the fact, written exactly as in the fact.
- cta: one call to action, close to "${brief.call_to_action}".
- hook + point + cta together: ${Math.round(budget * 0.7)}-${budget} words (a ${brief.script.seconds}-second video).
- One variant per platform (${brief.platforms.join(", ")}): its own hook (same word limit) and a caption written for that platform, plus 3-5 hashtags.
- Plain, true statements. No promises about income.

Reply with JSON only:
{"hook": "...", "point": "...", "number": "${idea.number}", "cta": "...",
 "platforms": {${brief.platforms.map((p) => `"${p}": {"hook": "...", "caption": "...", "hashtags": ["#..."]}`).join(", ")}}}`;

  let prompt = base;
  let script: Script | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = extractJson<Omit<Script, "idea" | "seconds" | "checks">>(await askClaude(system, prompt));
    const s: Script = { idea, seconds: brief.script.seconds, ...r, platforms: r.platforms ?? {}, checks: { ok: false, problems: [], spokenWords: 0, budget, attempts: attempt } };
    const problems = scriptProblems(s, fact, brief);
    s.checks = { ok: problems.length === 0, problems, spokenWords: spokenWords(s), budget, attempts: attempt };
    script = s;
    if (s.checks.ok) break;
    prompt = `${base}\n\nYOUR LAST DRAFT FAILED THESE CHECKS — fix every one:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nLast draft:\n${JSON.stringify(r)}`;
  }
  return script!;
}
