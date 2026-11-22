// DEVELOPER ONLY. Terminal runs: POSTER_DEV_MAX=1 in the environment of the process that
// starts the app makes the maker use Claude Code on this Mac instead of the API, so
// development doesn't spend API money. Never from settings, never from the app folder's
// .env, never from a request; the dashboard shows a red banner whenever it's on.
//
// The packaged builds replace this file (desktop/build.mjs): dev-provider.me.ts in Colin's
// own copy (always on), dev-provider.client.ts in clients' copies (nothing at all).
import { spawnSync } from "node:child_process";
import { runClaudeCode, type DevAnswer } from "./claude-code.ts";

export interface DevProvider { mode: string; label: string; think(system: string, user: string, plain: (msg: string) => Error): Promise<DevAnswer>; }

let onPath: boolean | null = null;
export function devProvider(): DevProvider | null {
  if (process.env.POSTER_DEV_MAX !== "1") return null;
  if (onPath === null) onPath = spawnSync("which", ["claude"]).status === 0;
  if (!onPath) return null;
  return { mode: "dev-max", label: "Developer mode: the AI is this Mac's Claude Code, not the API. Never run a client's install like this.", think: runClaudeCode };
}
