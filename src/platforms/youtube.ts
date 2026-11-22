import type { Page } from "playwright-core";
import type { Platform } from "./types.ts";
import { uploadTimeoutMs, neverClickable, waitUploaded } from "./timing.ts";
import { typeCaption, youtubeParts } from "./caption.ts";
import { needle } from "./remove.ts";

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

    // An unverified channel can upload only so many videos a day (hit on 2026-11-22 after a day of
    // tests): Studio says "Daily upload limit reached" and won't go on. Don't leave the draft behind.
    const limit = page.locator("ytcp-uploads-dialog").getByText(/Daily upload limit reached/i).first();
    if (await limit.isVisible({ timeout: 3000 }).catch(() => false)) {
      const id = await uploadId(page);
      await page.locator("ytcp-uploads-dialog #close-button, ytcp-uploads-dialog [aria-label='Close']").first().click({ timeout: 10_000 }).catch(() => {});
      if (id) await deleteRows(page, (html) => html.includes(`/vi/${id}/`), "the unfinished upload", log).catch(() => {});
      throw new Error("YouTube daily upload limit reached for this channel");
    }
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

    // Studio enables Publish while the video is still being sent ("Uploading 12% ...").
    await waitUploaded(async () => {
      const t = await page.locator("ytcp-uploads-dialog ytcp-video-upload-progress").first().innerText({ timeout: 5000 }).catch(() => "");
      const m = /Uploading\s+(\d+)%/i.exec(t);
      return { uploading: /Uploading|Video uploading|Waiting/i.test(t), pct: m ? Number(m[1]) : null };
    }, "YouTube", uploadMs, log);
    const done = page.locator("#done-button").first();
    await page.waitForFunction(() => {
      const b = document.querySelector("#done-button") as HTMLElement | null;
      return !!b && b.getAttribute("disabled") === null && b.getAttribute("aria-disabled") !== "true";
    }, undefined, { timeout: uploadMs }).catch(() => { throw neverClickable("YouTube"); });
    if (input.dryRun) {
      log(`DRY RUN: visibility set to ${visName}, upload processed. Not clicking Publish.`);
      // YouTube keeps every upload as a draft even when Publish is never pressed, so a
      // preview deletes the draft it made. Only that one: it is found by its own video id.
      const id = await uploadId(page);
      await page.locator("ytcp-uploads-dialog #close-button, ytcp-uploads-dialog [aria-label='Close']").first().click({ timeout: 10_000 }).catch(() => {});
      if (!id) throw new Error("YouTube's preview worked, but the app couldn't read the draft's address to delete it. Delete the draft in YouTube Studio > Content.");
      await deleteRows(page, (html) => html.includes(`/vi/${id}/`), "the preview's draft", log);
      log("Deleted the draft YouTube kept from the preview.");
      return;
    }
    await done.click();
    input.clicked?.();
    log("Publish clicked. Waiting for YouTube to confirm...");
    // The box that follows Publish: "Video published", or "Video processing" while the SD copy is
    // still being made (seen 2026-11-22 on an unlisted test post), or the dialog simply closes.
    await Promise.any([
      page.locator("ytcp-uploads-dialog, tp-yt-paper-dialog").getByText(/Video (published|processing|unlisted|saved|scheduled)|Published/i).first().waitFor({ state: "visible", timeout: 120_000 }),
      page.locator("ytcp-uploads-dialog").first().waitFor({ state: "hidden", timeout: 120_000 }),
    ]);
    log("Published.");
  },

  async remove(page, caption, log): Promise<void> {
    needle(caption); // refuses a caption too short to find the video safely
    const { title } = youtubeParts(caption);
    // The whole title must match, so "TEST one" never takes down "TEST one more".
    await deleteRows(page, (_html, t) => t === title, `"${title}"`, log);
    log("Deleted.");
  },
};

