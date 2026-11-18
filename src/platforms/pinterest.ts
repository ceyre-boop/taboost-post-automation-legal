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

    // Board: Pinterest will not publish without one. Use the first the picker offers.
    const boardPicker = page.locator('[data-test-id="board-dropdown-select-button"]').first();
    await boardPicker.waitFor({ state: "visible", timeout: 60_000 });
    if (/choose a board/i.test(await boardPicker.innerText())) {
      await boardPicker.click();
      const firstBoard = page.locator('[data-test-id="board-row"], [data-test-id^="board-row"], [role="listbox"] [role="option"]').first();
      if (!(await firstBoard.isVisible({ timeout: 6000 }).catch(() => false))) {
        await page.keyboard.press("Escape").catch(() => {});
        throw new Error("Pinterest has no board to pin to. Make one board on Pinterest, then run again.");
      }
      await firstBoard.click();
    }

    const publishBtn = page.getByRole("button", { name: "Publish", exact: true }).first();
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
