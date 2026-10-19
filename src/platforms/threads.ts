import type { Page } from "playwright-core";
import type { Platform, PostInput } from "./types.ts";

/** Threads web composer. Threads uses an Instagram-linked login. Best-effort
 *  selectors — UNVERIFIED until a dry run. */
export const threads: Platform = {
  id: "threads",
  label: "Threads",
  loginUrl: "https://www.threads.net/login",
  host: /threads\.(net|com)/,
  verified: false,

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
    const opener = page.locator('[role="button"]:has-text("Start a thread"), [aria-label="Create"], svg[aria-label="Create"]').first();
    await opener.waitFor({ state: "visible", timeout: 30_000 });
    await opener.click();

    // Attach media (there's usually a hidden file input in the composer dialog).
    const fileInput = page.locator('[role="dialog"] input[type="file"], input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(input.video);
    log("Video handed to the uploader, waiting for processing...");

    if (input.caption) {
      const box = page.locator('[role="dialog"] [contenteditable="true"], [contenteditable="true"][role="textbox"]').first();
      await box.waitFor({ state: "visible", timeout: 30_000 });
      await box.click();
      await page.keyboard.type(input.caption, { delay: 8 });
      log("Text typed.");
    }

    const postBtn = page.locator('[role="dialog"] [role="button"]:text-is("Post"), div[role="button"]:text-is("Post")').first();
    await postBtn.waitFor({ state: "visible", timeout: 180_000 });

    if (input.dryRun) {
      log("DRY RUN: thread is composed with the video attached. Not clicking Post.");
      return;
    }
    await postBtn.click({ force: true });
    log("Post clicked. Waiting for Threads to confirm...");
    await page.getByText(/Posted|Your thread/i).first()
      .waitFor({ state: "visible", timeout: 60_000 })
      .catch(() => { throw new Error("Post clicked but Threads never confirmed. Check the window."); });
    log("Published.");
  },
};
