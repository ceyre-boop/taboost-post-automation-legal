// Deterministic checks shared by the script stage (self-check + one retry) and
// the quality gate (stage 5). No model involved: these are the hard rules.
import { normNum, numbersIn, type Fact } from "./facts.ts";
import type { Brief } from "./brief.ts";
import { wordBudget } from "./brief.ts";
import type { Script } from "./script.ts";

export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Every number anywhere in the script must appear in the source fact, exactly. */
export function numberProblems(texts: string[], fact: Fact): string[] {
  const allowed = new Set(fact.numbers.map(normNum));
  const out: string[] = [];
  for (const t of texts) for (const n of numbersIn(t)) {
    if (!allowed.has(normNum(n))) out.push(`"${n}" is not in the source (${fact.location}). Source numbers: ${fact.numbers.join(", ") || "none"}`);
  }
  return [...new Set(out)];
}

export function bannedProblems(texts: string[], brief: Brief): string[] {
  const all = texts.join(" \n ").toLowerCase();
  return brief.banned_claims.filter((c) => all.includes(c.toLowerCase())).map((c) => `banned claim "${c}" appears`);
}

/** Every piece of text a viewer will see or hear. */
export function scriptTexts(s: Script): string[] {
  return [s.hook, s.point, s.number, s.cta,
    ...Object.values(s.platforms).flatMap((v) => [v.hook, v.caption, ...(v.hashtags ?? [])])];
}

export function spokenWords(s: Script, platformHook?: string): number {
  return wordCount([platformHook ?? s.hook, s.point, s.cta].join(" "));
}

export function lengthProblems(s: Script, brief: Brief): string[] {
  const out: string[] = [];
  const budget = wordBudget(brief);
  const hooks = [s.hook, ...Object.values(s.platforms).map((v) => v.hook)];
  for (const h of hooks) if (wordCount(h) > brief.script.hook_max_words) out.push(`hook "${h}" is ${wordCount(h)} words (max ${brief.script.hook_max_words}, ~2 seconds)`);
  for (const [p, v] of Object.entries(s.platforms)) {
    const n = spokenWords(s, v.hook);
    if (n > budget) out.push(`${p}: ${n} spoken words, budget ${budget} for ${brief.script.seconds}s`);
    if (n < Math.round(budget * 0.5)) out.push(`${p}: only ${n} spoken words, too short for ${brief.script.seconds}s`);
  }
  for (const p of brief.platforms) if (!s.platforms[p]) out.push(`missing variant for ${p}`);
  return out;
}

export function scriptProblems(s: Script, fact: Fact, brief: Brief): string[] {
  const texts = scriptTexts(s);
  const out = [...numberProblems(texts, fact), ...bannedProblems(texts, brief), ...lengthProblems(s, brief)];
  if (!numbersIn(s.number).length) out.push(`"number" field has no number: "${s.number}"`);
  return out;
}
