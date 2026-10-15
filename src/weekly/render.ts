import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { VIDEO_PUBLIC } from "./paths.ts";
import type { SpotProps } from "./draft.ts";

const VIDEO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "video");

/** Download the official product photo into the Remotion public/ dir.
 *  Returns the staticFile name to put in props, or "" if it could not be fetched. */
export async function stageImage(imageUrl: string, jobId: string): Promise<string> {
  if (!imageUrl) return "";
  try {
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
