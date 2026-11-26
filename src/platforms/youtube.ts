import type { Page } from "playwright-core";
import type { Platform } from "./types.ts";
import { uploadTimeoutMs, neverClickable } from "./timing.ts";
import { typeCaption, youtubeParts } from "./caption.ts";
import { needle, clickNamed, waitGone } from "./remove.ts";

/** YouTube Studio upload flow. Posts and deletes for real (2026-11-18). */
export const youtube: Platform = {
  id: "youtube",
  label: "YouTube",
  loginUrl: "https://studio.youtube.com/",
  host: /^https:\/\/([a-z0-9-]+\.)*youtube\.com(\/|$)/,
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
    const uploadMs = uploadTimeoutMs(input.video);

    const { title, description } = youtubeParts(input.caption);
    const titleBox = page.locator('#title-textarea #textbox, ytcp-social-suggestions-textbox#title-textarea [contenteditable="true"]').first();
    await titleBox.waitFor({ state: "visible", timeout: uploadMs });
    await titleBox.click();
    await page.keyboard.press("Meta+A");
    await page.keyboard.type(title, { delay: 10 });
    const descBox = page.locator('#description-textarea #textbox, ytcp-social-suggestions-textbox#description-textarea [contenteditable="true"]').first();
    if (description && (await descBox.isVisible().catch(() => false))) {
      await descBox.click();
      await typeCaption(page, description, 10);
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
    }, undefined, { timeout: uploadMs }).catch(() => { throw neverClickable("YouTube"); });
    if (input.dryRun) {
      log(`DRY RUN: visibility set to ${visName}, upload processed. Not clicking Publish.`);
      return;
    }
    // Found 2026-11-26: pressed while YouTube is still running its checks, Publish only saves a
    // draft "to publish when the checks finish", and leaving the page then leaves it a draft. So wait
    // for the checks first (a short clip takes a few minutes); if they never finish, go on anyway.
    log("Waiting for YouTube's checks to finish before publishing...");
    await page.locator("ytcp-uploads-dialog").getByText(/Checks complete/i).first().waitFor({ state: "visible", timeout: 10 * 60_000 })
      .catch(() => log("YouTube's checks didn't finish in 10 minutes; publishing anyway."));
    await done.click();
    input.clicked?.();
    log("Publish clicked. Waiting for YouTube to confirm...");
    // Found 2026-11-26: a click while YouTube is still running its checks can leave the video as a
    // draft (the dialog stays open, or a "publish anyway" box appears). So: watch for the "published"
    // box or the dialog closing, press any confirm box, and press Publish again if it's still there.
    // Done when YouTube says so: the "Video published" box, its "Video processing" box (saved, and
    // public once processed; closed here so nothing is left open), or the upload dialog closing.
    const published = page.getByText(/Video published|Published/i).first();
    const processing = page.locator("ytcp-dialog, tp-yt-paper-dialog").filter({ hasText: /Video processing|still processing/i }).first();
    const dialogDone = page.locator("ytcp-uploads-dialog #done-button").first();
    const until = Date.now() + 150_000;
    let ok = false;
    while (Date.now() < until) {
      if (await published.isVisible().catch(() => false)) { ok = true; break; }
      if (await processing.isVisible().catch(() => false)) { ok = true; await processing.getByRole("button", { name: /close/i }).first().click({ timeout: 5000 }).catch(() => {}); break; }
      if (!(await dialogDone.isVisible().catch(() => false))) { ok = true; break; }
      await page.waitForTimeout(1500);
    }
    if (!ok) throw new Error("YouTube never confirmed the video was published. It may be saved as a draft in YouTube Studio.");
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
