import type { BrowserContext, Page } from "playwright-core";
import { attach, launchChrome } from "./chrome.ts";
import { defaultProfile, type Profile } from "./config.ts";

/** One Playwright attach at a time PER PROFILE. Chrome over CDP does not like concurrent
 *  sessions, but two different profiles are two different Chromes and can run side by side. */
const chains = new Map<string, Promise<unknown>>();
export function withBrowser<T>(
  fn: (ctx: BrowserContext) => Promise<T>,
  startUrl = "about:blank",
  profile: Profile = defaultProfile,
): Promise<T> {
  const prev = chains.get(profile.dir) ?? Promise.resolve();
  const run = prev.then(async () => {
    await launchChrome(startUrl, profile);
    const { browser, context } = await attach(profile, startUrl);
    try {
      return await fn(context);
    } finally {
      await browser.close().catch(() => {});
    }
  });
  chains.set(profile.dir, run.catch(() => {}));
  return run;
}

/** Reuse the tab already on this platform's site, otherwise open a new one. */
export async function pageFor(context: BrowserContext, hostMatch: RegExp): Promise<Page> {
  const existing = context.pages().find((p) => hostMatch.test(p.url()));
  return existing ?? (await context.newPage());
}
