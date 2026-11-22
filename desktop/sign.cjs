// Signing for the Mac app. Used by afterPack.cjs (the .app) and build.mjs (notarizing).
//
//   Developer ID in the Keychain ("Developer ID Application: …") and a client build:
//     signed with it, hardened runtime, then notarized and stapled. Needs a notary profile,
//     made once:  xcrun notarytool store-credentials northbound-notary --apple-id <Apple ID> --team-id <Team ID>
//   Otherwise (and always for Colin's own build): ad-hoc. Works on this Mac; on another Mac
//   the person clicks "Open Anyway" once in System Settings → Privacy & Security.
const { execFileSync, execSync } = require("node:child_process");
const { join } = require("node:path");
const PROFILE = "northbound-notary";

function developerId() {
  try {
    const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    const m = out.match(/"(Developer ID Application: [^"]+)"/);
    return m ? m[1] : "";
  } catch { return ""; }
}

function sign(appPath, flavor) {
  const id = flavor === "client" ? developerId() : "";
  if (!id) {
    console.log(`Signing ad-hoc (${flavor === "client" ? "no Developer ID in the Keychain yet" : "Colin's own build"}): ${appPath}`);
    execSync(`codesign --force --deep --sign - ${JSON.stringify(appPath)}`, { stdio: "inherit" });
  } else {
    console.log(`Signing with ${id}, hardened runtime: ${appPath}`);
    const ent = join(__dirname, "build", "entitlements.mac.plist");
    execSync(`codesign --force --deep --options runtime --timestamp --entitlements ${JSON.stringify(ent)} --sign ${JSON.stringify(id)} ${JSON.stringify(appPath)}`, { stdio: "inherit" });
  }
  execSync(`codesign --verify --deep --strict ${JSON.stringify(appPath)}`, { stdio: "inherit" });
}

function notarize(appPath, dmgPath) {
  try { execFileSync("xcrun", ["notarytool", "history", "--keychain-profile", PROFILE], { stdio: "ignore" }); }
  catch {
    console.log(`\nSigned with your Developer ID but NOT notarized: no notary profile yet. Run this once, then build again:\n  xcrun notarytool store-credentials ${PROFILE} --apple-id <your Apple ID email> --team-id <your Team ID>\n`);
    return;
  }
  const id = developerId();
  execSync(`codesign --force --sign ${JSON.stringify(id)} --timestamp ${JSON.stringify(dmgPath)}`, { stdio: "inherit" });
  console.log("Notarizing the disk image (a few minutes)…");
  execFileSync("xcrun", ["notarytool", "submit", dmgPath, "--keychain-profile", PROFILE, "--wait"], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "staple", dmgPath], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
}

module.exports = { developerId, sign, notarize };
