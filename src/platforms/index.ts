import type { Platform } from "./types.ts";
import { tiktok } from "./tiktok.ts";
import { instagram } from "./instagram.ts";
import { youtube } from "./youtube.ts";
import { x } from "./x.ts";
import { facebook } from "./facebook.ts";
import { linkedin } from "./linkedin.ts";
import { pinterest } from "./pinterest.ts";
import { threads } from "./threads.ts";

export const PLATFORMS: Record<string, Platform> = { tiktok, instagram, youtube, x, facebook, linkedin, pinterest, threads };

export function getPlatform(id: string): Platform {
  const p = PLATFORMS[id];
  if (!p) throw new Error(`Unknown platform "${id}". Known: ${Object.keys(PLATFORMS).join(", ")}`);
  return p;
}
