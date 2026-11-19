import type { Page } from "playwright-core";
import type { Platform } from "./types.ts";
import { needle, clickNamed, waitGone } from "./remove.ts";

/** YouTube Studio upload flow. Posts and deletes for real (2026-11-18). */
export const youtube: Platform = {
  id: "youtube",
  label: "YouTube",
  loginUrl: "https://studio.youtube.com/",
  host: /youtube\.com/,
  verified: true, // posted and deleted for real 2026-11-18

  async isLoggedIn(page: Page): Promise<boolean> {
    const cookies = await page.context().cookies("https://www.youtube.com");
    return cookies.some((c) => (c.name === "SID" || c.name === "__Secure-3PSID") && c.value.length > 0);
  },

  async post(page, input, log): Promise<void> {
    log("Opening YouTube Studio");
    await page.goto("https://studio.youtube.com/", { waitUntil: "domcontentloaded" });
    if (page.url().includes("accounts.google.com")) throw new Error("YouTube asked for Google login. Log in in the Chrome window, then run again.");

    // The dashboard has its own "Upload videos" button; the Create menu is the fallback.
    const direct = page.locator('ytcp-icon-button#upload-icon, button[aria-label="Upload videos"]').first();
    if (await direct.isVisible({ timeout: 15_000 }).catch(() => false)) {
      await direct.click();
    } else {
      await page.locator('button[aria-label="Create"], #create-icon').first().click({ timeout: 30_000 });
      await page.locator('tp-yt-paper-item:has-text("Upload video"), [role="menuitem"]:has-text("Upload video")').first().click({ timeout: 15_000 });
    }
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(input.video);
    log("Video handed to the uploader...");

    const [title, ...rest] = input.caption.split("\n");
    const titleBox = page.locator('#title-textarea #textbox, ytcp-social-suggestions-textbox#title-textarea [contenteditable="true"]').first();
    await titleBox.waitFor({ state: "visible", timeout: 120_000 });
    await titleBox.click();
    await page.keyboard.press("Meta+A");
    await page.keyboard.type((title || "Untitled").slice(0, 100), { delay: 10 });
    const descBox = page.locator('#description-textarea #textbox, ytcp-social-suggestions-textbox#description-textarea [contenteditable="true"]').first();
    if (rest.length && (await descBox.isVisible().catch(() => false))) {
      await descBox.click();
      await page.keyboard.type(rest.join("\n"), { delay: 10 });
    }
    const notForKids = page.locator('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]').first();
    if (await notForKids.isVisible().catch(() => false)) await notForKids.click();
    log("Details filled.");

    for (let i = 0; i < 3; i++) {
      await page.locator("#next-button").first().click({ timeout: 30_000 });
      await page.waitForTimeout(800);
    }
    // Visibility: POSTER_YT_VISIBILITY = public | unlisted | private (default public).
    const vis = (process.env.POSTER_YT_VISIBILITY || "public").toUpperCase();
    const visName = ["PUBLIC", "UNLISTED", "PRIVATE"].includes(vis) ? vis : "PUBLIC";
    const visRadio = page.locator(`tp-yt-paper-radio-button[name="${visName}"]`).first();
    await visRadio.waitFor({ state: "visible", timeout: 30_000 });
    await visRadio.click();

    const done = page.locator("#done-button").first();
    await page.waitForFunction(() => {
      const b = document.querySelector("#done-button") as HTMLElement | null;
      return !!b && b.getAttribute("disabled") === null && b.getAttribute("aria-disabled") !== "true";
    }, undefined, { timeout: 600_000 });
    if (input.dryRun) {
      log(`DRY RUN: visibility set to ${visName}, upload processed. Not clicking Publish.`);
      return;
    }
    await done.click();
    log("Publish clicked. Waiting for YouTube to confirm...");
    // Either the "Video published" box appears, or the upload dialog simply closes.
    await Promise.any([
      page.getByText(/Video published|Published/i).first().waitFor({ state: "visible", timeout: 120_000 }),
      page.locator("ytcp-uploads-dialog #done-button").first().waitFor({ state: "hidden", timeout: 120_000 }),
    ]);
    log("Published.");
  },

  async remove(page, caption, log): Promise<void> {
    const text = needle(caption);
    await page.goto("https://studio.youtube.com/", { waitUntil: "domcontentloaded" }).catch(() => {}); // Studio redirects mid-load
    await page.waitForURL(/\/channel\/[^/?]+/, { timeout: 30_000 });
    const channel = page.url().match(/\/channel\/([^/?]+)/)![1];
    // A short vertical clip is filed under Shorts, a longer one under Videos.
    const row = page.locator("ytcp-video-row").filter({ hasText: text }).first();
    for (const list of ["short", "upload"]) {
      await page.goto(`https://studio.youtube.com/channel/${channel}/videos/${list}`, { waitUntil: "domcontentloaded" });
      if (await row.isVisible({ timeout: 12_000 }).catch(() => false)) break;
    }
    await row.waitFor({ state: "visible", timeout: 5_000 });
    await row.hover();
    await row.locator('ytcp-icon-button[aria-label="Options"], [aria-label="Options"]').first().click();
    await page.locator('tp-yt-paper-item:has-text("Delete forever")').first().click({ timeout: 15_000 });
    await page.locator("ytcp-checkbox-lit#confirm-checkbox, #confirm-checkbox").first().click({ timeout: 15_000 });
    await page.locator("#confirm-button").first().click({ timeout: 15_000 });
    if (!(await waitGone(page, text))) throw new Error("Delete clicked but the video is still listed on YouTube.");
    log("Deleted.");
  },
};
