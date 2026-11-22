// THE ONE PLACE THE POST MAKER TALKS TO AN AI MODEL. Policy: HOSTING.md.
//
// Two modes a client can be in:
//
//   "hosted" (default)  The app calls Northbound's backend (NORTHBOUND_AI_ENDPOINT),
//                       which holds Northbound's Anthropic key. The client signs in
//                       once and never sees a key.
//   "byo"               The client's own Anthropic API key, through the official SDK.
//
// A client's AI NEVER goes through a personal Claude subscription. There is one
// developer switch, POSTER_DEV_MAX=1, for the developer's own Mac only (see devMax()).
// The TABOOST tools in src/pipeline/ use the Max plan on purpose (internal work); this
// module never imports them, and src/maker/*.test.ts checks that.
//
// The model is handed text and hands text back. It has no tools; code (checks.ts)
// checks everything it writes. Every call is logged with tokens and estimated cost.
import Anthropic from "@anthropic-ai/sdk";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "../config.ts";

export type Mode = "hosted" | "byo";
/** What the call is for. The task decides the model. */
export type Task = "ideas" | "script";

/** Ideas are a short list: the cheapest model. The script is the product: the better one. */
export const MODELS: Record<Task, string> = {
  ideas: "claude-haiku-5-5",
  script: "claude-sonnet-5-5",
};

/** Dollars per million tokens (input, output), for the estimate in the usage log. */
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};

export class AiError extends Error {
  /** A sentence the person can act on. `setup` means nothing will work until they change something. */
  plain: string;
  setup: boolean;
  constructor(plain: string, setup = false, detail?: string) { super(detail ? `${plain} (${detail})` : plain); this.plain = plain; this.setup = setup; }
}

const root = () => process.env.POSTER_APP_DIR || ROOT_DIR;

/* ---------------- configuration: the environment, then a .env in the app folder ---------------- */

const ENV_KEYS = ["NORTHBOUND_AI_ENDPOINT", "NORTHBOUND_CLIENT_TOKEN", "ANTHROPIC_API_KEY"] as const;

/** Read one setting. The real environment wins; otherwise a `.env` file in the app folder.
 *  Only the three names above are ever read from that file. */
export function config(name: (typeof ENV_KEYS)[number]): string {
  const live = process.env[name];
  if (live !== undefined && live !== "") return live.trim();
  try {
    const path = join(root(), ".env");
    if (!existsSync(path)) return "";
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[1] === name && !line.trim().startsWith("#")) return m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch { /* an unreadable file is the same as no file */ }
  return "";
}

/* ---------------- the person's own key, saved on this Mac only ---------------- */

const secretsFile = () => join(root(), "secrets.json");
const readSecrets = (): { apiKey?: string } => { try { return JSON.parse(readFileSync(secretsFile(), "utf8")); } catch { return {}; } };

export function saveApiKey(key: string): void {
  mkdirSync(root(), { recursive: true });
  writeFileSync(secretsFile(), JSON.stringify({ ...readSecrets(), apiKey: key.trim() }), { mode: 0o600 });
  chmodSync(secretsFile(), 0o600);
}
export function forgetApiKey(): void {
  const s = readSecrets();
  delete s.apiKey;
  if (Object.keys(s).length) writeFileSync(secretsFile(), JSON.stringify(s), { mode: 0o600 });
  else if (existsSync(secretsFile())) rmSync(secretsFile());
}
const byoKey = (): string => readSecrets().apiKey || config("ANTHROPIC_API_KEY");
export const hasByoKey = (): boolean => byoKey() !== "";
export const isApiKey = (k: string): boolean => /^sk-ant-[A-Za-z0-9_\-]{20,300}$/.test(k.trim());

/** The mode the person chose. Anything other than exactly "byo" is Hosted. */
const modeFile = () => join(root(), "maker-ai.json");
export function readMode(): Mode { try { return JSON.parse(readFileSync(modeFile(), "utf8")).mode === "byo" ? "byo" : "hosted"; } catch { return "hosted"; } }
export function writeMode(mode: Mode): Mode {
  mkdirSync(root(), { recursive: true });
  const m: Mode = mode === "byo" ? "byo" : "hosted";
  writeFileSync(modeFile(), JSON.stringify({ mode: m }));
  return m;
}

