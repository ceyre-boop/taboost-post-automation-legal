import type { Page } from "playwright-core";
import type { Platform, PostInput } from "./types.ts";
import { uploadTimeoutMs, waitClickable, waitUploaded } from "./timing.ts";
import { typeCaption } from "./caption.ts";
import { needle, clickNamed, waitGone, postBlock } from "./remove.ts";

/** Facebook's one-off notices that hold a post until answered, recognised by their words. */
export const FB_NOTICE = /Review audience|All video posts are now reels|Choose who can see this and future/i;

/** Answer one such notice with its own Continue/Done button. True when there was one. */
async function acceptNotice(page: Page, log: (m: string) => void): Promise<boolean> {
  const notice = page.locator('[role="dialog"]').filter({ hasText: FB_NOTICE }).last();
  if (!(await notice.isVisible({ timeout: 500 }).catch(() => false))) return false;
  const btn = notice.getByRole("button", { name: /^(Continue|Done|Save|OK)$/ }).last();
  if (!(await btn.isVisible({ timeout: 2000 }).catch(() => false))) return false;
  const what = (await notice.innerText().catch(() => "")).split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? "a notice";
  await btn.click();
  log(`Answered Facebook's one-time "${what}" notice (Continue keeps your usual audience).`);
  await page.waitForTimeout(1500);
  return true;
}

/** Facebook feed video post via the web composer. Facebook's DOM is heavily
 *  obfuscated, so these selectors are best-effort. */
