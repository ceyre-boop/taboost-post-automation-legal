// Northbound Poster — phone remote.
// Starts the tool's Chrome, the upload server, and a public tunnel so a phone can
// post from anywhere. The phone only ever uploads a video + caption; the posting
// runs here, on this machine's logged-in Chrome. No API keys, no stored passwords.
//
//   node src/remote.ts [--port 4747] [--lan]
//
// A random access key is minted each run and baked into the phone URL, so a stranger
// who guesses the tunnel address still can't post. Connect the accounts once in the
// Chrome window that opens (TikTok, Instagram, …); the session stays in the profile.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { launchChrome, killToolChrome } from "./chrome.ts";
import { startServer } from "./server.ts";
import { CDP_PORT, APP_DIR } from "./config.ts";

const URL_FILE = join(APP_DIR, "phone-url.txt");       // always holds the current live link
const TOKEN_FILE = join(APP_DIR, "access-token.txt");  // stable key so the link survives restarts
const LOCK_FILE = join(APP_DIR, "remote.lock");        // one phone remote per app folder

/* Settings the official sign-ins need (client ids and secrets) live in .env next to the code,
   filled in by the owner, never committed (.gitignore). */
const ENV_FILE = join(import.meta.dirname, "..", ".env");
if (existsSync(ENV_FILE)) { try { process.loadEnvFile(ENV_FILE); } catch (e) { console.error(`Couldn't read .env: ${(e as Error).message}`); } }

/** Two remotes on one app folder fight over its Chrome profiles and ports (Nov 2026: a second,
 *  hand-started one gave a phone the same Chrome port as another phone). The second one stops. */
function takeLock(): void {
  try {
    const held = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as { pid: number; port: number };
    if (held.pid && held.pid !== process.pid) {
      try { process.kill(held.pid, 0); console.error(`Another phone remote is already running for this app folder (pid ${held.pid}, port ${held.port}). Stopping.`); process.exit(1); } catch { /* stale */ }
    }
  } catch { /* no lock */ }
  mkdirSync(APP_DIR, { recursive: true });
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, port: Number(arg("port")) || 4747 }), { mode: 0o600 });
  process.on("exit", () => { try { if (JSON.parse(readFileSync(LOCK_FILE, "utf8")).pid === process.pid) unlinkSync(LOCK_FILE); } catch { /* gone */ } });
}
/** The key and the link let anyone on the Wi-Fi post: only this Mac's user may read them. The .env holds
 *  the platforms' app secrets, the lock names a process, and the app folder itself is this user's alone. */
for (const f of [TOKEN_FILE, URL_FILE, ENV_FILE, LOCK_FILE, join(APP_DIR, "secrets.json")]) { try { if (existsSync(f)) chmodSync(f, 0o600); } catch { /* not ours */ } }
try { mkdirSync(APP_DIR, { recursive: true }); chmodSync(APP_DIR, 0o700); } catch { /* not ours */ }

/** Reuse the saved access key if there is one, so the phone link stays the same. */
function stableToken(): string {
  try { const t = readFileSync(TOKEN_FILE, "utf8").trim(); if (t) return t; } catch {}
  const t = randomBytes(18).toString("base64url"); // 144 bits
  try { mkdirSync(APP_DIR, { recursive: true }); writeFileSync(TOKEN_FILE, t, { mode: 0o600 }); chmodSync(TOKEN_FILE, 0o600); } catch {}
  return t;
}

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (flag: string) => process.argv.includes(`--${flag}`);

let PORT = Number(arg("port")) || 4747;
const TOKEN = has("new-key") ? randomBytes(18).toString("base64url") : stableToken();

function have(cmd: string): boolean {
  try { return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0; }
  catch { return false; }
}

/** The Mac's Bonjour name (e.g. Sams-MacBook-Pro.local). Unlike the IP it doesn't
 *  change when the Wi-Fi hands out a new address, so the phone link keeps working. */
function bonjourHost(): string | null {
  try {
    const r = spawnSync("scutil", ["--get", "LocalHostName"], { encoding: "utf8" });
    const n = r.stdout?.trim();
    if (r.status === 0 && n) return `${n}.local`;
  } catch {}
  return null;
}

