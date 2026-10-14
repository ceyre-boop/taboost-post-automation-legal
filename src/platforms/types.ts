import type { Page } from "playwright-core";

export interface PostInput {
  video: string;
  caption: string;
  /** When true (default) the flow stops right before the final publish click. */
  dryRun: boolean;
}

export interface Platform {
  id: string;
  label: string;
  /** Where to send the user so they can log in. */
  loginUrl: string;
  /** Which tab belongs to this platform. */
  host: RegExp;
  /** True when the current tab's session is signed in. */
  isLoggedIn(page: Page): Promise<boolean>;
  /** Drive the native upload UI. */
  post(page: Page, input: PostInput, log: (m: string) => void): Promise<void>;
}