/** The hosted endpoint, if one is set and safe to send the person's business details to. */
export function hostedEndpoint(): { url: string; problem: string } {
  const raw = config("NORTHBOUND_AI_ENDPOINT");
  if (!raw) return { url: "", problem: "Northbound hosting isn't set up yet." };
  try {
    const u = new URL(raw);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return { url: "", problem: "The hosting address isn't secure (it must start with https), so the app won't send anything to it." };
    return { url: u.toString(), problem: "" };
  } catch {
    return { url: "", problem: "The hosting address isn't a valid web address." };
  }
}

/* ---------------- the developer switch ---------------- */

let claudeOnPath: boolean | null = null;
/** DEVELOPER ONLY. POSTER_DEV_MAX=1 in the environment of the process that starts the app
 *  makes the maker use Claude Code on this Mac instead of the API, so development does not
 *  spend API money. Never from settings, never from the app folder's .env, never from a
 *  request; the dashboard shows a red banner whenever it is on. */
export function devMax(): boolean {
  if (process.env.POSTER_DEV_MAX !== "1") return false;
  if (claudeOnPath === null) claudeOnPath = spawnSync("which", ["claude"]).status === 0;
  return claudeOnPath;
}

/* ---------------- status, for the dashboard ---------------- */

export interface AiStatus { mode: Mode; ready: boolean; problem: string; hostedConfigured: boolean; byoKeySaved: boolean; devMax: boolean; models: Record<Task, string>; }

export function aiStatus(mode: Mode = readMode()): AiStatus {
  const hosted = hostedEndpoint();
  const base = { mode, hostedConfigured: !!hosted.url, byoKeySaved: hasByoKey(), devMax: devMax(), models: MODELS };
  if (base.devMax) return { ...base, ready: true, problem: "" };
  if (mode === "byo") return { ...base, ready: base.byoKeySaved, problem: base.byoKeySaved ? "" : "No API key is saved yet. Add one under Make, in AI settings." };
  return { ...base, ready: !!hosted.url, problem: hosted.url ? "" : `${hosted.problem} Until it is, you can add your own API key under Make, in AI settings.` };
}

/* ---------------- the usage log ---------------- */

export interface Usage { ts: string; mode: Mode | "dev-max"; task: Task; model: string; input_tokens: number; output_tokens: number; est_cost_usd: number; }

export function estimateCost(model: string, input: number, output: number): number {
  const [pin, pout] = PRICES[model] ?? PRICES["claude-sonnet-5-5"];
  return Math.round(((input * pin + output * pout) / 1_000_000) * 1e6) / 1e6;
}
const usageFile = () => join(root(), "usage.jsonl");
function logUsage(mode: Usage["mode"], task: Task, model: string, input: number, output: number): void {
  const row: Usage = { ts: new Date().toISOString(), mode, task, model, input_tokens: input, output_tokens: output, est_cost_usd: mode === "dev-max" ? 0 : estimateCost(model, input, output) };
  try { mkdirSync(root(), { recursive: true }); appendFileSync(usageFile(), JSON.stringify(row) + "\n", { mode: 0o600 }); } catch { /* a log that cannot be written never stops the work */ }
}
export function readUsage(): Usage[] {
  try { return readFileSync(usageFile(), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Usage); } catch { return []; }
}
export function usageSummary(): { today: { calls: number; cost: number }; total: { calls: number; cost: number } } {
  const rows = readUsage();
  const day = new Date().toISOString().slice(0, 10);
  const sum = (list: Usage[]) => Math.round(list.reduce((n, r) => n + r.est_cost_usd, 0) * 10000) / 10000;
  const today = rows.filter((r) => r.ts.startsWith(day));
  return { today: { calls: today.length, cost: sum(today) }, total: { calls: rows.length, cost: sum(rows) } };
}

/* ---------------- the ways a call can go ---------------- */

interface Answer { text: string; model: string; input: number; output: number; }

/** HOSTED. TODO(northbound-backend): the backend does not exist yet. When it does, this is
 *  the only function that changes (sign-in that issues NORTHBOUND_CLIENT_TOKEN). The request
 *  and response shapes are in HOSTING.md. */
