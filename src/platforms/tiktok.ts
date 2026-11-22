import type { Page } from "playwright-core";
import type { Platform, PostInput, SongChoice } from "./types.ts";
import { pickSong, tiktokResult } from "./song.ts";
import { uploadTimeoutMs, neverClickable } from "./timing.ts";
import { typeCaption } from "./caption.ts";
import { needle, clickNamed, waitGone, postBlock } from "./remove.ts";

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

/**
 * Add a song from TikTok's own library in TikTok Studio's editor (the upload page's Sounds
 * button), optionally muted (the song's lane speaker: volume "-∞ dB"), and save the edit.
 * TikTok then shows the song on the post. Returns what happened in plain words; a song that
 * can't be found or added never stops the post: the editor is left without changes.
 */
async function addSong(page: Page, song: SongChoice, log: (m: string) => void): Promise<string> {
  const what = `"${song.title}"${song.artist ? ` by ${song.artist}` : ""}`;
  const leave = async () => {
    await page.getByRole("button", { name: /^Cancel$/ }).filter({ visible: true }).first().click({ timeout: 5000 }).catch(() => {});
    await page.getByRole("button", { name: /^Discard$/ }).filter({ visible: true }).first().click({ timeout: 5000 }).catch(() => {});
  };
  const sounds = page.getByRole("button", { name: /^Sounds$/ }).first();
  if (!(await sounds.isVisible({ timeout: 20_000 }).catch(() => false))) return `TikTok's upload page didn't offer its Sounds button, so ${what} wasn't added.`;
  await sounds.click();
  const search = page.getByPlaceholder("Search sounds");
  await search.waitFor({ state: "visible", timeout: 30_000 });
  const gotIt = page.getByRole("button", { name: /^Got it$/ }).filter({ visible: true }).first();
  if (await gotIt.isVisible({ timeout: 1500 }).catch(() => false)) await gotIt.click();
  await search.fill(`${song.title} ${song.artist}`.trim());
  await page.keyboard.press("Enter");
  const items = page.locator("[class*=MusicPanelMusicItem__wrap]").filter({ visible: true });
  await items.first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1500); // the list fills in as results arrive
  const texts = await items.allInnerTexts().catch(() => [] as string[]);
  const i = pickSong(texts.map(tiktokResult), song.title, song.artist);
  if (i < 0) { await leave(); return `TikTok's library has no ${what}, so it went without a song. The caption credit (if chosen) still names it.`; }
  const tracksBefore = await page.locator("[class*=Track__root]").count();
  const item = items.nth(i);
  await item.hover();
  await item.locator("button").filter({ visible: true }).last().click();
  for (let n = 0; n < 20 && (await page.locator("[class*=Track__root]").count()) <= tracksBefore; n++) await page.waitForTimeout(300);
  if ((await page.locator("[class*=Track__root]").count()) <= tracksBefore) { await leave(); return `TikTok didn't add ${what} to the video, so it went without a song.`; }
  if (song.mute) {
    // The newest lane is the song's; its speaker button mutes just that lane.
    await page.locator("[class*=TrackOperation__item] button").last().click();
    const db = page.locator("[class*=PropSettingSliderInput] input[type=text], [class*=PropSettingInput__input]").first();
    let muted = false;
    for (let n = 0; n < 15 && !muted; n++) { muted = /∞/.test(await db.inputValue().catch(() => "")); if (!muted) await page.waitForTimeout(200); }
    if (!muted) { await leave(); return `TikTok wouldn't set ${what} to 0%, so it went without a song rather than playing over your sound.`; }
  }
  await page.getByRole("button", { name: /^Save$/ }).filter({ visible: true }).first().click();
  await search.waitFor({ state: "hidden", timeout: 60_000 });
  log(`Added ${what} from TikTok's library${song.mute ? ", muted so only your own sound is heard" : ""}.`);
  return `Added ${what} from TikTok's library${song.mute ? " at 0%, so only your own sound is heard" : ""}. TikTok shows it on the post.`;
}

export const tiktok: Platform = {
  id: "tiktok",
  label: "TikTok",
  loginUrl: "https://www.tiktok.com/login",
  host: /^https:\/\/([a-z0-9-]+\.)*tiktok\.com(\/|$)/,
  verified: true,
  addsSongs: true,

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
    const uploadMs = uploadTimeoutMs(input.video);
    await dismissModals(page, log);

    const editor = page
      .locator('[contenteditable="true"], .public-DraftEditor-content, div[data-e2e="caption-input"] [contenteditable]')
      .first();
    await editor.waitFor({ state: "visible", timeout: uploadMs });
    await dismissModals(page, log);
    // The song goes in before the caption: the editor covers the whole upload page.
    if (input.song?.title) input.songNote?.(await addSong(page, input.song, log));
    await editor.click();
    await page.keyboard.press("Meta+A");
    await page.keyboard.press("Backspace");
    await typeCaption(page, input.caption, 20);
    log("Caption typed.");

    const postBtn = page.locator('button[data-e2e="post_video_button"], button:text-is("Post")').first();
    await postBtn.waitFor({ state: "visible", timeout: uploadMs });
    // The button stays disabled until TikTok finishes processing the upload.
    await page.waitForFunction(
      (sel) => {
        const b = document.querySelector(sel) as HTMLButtonElement | null;
        return !!b && !b.disabled && b.getAttribute("aria-disabled") !== "true";
      },
      'button[data-e2e="post_video_button"]',
      { timeout: uploadMs },
    ).catch(() => { throw neverClickable("TikTok"); });

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
    input.clicked?.();
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

  async remove(page, caption, log): Promise<void> {
    const text = needle(caption);
    await page.goto("https://www.tiktok.com/tiktokstudio/content", { waitUntil: "domcontentloaded" });
    // Each row ends with four round action buttons; the last one is the "..." menu.
    const action = '[data-tt^="components_ActionCell_Clickabl"]';
    const row = postBlock(page, text, action);
    await row.waitFor({ state: "visible", timeout: 30_000 });
    await row.locator(action).last().click();
    await clickNamed(page, /^Delete$/);
    await page.waitForTimeout(1000);
    // The confirmation has its own Delete button; the menu item is gone by now.
    await page.getByRole("button", { name: /^Delete$/ }).last().click({ timeout: 15_000 });
    if (!(await waitGone(page, text))) throw new Error("Delete clicked but the post is still showing on TikTok.");
    log("Deleted.");
  },
};
