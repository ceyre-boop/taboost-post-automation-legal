import type { Page } from "playwright-core";
import type { Platform } from "./types.ts";
import { uploadTimeoutMs } from "./timing.ts";
import { typeCaption } from "./caption.ts";
import { needle, clickNamed, waitGone } from "./remove.ts";

/** Instagram web "Create" flow. Posts and deletes for real (2026-11-18). */
export const instagram: Platform = {
  id: "instagram",
  label: "Instagram",
  loginUrl: "https://www.instagram.com/accounts/login/",
  host: /^https:\/\/([a-z0-9-]+\.)*instagram\.com(\/|$)/,
  verified: true,

  async isLoggedIn(page: Page): Promise<boolean> {
    const cookies = await page.context().cookies("https://www.instagram.com");
    return cookies.some((c) => c.name === "sessionid" && c.value.length > 0);
  },

  async post(page, input, log): Promise<void> {
    log("Opening instagram.com");
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
    if (page.url().includes("/accounts/login")) throw new Error("Instagram asked for login. Log in in the Chrome window, then run again.");
    for (const b of await page.locator('button:text-is("Not Now"), button:text-is("Not now")').all()) await b.click().catch(() => {});

    const create = page.locator('a:has(svg[aria-label="New post"]), [role="link"]:has(svg[aria-label="New post"]), svg[aria-label="New post"]').first();
    await create.waitFor({ state: "visible", timeout: 30_000 });
    await create.click();
    const postOption = page.locator('span:text-is("Post"), a:has(svg[aria-label="Post"])').first();
    if (await postOption.isVisible({ timeout: 2000 }).catch(() => false)) await postOption.click();
    log("Create dialog open, handing over the video...");

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(input.video);

    const uploadMs = uploadTimeoutMs(input.video);
    const okBtn = page.locator('[role="dialog"] button:text-is("OK")').first();
    if (await okBtn.isVisible({ timeout: 4000 }).catch(() => false)) await okBtn.click();

    for (let i = 0; i < 2; i++) {
      const next = page.locator('[role="dialog"] [role="button"]:text-is("Next"), [role="dialog"] button:text-is("Next")').first();
      await next.waitFor({ state: "visible", timeout: uploadMs });
      // Instagram nests the clickable Next inside another role=button div, so a strict
      // click fails the hit-test ("subtree intercepts pointer events"). The topmost
      // element at the button's center IS the Next button, so a forced click is correct.
      await next.click({ force: true });
      await page.waitForTimeout(1500);
    }
    const caption = page.locator('[role="dialog"] [aria-label="Write a caption..."], [role="dialog"] [contenteditable="true"]').first();
    await caption.waitFor({ state: "visible", timeout: 30_000 });
    await caption.click();
    await typeCaption(page, input.caption, 15);
    log("Caption typed.");

    const share = page.locator('[role="dialog"] [role="button"]:text-is("Share"), [role="dialog"] button:text-is("Share")').first();
    await share.waitFor({ state: "visible", timeout: 30_000 });
    if (input.dryRun) {
      log("DRY RUN: ready to share. Not clicking Share.");
      return;
    }
    await share.click({ force: true });
    input.clicked?.();
    log("Share clicked. Waiting for Instagram to confirm...");
    await page.getByText(/has been shared|Post shared|Reel shared/i).first().waitFor({ state: "visible", timeout: uploadMs });
    log("Published.");
  },

  async remove(page, caption, log): Promise<void> {
    const text = needle(caption);
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
    const profile = page.locator('a[href^="/"]:has(img[alt*="profile picture"])').first();
    await profile.waitFor({ state: "attached", timeout: 30_000 });
    await page.goto("https://www.instagram.com" + (await profile.getAttribute("href")), { waitUntil: "domcontentloaded" });
    // The grid shows no captions, so open the newest few posts and read each one.
    const tiles = page.locator('a[href*="/p/"], a[href*="/reel/"]');
    await tiles.first().waitFor({ state: "visible", timeout: 30_000 });
    const links = (await tiles.evaluateAll((as) => as.map((a) => a.getAttribute("href")))).slice(0, 6);
    for (const href of links) {
      await page.goto("https://www.instagram.com" + href, { waitUntil: "domcontentloaded" });
      if (!(await page.getByText(text).first().isVisible({ timeout: 8000 }).catch(() => false))) continue;
      await page.locator('svg[aria-label="More options"]').first().click();
      await clickNamed(page, /^Delete$/);
      await clickNamed(page.locator('[role="dialog"]').last(), /^Delete$/);
      await page.waitForTimeout(4000);
      log("Deleted.");
      return;
    }
    throw new Error("Could not find that post among your newest Instagram posts. Nothing deleted.");
  },
};
