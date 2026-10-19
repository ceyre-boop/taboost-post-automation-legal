import type { Page } from "playwright-core";
import type { Platform, PostInput } from "./types.ts";

/** LinkedIn feed post with a video. Best-effort selectors — UNVERIFIED until a dry run. */
export const linkedin: Platform = {
  id: "linkedin",
  label: "LinkedIn",
  loginUrl: "https://www.linkedin.com/login",
  host: /linkedin\.com/,
  verified: false,

  async isLoggedIn(page: Page): Promise<boolean> {
    const cookies = await page.context().cookies("https://www.linkedin.com");
    return cookies.some((c) => c.name === "li_at" && c.value.length > 0);
  },

  async post(page, input, log): Promise<void> {
    log("Opening LinkedIn feed");
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
    if (page.url().includes("/login") || page.url().includes("/checkpoint")) {
      throw new Error("LinkedIn asked for login. Log in in the Chrome window, then run again.");
    }

    const startPost = page.locator('button:has-text("Start a post"), button[aria-label*="Start a post"]').first();
    await startPost.waitFor({ state: "visible", timeout: 30_000 });
    await startPost.click();

    // Open the Video attachment in the share box.
    const videoBtn = page.locator('button[aria-label*="video"], button[aria-label*="Video"], [aria-label="Add a video"]').first();
    if (await videoBtn.isVisible({ timeout: 5000 }).catch(() => false)) await videoBtn.click();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(input.video);
    log("Video handed to the uploader, waiting for processing...");

    // Some flows show a "Next"/"Done" to return to the composer after the video is added.
    for (const t of ["Next", "Done"]) {
      const b = page.locator(`[role="dialog"] button:has-text("${t}")`).first();
      if (await b.isVisible({ timeout: 4000 }).catch(() => false)) await b.click().catch(() => {});
    }

    if (input.caption) {
      const box = page.locator('[role="dialog"] [role="textbox"], .ql-editor[contenteditable="true"], [contenteditable="true"]').first();
      await box.waitFor({ state: "visible", timeout: 30_000 });
      await box.click();
      await page.keyboard.type(input.caption, { delay: 8 });
      log("Text typed.");
    }

    const postBtn = page.locator('[role="dialog"] button:text-is("Post"), button.share-actions__primary-action').first();
    await postBtn.waitFor({ state: "visible", timeout: 180_000 });
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === "Post") as HTMLButtonElement | undefined;
      return !!b && !b.disabled;
    }, undefined, { timeout: 300_000 }).catch(() => {});

    if (input.dryRun) {
      log("DRY RUN: post is composed with the video attached. Not clicking Post.");
      return;
    }
    await postBtn.click({ force: true });
    log("Post clicked. Waiting for LinkedIn to confirm...");
    await page.getByText(/Post successful|Your post|shared this/i).first()
      .waitFor({ state: "visible", timeout: 60_000 })
      .catch(() => { throw new Error("Post clicked but LinkedIn never confirmed. Check the window."); });
    log("Published.");
  },
};
