#!/usr/bin/env node
// Content pipeline CLI. Each stage reads/writes JSON in one run folder:
//   <APP_DIR>/pipeline/<business>/runs/<runId>/{facts,ideas,script}.json + script.md
//
//   node src/pipeline/run.ts ideas  --brief taboost            # stage 2 (new run)
//   node src/pipeline/run.ts script --brief taboost [--run ID] [--idea N]   # stage 3
//   node src/pipeline/run.ts step1  --brief taboost            # stages 2 + 3
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { loadBrief } from "./brief.ts";
import { extractFacts, type Fact } from "./facts.ts";
import { makeIdeas, type IdeasFile } from "./ideas.ts";
import { writeScript, type Script } from "./script.ts";
import { latestRun, newRunId, readJson, runDir, writeJson } from "./store.ts";
import { makeScenes } from "./scenes.ts";
import { toCreatorTipProps } from "./scenes.ts";
import { speakLines, VOICE } from "./voice.ts";
import { render, stageImage, VIDEO_PUBLIC } from "../weekly/render.ts";
import { loadProducts } from "../weekly/catalog.ts";
import { copyFileSync, mkdirSync } from "node:fs";

const FPS = 30; // video/src/brand.ts

/** Stage 4: scene data (Claude) → voice → adapter → existing CreatorTip render. */
async function renderStage(business: string, run: string): Promise<string> {
  const brief = loadBrief(business);
  const dir = runDir(business, run);
  const script = readJson<Script>(join(dir, "script.json"));
  if (!script.checks.ok) throw new Error("script.json failed its checks; fix or re-run the script stage first");
  const fact = readJson<Fact[]>(join(dir, "facts.json")).find((f) => f.id === script.idea.factId)!;

  // Visual: the official product photo when the fact is a product row.
  let photo = "";
  const pid = fact.id.startsWith("tap-products.csv#") ? fact.id.split("#")[1] : "";
  if (pid) {
    const prod = loadProducts().find((p) => p.id === pid);
    if (prod?.imageUrl) photo = await stageImage(prod.imageUrl, run);
  }

  console.log(`[render] storyboarding scenes${photo ? " (with product photo)" : ""}…`);
  const sc = await makeScenes(brief, script, fact, !!photo);
  writeJson(join(dir, "scenes.json"), sc);
  if (!sc.checks.ok) throw new Error(`scene data failed checks:\n- ${sc.checks.problems.join("\n- ")}`);

  console.log(`[render] voice (${VOICE}) for ${sc.scenes.length} scenes…`);
  const wav = join(dir, "voice.wav");
  const timing = speakLines(sc.scenes.map((s) => s.line), wav);
  mkdirSync(VIDEO_PUBLIC, { recursive: true });
  const voiceFile = `voice-${run}.wav`;
  copyFileSync(wav, join(VIDEO_PUBLIC, voiceFile));

  const props = toCreatorTipProps(sc.scenes, timing, FPS, {
    source: brief.business.toUpperCase(), ctaSub: brief.call_to_action, voiceFile, photo,
    kicker: pid ? "TikTok Shop sales data" : fact.subject,
  });
  writeJson(join(dir, "render-props.json"), props);
  const out = join(dir, "video.mp4");
  console.log(`[render] rendering ${(timing.at(-1)!.start + timing.at(-1)!.dur).toFixed(1)}s of voice → ${out}`);
  render("CreatorTip", props, out);
  return out;
}

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };

async function ideasStage(business: string): Promise<string> {
  const brief = loadBrief(business);
  const run = newRunId();
  const dir = runDir(business, run);
  const facts = extractFacts(brief);
  writeJson(join(dir, "facts.json"), facts);
  console.log(`[ideas] ${facts.length} facts from ${brief.sources.length} source(s); asking Claude…`);
  const ideas = await makeIdeas(brief, facts);
  writeJson(join(dir, "ideas.json"), ideas);
  console.log(`[ideas] run ${run}: ${ideas.kept.length} kept, ${ideas.dropped.length} dropped`);
  ideas.kept.forEach((i, n) => console.log(`  ${n}. ${i.title}  [${i.number} · ${i.source.location}]`));
  for (const d of ideas.dropped) console.log(`  ✖ ${d.title} — ${d.reason}`);
  return run;
}

async function scriptStage(business: string, run: string, ideaIdx: number): Promise<Script> {
  const brief = loadBrief(business);
  const dir = runDir(business, run);
  const ideas = readJson<IdeasFile>(join(dir, "ideas.json"));
  const idea = ideas.kept[ideaIdx];
  if (!idea) throw new Error(`No idea #${ideaIdx} in run ${run} (${ideas.kept.length} kept)`);
  const fact = readJson<Fact[]>(join(dir, "facts.json")).find((f) => f.id === idea.factId)!;
  console.log(`[script] writing from idea ${ideaIdx}: ${idea.title}`);
  const s = await writeScript(brief, idea, fact);
  writeJson(join(dir, "script.json"), s);
  writeFileSync(join(dir, "script.md"), renderMd(s));
  return s;
}

export function renderMd(s: Script): string {
  const L = [
    `# ${s.idea.title}`,
    ``,
    `**Source:** ${s.idea.source.location}`,
    `> ${s.idea.source.text}`,
    ``,
    `| | |`, `|---|---|`,
    `| Hook (~2s) | ${s.hook} |`,
    `| Point | ${s.point} |`,
    `| Number | ${s.number} |`,
    `| Call to action | ${s.cta} |`,
    ``,
    `Length: ${s.checks.spokenWords} spoken words, budget ${s.checks.budget} for ${s.seconds}s.`,
    `Checks: ${s.checks.ok ? "all pass" : "FAILED"} (attempt ${s.checks.attempts})`,
    ...s.checks.problems.map((p) => `- ✖ ${p}`),
    ``,
  ];
  for (const [p, v] of Object.entries(s.platforms)) {
    L.push(`## ${p}`, ``, `**Hook:** ${v.hook}`, ``, v.caption, ``, (v.hashtags ?? []).join(" "), ``);
  }
  return L.join("\n");
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const business = arg("brief") ?? "taboost";
  const idea = Number(arg("idea") ?? 0);
  if (cmd === "ideas") { await ideasStage(business); return; }
  if (cmd === "render") { console.log(await renderStage(business, arg("run") ?? latestRun(business))); return; }
  if (cmd === "script" || cmd === "step1") {
    const run = cmd === "step1" ? await ideasStage(business) : (arg("run") ?? latestRun(business));
    const s = await scriptStage(business, run, idea);
    const dir = runDir(business, run);
    console.log(`\n${renderMd(s)}\nFiles: ${dir}`);
    if (!s.checks.ok) process.exitCode = 2;
    return;
  }
  console.log("usage: node src/pipeline/run.ts <ideas|script|step1|render> --brief <business> [--run ID] [--idea N]");
  process.exitCode = 1;
}

main().catch((e) => { console.error(`ERROR: ${(e as Error).message}`); process.exit(1); });
