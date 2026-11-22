// Colin's own packaged copy: the post maker always writes with Claude Code on this Mac
// (his Max plan), so it never asks him for an API key. Only desktop/build.mjs --flavor=me
// bundles this file.
import { runClaudeCode, type DevAnswer } from "./claude-code.ts";

export interface DevProvider { mode: string; label: string; think(system: string, user: string, plain: (msg: string) => Error): Promise<DevAnswer>; }

const ME: DevProvider = { mode: "dev-max", label: "Colin's own build: the AI is Claude Code on this Mac (Max plan).", think: runClaudeCode };
export function devProvider(): DevProvider | null { return ME; }
