// Bundle the Electron main process + the whole posting engine into one ESM file,
// then copy the static assets the app loads at runtime. Keeping playwright-core and
// node:* external means Node resolves them from the packaged node_modules / runtime.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/main.mjs",
  // electron is provided by the runtime; playwright-core stays a real dependency
  // (it's imported the same way the working CLI imports it).
  external: ["electron", "playwright-core"],
  // Some bundled deps use require(); give ESM output a working require shim.
  banner: {
    js: "import { createRequire as __taboostCreateRequire } from 'module'; const require = __taboostCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

cpSync("src/preload.cjs", "dist/preload.cjs");
cpSync("src/license.html", "dist/license.html");
cpSync("../dashboard/index.html", "dist/dashboard.html");

console.log("✓ built desktop/dist");
