// Ad-hoc code-sign the macOS app after packaging. Without this, `identity: null`
// leaves the app unsigned, and Apple Silicon reports a downloaded unsigned app as
// "damaged and can't be opened" (a dead end). An ad-hoc signature makes it a normal
// unsigned app: Gatekeeper shows "unidentified developer" and right-click → Open works.
// (A real Developer ID + notarization — deferred — removes the prompt entirely.)
const { execSync } = require("node:child_process");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log("Ad-hoc signing", app);
  execSync(`codesign --force --deep --sign - ${JSON.stringify(app)}`, { stdio: "inherit" });
  execSync(`codesign --verify --verbose ${JSON.stringify(app)}`, { stdio: "inherit" });
};
