// node build.mjs --flavor=me|client
// Bundles the app (bundle.mjs), packages it with electron-builder into a .app and a .dmg
// (release/<flavor>/), with a Chrome for Testing copy inside for Macs that have no Chrome.
// Signing (afterPack.cjs → sign.cjs): Developer ID + notarizing for the client build when
// that identity is in the Keychain, ad-hoc otherwise.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "./bundle.mjs";
import { developerId, notarize } from "./sign.cjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const flavor = (process.argv.find((a) => a.startsWith("--flavor=")) ?? "").split("=")[1];
if (!["me", "client"].includes(flavor)) { console.error("usage: node build.mjs --flavor=me|client"); process.exit(1); }
const NAME = flavor === "me" ? "Post Everywhere (Colin)" : "Post Everywhere";
const SLUG = flavor === "me" ? "Post-Everywhere-Colin" : "Post-Everywhere";

/** The Chrome for Testing build that matches this playwright-core, from Playwright's cache. */
function chromeForTesting() {
  const browsers = JSON.parse(readFileSync(join(HERE, "node_modules", "playwright-core", "browsers.json"), "utf8")).browsers;
  const rev = browsers.find((b) => b.name === "chromium").revision;
  const app = join(homedir(), "Library", "Caches", "ms-playwright", `chromium-${rev}`, "chrome-mac-arm64", "Google Chrome for Testing.app");
  if (!existsSync(app)) {
    console.log(`Getting Chrome for Testing (Playwright chromium ${rev})…`);
    execFileSync(join(HERE, "node_modules", ".bin", "playwright-core"), ["install", "chromium"], { stdio: "inherit" });
  }
  if (!existsSync(app)) throw new Error(`Chrome for Testing not found at ${app}`);
  return app;
}

console.log(`▶ ${NAME}: bundling (${flavor})`);
await bundle({ flavor, outdir: join(HERE, "dist") });

const config = {
  appId: flavor === "me" ? "com.northbound.posteverywhere.me" : "com.northbound.posteverywhere",
  productName: NAME,
  directories: { output: `release/${flavor}`, buildResources: "build" },
  files: ["dist/**/*", "package.json"],
  asarUnpack: ["**/node_modules/playwright-core/**"],
  extraMetadata: { main: "dist/main.mjs", productName: NAME },
  afterPack: "./afterPack.cjs",
  mac: {
    target: [{ target: "dmg", arch: ["arm64"] }],
    category: "public.app-category.social-networking",
    identity: null, // signed in afterPack (sign.cjs), the same way for both kinds of signature
    icon: "build/icon.png",
    artifactName: `${SLUG}-mac-\${arch}.\${ext}`,
  },
  dmg: { title: NAME, contents: [{ x: 140, y: 180 }, { x: 400, y: 180, type: "link", path: "/Applications" }] },
};
const cfgFile = join(HERE, `electron-builder.${flavor}.json`);
writeFileSync(cfgFile, JSON.stringify(config, null, 2));

const env = { ...process.env, POSTER_FLAVOR: flavor, POSTER_CFT_APP: chromeForTesting(), CSC_IDENTITY_AUTO_DISCOVERY: "false" };
console.log(`▶ ${NAME}: packaging`);
execFileSync(join(HERE, "node_modules", ".bin", "electron-builder"), ["--mac", "--arm64", "--config", cfgFile, "--publish", "never"], { stdio: "inherit", env, cwd: HERE });

const out = join(HERE, "release", flavor);
const appPath = join(out, "mac-arm64", `${NAME}.app`);
const dmg = join(out, `${SLUG}-mac-arm64.dmg`);
if (flavor === "client" && developerId()) notarize(appPath, dmg);
console.log(`\n✓ ${NAME}\n  app: ${appPath}\n  dmg: ${dmg}`);
