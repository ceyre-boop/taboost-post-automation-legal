import type { Page } from "playwright-core";

export interface PostInput {
  video: string;
  caption: string;
  /** When true (default) the flow stops right before the final publish click. */
  dryRun: boolean;
  /** Called right after the final publish click (live only). Anything that fails after this may
   *  already be posted, so it must not be retried blindly. */
  clicked?: () => void;
  /** A song to add from the platform's own library, so the post shows it and credits the
   *  artist. `mute` sets it to 0% so only the video's own sound is heard. Only platforms with
   *  `addsSongs` act on it. */
  song?: SongChoice;
  /** Told what happened to the song, in plain words, for the progress grid. */
  songNote?: (note: string) => void;
}

export interface SongChoice { title: string; artist: string; mute: boolean; }

export interface Platform {
  id: string;
  label: string;
  /** Where to send the user so they can log in. */
  loginUrl: string;
  /** Which tab belongs to this platform. */
  host: RegExp;
  /** True once a dry run has reached the publish screen on a real account.
   *  Unverified adapters still work in dry run but are flagged before going live. */
  verified?: boolean;
  /** True when its website can add a song from its own library (TikTok Studio can). */
  addsSongs?: boolean;
  /** True when the current tab's session is signed in. */
  isLoggedIn(page: Page): Promise<boolean>;
  /** Drive the native upload UI. */
  post(page: Page, input: PostInput, log: (m: string) => void): Promise<void>;
  /** Take down the post that carries this caption. Finds it on the account's own post list,
   *  and throws rather than deleting anything it cannot match to the caption. */
  remove?(page: Page, caption: string, log: (m: string) => void): Promise<void>;
}
