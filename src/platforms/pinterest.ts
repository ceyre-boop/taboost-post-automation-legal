import type { Page } from "playwright-core";
import type { Platform, PostInput } from "./types.ts";

/** Pinterest pin-builder video pin. Needs a board selection (defaults to the first).
 *  Best-effort selectors — UNVERIFIED until a dry run. Caption: first line = title. */
export const pinterest: Platform = {
  id: "pinterest",
  label: "Pinterest",
  loginUrl: "https://www.pinterest.com/login/",
  host: /pinterest\.com/,
  verified: false,

  async isLoggedIn(page: Page): Promise<boolean> {
    const cookies = await page.context().cookies("https://www.pinterest.com");
    return cookies.some((c) => c.name === "_pinterest_sess" && c.value.length > 40);
  },

  async post(page, input, log): Promise<void> {
    log("Opening Pinterest pin builder");
    await page.goto("https://www.pinterest.com/pin-builder/", { waitUntil: "domcontentloaded" });
    if (page.url().includes("/login")) throw new Error("Pinterest asked for login. Log in in the Chrome window, then run again.");

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(input.video);
    log("Video handed to the uploader, waiting for processing...");

    const [title, ...rest] = input.caption.split("\n");
    const titleBox = page.locator('[id*="title"] textarea, textarea[placeholder*="title"], [data-test-id="pin-draft-title"] textarea').first();
    if (await titleBox.isVisible({ timeout: 30_000 }).catch(() => false)) {
      await titleBox.click();
      await page.keyboard.type((title || "Untitled").slice(0, 100), { delay: 8 });
    }
    if (rest.length) {
      const descBox = page.locator('[data-test-id="pin-draft-description"] [contenteditable="true"], [contenteditable="true"][aria-label*="description"]').first();
      if (await descBox.isVisible().catch(() => false)) { await descBox.click(); await page.keyboard.type(rest.join("\n"), { delay: 6 }); }
    }
    log("Title/description filled.");

    // Board: default to the first board the picker offers.
    const boardPicker = page.locator('[data-test-id="board-dropdown-select-button"], button:has-text("Choose a board")').first();
    if (await boardPicker.isVisible({ timeout: 4000 }).catch(() => false)) {
      await boardPicker.click();
      const firstBoard = page.locator('[role="listbox"] [role="option"], [data-test-id="board-row"]').first();
      await firstBoard.click().catch(() => {});
    }

    const publishBtn = page.locator('[data-test-id="board-dropdown-save-button"], button:text-is("Publish"), button:text-is("Save")').first();
    await publishBtn.waitFor({ state: "visible", timeout: 180_000 });

    if (input.dryRun) {
      log("DRY RUN: pin is ready with the video + a board selected. Not clicking Publish.");
      return;
    }
    await publishBtn.click();
    log("Publish clicked. Waiting for Pinterest to confirm...");
    await page.getByText(/Your Pin|Pin published|was published/i).first()
      .waitFor({ state: "visible", timeout: 120_000 })
      .catch(() => { throw new Error("Publish clicked but Pinterest never confirmed. Check the window."); });
    log("Published.");
  },
};
