// Stage 2: idea bank. Input = brief + source facts + posted history (+ feedback
// examples once stage 7 exists). Output = ideas.json, each idea tied to ONE fact.
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Brief } from "./brief.ts";
import { normNum, type Fact } from "./facts.ts";
import { askClaude, extractJson } from "./llm.ts";
import { tooClose } from "./similar.ts";
import { bizDir, loadPosted, readJson } from "./store.ts";
import { loadFeatured } from "../weekly/paths.ts";

export interface Idea {
  factId: string;
  title: string;      // one line: what the video is
  angle: string;      // why this audience cares
  number: string;     // the one number it's built on, verbatim from the fact
  source: { location: string; text: string };
}
export interface IdeasFile { brief: string; createdAt: string; kept: Idea[]; dropped: (Partial<Idea> & { reason: string })[]; }

/** Best/worst performers written by stage 7; empty until that stage runs. */
export function feedbackExamples(business: string): { best: string[]; worst: string[] } {
  const f = join(bizDir(business), "feedback.json");
  return existsSync(f) ? readJson(f) : { best: [], worst: [] };
}

/** Anything already posted counts — including the older weekly ProductSpot pipeline. */
export function priorItems(business: string): { factId: string; title: string }[] {
  const posted = loadPosted(business).map((p) => ({ factId: p.factId, title: p.title }));
  const weekly = business === "taboost"
    ? [...loadFeatured()].map((id) => ({ factId: `tap-products.csv#${id}`, title: `weekly product spot ${id}` }))
    : [];
  return [...posted, ...weekly];
}

export async function makeIdeas(brief: Brief, facts: Fact[], want = 8): Promise<IdeasFile> {
  const prior = priorItems(brief.business);
  const priorIds = new Set(prior.map((p) => p.factId));
  const usable = facts.filter((f) => f.numbers.length && !priorIds.has(f.id)).slice(0, 90);
  const fb = feedbackExamples(brief.business);

  const system = "You plan short-form vertical videos. You only use facts you are given, you cite them by id, and you reply with JSON only.";
  const prompt = `BRIEF
Audience: ${brief.audience}
Promise: ${brief.promise}
Tone: ${brief.tone}
Never say: ${brief.banned_claims.join("; ")}

FACTS (id ⇒ fact). These are the ONLY allowed facts.
${usable.map((f) => `${f.id} ⇒ ${f.text}`).join("\n")}

ALREADY POSTED (do not repeat these topics):
${prior.map((p) => `- ${p.title}`).join("\n") || "- nothing yet"}
${fb.best.length ? `\nPERFORMED BEST (more like these):\n${fb.best.map((b) => `- ${b}`).join("\n")}` : ""}
${fb.worst.length ? `\nPERFORMED WORST (avoid these patterns):\n${fb.worst.map((b) => `- ${b}`).join("\n")}` : ""}

TASK
Propose ${want} different video ideas for this audience. Each idea is built on exactly ONE fact above and ONE number copied character-for-character from that fact's text. Vary the topics: don't do two ideas about the same product or the same lesson.

Reply with a JSON array only:
[{"fact_id": "...", "title": "one line, what the video is", "angle": "why this audience cares, one sentence", "number": "the number exactly as written in the fact"}]`;

  const raw = extractJson<{ fact_id: string; title: string; angle: string; number: string }[]>(await askClaude(system, prompt));
  const byId = new Map(facts.map((f) => [f.id, f]));
  const kept: Idea[] = [];
  const dropped: IdeasFile["dropped"] = [];
  for (const r of raw) {
    const fact = byId.get(r.fact_id);
    const base = { factId: r.fact_id, title: r.title, angle: r.angle, number: r.number };
    if (!fact) { dropped.push({ ...base, reason: "cites a fact id that doesn't exist" }); continue; }
    if (!fact.numbers.map(normNum).includes(normNum(r.number ?? ""))) { dropped.push({ ...base, reason: `number "${r.number}" is not in the fact` }); continue; }
    const close = tooClose(base, [...prior, ...kept]);
    if (close) { dropped.push({ ...base, reason: `too close: ${close}` }); continue; }
    kept.push({ ...base, source: { location: fact.location, text: fact.text } });
  }
  return { brief: brief.business, createdAt: new Date().toISOString(), kept, dropped };
}
