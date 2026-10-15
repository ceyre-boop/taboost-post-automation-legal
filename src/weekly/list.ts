#!/usr/bin/env node
import { listJobs } from "./paths.ts";

const jobs = listJobs();
if (jobs.length === 0) { console.log("No weekly jobs yet. Build one: node src/weekly/build.ts"); process.exit(0); }

for (const j of jobs) {
  const mark = j.status === "awaiting_approval" ? "⏳" : j.status === "posted" ? "✅" : j.status === "skipped" ? "⏭️" : "⚠️";
  console.log(`${mark} ${j.id}  ${j.status.padEnd(17)}  ${j.productName} (${j.brand})`);
  if (j.status === "awaiting_approval") console.log(`     POST: node src/weekly/approve.ts ${j.id} --live   ·   open "${j.videoPath}"`);
}
