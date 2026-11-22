// Official sign-in (OAuth 2.0). Skyler taps Connect on her phone; the platform's own sign-in page
// opens in Safari (her saved passwords and Face ID work there); the platform sends her back to one
// static page on northbound-dev.com, which hands the one-time code to this Mac on the home Wi-Fi.
// The Mac swaps the code for posting permission with its client secret and keeps it in the Keychain.
//
// The `state` that rides along is signed (HMAC, key in the Keychain), names the Mac's address on the
// Wi-Fi, carries a one-time number tied to the phone that started it, and expires in 10 minutes. The
// return page and this Mac both refuse any address that isn't this Mac on the local network.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { api, ApiError, form } from "./http.ts";
import { kcDelete, kcGet, kcGetJson, kcSet, kcSetJson } from "./keychain.ts";
import { connectionsFor, PLATFORMS_OF, removeProvider, saveConnection, type Provider } from "./connections.ts";
import type { Tokens, WhoAmI } from "./types.ts";
import { youtubeWho } from "./youtube.ts";
import { GRAPH, metaWho } from "./meta.ts";
import { tiktokWho } from "./tiktok.ts";
import { linkedinWho } from "./linkedin.ts";

export const REDIRECT_URI = process.env.POSTER_OAUTH_REDIRECT || "https://northbound-dev.com/connect/callback.html";
/** Where a sign-in may come back to: this Mac on the local network, on the poster's ports. */
export const FINISH_HOST = /^([a-z0-9-]{1,63}\.local|localhost|127\.0\.0\.1):(4747|4748|4749)$/i;