/** The new video's id, from the link the upload dialog shows. */
async function uploadId(page: Page): Promise<string | null> {
  const hrefs = await page.locator("ytcp-uploads-dialog a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? "")).catch(() => [] as string[]);
  for (const h of hrefs) { const m = /(?:shorts\/|youtu\.be\/|[?&]v=|\/video\/)([A-Za-z0-9_-]{11})/.exec(h); if (m) return m[1]; }
  return null;
}

/**
 * Delete every row in Studio's Content lists (Shorts, then Videos) that `match` picks, by its
 * html (a draft is found by the id in its picture's address) or by its exact title. Drafts
 * and failed uploads have their own "Delete video" button; published videos use Options >
 * Delete forever. Throws, deleting nothing, when no row matches.
 */
export async function deleteRows(page: Page, match: (html: string, title: string) => boolean, what: string, log: (m: string) => void): Promise<number> {
  await page.goto("https://studio.youtube.com/", { waitUntil: "domcontentloaded" }).catch(() => {}); // Studio redirects mid-load
  await page.waitForURL(/\/channel\/[^/?]+/, { timeout: 30_000 });
  const channel = page.url().match(/\/channel\/([^/?]+)/)![1];
  let deleted = 0;
  // Studio's list lags behind a delete, so a video already deleted here is never picked again.
  const gone = new Set<string>();
  // A video that just went up (or a draft just made) can take a little while to show in the list.
  for (let pass = 0; pass < 3 && !deleted; pass++) {
    if (pass) await page.waitForTimeout(10_000);
    for (const list of ["short", "upload"]) {
      const url = `https://studio.youtube.com/channel/${channel}/videos/${list}`;
      for (let guard = 0; guard < 10; guard++) {
        // A fresh list every time: a row being deleted lingers, and the rows below it move up.
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.locator("ytcp-video-row").first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
        const snap = await page.locator("ytcp-video-row").evaluateAll((els) => els.map((el) => ({ html: el.outerHTML, title: (el.querySelector("#video-title") as HTMLElement | null)?.innerText?.trim() ?? "" }))).catch(() => []);
        const pick = snap.find((r) => match(r.html, r.title) && !gone.has(videoIdIn(r.html) ?? ""));
        if (!pick) break;
        // Every action below is pinned to this one video by its id, never to a position in the list.
        const id = videoIdIn(pick.html);
        if (!id) throw new Error(`Found ${what} in YouTube Studio but couldn't tell it apart from the other videos safely, so nothing was deleted. Delete it in YouTube Studio > Content.`);
        const row = page.locator("ytcp-video-row").filter({ has: page.locator(`[src*="/vi/${id}/"], [style*="/vi/${id}/"]`) });
        if ((await row.count()) !== 1) throw new Error(`Couldn't pin down ${what} in YouTube Studio's list, so nothing was deleted.`);
        await row.scrollIntoViewIfNeeded().catch(() => {});
        await row.hover();
        const direct = row.getByRole("button", { name: /^Delete video$/ }).first();
        if (await direct.isVisible({ timeout: 2000 }).catch(() => false)) await direct.click();
        else {
          await row.locator('ytcp-icon-button[aria-label="Options"], [aria-label="Options"]').first().click();
          await page.locator('tp-yt-paper-item:has-text("Delete forever")').filter({ visible: true }).first().click({ timeout: 15_000 });
        }
        await confirmDelete(page);
        if (!(await waitGoneBy(page, `/vi/${id}/`))) throw new Error(`Delete clicked but ${what} is still listed on YouTube.`);
        deleted++;
        gone.add(id);
        log(`Deleted ${what} from YouTube Studio (${id}).`);
      }
    }
  }
  if (!deleted) throw new Error(`Couldn't find ${what} in YouTube Studio's Shorts or Videos. Nothing deleted.`);
  return deleted;
}

/** Studio's "delete forever?" box: tick "I understand" when it's there, then confirm. */
async function confirmDelete(page: Page): Promise<void> {
  const dialog = page.locator("ytcp-confirmation-dialog, tp-yt-paper-dialog, ytcp-dialog").filter({ visible: true }).last();
  await dialog.waitFor({ state: "visible", timeout: 15_000 });
  // "I understand that deleting ... is permanent": the confirm button stays off until it's ticked.
  // The inner box is covered by its own container, so the whole checkbox element is clicked.
  const host = dialog.locator("ytcp-checkbox-lit").filter({ visible: true }).first();
  const box = dialog.locator("[role='checkbox']").filter({ visible: true }).first();
  if (await box.isVisible({ timeout: 2000 }).catch(() => false)) {
    if ((await box.getAttribute("aria-checked").catch(() => null)) !== "true") await ((await host.count()) ? host : box).click();
    for (let i = 0; i < 20 && (await box.getAttribute("aria-checked").catch(() => null)) !== "true"; i++) await page.waitForTimeout(150);
    if ((await box.getAttribute("aria-checked").catch(() => null)) !== "true") throw new Error("YouTube's \"I understand\" box wouldn't tick, so nothing was deleted.");
  }
  // A published video says "Delete forever", a draft "Delete draft video".
  const confirm = dialog.getByRole("button", { name: /^(Delete forever|Delete draft video|Delete)$/ }).last();
  for (let i = 0; i < 30 && ((await confirm.getAttribute("aria-disabled").catch(() => null)) === "true" || (await confirm.isDisabled().catch(() => false))); i++) await page.waitForTimeout(200);
  await confirm.click({ timeout: 15_000 });
  await dialog.waitFor({ state: "hidden", timeout: 30_000 }).catch(() => {});
}

/** The video id a Studio row carries in its picture's address. One id, or none. */
export function videoIdIn(html: string): string | null {
  const ids = new Set([...html.matchAll(/\/vi\/([A-Za-z0-9_-]{11})\//g)].map((m) => m[1]));
  return ids.size === 1 ? [...ids][0] : null;
}

/** Wait until no row carries this piece of html in a freshly loaded list. The row on screen
 *  disappears as soon as Delete is pressed, deleted or not, so only a reload is proof. */
async function waitGoneBy(page: Page, piece: string, timeout = 75_000): Promise<boolean> {
  const end = Date.now() + timeout;
  // Studio sends the delete a few seconds after its box closes: leaving the page before then
  // cancels it (found 2026-11-22: drafts came back when the list was reloaded after 3 seconds).
  await page.waitForTimeout(12_000);
  while (Date.now() < end) {
    await page.waitForTimeout(3000);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await page.locator("ytcp-video-row").first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1500); // the list fills in after the page itself
    const left = await page.locator("ytcp-video-row").evaluateAll((els, p) => els.filter((e) => e.outerHTML.includes(p)).length, piece).catch(() => 1);
    if (!left) return true;
  }
  return false;
}
