import { statSync } from "node:fs";

const MIN_MS = 300_000;
const MAX_MS = 45 * 60_000;

/** How long to wait for a video to upload and process: grows with file size (about 250 KB/s
 *  assumed plus two minutes of slack), never under 5 minutes, never over 45. */
export function uploadTimeoutMs(videoPath: string): number {
  let bytes: number;
  try {
    bytes = statSync(videoPath).size;
  } catch {
    return MIN_MS;
  }
  return Math.min(MAX_MS, Math.max(MIN_MS, 120_000 + (bytes / 250_000) * 1000));
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
