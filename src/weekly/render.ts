import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { SpotProps } from "./draft.ts";

// Single source of truth for the Remotion project location. staticFile() resolves
// from VIDEO_DIR/public, so images MUST be staged into exactly this dir.
export const VIDEO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "video");
export const VIDEO_PUBLIC = join(VIDEO_DIR, "public");

/** Download the official product photo into the Remotion public/ dir.
 *  Returns the staticFile name to put in props, or "" if it could not be fetched. */
export async function stageImage(imageUrl: string, jobId: string): Promise<string> {
  if (!imageUrl) return "";
  try {
    mkdirSync(VIDEO_PUBLIC, { recursive: true });
    // Remove prior staged photos so public/ doesn't grow unbounded.
    for (const f of readdirSync(VIDEO_PUBLIC)) {
      if (f.startsWith("product-")) rmSync(join(VIDEO_PUBLIC, f), { force: true });
    }
    const res = await fetch(imageUrl, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    const ext = ct.includes("png") ? "png" : ct.includes("jpeg") || ct.includes("jpg") ? "jpg" : "webp";
    const name = `product-${jobId}.${ext}`;
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(join(VIDEO_PUBLIC, name), buf);
    return name;
  } catch (e) {
    console.warn(`[render] photo fetch failed (${(e as Error).message}); rendering without it`);
    return "";
  }
}

/** Render the ProductSpot composition with the given props to outPath (abs .mp4). */
export function renderSpot(props: SpotProps, outPath: string): void {
  const propsFile = join(mkdtempSync(join(tmpdir(), "taboost-spot-")), "props.json");
  writeFileSync(propsFile, JSON.stringify(props));
  const r = spawnSync(
    "bunx",
    ["remotion", "render", "src/index.ts", "ProductSpot", outPath, `--props=${propsFile}`],
    { cwd: VIDEO_DIR, stdio: "inherit", env: process.env },
  );
  if (r.status !== 0) throw new Error(`remotion render exited ${r.status ?? r.signal}`);
}
