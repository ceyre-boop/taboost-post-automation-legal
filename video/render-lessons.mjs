// Render one LiveLesson video per entry in lessons.json.
// Usage: node render-lessons.mjs [startIndex] [count]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const lessons = JSON.parse(readFileSync(new URL("./lessons.json", import.meta.url)));
const OUT = new URL("./out/", import.meta.url).pathname;
const TMP = new URL("./.props/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });

const start = Number(process.argv[2] ?? 0);
const count = Number(process.argv[3] ?? lessons.length);
const bin = new URL("./node_modules/.bin/remotion", import.meta.url).pathname;

for (let i = start; i < Math.min(start + count, lessons.length); i++) {
  const n = String(i + 1).padStart(2, "0");
  const propsFile = join(TMP, `lesson-${n}.json`);
  const outFile = join(OUT, `live-lesson-${n}.mp4`);
  writeFileSync(propsFile, JSON.stringify(lessons[i]));
  console.log(`\n=== Rendering ${n}: ${lessons[i].tag} ===`);
  execFileSync(bin, ["render", "LiveLesson", outFile, `--props=${propsFile}`, "--log=error"], {
    cwd: new URL("./", import.meta.url).pathname,
    stdio: "inherit",
  });
  console.log(`✓ ${outFile}`);
}
console.log("\nAll done.");
