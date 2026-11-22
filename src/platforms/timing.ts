import { statSync } from "node:fs";

const MIN_MS = 300_000;
// Not a size limit in disguise: a 3 GB clip over a slow home connection needs hours. Where a
// site shows its upload progress, a stalled upload is caught long before this (waitUploaded).
const MAX_MS = 6 * 3600_000;

/** How long to wait for a video to upload and process: grows with file size (about 250 KB/s
 *  assumed plus two minutes of slack), never under 5 minutes, never over 6 hours. */
export function uploadTimeoutMs(videoPath: string): number {
  let bytes: number;
  try {
    bytes = statSync(videoPath).size;
  } catch {
    return MIN_MS;
  }
  return Math.min(MAX_MS, Math.max(MIN_MS, 120_000 + (bytes / 250_000) * 1000));
}

/** What a site's upload screen says right now: still sending, and how far along. */
export interface UploadState { uploading: boolean; pct: number | null; }

/**
 * Wait until the site has the whole video. YouTube and Facebook enable their Publish/Post
 * buttons while a video is still being sent, so a button alone isn't proof: on a home
 * connection a 3 GB clip takes many minutes, and leaving the page cuts it off. Says how far
 * along it is about every 30 seconds.
 */
export async function waitUploaded(
  read: () => Promise<UploadState>, label: string, timeoutMs: number, log: (m: string) => void,
  sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms)), stepMs = 2000,
): Promise<void> {
  let waited = 0, lastSaid = -30_000, lastPct = -1;
  // Only a stalled upload gives up: one still moving may take as long as it takes.
  let best = -1, movedAt = 0;
  const STALL_MS = 10 * 60_000;
  for (;;) {
    const s = await read().catch(() => ({ uploading: true, pct: null } as UploadState));
    if (!s.uploading) { if (lastPct >= 0) log(`${label} has the whole video.`); return; }
    if (s.pct !== null && s.pct > best) { best = s.pct; movedAt = waited; }
    if (waited - lastSaid >= 30_000 && s.pct !== null && s.pct !== lastPct) { log(`Sending the video to ${label}: ${Math.floor(s.pct)}%`); lastSaid = waited; lastPct = s.pct; }
    if (best >= 0 && waited - movedAt >= STALL_MS) throw new Error(`${label} stopped receiving the video at ${Math.floor(best)}% and didn't move for 10 minutes (the connection may have dropped)`);
    if (waited >= timeoutMs) throw new Error(`${label} was still receiving the video after ${Math.round(timeoutMs / 60_000)} minutes (the upload is too slow, or stopped)`);
    await sleep(stepMs);
    waited += stepMs;
  }
}

/** The minimal slice of a Playwright Locator that waitClickable needs. */
export interface ClickableLike {
  isEnabled(): Promise<boolean>;
  getAttribute(name: string): Promise<string | null>;
}

export function neverClickable(label: string): Error {
  return new Error(`${label}'s Post button never became clickable (the upload may still be processing)`);
}

/** Wait until the publish button is enabled. Never force-clicks a disabled button:
 *  throws if it is still disabled when the timeout runs out. */
export async function waitClickable(
  btn: ClickableLike,
  label: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms)),
  stepMs = 1000,
): Promise<void> {
  let waited = 0;
  for (;;) {
    const ok = (await btn.isEnabled().catch(() => false)) && (await btn.getAttribute("aria-disabled").catch(() => null)) !== "true";
    if (ok) return;
    if (waited >= timeoutMs) throw neverClickable(label);
    await sleep(stepMs);
    waited += stepMs;
  }
}
