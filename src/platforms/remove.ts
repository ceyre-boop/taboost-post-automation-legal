import type { Locator, Page } from "playwright-core";

/** The text a post is recognised by when taking it down: the first line of its caption.
 *  Every remove() matches on this and refuses to delete anything that does not carry it. */
export function needle(caption: string): string {
  const first = caption.split("\n")[0].trim().slice(0, 60);
  if (first.length < 8) throw new Error("Caption is too short to find the post safely. Nothing deleted.");
  return first;
}

/** Click the first visible menu item or button with this name. These sites build menus out of
 *  div role=menuitem / role=button, and some out of bare divs, so look by role and then by text. */
export async function clickNamed(scope: Page | Locator, name: RegExp, timeout = 15_000): Promise<void> {
  const hit = scope.getByRole("menuitem", { name }).or(scope.getByRole("button", { name })).or(scope.getByText(name)).first();
  await hit.waitFor({ state: "visible", timeout });
  await hit.click();
}

/** Wait until nothing visible on the page shows the text any more (sites leave hidden copies). */
export async function waitGone(page: Page, text: string, timeout = 30_000): Promise<boolean> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await page.getByText(text).filter({ visible: true }).count()) === 0) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

/** The smallest block on the page that holds both the caption text and the post's own menu
 *  button. Nested blocks come back outermost first, so the last match is the post itself. */
export function postBlock(page: Page, text: string, menuButton: string): Locator {
  return page.locator("div, li, article").filter({ hasText: text }).filter({ has: page.locator(menuButton) }).last();
}
