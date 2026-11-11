// The thinking stages call Claude through the local `claude` CLI (the Max plan
// already signed in on this Mac) — no API key in this repo. Same env hygiene as
// PAI's Inference tool: drop CLAUDECODE so it runs as its own session, and drop
// API-key vars so they can't silently override the signed-in account.
import { spawn } from "node:child_process";

export async function askClaude(system: string, prompt: string, opts: { model?: string; timeoutMs?: number } = {}): Promise<string> {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const args = ["-p", "--model", opts.model ?? "sonnet", "--output-format", "text", "--append-system-prompt", system, "--tools", ""];
  return new Promise((resolve, reject) => {
    const p = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { p.kill(); reject(new Error("claude timed out")); }, opts.timeoutMs ?? 240_000);
    p.on("close", (code) => {
      clearTimeout(t);
      code === 0 ? resolve(out.trim()) : reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
    });
    p.stdin.end(prompt);
  });
}

/** Pull the first JSON object/array out of a reply (tolerates ```json fences). */
export function extractJson<T>(reply: string): T {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : reply;
  const start = body.search(/[\[{]/);
  if (start < 0) throw new Error(`no JSON in reply: ${reply.slice(0, 200)}`);
  const open = body[start], close = open === "{" ? "}" : "]";
  const end = body.lastIndexOf(close);
  return JSON.parse(body.slice(start, end + 1)) as T;
}
