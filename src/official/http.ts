// Calls to the platforms' official APIs. Every error message is passed through redact() first, so
// a token can never end up in a log line, a batch file, an API response or on the phone.
import { open } from "node:fs/promises";

export function redact(s: string): string {
  return String(s ?? "")
    .replace(/((?:access|refresh|id)_token|client_secret|fb_exchange_token|code|code_verifier)=([^&\s"']+)/gi, "$1=[hidden]")
    .replace(/(Bearer|OAuth)\s+[A-Za-z0-9._\-~+/=]+/g, "$1 [hidden]")
    .replace(/"((?:access|refresh|id)_token|client_secret)"\s*:\s*"[^"]*"/gi, '"$1":"[hidden]"');
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 0, code = "") { super(redact(message)); this.status = status; this.code = code; }
}

type Fetch = typeof fetch;
let fetcher: Fetch = (...a) => fetch(...a);
/** Tests swap in a fake. */
export function setFetch(f: Fetch | null): void { fetcher = f ?? ((...a) => fetch(...a)); }
export const rawFetch: Fetch = (...a) => fetcher(...a);

/** One call: JSON back, or an ApiError naming the platform and what it said (redacted). */
export async function api<T = any>(label: string, url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try { res = await fetcher(url, { ...init, signal: init.signal ?? AbortSignal.timeout(120_000) }); }
  catch (e) { throw new ApiError(`${label}: couldn't reach it (${(e as Error).message})`); }
  const text = await res.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (!res.ok || (body && typeof body === "object" && body.error && (body.error.code ?? "ok") !== "ok" && body.error.message)) {
    const msg = typeof body === "object" ? body?.error?.message ?? body?.error_description ?? body?.message ?? JSON.stringify(body).slice(0, 300) : String(body).slice(0, 300);
    throw new ApiError(`${label}: ${msg}`, res.status, typeof body === "object" ? String(body?.error?.code ?? body?.error ?? "") : "");
  }
  return body as T;
}

/** A form body for the APIs that take one. */
export const form = (o: Record<string, string | number | boolean | undefined>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));

/** Bytes [start, start+len) of a file, without loading the whole video into memory. */
export async function readChunk(file: string, start: number, len: number): Promise<Uint8Array<ArrayBuffer>> {
  const h = await open(file, "r");
  try {
    const out = new Uint8Array(new ArrayBuffer(len));
    const { bytesRead } = await h.read(out, 0, len, start);
    return bytesRead === len ? out : out.slice(0, bytesRead);
  } finally { await h.close(); }
}
