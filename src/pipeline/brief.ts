// Stage 1: the channel brief. Written by a person, once per business.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface SourceSpec {
  path: string;
  kind: "csv" | "text" | "json-lessons";
  id_column?: string;
  title_column?: string;
  fact_columns?: string[];
  max_rows?: number;
}

export interface Brief {
  business: string;
  audience: string;
  promise: string;
  tone: string;
  banned_claims: string[];
  call_to_action: string;
  platforms: string[];
  script: { seconds: number; words_per_second: number; hook_max_words: number };
  ai_label: Record<string, boolean> & { default: boolean };
  sources: SourceSpec[];
}

/** ~ and repo-relative paths → absolute. */
export function resolvePath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(REPO, p);
}

export function briefPath(business: string): string {
  return join(REPO, "briefs", `${business}.yaml`);
}

export function loadBrief(business: string): Brief {
  const file = briefPath(business);
  if (!existsSync(file)) throw new Error(`No brief at ${file}. Copy briefs/_template.yaml.`);
  return validateBrief(parse(readFileSync(file, "utf8")));
}

export function validateBrief(b: any): Brief {
  const missing = ["business", "audience", "promise", "tone", "banned_claims", "platforms", "sources"]
    .filter((k) => b?.[k] === undefined || b?.[k] === null || b?.[k] === "");
  if (missing.length) throw new Error(`Brief is missing: ${missing.join(", ")}`);
  if (!Array.isArray(b.sources) || !b.sources.length) throw new Error("Brief needs at least one source");
  return {
    ...b,
    audience: String(b.audience).trim(),
    promise: String(b.promise).trim(),
    tone: String(b.tone).trim(),
    banned_claims: (b.banned_claims ?? []).map(String),
    call_to_action: String(b.call_to_action ?? "Link in bio"),
    script: { seconds: 20, words_per_second: 2.5, hook_max_words: 6, ...(b.script ?? {}) },
    ai_label: { default: true, ...(b.ai_label ?? {}) },
  };
}

/** Spoken-word budget for the whole script. */
export function wordBudget(b: Brief): number {
  return Math.round(b.script.seconds * b.script.words_per_second);
}
