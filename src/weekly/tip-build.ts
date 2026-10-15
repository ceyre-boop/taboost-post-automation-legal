#!/usr/bin/env node
// Teaching-video builder: pick a creator lesson -> draft -> render -> stage.
// Mirrors build.ts, but renders the CreatorTip template from a distilled lesson
// instead of ProductSpot from a product. Nothing is posted here;
// `node src/weekly/approve.ts <id> --live` publishes it, same as product videos.
import { join } from "node:path";
import { getLesson, pickLesson, draftLessonCaption, type Lesson } from "./lessons.ts";
import { renderTip, type TipProps } from "./render.ts";
import { ensureWeeklyDirs, loadFeatured, saveJob, listJobs, JOBS_DIR, type Job } from "./paths.ts";
import { voice } from "./notify.ts";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function jobId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `tip-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main(): Promise<void> {
  ensureWeeklyDirs();
  const id = jobId();

  const forced = arg("lesson");

  // Don't stack work: if a video is already staged and un-approved, stop here
  // (unless --lesson forces a specific one).
  const pending = listJobs().filter((j) => j.status === "awaiting_approval");
  if (!forced && pending.length > 0) {
    console.log(`[tip] ${pending.length} video(s) already awaiting your approval — not building another:`);
    for (const j of pending) console.log(`  ⏳ ${j.id}  ${j.productName}`);
    console.log(`Resolve first: node src/weekly/approve.ts <id> --live   (or --skip)`);
    return;
  }

  const exclude = loadFeatured();
  for (const j of pending) exclude.add(j.productId);

  let lesson: Lesson | undefined;
  if (forced) {
    lesson = getLesson(forced);
    if (!lesson) throw new Error(`No lesson with id "${forced}". See src/weekly/lessons.ts`);
  } else {
    lesson = pickLesson(exclude);
  }
  if (!lesson) throw new Error("No eligible lesson (all featured). Add one to src/weekly/lessons.ts.");

  console.log(`[tip] ${id}: "${lesson.hook}" — ${lesson.source}`);

  const voiceFile = arg("voice") ?? ""; // drop an ElevenLabs mp3 into video/public/ and pass its name
  const props: TipProps = {
    source: lesson.source,
    hook: lesson.hook,
    tips: lesson.tips,
    cta: lesson.cta,
    ctaSub: lesson.ctaSub,
    voiceFile,
  };
  const caption = arg("caption") ?? draftLessonCaption(lesson);

  const videoPath = join(JOBS_DIR, `${id}.mp4`);
  console.log(`[tip] rendering -> ${videoPath}`);
  renderTip(props, videoPath);

  const job: Job = {
    id,
    createdAt: new Date().toISOString(),
    kind: "tip",
    productId: lesson.id,
    productName: lesson.hook,
    brand: lesson.source,
    caption,
    videoPath,
    status: "awaiting_approval",
  };
  saveJob(job);

  console.log(`\n[tip] STAGED, awaiting your approval.`);
  console.log(`  video:   ${videoPath}`);
  console.log(`  caption: ${caption.replace(/\n/g, "\n           ")}`);
  console.log(`\n  review:  open "${videoPath}"`);
  console.log(`  POST:    node src/weekly/approve.ts ${id} --live`);
  console.log(`  skip:    node src/weekly/approve.ts ${id} --skip`);

  await voice(`A new TABOOST creator-tips video is ready to review. Approve it to post.`);
}

main().catch((e) => { console.error(`ERROR: ${(e as Error).message}`); process.exit(1); });
