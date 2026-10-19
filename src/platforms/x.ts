import type { Page } from "playwright-core";
import type { Platform, PostInput } from "./types.ts";

/** X (Twitter) web composer. X exposes stable data-testid hooks, so this is the
 *  most reliable of the new adapters — but still UNVERIFIED until a live dry run. */
export const x: Platform = {
  id: "x",
  label: "X (Twitter)",
  loginUrl: "https://x.com/login",
  host: /(x|twitter)\.com/,
  verified: false,

  async isLoggedIn(page: Page): Promise<boolean> {
    const cookies = await page.context().cookies("https://x.com");
    return cookies.some((c) => c.name === "auth_token" && c.value.length > 0);
  },

  async post(page, input, log): Promise<void> {
    log("Opening X composer");
    await page.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded" });
    if (page.url().includes("/login") || page.url().includes("/i/flow/login")) {
      throw new Error("X asked for login. Log in in the Chrome window, then run again.");
    }

    const fileInput = page.locator('input[type="file"][data-testid="fileInput"], input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(input.video);
    log("Video handed to the uploader, waiting for processing...");

    const text = input.caption.length > 280 ? input.caption.slice(0, 277) + "…" : input.caption;
    if (text) {
      const box = page.locator('[data-testid="tweetTextarea_0"], [role="textbox"][contenteditable="true"]').first();
      await box.waitFor({ state: "visible", timeout: 30_000 });
      await box.click();
      await page.keyboard.type(text, { delay: 8 });
      if (input.caption.length > 280) log("Caption trimmed to X's 280-char limit.");
      log("Text typed.");
    }

    const postBtn = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').first();
    await postBtn.waitFor({ state: "visible", timeout: 180_000 });
    // Button is disabled until the video finishes uploading.
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="tweetButton"],[data-testid="tweetButtonInline"]') as HTMLElement | null;
      return !!b && b.getAttribute("aria-disabled") !== "true";
    }, undefined, { timeout: 300_000 }).catch(() => {});

    if (input.dryRun) {
      log("DRY RUN: post is composed with the video attached. Not clicking Post.");
      return;
    }
    await postBtn.click();
    log("Post clicked. Waiting for X to confirm...");
    await page.getByText(/Your post was sent|Your Tweet was sent/i).first()
      .waitFor({ state: "visible", timeout: 60_000 })
      .catch(() => { throw new Error("Post clicked but X never confirmed. Check the window."); });
    log("Published.");
  },
};
