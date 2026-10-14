import type { Page } from "playwright-core";
import type { Platform, PostInput } from "./types.ts";

const UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload";

/** TikTok Studio shows one-off prompts (content checks, tips). Dismiss without changing the user's settings. */
async function dismissModals(page: Page, log: (m: string) => void): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const btn = page
      .locator('.TUXModal-overlay button, [role="dialog"] button, #react-joyride-portal button, .react-joyride__tooltip button')
      .filter({ hasText: /^(Cancel|Not now|Skip|Got it|Close|Maybe later|OK)$/i })
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
  label: "TikTok",
  loginUrl: "https://www.tiktok.com/login",
  host: /tiktok\.com/,

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

    const postBtn = page.locator('button[data-e2e="post_video_button"], button:text-is("Post")').first();
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
    // Give TikTok's copyright / content check up to 90s to finish so we post with a completed check.
    const checking = page.getByText(/checking your video|check in progress|Checking/i).first();
    if (await checking.isVisible().catch(() => false)) {
      log("Waiting for TikTok's copyright check to finish (up to 90s)...");
      await checking.waitFor({ state: "hidden", timeout: 90_000 }).catch(() => log("Check still running, continuing anyway."));
    }
    if (input.dryRun) {
      log("DRY RUN: everything is filled in. Not clicking Post. Re-run with --live to publish.");
      return;
    }
    await postBtn.click();
    log("Post clicked. Waiting for TikTok to confirm...");
    // If the check is still incomplete TikTok asks "Continue to post?" — answer Post now.
    const postNow = page.locator('[role="dialog"] button, .TUXModal-overlay button').filter({ hasText: /^Post now$/i }).first();
    if (await postNow.isVisible({ timeout: 4000 }).catch(() => false)) {
      await postNow.click();
      log('Confirmed "Post now" on the copyright-check prompt.');
    }
    // Success = TikTok leaves the upload page, or shows its "uploaded" dialog. Anything else is NOT a post.
    const confirmed = await Promise.race([
      page.waitForURL(/tiktokstudio\/content/i, { timeout: 120_000 }).then(() => "redirected to Posts"),
      page
        .locator('[role="dialog"], .TUXModal-overlay')
        .filter({ hasText: /uploaded|posted|being uploaded|Manage your posts|View post/i })
        .first()
        .waitFor({ state: "visible", timeout: 120_000 })
        .then(() => "upload dialog shown"),
    ]).catch(() => null);
    if (!confirmed) {
      const leftover = await page
        .locator('[role="dialog"], .TUXModal-overlay, #react-joyride-portal')
        .first()
        .innerText()
        .catch(() => "");
      throw new Error(`Post clicked but TikTok never confirmed. Still on ${page.url()}. On screen: ${leftover.slice(0, 200).replace(/\n+/g, " / ") || "nothing"}`);
    }
    log(`Published (${confirmed}).`);
  },
};
