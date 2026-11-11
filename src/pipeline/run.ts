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
  if (cmd === "script" || cmd === "step1") {
    const run = cmd === "step1" ? await ideasStage(business) : (arg("run") ?? latestRun(business));
    const s = await scriptStage(business, run, idea);
    const dir = runDir(business, run);
    console.log(`\n${renderMd(s)}\nFiles: ${dir}`);
    if (!s.checks.ok) process.exitCode = 2;
    return;
  }
  console.log("usage: node src/pipeline/run.ts <ideas|script|step1> --brief <business> [--run ID] [--idea N]");
  process.exitCode = 1;
}

main().catch((e) => { console.error(`ERROR: ${(e as Error).message}`); process.exit(1); });
