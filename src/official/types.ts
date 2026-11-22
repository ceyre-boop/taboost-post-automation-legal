import type { Identity } from "./connections.ts";

/** What the Keychain holds for one provider (never logged, never sent to the phone). */
export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // ms
  refresh_expires_at?: number; // ms
  scope?: string;
  /** Meta: each Page's own token, and which Page each Instagram account belongs to */
  pages?: Record<string, string>;
  ig_page?: Record<string, string>;
  /** TikTok open_id, LinkedIn member id */
  user_id?: string;
}

export interface Song { title: string; artist: string; credit?: Record<string, boolean>; igAudioId?: string }

export interface OfficialPost {
  file: string;
  caption: string;
  /** YouTube's title (the first caption line when not given) */
  title?: string;
  /** which Page / Instagram account / channel */
  identity: string;
  /** a private test: YouTube private, Facebook draft, TikTok inbox, Instagram skipped */
  test: boolean;
  /** false = a preview: check everything, post nothing */
  live: boolean;
  song?: Song;
  /** seconds, when known (Facebook Reels are 3-90 s) */
  duration?: number;
}

export interface OfficialResult { status: "done" | "draft" | "skipped"; remoteId?: string; link?: string; note?: string }
export type Log = (m: string) => void;

/** Who signed in, and which identities each platform can post as. */
export interface WhoAmI { account: string; identities: Record<string, Identity[]>; tokens?: Partial<Tokens> }