function lanIP(): string | null {
  for (const iface of Object.values(networkInterfaces())) {
    for (const net of iface ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}

/**
 * Keep a cloudflared quick-tunnel alive. These free tunnels can drop their hostname
 * even while the process lives, so we respawn on exit and re-announce whenever the
 * public URL changes. `onUrl` fires with each new base URL. Returns a stop fn.
 */
function manageTunnel(port: number, onUrl: (base: string) => void): () => void {
  let proc: ChildProcess | null = null;
  let current = "";
  let stopped = false;
  const spawnOne = () => {
    proc = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const scan = (buf: Buffer) => {
      // Quick-tunnel hostnames are hyphenated random words (e.g. foo-bar-baz-qux);
      // the ≥1 hyphen requirement excludes cloudflared's own api.trycloudflare.com.
      const m = buf.toString().match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/);
      if (m && m[0] !== current) { current = m[0]; onUrl(current); }
    };
    proc.stdout!.on("data", scan);
    proc.stderr!.on("data", scan); // cloudflared prints the URL to stderr
    proc.on("exit", () => {
      if (stopped) return;
      console.log("Tunnel dropped — reconnecting (the phone link will change)…");
      current = "";
      setTimeout(spawnOne, 1500);
    });
  };
  spawnOne();
  return () => { stopped = true; try { proc?.kill(); } catch {} };
}

function box(lines: string[]): void {
  const w = Math.max(...lines.map((l) => l.length));
  const bar = "─".repeat(w + 2);
  console.log(`\n┌${bar}┐`);
  for (const l of lines) console.log(`│ ${l.padEnd(w)} │`);
  console.log(`└${bar}┘\n`);
}

async function main(): Promise<void> {
  takeLock();
  console.log("Starting Northbound Poster phone remote…");
  await launchChrome("https://www.tiktok.com/tiktokstudio/upload"); // opens the profile's Chrome

  const useTunnel = !has("lan") && have("cloudflared");
  const host = useTunnel ? "127.0.0.1" : "0.0.0.0";
  // Find a free port — the Electron app or a prior run may already hold 4747.
  for (let tries = 0; ; tries++) {
    try { await startServer({ port: PORT, host, open: false, token: TOKEN }); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE" && tries < 10) {
        console.log(`Port ${PORT} busy, trying ${PORT + 1}…`); PORT++; continue;
      }
      throw e;
    }
  }

  const lan = lanIP();
  const ipUrl = `http://${lan ?? "127.0.0.1"}:${PORT}/m?k=${TOKEN}`;
  const mdns = bonjourHost();
  const lanUrl = mdns ? `http://${mdns}:${PORT}/m?k=${TOKEN}` : ipUrl;

  const announce = (phoneUrl: string, anywhere: boolean) => {
    try { writeFileSync(URL_FILE, phoneUrl + "\n", { mode: 0o600 }); chmodSync(URL_FILE, 0o600); } catch {}
    // Copied to the clipboard only when someone started this by hand: under the boot service
    // nobody is there to paste it, and the clipboard is shared with the person's other devices.
    const byHand = !!process.stdout.isTTY;
    if (byHand) { try { const p = spawn("pbcopy"); p.stdin.end(phoneUrl); } catch {} }
    // The log file keeps the link without its key.
    const shown = byHand ? phoneUrl : phoneUrl.replace(/([?&]k=)[^&]+/, "$1(saved in phone-url.txt)");
    box([
      "Northbound Poster is live. Open this on the iPhone:",
      "",
      shown,
      "",
      anywhere ? `Works from anywhere${byHand ? " (copied to clipboard — AirDrop/text it)" : ""}.`
               : `Phone must be on the SAME Wi-Fi${byHand ? " (copied to clipboard)" : ""}. This link is not encrypted: use it on your own Wi-Fi only.`,
      ...(anywhere && lan && byHand ? [`Same-Wi-Fi backup: ${lanUrl}`] : []),
      ...(!anywhere && mdns && byHand ? [`(Backup by address, changes with the Wi-Fi: ${ipUrl})`] : []),
      "",
      "First: connect accounts in the Chrome window that opened,",
      "then refresh the phone page. Keep this running.",
    ]);
    console.log(`Chrome CDP :${CDP_PORT} · current link saved to ${URL_FILE} · new key: run with --new-key`);
    console.log("Press Ctrl-C to stop.\n");
  };

  let stopTunnel: (() => void) | null = null;
  if (useTunnel) {
    // Self-healing: re-announces (and rewrites the link file) on every reconnect.
    stopTunnel = manageTunnel(PORT, (base) => announce(`${base}/m?k=${TOKEN}`, true));
  } else {
    if (!have("cloudflared")) console.log("(cloudflared not installed — same-Wi-Fi link only. `brew install cloudflared` for an anywhere link.)");
    announce(lanUrl, false);
  }

  const stop = () => { try { stopTunnel?.(); } catch {} ; killToolChrome(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => { console.error(`ERROR: ${(e as Error).message}`); process.exit(1); });