async function hosted(task: Task, system: string, user: string): Promise<Answer> {
  const { url, problem } = hostedEndpoint();
  if (!url) throw new AiError(`${problem} Until it is, you can add your own API key under Make, in AI settings.`, true);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config("NORTHBOUND_CLIENT_TOKEN")}` },
      body: JSON.stringify({ app: "post-everywhere", task, system, user }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new AiError("Northbound's hosting couldn't be reached. Try again in a minute.");
  }
  const body = (await res.json().catch(() => ({}))) as { text?: string; model?: string; error?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  if (res.status === 401 || res.status === 403) throw new AiError("Northbound's hosting didn't recognise this install. Sign in again, or add your own API key.", true);
  if (res.status === 402 || res.status === 429) throw new AiError(body.error || "This month's hosted AI allowance has been used up.", true);
  if (!res.ok || typeof body.text !== "string" || !body.text.trim()) throw new AiError("Northbound's hosting returned an error. Try again in a minute.", false, `status ${res.status}`);
  return { text: body.text, model: body.model || MODELS[task], input: Number(body.usage?.input_tokens ?? 0), output: Number(body.usage?.output_tokens ?? 0) };
}

/** BYO-KEY: the client's own Anthropic key, through the official SDK. */
async function byo(task: Task, system: string, user: string): Promise<Answer> {
  const key = byoKey();
  if (!key) throw new AiError("No API key is saved yet. Add one under Make, in AI settings.", true);
  // POSTER_ANTHROPIC_BASE_URL exists so the tests can stand in for the API. Nothing else sets it.
  const client = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 120_000, baseURL: process.env.POSTER_ANTHROPIC_BASE_URL || undefined });
  const model = MODELS[task];
  const messages = [{ role: "user" as const, content: user }];
  try {
    const response = task === "script"
      // A safety check can decline a request; the fallback lets another model answer.
      ? await client.beta.messages.create({ model, max_tokens: 4000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", output_config: { effort: "low" }, system, messages })
      : await client.messages.create({ model, max_tokens: 2000, output_config: { effort: "low" }, system, messages });
    if (response.stop_reason === "refusal") throw new AiError("The AI declined this one. Try another idea.");
    const text = response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    if (!text.trim()) throw new AiError("The AI gave an empty answer. Try again.");
    return { text, model: response.model || model, input: response.usage.input_tokens ?? 0, output: response.usage.output_tokens ?? 0 };
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new AiError("That API key was refused. Check it in AI settings.", true);
    if (e instanceof Anthropic.PermissionDeniedError) throw new AiError("That API key isn't allowed to use this model. Check it in AI settings.", true);
    if (e instanceof Anthropic.RateLimitError) throw new AiError("The AI is busy, or the key has hit its limit. Try again in a minute.");
    if (e instanceof Anthropic.APIConnectionError) throw new AiError("The AI couldn't be reached. Check the internet connection.");
    if (e instanceof Anthropic.APIError) {
      const credit = e.status === 400 && /credit|billing/i.test(e.message);
      throw new AiError(credit ? "That API key has no credit left. Add credit in the Anthropic console." : "The AI returned an error. Try again in a minute.", credit, `status ${e.status}`);
    }
    throw e;
  }
}

/** DEVELOPER ONLY (see devMax). Claude Code on this Mac, headless, with no tools. */
function developerClaudeCode(system: string, user: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json", "--system-prompt", system];
    const p = spawn("claude", args, { cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill(), 180_000);
    p.on("close", (code) => {
      clearTimeout(t);
      try {
        const j = JSON.parse(out) as { result?: string; is_error?: boolean; usage?: { input_tokens?: number; output_tokens?: number } };
        if (code === 0 && !j.is_error && typeof j.result === "string") return resolve({ text: j.result, model: "claude-code (developer)", input: Number(j.usage?.input_tokens ?? 0), output: Number(j.usage?.output_tokens ?? 0) });
      } catch { /* fall through */ }
      reject(new AiError("Developer mode: Claude Code didn't answer."));
    });
    p.stdin.end(user);
  });
}

/* ---------------- what the rest of the maker calls ---------------- */

type Thinker = (task: Task, system: string, user: string) => Promise<string>;
let override: Thinker | null = null;
/** Tests replace the model with a function. */
export function setThinker(fn: Thinker | null): void { override = fn; }

export async function think(task: Task, system: string, user: string, mode: Mode = readMode()): Promise<string> {
  if (override) return override(task, system, user);
  const dev = devMax();
  const answer = dev ? await developerClaudeCode(system, user) : mode === "byo" ? await byo(task, system, user) : await hosted(task, system, user);
  logUsage(dev ? "dev-max" : mode, task, answer.model, answer.input, answer.output);
  return answer.text;
}

/** Pull the one JSON object out of a reply, even if it arrives wrapped in prose or a code fence. */
export function parseJson<T = Record<string, unknown>>(text: string): T {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new AiError("The AI gave an answer the app couldn't read. Try again.");
  try { return JSON.parse(text.slice(a, b + 1)) as T; } catch { throw new AiError("The AI gave an answer the app couldn't read. Try again."); }
}
