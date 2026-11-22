import type { Page } from "playwright-core";
import type { Platform, PostInput } from "./types.ts";
import { uploadTimeoutMs, waitClickable } from "./timing.ts";
import { typeCaption } from "./caption.ts";
import { needle, clickNamed, waitGone, postBlock } from "./remove.ts";

/** Facebook feed video post via the web composer. Facebook's DOM is heavily
 *  obfuscated, so these selectors are best-effort. */
export const facebook: Platform = {
  id: "facebook",
  label: "Facebook",
  loginUrl: "https://www.facebook.com/login",
  host: /^https:\/\/([a-z0-9-]+\.)*facebook\.com(\/|$)/,
  verified: true, // posted and deleted for real 2026-11-18

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
    const uploadMs = uploadTimeoutMs(input.video);

    if (input.caption) {
      // Facebook keeps an older copy of the post box behind the one on screen: the last one is the live one.
      const box = page.locator('[role="dialog"] [contenteditable="true"][role="textbox"]').last();
      await box.waitFor({ state: "visible", timeout: 30_000 });
      // Facebook lays its placeholder over the text box, so an ordinary click is intercepted.
      await box.click({ force: true });
      await typeCaption(page, input.caption, 8);
      // Typing can land nowhere without an error, so read the box back before saying so.
      const first = input.caption.split("\n")[0].slice(0, 20);
      if (!(await box.innerText().catch(() => "")).includes(first)) {
        await box.evaluate((el) => (el as HTMLElement).focus());
        await typeCaption(page, input.caption, 8);
      }
      if (!(await box.innerText().catch(() => "")).includes(first)) throw new Error("Facebook's text box did not take the caption.");
      log("Text typed.");
    }

    const postBtn = page.locator('[role="dialog"] [aria-label="Post"][role="button"]').last();
    await postBtn.waitFor({ state: "visible", timeout: uploadMs });
    // Post is greyed out until Facebook has taken the video.
    await waitClickable(postBtn, "Facebook", uploadMs);

    if (input.dryRun) {
      log("DRY RUN: post is composed with the video attached. Not clicking Post.");
      return;
    }
    await postBtn.click({ force: true });
    input.clicked?.();
    log("Post clicked. Waiting for Facebook to finish uploading...");
    // The composer dialog closing is the success signal.
    await page.locator('[role="dialog"]').last().waitFor({ state: "hidden", timeout: uploadMs })
      .catch(() => { throw new Error("Post clicked but the Facebook composer never closed. Check the window."); });
    log("Published.");
  },

  async remove(page, caption, log): Promise<void> {
    const text = needle(caption);
    await page.goto("https://www.facebook.com/me", { waitUntil: "domcontentloaded" });
    const menu = '[aria-label^="Actions for this post"]';
    const post = postBlock(page, text, menu);
    // A new video can take a minute or two to show on the profile while Facebook processes it.
    for (let i = 0; i < 8 && !(await post.isVisible({ timeout: 20_000 }).catch(() => false)); i++) {
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    await post.waitFor({ state: "visible", timeout: 20_000 });
    await post.locator(menu).first().click();
    await clickNamed(page, /Move to (trash|Recycle bin)|^Delete/i);
    await clickNamed(page.locator('[role="dialog"]').last(), /^(Move|Delete)$/);
    if (!(await waitGone(page, text))) throw new Error("Delete clicked but the post is still showing on Facebook.");
    log("Deleted (Facebook keeps it in your trash for 30 days).");
  },
};
