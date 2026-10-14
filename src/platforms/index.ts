import type { Platform } from "./types.ts";
import { tiktok } from "./tiktok.ts";
import { instagram } from "./instagram.ts";
import { youtube } from "./youtube.ts";

export const PLATFORMS: Record<string, Platform> = { tiktok, instagram, youtube };

export function getPlatform(id: string): Platform {
  const p = PLATFORMS[id];
  if (!p) throw new Error(`Unknown platform "${id}". Known: ${Object.keys(PLATFORMS).join(", ")}`);
  return p;
}
