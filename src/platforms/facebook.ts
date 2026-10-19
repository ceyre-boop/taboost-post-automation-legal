import type { Page } from "playwright-core";
import type { Platform, PostInput } from "./types.ts";

/** Facebook feed video post via the web composer. Facebook's DOM is heavily
 *  obfuscated, so these selectors are best-effort — UNVERIFIED until a dry run. */
export const facebook: Platform = {
  id: "facebook",
  label: "Facebook",
  loginUrl: "https://www.facebook.com/login",
  host: /facebook\.com/,
  verified: false,

  async isLoggedIn(page: Page): Promise<boolean> {
    const cookies = await page.context().cookies("https://www.facebook.com");
    return cookies.some((c) => c.name === "c_user" && c.value.length > 0);
  },

  async post(page, input, log): Promise<void> {
    log("Opening Facebook");
    await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded" });
    if (page.url().includes("/login")) throw new Error("Facebook asked for login. Log in in the Chrome window, then run again.");

    // Open the status composer ("What's on your mind?").
    const opener = page.locator('[role="button"]:has-text("What\'s on your mind"), [aria-label*="What\'s on your mind"]').first();
    await opener.waitFor({ state: "visible", timeout: 30_000 });
    await opener.click();

    // In the composer dialog, choose Photo/video, then attach the file.
    const photoVideo = page.locator('[role="dialog"] [aria-label="Photo/video"], [role="dialog"] div:has-text("Photo/video")').first();
    if (await photoVideo.isVisible({ timeout: 5000 }).catch(() => false)) await photoVideo.click();
    const fileInput = page.locator('[role="dialog"] input[type="file"], input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(input.video);
    log("Video handed to the uploader, waiting for processing...");

    if (input.caption) {
      const box = page.locator('[role="dialog"] [contenteditable="true"][role="textbox"], [role="dialog"] [contenteditable="true"]').first();
      await box.waitFor({ state: "visible", timeout: 30_000 });
      await box.click();
      await page.keyboard.type(input.caption, { delay: 8 });
      log("Text typed.");
    }

    const postBtn = page.locator('[role="dialog"] [aria-label="Post"][role="button"], [role="dialog"] div[role="button"]:has-text("Post")').first();
    await postBtn.waitFor({ state: "visible", timeout: 180_000 });

    if (input.dryRun) {
      log("DRY RUN: post is composed with the video attached. Not clicking Post.");
      return;
    }
    await postBtn.click({ force: true });
    log("Post clicked. Waiting for Facebook to finish uploading...");
    // The composer dialog closing is the success signal.
    await page.locator('[role="dialog"]').first().waitFor({ state: "hidden", timeout: 180_000 })
      .catch(() => { throw new Error("Post clicked but the Facebook composer never closed. Check the window."); });
    log("Published.");
  },
};
