/** Each platform's caption limit, in characters (X counts its own way: see fitX in caption.ts). */
export const CAPTION_LIMITS: Record<string, number> = {
  tiktok: 2200, instagram: 2200, youtube: 5000, x: 280, facebook: 2200, linkedin: 3000, threads: 500,
};

// Each platform's own limits for a video uploaded on its website, taken from its official
// help pages on 2026-11-22 (links and quotes in docs/OFFICIAL-APIS.md). These are the
// platforms' limits, not the app's: the app takes any size, and when a platform takes less
// it posts a smaller copy there and the original everywhere else.

export interface UploadLimits {
  /** Largest file the site takes. Missing = the platform doesn't publish one. */
  maxBytes?: number;
  /** Longest video it takes, in seconds. */
  maxSeconds?: number;
  /** Shortest video it takes, in seconds. A copy can't fix this one. */
  minSeconds?: number;
  /** Highest bit rate it processes, in bits per second (LinkedIn says 30 Mbps). */
  maxBitrate?: number;
  /** The same limits for a paid tier, where the platform has one (X Premium). */
  premium?: Omit<UploadLimits, "premium" | "sources">;
  /** The help pages these come from. */
  sources: string[];
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const UPLOAD_LIMITS: Record<string, UploadLimits> = {
  // "Videos you upload in TikTok can be up to 60 minutes long." No size is published for the website.
  tiktok: { maxSeconds: 60 * 60, sources: ["https://support.tiktok.com/en/using-tiktok/creating-videos/camera-tools"] },
  // "You can record and edit videos up to 20 minutes with Instagram Reels." No size is published.
  instagram: { maxSeconds: 20 * 60, sources: ["https://help.instagram.com/225190788256708", "https://help.instagram.com/1038071743007909"] },
  // "The maximum file size you can upload is 256 GB or 12 hours, whichever is less."
  // (Over 15 minutes needs a verified account; YouTube says so on its own page when it applies.)
  youtube: { maxBytes: 256 * GB, maxSeconds: 12 * 3600, sources: ["https://support.google.com/youtube/answer/71673"] },
  // "...upload videos up to 140 seconds long with a maximum file size of 512MB." Premium: under 4 hours, 16GB.
  x: {
    maxBytes: 512 * MB, maxSeconds: 140,
    premium: { maxBytes: 16 * GB, maxSeconds: 4 * 3600 },
    sources: ["https://help.x.com/en/using-x/x-videos", "https://help.x.com/en/using-x/premium-longer-videos"],
  },
  // Meta's page upload help: up to 10 GB and under 240 minutes. Since June 2025 every video is a reel, "any length".
  facebook: { maxBytes: 10 * GB, maxSeconds: 240 * 60, sources: ["https://www.facebook.com/business/help/163131210928551", "https://creators.facebook.com/blog/making-it-easier-to-create-videos-on-facebook"] },
  // "Maximum file size: 5 GB ... Maximum video duration: 15 minutes ... Minimum ... 3 seconds when uploading from desktop ... Bit rates: 192 Kbps - 30 Mbps"
  linkedin: { maxBytes: 5 * GB, maxSeconds: 15 * 60, minSeconds: 3, maxBitrate: 30_000_000, sources: ["https://www.linkedin.com/help/linkedin/answer/a548372"] },
  // "photos and videos, up to 5 minutes long." Meta's assistant account on Threads gives 1 GB a file;
  // no help page does, so 1 GB is used to be safe (a smaller copy costs a little quality, a refusal costs the post).
  threads: { maxBytes: 1 * GB, maxSeconds: 5 * 60, sources: ["https://creators.instagram.com/threads", "https://www.threads.com/@threads/post/CyyjSsxuCkI"] },
};

/** What is known about a video. */
export interface VideoFacts { bytes: number; seconds: number; }

export type FitPlan =
  | { action: "as-is" }
  | { action: "smaller"; maxBytes?: number; maxBitrate?: number; trimTo?: number; say: string }
  | { action: "cannot"; say: string };

const sizeWords = (b: number) => (b >= GB ? `${+(b / GB).toFixed(1)} GB` : `${Math.round(b / MB)} MB`);
export function lengthWords(s: number): string {
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? "" : "s"}`;
  if (s >= 60) { const m = Math.floor(s / 60), r = Math.round(s % 60); return r ? `${m} min ${r} s` : `${m} minute${m === 1 ? "" : "s"}`; }
  return `${Math.round(s)} seconds`;
}

/** The limits that apply to this account (X Premium has its own). */
export function limitsFor(platformId: string, premium = false): UploadLimits | null {
  const l = UPLOAD_LIMITS[platformId];
  if (!l) return null;
  return premium && l.premium ? { ...l, ...l.premium, sources: l.sources } : l;
}

/**
 * Does this platform need a smaller copy of this video? Bigger than it takes, longer than
 * it takes (the copy is cut to its limit), or a higher bit rate than it processes. A video
 * shorter than its minimum can't be fixed by a copy, so that one is refused in plain words.
 */
export function planFor(platformId: string, label: string, v: VideoFacts, premium = false): FitPlan {
  const l = limitsFor(platformId, premium);
  if (!l || !v.bytes) return { action: "as-is" };
  if (l.minSeconds && v.seconds > 0 && v.seconds < l.minSeconds) {
    return { action: "cannot", say: `${label} takes videos of at least ${lengthWords(l.minSeconds)}; this one is ${v.seconds.toFixed(1)} seconds.` };
  }
  const tooBig = !!l.maxBytes && v.bytes > l.maxBytes;
  const tooLong = !!l.maxSeconds && v.seconds > l.maxSeconds + 0.05;
  const bitrate = v.seconds > 0 ? (v.bytes * 8) / v.seconds : 0;
  const tooDense = !!l.maxBitrate && bitrate > l.maxBitrate;
  if (!tooBig && !tooLong && !tooDense) return { action: "as-is" };
  const takes = [l.maxBytes ? `up to ${sizeWords(l.maxBytes)}` : "", l.maxSeconds ? `${l.maxBytes ? "and " : "up to "}${lengthWords(l.maxSeconds)}` : ""].filter(Boolean).join(" ");
  let say = tooDense && !tooBig && !tooLong
    ? `${label} handles videos up to ${l.maxBitrate! / 1e6} Mbps; this one got a lighter copy.`
    : `${label} takes videos ${takes}; this one got a smaller copy.`;
  if (tooLong) say += ` It was cut to the first ${lengthWords(l.maxSeconds!)}.`;
  return { action: "smaller", maxBytes: l.maxBytes, maxBitrate: l.maxBitrate, trimTo: tooLong ? l.maxSeconds : undefined, say };
}
