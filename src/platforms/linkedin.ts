import type { Page } from "playwright-core";
import type { Platform, PostInput } from "./types.ts";
import { needle, clickNamed, waitGone, postBlock } from "./remove.ts";

/** LinkedIn feed post with a video. Best-effort selectors. */
export const linkedin: Platform = {
  id: "linkedin",
  label: "LinkedIn",
  loginUrl: "https://www.linkedin.com/login",
  host: /linkedin\.com/,
  verified: true, // posted and deleted for real 2026-11-18

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

    // The feed's own "Video" shortcut opens the file picker straight away. LinkedIn builds
    // these as div role=button, not <button>.
    const videoBtn = page.getByRole("button", { name: "Video", exact: true }).first();
    await videoBtn.waitFor({ state: "visible", timeout: 30_000 });
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 15_000 }).catch(() => null),
      videoBtn.click(),
    ]);
    if (chooser) {
      await chooser.setFiles(input.video);
    } else {
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.waitFor({ state: "attached", timeout: 30_000 });
      await fileInput.setInputFiles(input.video);
    }
    log("Video handed to the uploader, waiting for processing...");

    // LinkedIn shows a small video editor first; Next returns to the post box.
    const next = page.getByRole("button", { name: "Next", exact: true }).first();
    await next.waitFor({ state: "visible", timeout: 120_000 });
    await next.click();

    if (input.caption) {
      const box = page.locator('.ql-editor[contenteditable="true"], [role="textbox"][contenteditable="true"]').first();
      await box.waitFor({ state: "visible", timeout: 30_000 });
      await box.click();
      await page.keyboard.type(input.caption, { delay: 8 });
      log("Text typed.");
    }

    const postBtn = page.getByRole("button", { name: "Post", exact: true }).first();
    await postBtn.waitFor({ state: "visible", timeout: 180_000 });
    // Post stays disabled until the video has finished uploading.
    for (let i = 0; i < 150 && !(await postBtn.isEnabled().catch(() => false)); i++) await page.waitForTimeout(2000);

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

  async remove(page, caption, log): Promise<void> {
    const text = needle(caption);
    await page.goto("https://www.linkedin.com/in/me/recent-activity/all/", { waitUntil: "domcontentloaded" });
    const menu = 'button[aria-label^="Open control menu for post"]';
    const post = postBlock(page, text, menu);
    await post.waitFor({ state: "visible", timeout: 30_000 });
    await post.locator(menu).first().click();
    await clickNamed(page, /Delete post/i);
    await clickNamed(page, /^Delete$/); // the "Delete post?" confirmation
    if (!(await waitGone(page, text))) throw new Error("Delete clicked but the post is still showing on LinkedIn.");
    log("Deleted.");
  },
};
