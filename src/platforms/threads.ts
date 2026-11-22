import type { Page } from "playwright-core";
import type { Platform, PostInput } from "./types.ts";
import { uploadTimeoutMs, waitClickable } from "./timing.ts";
import { typeCaption } from "./caption.ts";
import { needle, clickNamed, waitGone } from "./remove.ts";

/** Threads web composer. Threads uses an Instagram-linked login. Best-effort
 *  selectors. */
export const threads: Platform = {
  id: "threads",
  label: "Threads",
  loginUrl: "https://www.threads.net/login",
  host: /^https:\/\/([a-z0-9-]+\.)*threads\.(net|com)(\/|$)/,
  verified: true, // posted and deleted for real 2026-11-18

  async isLoggedIn(page: Page): Promise<boolean> {
    for (const url of ["https://www.threads.net", "https://www.threads.com"]) {
      const cookies = await page.context().cookies(url).catch(() => []);
      if (cookies.some((c) => c.name === "sessionid" && c.value.length > 0)) return true;
    }
    return false;
  },

  async post(page, input, log): Promise<void> {
    log("Opening Threads");
    await page.goto("https://www.threads.net/", { waitUntil: "domcontentloaded" });
    if (page.url().includes("/login")) throw new Error("Threads asked for login (via Instagram). Log in in the Chrome window, then run again.");

    // Open the composer.
    const opener = page.locator('[role="button"][aria-label*="compose a new post"], [role="button"]:has-text("Start a thread"), [aria-label="Create"], svg[aria-label="Create"]').first();
    await opener.waitFor({ state: "visible", timeout: 30_000 });
    await opener.click();

    // Attach media (there's usually a hidden file input in the composer dialog).
    const fileInput = page.locator('[role="dialog"] input[type="file"], input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(input.video);
    log("Video handed to the uploader, waiting for processing...");
    const uploadMs = uploadTimeoutMs(input.video);

    if (input.caption) {
      const box = page.locator('[role="dialog"] [contenteditable="true"], [contenteditable="true"][role="textbox"]').first();
      await box.waitFor({ state: "visible", timeout: 30_000 });
      await box.click();
      await typeCaption(page, input.caption, 8);
      log("Text typed.");
    }

    const postBtn = page.locator('[role="dialog"]').getByRole("button", { name: "Post", exact: true }).last();
    await postBtn.waitFor({ state: "visible", timeout: uploadMs });
    // Post stays disabled until the video has been taken.
    await waitClickable(postBtn, "Threads", uploadMs);

    if (input.dryRun) {
      log("DRY RUN: thread is composed with the video attached. Not clicking Post.");
      return;
    }
    await postBtn.click({ force: true });
    input.clicked?.();
    log("Post clicked. Waiting for Threads to confirm...");
    // Only a toast or alert counts: the typed caption and the feed also contain "Posted".
    await page.locator('[role="alert"], [role="status"], [aria-live]')
      .filter({ hasText: /Posted|Your thread/i }).first()
      .waitFor({ state: "visible", timeout: 60_000 })
      .catch(() => { throw new Error("Post clicked but Threads never confirmed. Check the window."); });
    log("Published.");
  },

  async remove(page, caption, log): Promise<void> {
    const text = needle(caption);
    await page.goto("https://www.threads.com/", { waitUntil: "domcontentloaded" });
    await page.locator('a:has-text("Profile"), a:has(svg[aria-label="Profile"])').first().click({ timeout: 30_000 });
    await page.waitForURL(/\/@[^/]+\/?$/, { timeout: 30_000 });
    const post = page.locator("[data-pressable-container]").filter({ hasText: text }).first();
    await post.waitFor({ state: "visible", timeout: 30_000 });
    await post.locator('[aria-haspopup="menu"], svg[aria-label="More"]').first().click();
    await clickNamed(page, /^Delete$/);
    await clickNamed(page.locator('[role="dialog"]').last(), /^Delete$/);
    if (!(await waitGone(page, text))) throw new Error("Delete clicked but the post is still showing on Threads.");
    log("Deleted.");
  },
};
