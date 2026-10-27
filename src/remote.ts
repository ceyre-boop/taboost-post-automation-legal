// TABOOST Poster — phone remote.
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
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchChrome, killToolChrome } from "./chrome.ts";
import { startServer } from "./server.ts";
import { CDP_PORT, APP_DIR } from "./config.ts";

const URL_FILE = join(APP_DIR, "phone-url.txt"); // always holds the current live link

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (flag: string) => process.argv.includes(`--${flag}`);

let PORT = Number(arg("port")) || 4747;
const TOKEN = randomBytes(9).toString("base64url"); // ~12 url-safe chars

function have(cmd: string): boolean {
  try { return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0; }
  catch { return false; }
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
      const m = buf.toString().match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/);
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
  console.log("Starting TABOOST Poster phone remote…");
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
  const lanUrl = `http://${lan ?? "127.0.0.1"}:${PORT}/m?k=${TOKEN}`;

  const announce = (phoneUrl: string, anywhere: boolean) => {
    try { writeFileSync(URL_FILE, phoneUrl + "\n"); } catch {}
    try { const p = spawn("pbcopy"); p.stdin.end(phoneUrl); } catch {} // handy on macOS
    box([
      "TABOOST Poster is live. Open this on the iPhone:",
      "",
      phoneUrl,
      "",
      anywhere ? "Works from anywhere (copied to clipboard — AirDrop/text it)."
               : "Phone must be on the SAME Wi-Fi (copied to clipboard).",
      ...(anywhere && lan ? [`Same-Wi-Fi backup: ${lanUrl}`] : []),
      "",
      "First: connect accounts in the Chrome window that opened,",
      "then refresh the phone page. Keep this running.",
    ]);
    console.log(`Chrome CDP :${CDP_PORT} · access key ${TOKEN} · current link saved to ${URL_FILE}`);
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