type Spec = { label: string; auth: string; token: string; revoke?: string; env: string[]; scopes: string[]; pkce: boolean; who: (t: Tokens) => Promise<WhoAmI> };
export const PROVIDERS: Record<Provider, Spec> = {
  google: { label: "YouTube", auth: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", revoke: "https://oauth2.googleapis.com/revoke", env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], scopes: ["openid", "https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"], pkce: true, who: youtubeWho },
  meta: { label: "Facebook and Instagram", auth: "https://www.facebook.com/v27.0/dialog/oauth", token: `${GRAPH}/oauth/access_token`, env: ["META_APP_ID", "META_APP_SECRET", "META_LOGIN_CONFIG_ID"], scopes: [], pkce: false, who: metaWho },
  tiktok: { label: "TikTok", auth: "https://www.tiktok.com/v2/auth/authorize/", token: "https://open.tiktokapis.com/v2/oauth/token/", revoke: "https://open.tiktokapis.com/v2/oauth/revoke/", env: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"], scopes: ["user.info.basic", "video.upload"], pkce: false, who: tiktokWho },
  linkedin: { label: "LinkedIn", auth: "https://www.linkedin.com/oauth/v2/authorization", token: "https://www.linkedin.com/oauth/v2/accessToken", env: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"], scopes: ["openid", "profile", "w_member_social"], pkce: false, who: linkedinWho },
};

const env = (k: string) => (process.env[k] ?? "").trim();
export const configured = (p: Provider) => PROVIDERS[p].env.every((k) => env(k));
const clientId = (p: Provider) => env(PROVIDERS[p].env[0]);
const clientSecret = (p: Provider) => env(PROVIDERS[p].env[1]);
const b64u = (b: Buffer) => b.toString("base64url");

/* ---- the signed state ---------------------------------------------------------------------------------- */

function stateKey(): Buffer {
  let k = kcGet("state-key");
  if (!k) { k = b64u(randomBytes(32)); kcSet("state-key", k); }
  return Buffer.from(k, "base64url");
}
type StateBody = { v: 1; p: Provider; h: string; n: string; t: number };
export function signState(body: StateBody): string {
  const raw = b64u(Buffer.from(JSON.stringify(body)));
  return `${raw}.${b64u(createHmac("sha256", stateKey()).update(raw).digest())}`;
}
export function readState(state: string, now = Date.now()): StateBody {
  const [raw, sig] = String(state ?? "").split(".");
  if (!raw || !sig) throw new ApiError("That sign-in link isn't valid.");
  const want = createHmac("sha256", stateKey()).update(raw).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new ApiError("That sign-in link isn't valid.");
  const body = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as StateBody;
  if (body.v !== 1 || !PROVIDERS[body.p] || !FINISH_HOST.test(body.h)) throw new ApiError("That sign-in link isn't valid.");
  if (now - body.t > 10 * 60_000) throw new ApiError("That sign-in took longer than 10 minutes. Tap Connect again.");
  return body;
}

/** Started sign-ins, by their one-time number: used once, gone after 10 minutes. */
const pending = new Map<string, { device: string; provider: Provider; verifier?: string; host: string; exp: number }>();

/** The platform's own sign-in page, for this phone. `host` is the address the phone used to reach the Mac. */
export function startConnect(device: string, provider: Provider, host: string, now = Date.now()): string {
  if (!configured(provider)) throw new ApiError(`${PROVIDERS[provider].label} isn't set up on this Mac yet (npm run connect-check says what's missing).`);
  if (!FINISH_HOST.test(host)) throw new ApiError("Open the poster on the home Wi-Fi link to connect accounts.");
  for (const [n, p] of pending) if (p.exp < now) pending.delete(n);
  const n = b64u(randomBytes(16));
  const s = PROVIDERS[provider];
  const verifier = s.pkce ? b64u(randomBytes(32)) : undefined;
  pending.set(n, { device, provider, verifier, host, exp: now + 10 * 60_000 });
  const state = signState({ v: 1, p: provider, h: host, n, t: now });
  const q = new URLSearchParams({ redirect_uri: REDIRECT_URI, response_type: "code", state });
  if (provider === "tiktok") { q.set("client_key", clientId(provider)); q.set("scope", s.scopes.join(",")); }
  else q.set("client_id", clientId(provider));
  if (provider === "google") { q.set("scope", s.scopes.join(" ")); q.set("access_type", "offline"); q.set("prompt", "consent"); q.set("include_granted_scopes", "true"); }
  if (provider === "linkedin") q.set("scope", s.scopes.join(" "));
  if (provider === "meta") q.set("config_id", env("META_LOGIN_CONFIG_ID"));
  if (verifier) { q.set("code_challenge", b64u(createHash("sha256").update(verifier).digest())); q.set("code_challenge_method", "S256"); }
  return `${s.auth}?${q}`;
}

const tokensKey = (device: string, p: Provider) => `${device}/${p}`;

/** The platform sent her back with a code: swap it, see who she is, keep the permission. */
export async function finishConnect(code: string, state: string, host: string, now = Date.now()): Promise<{ provider: Provider; account: string; platforms: string[] }> {
  const st = readState(state, now);
  const pend = pending.get(st.n);
  if (!pend || pend.provider !== st.p || pend.exp < now) throw new ApiError("That sign-in was already used or has expired. Tap Connect again.");
  if (pend.host.toLowerCase() !== String(host).toLowerCase() && st.h.toLowerCase() !== String(host).toLowerCase()) throw new ApiError("That sign-in came back to a different address.");
  pending.delete(st.n); // one use, whatever happens next
  const t = await exchange(st.p, code, pend.verifier, now);
  const who = await PROVIDERS[st.p].who(t);
  const full: Tokens = { ...t, ...(who.tokens ?? {}) };
  kcSetJson(tokensKey(pend.device, st.p), full);
  const platforms = PLATFORMS_OF[st.p];
  const at = new Date(now).toISOString();
  for (const platform of platforms) {
    const ids = who.identities[platform] ?? [];
    if (!ids.length) continue;
    saveConnection(pend.device, { platform, provider: st.p, account: who.account, identities: ids, scopes: (t.scope ?? "").split(/[ ,]+/).filter(Boolean), connectedAt: at, expiresAt: st.p === "google" || st.p === "tiktok" ? undefined : t.expires_at ? new Date(t.expires_at).toISOString() : undefined });
  }
  return { provider: st.p, account: who.account, platforms };
}

async function exchange(p: Provider, code: string, verifier: string | undefined, now: number): Promise<Tokens> {
  const s = PROVIDERS[p];
  const when = (sec: unknown) => (Number(sec) > 0 ? now + Number(sec) * 1000 : undefined);
  if (p === "meta") {
    const short = await api<any>("Facebook", `${s.token}?${new URLSearchParams({ client_id: clientId(p), client_secret: clientSecret(p), redirect_uri: REDIRECT_URI, code })}`);
    const long = await api<any>("Facebook", `${s.token}?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: clientId(p), client_secret: clientSecret(p), fb_exchange_token: short.access_token })}`);
    return { access_token: long.access_token, expires_at: when(long.expires_in ?? 60 * 24 * 3600) };
  }
  const body = p === "tiktok"
    ? form({ client_key: clientId(p), client_secret: clientSecret(p), code, grant_type: "authorization_code", redirect_uri: REDIRECT_URI })
    : form({ client_id: clientId(p), client_secret: clientSecret(p), code, grant_type: "authorization_code", redirect_uri: REDIRECT_URI, code_verifier: verifier });
  const j = await api<any>(s.label, s.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: when(j.expires_in), refresh_expires_at: when(j.refresh_expires_in), scope: j.scope, user_id: j.open_id };
}

/** A working permission for this phone and provider, refreshed if it ran out (TikTok hands back a new
    refresh token each time; it is kept). Throws a plain "connect again" when it can't be renewed. */
export async function tokensFor(device: string, p: Provider, now = Date.now()): Promise<Tokens> {
  const t = kcGetJson<Tokens>(tokensKey(device, p));
  if (!t?.access_token) throw new ApiError(`${PROVIDERS[p].label} isn't connected. Tap Connect.`);
  if (!t.expires_at || t.expires_at - 60_000 > now) return t;
  if (!t.refresh_token || (t.refresh_expires_at && t.refresh_expires_at < now)) throw new ApiError(`${PROVIDERS[p].label}'s permission ran out. Tap Connect to sign in again.`);
  const s = PROVIDERS[p];
  const body = p === "tiktok"
    ? form({ client_key: clientId(p), client_secret: clientSecret(p), grant_type: "refresh_token", refresh_token: t.refresh_token })
    : form({ client_id: clientId(p), client_secret: clientSecret(p), grant_type: "refresh_token", refresh_token: t.refresh_token });
  const j = await api<any>(s.label, s.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const next: Tokens = { ...t, access_token: j.access_token, refresh_token: j.refresh_token ?? t.refresh_token, expires_at: Number(j.expires_in) > 0 ? now + Number(j.expires_in) * 1000 : undefined, refresh_expires_at: Number(j.refresh_expires_in) > 0 ? now + Number(j.refresh_expires_in) * 1000 : t.refresh_expires_at };
  kcSetJson(tokensKey(device, p), next);
  return next;
}

/** Disconnect: tell the platform to drop the permission, forget it here. */
export async function disconnectProvider(device: string, p: Provider): Promise<void> {
  const t = kcGetJson<Tokens>(tokensKey(device, p));
  const s = PROVIDERS[p];
  try {
    if (t?.access_token && p === "google") await api("YouTube", `${s.revoke}?${new URLSearchParams({ token: t.refresh_token ?? t.access_token })}`, { method: "POST" });
    if (t?.access_token && p === "tiktok") await api("TikTok", s.revoke!, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ client_key: clientId(p), client_secret: clientSecret(p), token: t.access_token }) });
    if (t?.access_token && p === "meta") await api("Facebook", `${GRAPH}/me/permissions?access_token=${encodeURIComponent(t.access_token)}`, { method: "DELETE" });
  } catch { /* the platform may already have dropped it; it is forgotten here either way */ }
  kcDelete(tokensKey(device, p));
  removeProvider(device, p);
}

/** For the phone and connect-check: which platforms are connected, as whom, until when. Names only. */
export function connectionView(device: string) {
  const mine = connectionsFor(device);
  return {
    providers: Object.fromEntries((Object.keys(PROVIDERS) as Provider[]).map((p) => [p, { label: PROVIDERS[p].label, configured: configured(p), platforms: PLATFORMS_OF[p] }])),
    platforms: mine,
  };
}
