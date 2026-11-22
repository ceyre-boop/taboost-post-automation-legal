// npm run connect-check: is everything in place for the official sign-ins? Names only: no secret, no
// token and no access key is ever printed.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..", "..");
const ENV = join(ROOT, ".env");
if (existsSync(ENV)) process.loadEnvFile(ENV);
const { APP_DIR } = await import("../config.ts");
const { PROVIDERS, REDIRECT_URI, configured } = await import("./oauth.ts");
const { kcReachable } = await import("./keychain.ts");

const ok = (b: boolean) => (b ? "✓" : "✗");
const line = (s: string) => console.log(s);

line("Post Everywhere: official sign-in setup\n");
const ignored = spawnSync("git", ["-C", ROOT, "check-ignore", "-q", ".env"]).status === 0;
line(`${ok(ignored)} .env is ignored by git${ignored ? "" : "  <- fix before creating it"}`);
line(`${ok(existsSync(ENV))} .env exists${existsSync(ENV) ? ` (mode ${(statSync(ENV).mode & 0o777).toString(8)}${(statSync(ENV).mode & 0o077) ? ": run chmod 600 .env" : ""})` : ": copy .env.example to .env and fill it in yourself"}`);
for (const [p, s] of Object.entries(PROVIDERS)) {
  const set = s.env.map((k) => `${(process.env[k] ?? "").trim() ? "✓" : "✗"} ${k}`).join("   ");
  line(`${ok(configured(p as never))} ${s.label.padEnd(22)} ${set}`);
}
line(`\nRedirect URI to register in every developer app:\n  ${REDIRECT_URI}`);
try {
  const r = await fetch(REDIRECT_URI, { signal: AbortSignal.timeout(8000) });
  line(`${ok(r.ok)} the return page answers (${r.status})`);
} catch (e) { line(`✗ the return page didn't answer (${(e as Error).message})`); }
line(`${ok(kcReachable())} the Keychain is reachable`);
for (const f of ["access-token.txt", "phone-url.txt"]) {
  const p = join(APP_DIR, f);
  if (existsSync(p)) { const m = statSync(p).mode & 0o777; line(`${ok(!(m & 0o077))} ${f} is private (mode ${m.toString(8)})`); }
}
let conns: Record<string, Record<string, { account: string; expiresAt?: string }>> = {};
try { conns = JSON.parse(readFileSync(join(APP_DIR, "connections.json"), "utf8")); } catch { /* none yet */ }
const devices: Record<string, { name: string }> = (() => { try { return JSON.parse(readFileSync(join(APP_DIR, "devices.json"), "utf8")); } catch { return {}; } })();
line("\nConnected:");
let any = false;
for (const [dev, ps] of Object.entries(conns)) for (const [platform, c] of Object.entries(ps)) {
  any = true;
  const days = c.expiresAt ? Math.round((Date.parse(c.expiresAt) - Date.now()) / 86_400_000) : null;
  line(`  ${devices[dev]?.name ?? dev}: ${platform} as ${c.account}${days === null ? "" : days < 7 ? `  (connect again within ${days} days)` : `  (good for ${days} days)`}`);
}
if (!any) line("  nothing yet: on the phone, tap Connect next to a platform");
