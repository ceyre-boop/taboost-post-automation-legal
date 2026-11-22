// node --test src/bundle.test.ts
// The client Mac app must not contain the developer's Max-plan path in any form: not the
// switch, not the Claude Code runner, not its wording. This bundles both flavors exactly
// as desktop/build.mjs does and reads what came out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { bundle } = await import("../desktop/bundle.mjs");

/** Anything that belongs to the developer path. */
export const MAX_PATH = /POSTER_DEV_MAX|dev-provider\.me|claude-code\.ts|findClaude|runClaudeCode|Claude Code|claude -p|spawn\(\s*["'`]claude|["'`]claude["'`]|\bMax plan\b|dev-?max|Developer build/gi;

function textFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...textFiles(p));
    else if (/\.(m?js|cjs|html|json)$/.test(f)) out.push(p);
  }
  return out;
}
function hits(dir: string): string[] {
  const found: string[] = [];
  for (const f of textFiles(dir)) for (const m of readFileSync(f, "utf8").matchAll(MAX_PATH)) found.push(`${f.slice(dir.length + 1)}: ${m[0]}`);
  return found;
}

const clientDir = mkdtempSync(join(tmpdir(), "pe-client-bundle-"));
const meDir = mkdtempSync(join(tmpdir(), "pe-me-bundle-"));

test("the client bundle has no developer or Max-plan path in it at all", async () => {
  const r = await bundle({ flavor: "client", outdir: clientDir });
  assert.equal(r.swapped.length, 2);
  assert.deepEqual(hits(clientDir), []);
  const main = readFileSync(join(clientDir, "main.mjs"), "utf8");
  assert.match(main, /FLAVOR\s*=\s*"client"/);
  assert.match(main, /DEFAULT_AI_MODE\s*=\s*"byo"/);
  assert.match(main, /devProvider\s*=\s*\(\)\s*=>\s*null/);
  // The TABOOST pipeline's model (Colin's own Max-plan work) isn't in the app either. Its pure
  // text helpers (numbers in facts, how alike two titles are) are, and they call no model.
  assert.doesNotMatch(main, /src\/pipeline\/llm|askClaude|"claude",\s*\[/);
  assert.match(readFileSync(join(clientDir, "dashboard.html"), "utf8"), /Make a post/); // the dashboard is still all there
});

test("the test can see the path when it is there: Colin's own bundle has it", async () => {
  await bundle({ flavor: "me", outdir: meDir });
  const found = hits(meDir);
  assert.ok(found.some((h) => /findClaude|runClaudeCode/.test(h)), found.join("\n"));
  assert.match(readFileSync(join(meDir, "main.mjs"), "utf8"), /FLAVOR\s*=\s*"me"/);
});
