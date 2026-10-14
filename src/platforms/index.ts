import type { Platform } from "./types.ts";
import { tiktok } from "./tiktok.ts";

export const PLATFORMS: Record<string, Platform> = { tiktok };

export function getPlatform(id: string): Platform {
  const p = PLATFORMS[id];
  if (!p) throw new Error(`Unknown platform "${id}". Known: ${Object.keys(PLATFORMS).join(", ")}`);
  return p;
}
