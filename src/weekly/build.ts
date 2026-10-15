#!/usr/bin/env node
// Weekly video builder: pick a product -> draft -> render -> stage for approval.
// Nothing is posted here. `node src/weekly/approve.ts <id>` publishes it.
import { join } from "node:path";
import { loadProducts, pickProduct, type Product } from "./catalog.ts";
import { draftSpot, draftCaption } from "./draft.ts";
import { stageImage, renderSpot } from "./render.ts";
import { ensureWeeklyDirs, loadFeatured, saveJob, listJobs, JOBS_DIR, type Job } from "./paths.ts";
import { voice } from "./notify.ts";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function jobId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main(): Promise<void> {
  ensureWeeklyDirs();
  const id = jobId();

  const forced = arg("product");

  // Don't stack work: if a video is already staged and un-approved, stop here
  // (unless --product forces a specific one). Also never re-pick a product that
  // already has an open job.
  const pending = listJobs().filter((j) => j.status === "awaiting_approval");
  if (!forced && pending.length > 0) {
    console.log(`[build] ${pending.length} video(s) already awaiting your approval — not building another:`);
    for (const j of pending) console.log(`  ⏳ ${j.id}  ${j.productName} (${j.brand})`);
    console.log(`Resolve first: node src/weekly/approve.ts <id> --live   (or --skip)`);
    return;
  }

  const exclude = loadFeatured();
  for (const j of pending) exclude.add(j.productId);

  let product: Product | undefined;
  if (forced) {
    product = loadProducts().find((p) => p.id === forced);
    if (!product) throw new Error(`No product with id ${forced} in the catalog`);
  } else {
    product = pickProduct(exclude);
  }
  if (!product) throw new Error("No eligible product (all featured, or none with a photo + sales).");

  console.log(`[build] ${id}: ${product.name} (${product.brand}) — ${product.itemsSold.toLocaleString("en-US")} sold`);

  const spot = draftSpot(product);
  const caption = arg("caption") ?? draftCaption(product);
  const hook = arg("hook");
  if (hook) spot.hook = hook;

  spot.imageFile = await stageImage(product.imageUrl, id);
  if (!spot.imageFile) console.warn("[build] no product photo — spot will show the placeholder");

  const videoPath = join(JOBS_DIR, `${id}.mp4`);
  console.log(`[build] rendering -> ${videoPath}`);
  renderSpot(spot, videoPath);

  const job: Job = {
    id, createdAt: new Date().toISOString(),
    productId: product.id, productName: product.name, brand: product.brand,
    caption, videoPath, status: "awaiting_approval",
  };
  saveJob(job);

  console.log(`\n[build] STAGED, awaiting your approval.`);
  console.log(`  video:   ${videoPath}`);
  console.log(`  caption: ${caption.replace(/\n/g, "\n           ")}`);
  console.log(`\n  review:  open "${videoPath}"`);
  console.log(`  edit:    node src/weekly/approve.ts ${id} --caption "your text"   (optional)`);
  console.log(`  POST:    node src/weekly/approve.ts ${id} --live`);
  console.log(`  skip:    node src/weekly/approve.ts ${id} --skip`);

  await voice(`This week's TABOOST video is ready to review: ${product.name}. Approve it to post.`);
}

main().catch((e) => { console.error(`ERROR: ${(e as Error).message}`); process.exit(1); });
