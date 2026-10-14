import type { Page } from "playwright-core";
import type { Platform, PostInput } from "./types.ts";

const UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload";

/** TikTok Studio shows one-off prompts (content checks, tips). Dismiss without changing the user's settings. */
async function dismissModals(page: Page, log: (m: string) => void): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const btn = page
      .locator('.TUXModal-overlay button, [role="dialog"] button')
      .filter({ hasText: /^(Cancel|Not now|Skip|Got it|Close|Maybe later)$/i })
      .first();
    if (!(await btn.isVisible().catch(() => false))) return;
    const text = (await btn.innerText()).trim();
    await btn.click();
    log(`Dismissed a TikTok prompt ("${text}").`);
    await page.waitForTimeout(500);
  }
}

export const tiktok: Platform = {
  id: "tiktok",
  loginUrl: "https://www.tiktok.com/login",

  async isLoggedIn(page: Page): Promise<boolean> {
    // TikTok sets sessionid / sid_tt on .tiktok.com once a login completes.
    const cookies = await page.context().cookies("https://www.tiktok.com");
    return cookies.some((c) => (c.name === "sessionid" || c.name === "sid_tt") && c.value.length > 0);
  },

  async post(page: Page, input: PostInput, log): Promise<void> {
    log(`Opening ${UPLOAD_URL}`);
    await page.goto(UPLOAD_URL, { waitUntil: "domcontentloaded" });
    if (page.url().includes("/login")) throw new Error("TikTok asked for login. Log in in the Chrome window, then run again.");

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(input.video);
    log("Video handed to the uploader, waiting for processing...");
    await dismissModals(page, log);

    const editor = page
      .locator('[contenteditable="true"], .public-DraftEditor-content, div[data-e2e="caption-input"] [contenteditable]')
      .first();
    await editor.waitFor({ state: "visible", timeout: 120_000 });
    await dismissModals(page, log);
    await editor.click();
    await page.keyboard.press("Meta+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(input.caption, { delay: 20 });
    log("Caption typed.");

    const postBtn = page.locator('button[data-e2e="post_video_button"], button:has-text("Post")').first();
    await postBtn.waitFor({ state: "visible", timeout: 180_000 });
    // The button stays disabled until TikTok finishes processing the upload.
    await page.waitForFunction(
      (sel) => {
        const b = document.querySelector(sel) as HTMLButtonElement | null;
        return !!b && !b.disabled && b.getAttribute("aria-disabled") !== "true";
      },
      'button[data-e2e="post_video_button"]',
      { timeout: 300_000 },
    );

    await dismissModals(page, log);
    if (input.dryRun) {
      log("DRY RUN: everything is filled in. Not clicking Post. Re-run with --live to publish.");
      return;
    }
    await postBtn.click();
    log("Post clicked. Waiting for confirmation...");
    await page.waitForURL(/tiktokstudio\/content|upload\?success|\/content/i, { timeout: 120_000 }).catch(() => {});
    log("Done.");
  },
};
