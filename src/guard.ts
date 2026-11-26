// Who may talk to the phone remote, and how hard they may knock.
//
// The link's access key is the only thing between the internet (through the tunnel) or
// the Wi-Fi and the signed-in accounts, so: it is compared in constant time, a client that
// guesses wrong too often is locked out (even if its next guess is right), and a flood of
// wrong guesses from everywhere at once slows down every wrong guess.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Equal strings, in time that doesn't depend on where they first differ. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  // Different lengths can't match; still do one comparison so the time doesn't tell the length apart.
  if (x.length !== y.length) { timingSafeEqual(x, x); return false; }
  return timingSafeEqual(x, y);
}

/** Who is knocking. Behind the tunnel every request comes from 127.0.0.1, and cloudflared says who
 *  really sent it in cf-connecting-ip; on the Wi-Fi it is the socket's own address. */
export function clientOf(req: IncomingMessage): string {
  const cf = req.headers["cf-connecting-ip"];
  const real = typeof cf === "string" && cf.length < 64 ? cf.trim() : "";
  return real || req.socket.remoteAddress || "unknown";
}

export const envInt = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export class KeyLimiter {
  private fails = new Map<string, number[]>();
  private locked = new Map<string, number>();
  private global: number[] = [];
  private perClient: number; private windowMs: number; private lockMs: number; private globalMax: number; private now: () => number;
  constructor(perClient = envInt("POSTER_KEY_FAILS", 8), windowSec = envInt("POSTER_KEY_WINDOW_SEC", 600), lockSec = envInt("POSTER_KEY_LOCK_SEC", 900), globalMax = envInt("POSTER_KEY_FAILS_GLOBAL", 200), now: () => number = Date.now) {
    this.perClient = perClient; this.windowMs = windowSec * 1000; this.lockMs = lockSec * 1000; this.globalMax = globalMax; this.now = now;
  }
  /** Is this client locked out right now? (checked before the key is even looked at) */
  blocked(client: string): boolean {
    const until = this.locked.get(client);
    if (until === undefined) return false;
    if (this.now() >= until) { this.locked.delete(client); this.fails.delete(client); return false; }
    return true;
  }
  /** Too many wrong guesses from everyone together: wrong guesses are refused fast, right ones still work. */
  floodActive(): boolean {
    const t = this.now() - this.windowMs;
    this.global = this.global.filter((x) => x > t);
    return this.global.length >= this.globalMax;
  }
  fail(client: string): void {
    const t = this.now();
    this.global.push(t);
    const list = (this.fails.get(client) ?? []).filter((x) => x > t - this.windowMs);
    list.push(t);
    this.fails.set(client, list);
    if (list.length >= this.perClient) this.locked.set(client, t + this.lockMs);
    if (this.fails.size > 5000) this.fails.clear(); // never let the table itself become the problem
    if (this.locked.size > 5000) this.locked.clear();
  }
  ok(client: string): void { this.fails.delete(client); }
}

/** At most `max` requests per client per window. Nobody posting by hand comes close. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private max: number; private windowMs: number; private now: () => number;
  constructor(max = envInt("POSTER_REQUESTS_PER_MIN", 400), windowMs = 60_000, now: () => number = Date.now) { this.max = max; this.windowMs = windowMs; this.now = now; }
  allow(client: string): boolean {
    const t = this.now();
    const list = (this.hits.get(client) ?? []).filter((x) => x > t - this.windowMs);
    if (list.length >= this.max) { this.hits.set(client, list); return false; }
    list.push(t);
    this.hits.set(client, list);
    if (this.hits.size > 5000) this.hits.clear();
    return true;
  }
}
