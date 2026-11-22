// DEVELOPER ONLY: Claude Code on this Mac, run headless with no tools, as the post maker's
// AI. Imported only by dev-provider.ts and dev-provider.me.ts. The client build never
// bundles this file (desktop/build.mjs swaps the provider for dev-provider.client.ts,
// and src/bundle.test.ts fails if any of it reaches a client bundle).
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DevAnswer { text: string; model: string; input: number; output: number; }

/** Where `claude` is. A double-clicked app gets a bare PATH, so look in the usual places. */
export function findClaude(): string {
  for (const p of [join(homedir(), ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) if (existsSync(p)) return p;
  const r = spawnSync("/bin/zsh", ["-lc", "command -v claude"], { encoding: "utf8", timeout: 5000 });
  const found = r.status === 0 ? r.stdout.trim().split("\n").pop() ?? "" : "";
  return found && existsSync(found) ? found : "";
}

export function runClaudeCode(system: string, user: string, plain: (msg: string) => Error): Promise<DevAnswer> {
  const bin = findClaude();
  if (!bin) return Promise.reject(plain("Claude Code isn't installed on this Mac, so this build can't write posts."));
  return new Promise((resolve, reject) => {
    const args = ["-p", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json", "--system-prompt", system];
    const env = { ...process.env, PATH: [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? "/usr/bin:/bin"].join(":") };
    const p = spawn(bin, args, { cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"], env });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => p.kill(), 180_000);
    p.on("error", () => { clearTimeout(t); reject(plain("Claude Code couldn't be started on this Mac.")); });
    p.on("close", (code) => {
      clearTimeout(t);
      try {
        const j = JSON.parse(out) as { result?: string; is_error?: boolean; usage?: { input_tokens?: number; output_tokens?: number } };
        if (code === 0 && !j.is_error && typeof j.result === "string") return resolve({ text: j.result, model: "claude-code (developer)", input: Number(j.usage?.input_tokens ?? 0), output: Number(j.usage?.output_tokens ?? 0) });
        if (/log ?in|auth|credential/i.test(`${j.result ?? ""} ${err}`)) return reject(plain("Claude Code on this Mac isn't signed in. Open Terminal, run claude, and sign in once."));
      } catch { /* fall through */ }
      reject(plain("Developer mode: Claude Code didn't answer."));
    });
    p.stdin.end(user);
  });
}