export const facebook: Platform = {
  id: "facebook",
  label: "Facebook",
  loginUrl: "https://www.facebook.com/login",
  host: /^https:\/\/([a-z0-9-]+\.)*facebook\.com(\/|$)/,
  verified: true, // posted and deleted for real 2026-11-18

  async isLoggedIn(page: Page): Promise<boolean> {
    const cookies = await page.context().cookies("https://www.facebook.com");
    return cookies.some((c) => c.name === "c_user" && c.value.length > 0);
  },

  async post(page, input, log): Promise<void> {
    log("Opening Facebook");
    await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded" });
    if (page.url().includes("/login")) throw new Error("Facebook asked for login. Log in in the Chrome window, then run again.");

    // Open the status composer ("What's on your mind?").
    const opener = page.locator('[role="button"]:has-text("What\'s on your mind"), [aria-label*="What\'s on your mind"]').first();
    await opener.waitFor({ state: "visible", timeout: 30_000 });
    await opener.click();

    // In the composer dialog, choose Photo/video, then attach the file.
    const photoVideo = page.locator('[role="dialog"] [aria-label="Photo/video"], [role="dialog"] div:has-text("Photo/video")').first();
    if (await photoVideo.isVisible({ timeout: 5000 }).catch(() => false)) await photoVideo.click();
    const fileInput = page.locator('[role="dialog"] input[type="file"], input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(input.video);
    log("Video handed to the uploader, waiting for processing...");
    const uploadMs = uploadTimeoutMs(input.video);

    if (input.caption) {
      // Facebook keeps an older copy of the post box behind the one on screen: the last one is the live one.
      const box = page.locator('[role="dialog"] [contenteditable="true"][role="textbox"]').last();
      await box.waitFor({ state: "visible", timeout: 30_000 });
      // Facebook lays its placeholder over the text box, so an ordinary click is intercepted.
      await box.click({ force: true });
      await typeCaption(page, input.caption, 8);
      // Typing can land nowhere without an error, so read the box back before saying so.
      const first = input.caption.split("\n")[0].slice(0, 20);
      if (!(await box.innerText().catch(() => "")).includes(first)) {
        await box.evaluate((el) => (el as HTMLElement).focus());
        await typeCaption(page, input.caption, 8);
      }
      if (!(await box.innerText().catch(() => "")).includes(first)) throw new Error("Facebook's text box did not take the caption.");
      log("Text typed.");
    }

    const postBtn = page.locator('[role="dialog"] [aria-label="Post"][role="button"]').last();
    await postBtn.waitFor({ state: "visible", timeout: uploadMs });
    // Post is greyed out until Facebook has taken the video.
    await waitClickable(postBtn, "Facebook", uploadMs);
    // ...but only until it has started taking it: the composer's "Uploading video" bar is the
    // real sign. Posting (or a preview moving on) before it's full can cut a big video off.
    const composer = page.locator('[role="dialog"]').filter({ has: page.locator('[aria-label="Post"][role="button"]') }).last();
    await waitUploaded(async () => {
      const now = await composer.locator('[role="progressbar"][aria-label="Uploading video"]').first().getAttribute("aria-valuenow", { timeout: 2000 }).catch(() => null);
      return now === null ? { uploading: false, pct: null } : { uploading: Number(now) < 100, pct: Number(now) };
    }, "Facebook", uploadMs, log);

    if (input.dryRun) {
      log("DRY RUN: post is composed with the video attached. Not clicking Post.");
      return;
    }
    // Facebook redraws the composer the moment its upload finishes; a press in that instant can be lost.
    await page.waitForTimeout(1500);
    await postBtn.click({ force: true });
    input.clicked?.();
    log("Post clicked. Waiting for Facebook to finish uploading...");
    // A one-off notice can hold the post until it's answered (2026-11-22: "Review audience. All
    // video posts are now reels ... Continue"). Answer it; it keeps the audience already in use.
    const firstLine = (input.caption.split("\n")[0] ?? "").slice(0, 20);
    // Taken: the composer closes, or (since 2026-11-22) Facebook empties it for a new post and
    // leaves it open: no video attached any more and Post greyed out.
    const attached = composer.locator('[aria-label="Remove post attachment"], [aria-label*="1 added"]');
    const taken = async () => !(await composer.isVisible().catch(() => false))
      || ((await attached.count().catch(() => 1)) === 0 && (await postBtn.getAttribute("aria-disabled").catch(() => null)) === "true");
    const end = Date.now() + 20_000;
    let pressedAgain = false;
    while (Date.now() < end) {
      if (await acceptNotice(page, log)) continue;
      if (await taken()) break;
      // Facebook empties and closes the composer when it takes a post. Still showing this
      // caption with Post ready after 15 seconds, and no notice: the press never landed. Once.
      if (!pressedAgain && Date.now() > end - 5000 && (await postBtn.getAttribute("aria-disabled").catch(() => "true")) !== "true" && (!firstLine || (await composer.innerText().catch(() => "")).includes(firstLine))) {
        pressedAgain = true;
        log("Facebook didn't take the press of Post; pressing it again.");
        await postBtn.click({ force: true });
      }
      await page.waitForTimeout(1000);
    }
    const until = Date.now() + uploadMs;
    while (Date.now() < until && !(await taken())) {
      await acceptNotice(page, log);
      await page.waitForTimeout(1500);
    }
    if (!(await taken())) throw new Error("Post clicked but the Facebook composer never closed. Check the window.");
    // Tidy away the empty box Facebook leaves open for the next post.
    if (await composer.isVisible().catch(() => false)) await composer.locator('[aria-label="Close"]').first().click({ timeout: 5000 }).catch(() => {});
    log("Published.");
  },

  async remove(page, caption, log): Promise<void> {
    const text = needle(caption);
    await page.goto("https://www.facebook.com/me", { waitUntil: "domcontentloaded" });
    const menu = '[aria-label^="Actions for this post"]';
    const post = postBlock(page, text, menu);
    // A new video can take a minute or two to show on the profile while Facebook processes it.
    for (let i = 0; i < 8 && !(await post.isVisible({ timeout: 20_000 }).catch(() => false)); i++) {
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    await post.waitFor({ state: "visible", timeout: 20_000 });
    await post.locator(menu).first().click();
    await clickNamed(page, /Move to (trash|Recycle bin)|^Delete/i);
    await clickNamed(page.locator('[role="dialog"]').last(), /^(Move|Delete)$/);
    if (!(await waitGone(page, text))) throw new Error("Delete clicked but the post is still showing on Facebook.");
    log("Deleted (Facebook keeps it in your trash for 30 days).");
  },
};
