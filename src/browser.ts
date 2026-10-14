import type { BrowserContext, Page } from "playwright-core";
import { attach, launchChrome } from "./chrome.ts";

/** One Playwright attach at a time. Chrome over CDP does not like concurrent sessions. */
let chain: Promise<unknown> = Promise.resolve();
export function withBrowser<T>(fn: (ctx: BrowserContext) => Promise<T>, startUrl = "about:blank"): Promise<T> {
  const run = chain.then(async () => {
    await launchChrome(startUrl);
    const { browser, context } = await attach(undefined, startUrl);
    try {
      return await fn(context);
    } finally {
      await browser.close().catch(() => {});
    }
  });
  chain = run.catch(() => {});
  return run;
}

/** Reuse the tab already on this platform's site, otherwise open a new one. */
export async function pageFor(context: BrowserContext, hostMatch: RegExp): Promise<Page> {
  const existing = context.pages().find((p) => hostMatch.test(p.url()));
  return existing ?? (await context.newPage());
}
