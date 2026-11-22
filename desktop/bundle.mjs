// Bundle the Mac app's main process and everything it serves, for one flavor.
//
//   me      Colin's own copy: src/flavor.me.ts + src/maker/dev-provider.me.ts (Claude Code).
//   client  Everyone else's: src/flavor.client.ts + src/maker/dev-provider.client.ts (nothing),
//           and every "dev-only" block is cut out of the dashboard. The developer path is
//           never imported, so it is not in the bundle at all (src/bundle.test.ts proves it).
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
export const FLAVORS = ["me", "client"];

/** The files each flavor swaps out. The plain (Terminal) versions are never bundled. */
const SWAPS = {
  [join(ROOT, "src", "flavor.ts")]: (f) => join(ROOT, "src", `flavor.${f}.ts`),
  [join(ROOT, "src", "maker", "dev-provider.ts")]: (f) => join(ROOT, "src", "maker", `dev-provider.${f}.ts`),
};

/** Cut everything between dev-only markers (HTML comments and script comments). */
export function stripDevOnly(text) {
  return text
    .replace(/<!-- dev-only:start -->[\s\S]*?<!-- dev-only:end -->/g, "")
    .replace(/\/\* dev-only:start \*\/[\s\S]*?\/\* dev-only:end \*\//g, "");
}

export async function bundle({ flavor, outdir }) {
  if (!FLAVORS.includes(flavor)) throw new Error(`--flavor must be one of ${FLAVORS.join(", ")}`);
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  const swapped = [];
  await build({
    entryPoints: [join(HERE, "src", "main.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: join(outdir, "main.mjs"),
    // Electron is the runtime; playwright-core stays a real package (it ships its own files).
    external: ["electron", "playwright-core"],
    banner: { js: "import { createRequire as __peCreateRequire } from 'module'; const require = __peCreateRequire(import.meta.url);" },
    legalComments: "none",
    // Strips comments too (the Anthropic SDK's own docs mention its other products), and keeps names readable.
    minifyWhitespace: true,
    minifySyntax: true,
    logLevel: "warning",
    plugins: [{
      name: "flavor",
      setup(b) {
        b.onResolve({ filter: /\.ts$/ }, (args) => {
          const abs = resolve(args.resolveDir, args.path);
          const swap = SWAPS[abs];
          if (!swap) return undefined;
          if (!swapped.includes(abs)) swapped.push(abs);
          return { path: swap(flavor) };
        });
      },
    }],
  });
  if (swapped.length < 2) throw new Error(`the flavor swap didn't happen (${swapped.length} of 2 files)`);

  const dash = readFileSync(join(ROOT, "dashboard", "index.html"), "utf8");
  writeFileSync(join(outdir, "dashboard.html"), flavor === "client" ? stripDevOnly(dash) : dash);
  cpSync(join(ROOT, "dashboard", "render.html"), join(outdir, "render.html"));
  mkdirSync(join(outdir, "vendor"), { recursive: true });
  cpSync(join(ROOT, "dashboard", "vendor", "mp4-muxer.mjs"), join(outdir, "vendor", "mp4-muxer.mjs"));
  cpSync(join(ROOT, "dashboard", "vendor", "mp4-muxer.LICENSE"), join(outdir, "vendor", "mp4-muxer.LICENSE"));
  cpSync(join(ROOT, "mobile", "index.html"), join(outdir, "mobile.html"));
  if (existsSync(join(ROOT, "mobile", "logo.png"))) cpSync(join(ROOT, "mobile", "logo.png"), join(outdir, "logo.png"));
  cpSync(join(HERE, "src", "preload.cjs"), join(outdir, "preload.cjs"));
  if (flavor === "client") cpSync(join(HERE, "src", "license.html"), join(outdir, "license.html"));
  for (const f of ["trayTemplate.png", "trayTemplate@2x.png"]) cpSync(join(HERE, "build", f), join(outdir, f));
  writeFileSync(join(outdir, "build-info.json"), JSON.stringify({ flavor, builtAt: new Date().toISOString() }));
  return { outdir, swapped };
}
