#!/usr/bin/env node
// Approve (and post) a staged weekly video. Publishing requires --live;
// without it this does a safe dry run (fills the upload, never clicks Post).
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJob, saveJob, addFeatured } from "./paths.ts";
import { voice } from "./notify.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (f: string) => process.argv.includes(`--${f}`);

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id || id.startsWith("--")) throw new Error("usage: approve <jobId> [--caption \"...\"] [--live] [--skip]");
  const job = loadJob(id);

  const newCaption = arg("caption");
  if (newCaption !== undefined) { job.caption = newCaption; saveJob(job); console.log("[approve] caption updated."); }

  if (has("skip")) {
    job.status = "skipped";
    saveJob(job);
    addFeatured(job.productId); // don't resurface it next week
    console.log(`[approve] ${id} skipped. ${job.productName} won't be picked again.`);
    return;
  }

  const live = has("live");
  console.log(`[approve] ${live ? "PUBLISHING" : "dry run"} — ${job.productName}`);
  const r = spawnSync(
    "node",
    [CLI, "post", "--platform", "tiktok", "--video", job.videoPath, "--caption", job.caption, ...(live ? ["--live"] : [])],
    { stdio: "inherit", env: process.env },
  );
  if (r.status !== 0) {
    job.status = "error";
    job.note = `poster exited ${r.status ?? r.signal}`;
    saveJob(job);
    throw new Error(`post failed (exit ${r.status ?? r.signal}). Job left as error; re-run when fixed.`);
  }

  if (live) {
    job.status = "posted";
    job.postedAt = new Date().toISOString();
    saveJob(job);
    addFeatured(job.productId);
    console.log(`[approve] POSTED. ${job.productName} recorded; next week picks a new product.`);
    await voice(`Posted this week's TABOOST video: ${job.productName}.`);
  } else {
    console.log(`[approve] dry run OK. When it looks right:  node src/weekly/approve.ts ${id} --live`);
  }
}

main().catch((e) => { console.error(`ERROR: ${(e as Error).message}`); process.exit(1); });
