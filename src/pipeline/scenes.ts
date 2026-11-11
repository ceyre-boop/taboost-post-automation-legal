// Stage 4a (Claude): turn a script into scene data — the spoken line for each
// scene, the short on-screen card text, and which visual to show.
// Stage 4b (adapter): scene data + voice timing → props for the existing
// CreatorTip template, rendered by the existing render() in src/weekly/render.ts.
import type { Brief } from "./brief.ts";
import type { Fact } from "./facts.ts";
import type { Script } from "./script.ts";
import { askClaude, extractJson } from "./llm.ts";
import { numberProblems, bannedProblems, wordCount } from "./checks.ts";

export type Visual = "none" | "product_photo";
export interface Scene { role: "hook" | "point" | "cta"; line: string; card_title: string; card_body: string; visual: Visual; }
export interface Scenes { scenes: Scene[]; checks: { ok: boolean; problems: string[] } }

export async function makeScenes(brief: Brief, script: Script, fact: Fact, hasPhoto: boolean): Promise<Scenes> {
  const system = "You storyboard short vertical videos. Reply with JSON only.";
  const prompt = `SCRIPT
hook: ${script.hook}
point: ${script.point}
number: ${script.number}
cta: ${script.cta}

SOURCE FACT (the only numbers allowed): ${fact.text}

Split this into scenes for a vertical video. Scene 1 is the hook, the last scene is the call to action, and the point is split across 1-3 middle scenes.
- "line": the exact words spoken in that scene. All lines joined must say the script (hook, then point, then cta) — you may only re-split it, not add claims.
- "card_title": 1-4 words shown big on the card (for the number scene, the number itself, exactly as written).
- "card_body": at most 10 words shown under the title.
- "visual": ${hasPhoto ? '"product_photo" on the ONE middle (point) scene where the product is named, otherwise "none". Never on the hook or cta' : '"none" for every scene (no photo available)'}.

Reply: {"scenes":[{"role":"hook|point|cta","line":"...","card_title":"...","card_body":"...","visual":"none|product_photo"}]}`;
  const { scenes } = extractJson<{ scenes: Scene[] }>(await askClaude(system, prompt));
  const texts = scenes.flatMap((s) => [s.line, s.card_title, s.card_body]);
  const problems = [...numberProblems(texts, fact), ...bannedProblems(texts, brief)];
  if (scenes[0]?.role !== "hook") problems.push("first scene is not the hook");
  if (scenes.at(-1)?.role !== "cta") problems.push("last scene is not the call to action");
  for (const s of scenes) if (wordCount(s.card_body) > 12) problems.push(`card body too long: "${s.card_body}"`);
  if (!hasPhoto && scenes.some((s) => s.visual === "product_photo")) problems.push("asked for a photo that doesn't exist");
  return { scenes, checks: { ok: problems.length === 0, problems } };
}

export interface Caption { from: number; to: number; text: string; }

/** Break each spoken line into ~4-word caption chunks timed by length. */
export function captionsFor(lines: string[], timing: { start: number; dur: number }[], fps: number): Caption[] {
  const out: Caption[] = [];
  lines.forEach((line, i) => {
    const words = line.split(/\s+/).filter(Boolean);
    const chunks: string[] = [];
    for (let k = 0; k < words.length; k += 4) chunks.push(words.slice(k, k + 4).join(" "));
    const total = chunks.reduce((a, c) => a + c.length, 0) || 1;
    let t = timing[i].start;
    for (const c of chunks) {
      const d = (c.length / total) * timing[i].dur;
      out.push({ from: Math.round(t * fps), to: Math.round((t + d) * fps), text: c });
      t += d;
    }
  });
  return out;
}

/** Adapter: scenes + voice timing → CreatorTip props. Each scene lasts as long as its line. */
export function toCreatorTipProps(
  scenes: Scene[], timing: { start: number; dur: number }[], fps: number,
  o: { source: string; kicker: string; ctaSub: string; voiceFile: string; photo: string },
) {
  const frames = scenes.map((_, i) => {
    const end = i + 1 < timing.length ? timing[i + 1].start : timing[i].start + timing[i].dur + 0.8;
    return Math.max(30, Math.round((end - timing[i].start) * fps));
  });
  const mid = scenes.slice(1, -1);
  // The hook and CTA cards can't hold a photo; if Claude put it there (or nowhere), use the first point scene.
  let photoAt = mid.findIndex((s) => s.visual === "product_photo");
  if (photoAt < 0 && o.photo) photoAt = 0;
  return {
    source: o.source,
    hook: scenes[0].line,
    kicker: o.kicker,
    tips: mid.map((s, i) => ({ title: s.card_title, body: s.card_body, ...(i === photoAt && o.photo ? { image: o.photo } : {}) })),
    cta: scenes.at(-1)!.card_title || scenes.at(-1)!.line,
    ctaSub: o.ctaSub,
    voiceFile: o.voiceFile,
    frames: { hook: frames[0], tips: frames.slice(1, -1), cta: frames.at(-1)! },
    captions: captionsFor(scenes.map((s) => s.line), timing, fps),
  };
}
