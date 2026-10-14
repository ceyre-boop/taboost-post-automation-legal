import type { Page } from "playwright-core";
import type { Platform } from "./types.ts";

/** Instagram web "Create" flow. Selectors are best-effort and UNVERIFIED on a live account. */
export const instagram: Platform = {
  id: "instagram",
  label: "Instagram",
  loginUrl: "https://www.instagram.com/accounts/login/",
  host: /instagram\.com/,

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

    const okBtn = page.locator('[role="dialog"] button:text-is("OK")').first();
    if (await okBtn.isVisible({ timeout: 4000 }).catch(() => false)) await okBtn.click();

    for (let i = 0; i < 2; i++) {
      const next = page.locator('[role="dialog"] [role="button"]:text-is("Next"), [role="dialog"] button:text-is("Next")').first();
      await next.waitFor({ state: "visible", timeout: 120_000 });
      await next.click();
      await page.waitForTimeout(1000);
    }
    const caption = page.locator('[role="dialog"] [aria-label="Write a caption..."], [role="dialog"] [contenteditable="true"]').first();
    await caption.waitFor({ state: "visible", timeout: 30_000 });
    await caption.click();
    await page.keyboard.type(input.caption, { delay: 15 });
    log("Caption typed.");

    const share = page.locator('[role="dialog"] [role="button"]:text-is("Share"), [role="dialog"] button:text-is("Share")').first();
    await share.waitFor({ state: "visible", timeout: 30_000 });
    if (input.dryRun) {
      log("DRY RUN: ready to share. Not clicking Share.");
      return;
    }
    await share.click();
    log("Share clicked. Waiting for Instagram to confirm...");
    await page.getByText(/has been shared|Post shared|Reel shared/i).first().waitFor({ state: "visible", timeout: 180_000 });
    log("Published.");
  },
};
