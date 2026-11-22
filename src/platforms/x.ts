import type { Page } from "playwright-core";
import type { Platform, PostInput } from "./types.ts";
import { uploadTimeoutMs, neverClickable } from "./timing.ts";
import { typeCaption, fitX } from "./caption.ts";
import { needle, clickNamed, waitGone } from "./remove.ts";

/** X (Twitter) web composer. X exposes stable data-testid hooks, so this is the
 *  most reliable of the new adapters. */
export const x: Platform = {
  id: "x",
  label: "X (Twitter)",
  loginUrl: "https://x.com/login",
  host: /^https:\/\/([a-z0-9-]+\.)*(x|twitter)\.com(\/|$)/,
  verified: true, // posted and deleted for real 2026-11-18

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

    // The composer opens as a pop-up over the timeline, and the timeline has its own inline
    // Post box underneath. Everything below is looked for inside the pop-up, so the hidden
    // inline box (and its covered Post button) is never picked by mistake.
    const modal = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator('[data-testid="tweetTextarea_0"]') }).last();
    await modal.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
    const root = (await modal.count()) ? modal : page.locator("body");
    const fileInput = root.locator('input[type="file"][data-testid="fileInput"], input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(input.video);
    log("Video handed to the uploader, waiting for processing...");
    const uploadMs = uploadTimeoutMs(input.video);

    const fit = fitX(input.caption);
    const text = fit.text;
    if (text) {
      const box = root.locator('[data-testid="tweetTextarea_0"], [role="textbox"][contenteditable="true"]').first();
      await box.waitFor({ state: "visible", timeout: 30_000 });
      await box.click();
      await typeCaption(page, text, 8);
      if (fit.shortened) log("caption shortened to fit X");
      log("Text typed.");
    }

    const postBtn = root.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').first();
    await postBtn.waitFor({ state: "visible", timeout: uploadMs });
    // Button is disabled until the video finishes uploading.
    const end = Date.now() + uploadMs;
    while ((await postBtn.getAttribute("aria-disabled").catch(() => "true")) === "true") {
      if (Date.now() > end) throw neverClickable("X (Twitter)");
      await page.waitForTimeout(1000);
    }

    if (input.dryRun) {
      log("DRY RUN: post is composed with the video attached. Not clicking Post.");
      return;
    }
    await postBtn.click();
    input.clicked?.();
    log("Post clicked. Waiting for X to confirm...");
    await page.locator('[data-testid="toast"], [role="alert"], [role="status"]')
      .filter({ hasText: /Your post was sent|Your Tweet was sent/i }).first()
      .waitFor({ state: "visible", timeout: 60_000 })
      .catch(() => { throw new Error("Post clicked but X never confirmed. Check the window."); });
    log("Published.");
  },

  async remove(page, caption, log): Promise<void> {
    const text = needle(caption);
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
    await page.locator('a[data-testid="AppTabBar_Profile_Link"]').click({ timeout: 30_000 });
    const post = page.locator('article[data-testid="tweet"]').filter({ hasText: text }).first();
    // A video post can take a minute or two to show on the profile while X finishes it.
    // Look again with a fresh page rather than giving up after the first look.
    for (let tries = 1; ; tries++) {
      try { await post.waitFor({ state: "visible", timeout: 30_000 }); break; }
      catch (e) {
        if (tries >= 6) throw new Error("The post never showed on the X profile, so nothing was deleted. Check X and delete it there.");
        log("Not on the profile yet; looking again…");
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      }
    }
    await post.locator('[data-testid="caret"]').first().click();
    await clickNamed(page, /^Delete$/);
    await page.locator('[data-testid="confirmationSheetConfirm"]').click({ timeout: 15_000 });
    if (!(await waitGone(page, text))) throw new Error("Delete clicked but the post is still showing on X.");
    log("Deleted.");
  },
};
