// After electron-builder lays out the .app: put Chrome for Testing inside it (for Macs with
// no Chrome), then sign the whole app (sign.cjs). Runs before the .dmg is made.
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { sign } = require("./sign.cjs");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const cft = process.env.POSTER_CFT_APP;
  if (cft && existsSync(cft)) {
    const dest = join(app, "Contents", "Resources", "chrome");
    mkdirSync(dest, { recursive: true });
    console.log("Adding Chrome for Testing to the app");
    execFileSync("ditto", [cft, join(dest, "Google Chrome for Testing.app")], { stdio: "inherit" });
  }
  sign(app, process.env.POSTER_FLAVOR || "client");
};
