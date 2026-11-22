// Official sign-in and posting: the signed state, the Keychain, each platform's upload protocol (with
// a fake network), refresh, captions with a song credit, and the server's sign-in return route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.POSTER_KEYCHAIN_FAKE = mkdtempSync(join(tmpdir(), "poster-kc-"));
Object.assign(process.env, { GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", TIKTOK_CLIENT_KEY: "tkey", TIKTOK_CLIENT_SECRET: "tsecret", META_APP_ID: "mid", META_APP_SECRET: "msecret", META_LOGIN_CONFIG_ID: "cfg" });

const { setFetch, redact } = await import("./http.ts");
const oauth = await import("./oauth.ts");
const { kcGetJson, kcSetJson } = await import("./keychain.ts");
const { connectionFor, chooseIdentity, targetFor, saveConnection } = await import("./connections.ts");
const { youtubePost } = await import("./youtube.ts");
const { chunkPlan, tiktokPost } = await import("./tiktok.ts");
const { facebookPost, instagramPost } = await import("./meta.ts");
const { linkedinPost } = await import("./linkedin.ts");
const { withSongCredit } = await import("../platforms/caption.ts");
const { APP_DIR } = await import("../config.ts");

const MB = 1024 * 1024;
const dir = mkdtempSync(join(tmpdir(), "poster-vid-"));
const video = (name: string, bytes: number) => { const f = join(dir, name); writeFileSync(f, ""); truncateSync(f, bytes); return f; };
type Call = { url: string; method: string; headers: Record<string, string>; body: any };
/** A fake network: each handler gets the call and returns [status, body, headers]. */
function fakeNet(handler: (c: Call) => [number, unknown, Record<string, string>?]): Call[] {
  const calls: Call[] = [];
  setFetch((async (url: string | URL, init: RequestInit = {}) => {
    const h: Record<string, string> = {};
    new Headers(init.headers as HeadersInit).forEach((v, k) => { h[k] = v; });
    const c = { url: String(url), method: init.method ?? "GET", headers: h, body: init.body };
    calls.push(c);
    const [status, body, headers = {}] = handler(c);
    return new Response(status === 308 || status === 204 ? null : typeof body === "string" ? body : JSON.stringify(body ?? {}), { status, headers: { "content-type": "application/json", ...headers } });
  }) as typeof fetch);
  return calls;
}

test("the sign-in state is signed, single-use, expires, and only ever points back at this Mac on the Wi-Fi", () => {
  const s = oauth.signState({ v: 1, p: "google", h: "skylers-mac.local:4747", n: "abc", t: Date.now() });
  assert.equal(oauth.readState(s).h, "skylers-mac.local:4747");
  const [raw, sig] = s.split(".");
  const forged = Buffer.from(JSON.stringify({ v: 1, p: "google", h: "evil.com:4747", n: "abc", t: Date.now() })).toString("base64url");
  assert.throws(() => oauth.readState(`${forged}.${sig}`), /isn't valid/);
  assert.throws(() => oauth.readState(`${raw}.${sig}x`), /isn't valid/);
  assert.throws(() => oauth.readState(s, Date.now() + 11 * 60_000), /10 minutes/);
  for (const bad of ["evil.com:4747", "x.local.evil.com:4747", "192.168.1.5:4747", "mac.local:80", "user@mac.local:4747", "mac.local"]) assert.equal(oauth.FINISH_HOST.test(bad), false, bad);
  for (const ok of ["TABOOSTs-MacBook-Pro-2.local:4747", "localhost:4748", "127.0.0.1:4749"]) assert.equal(oauth.FINISH_HOST.test(ok), true, ok);
});

test("connecting: the platform's own page with PKCE; the code is swapped once, the permission goes to the Keychain, names to connections.json", async () => {
  assert.throws(() => oauth.startConnect("dev1", "google", "evil.com:4747"), /home Wi-Fi/);
  const url = new URL(oauth.startConnect("dev1", "google", "mac.local:4747"));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("redirect_uri"), "https://northbound-dev.com/connect/callback.html");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  const state = url.searchParams.get("state")!;
  const calls = fakeNet((c) => c.url.startsWith("https://oauth2.googleapis.com/token")
    ? [200, { access_token: "ya29.SECRET-ACCESS", refresh_token: "1//SECRET-REFRESH", expires_in: 3600, scope: "openid youtube.upload" }]
    : [200, { items: [{ id: "UC1", snippet: { title: "Skyler Drums" } }] }]);
  const r = await oauth.finishConnect("the-code", state, "mac.local:4747");
  assert.deepEqual([r.provider, r.account], ["google", "Skyler Drums"]);
  assert.match(String(calls[0].body), /code_verifier=/);
  assert.equal(kcGetJson<any>("dev1/google")?.refresh_token, "1//SECRET-REFRESH");
  assert.equal(connectionFor("dev1", "youtube")?.identities[0].name, "Skyler Drums");
  await assert.rejects(oauth.finishConnect("the-code", state, "mac.local:4747"), /already used/);
  // nothing the app keeps on disk holds a token
  for (const f of readdirSync(APP_DIR)) { if (statSync(join(APP_DIR, f)).isFile()) assert.equal(/SECRET-(ACCESS|REFRESH)/.test(readFileSync(join(APP_DIR, f), "utf8")), false, f); }
});

test("errors never carry a token", () => {
  assert.equal(redact("Bearer ya29.abc and access_token=EAAB123&x=1 and OAuth EAAC9"), "Bearer [hidden] and access_token=[hidden]&x=1 and OAuth [hidden]");
  assert.equal(redact('{"access_token":"t","refresh_token":"r"}'), '{"access_token":"[hidden]","refresh_token":"[hidden]"}');
});

test("TikTok: an expired permission is renewed, and the new refresh token (TikTok rotates them) is kept", async () => {
  kcSetJson("dev1/tiktok", { access_token: "old", refresh_token: "r1", expires_at: Date.now() - 1000, refresh_expires_at: Date.now() + 1e9 });
  const calls = fakeNet(() => [200, { access_token: "new", refresh_token: "r2", expires_in: 86400, refresh_expires_in: 31536000 }]);
  const t = await oauth.tokensFor("dev1", "tiktok");
  assert.equal(t.access_token, "new");
  assert.equal(kcGetJson<any>("dev1/tiktok")?.refresh_token, "r2");
  assert.match(String(calls[0].body), /client_key=tkey/);
  assert.match(String(calls[0].body), /grant_type=refresh_token/);
});

test("YouTube: resumable upload in 256 KiB-multiple pieces, resuming after 308; a test uploads private", async () => {
  const f = video("yt.mp4", 20 * MB);
  let n = 0;
  const calls = fakeNet((c) => {
    if (c.method === "POST") return [200, {}, { location: "https://upload.example/session" }];
    n++;
    return n < 3 ? [308, null, { range: `bytes=0-${n * 8 * MB - 1}` }] : [201, { id: "vid123" }];
  });
  let clickedAt = -1;
  const r = await youtubePost({ access_token: "a" }, { file: f, caption: "Final Countdown cover\n#drums", identity: "UC1", test: true, live: true }, () => {}, () => { clickedAt = calls.length; });
  assert.deepEqual([r.status, r.remoteId], ["done", "vid123"]);
  const meta = JSON.parse(String(calls[0].body));
  assert.equal(meta.status.privacyStatus, "private");
  assert.equal(meta.snippet.title, "Final Countdown cover");
  const puts = calls.filter((c) => c.method === "PUT");
  assert.equal(puts.length, 3);
  assert.equal(puts[0].headers["content-range"], `bytes 0-${8 * MB - 1}/${20 * MB}`);
  assert.equal(puts[2].headers["content-range"], `bytes ${16 * MB}-${20 * MB - 1}/${20 * MB}`);
  assert.equal((8 * MB) % (256 * 1024), 0);
  assert.equal(clickedAt, 3); // armed just before the last piece
});

test("TikTok: chunk maths, pieces in order, and the video lands as a draft in her inbox", async () => {
  assert.deepEqual(chunkPlan(3 * MB), { chunk_size: 3 * MB, total_chunk_count: 1 });
  assert.deepEqual(chunkPlan(64 * MB), { chunk_size: 64 * MB, total_chunk_count: 1 });
  assert.deepEqual(chunkPlan(147 * MB), { chunk_size: 32 * MB, total_chunk_count: 4 }); // last piece: 51 MB
  const f = video("tt.mp4", 70 * MB);
  const calls = fakeNet((c) => c.url.includes("/inbox/video/init/") ? [200, { data: { publish_id: "p1", upload_url: "https://up.tiktok.example/x" }, error: { code: "ok" } }]
    : c.url.includes("/status/fetch/") ? [200, { data: { status: "SEND_TO_USER_INBOX" }, error: { code: "ok" } }]
    : [201, {}]);
  const r = await tiktokPost({ access_token: "a" }, { file: f, caption: "x", identity: "me", test: false, live: true }, () => {}, () => {}, 0);
  assert.equal(r.status, "draft");
  const init = JSON.parse(String(calls[0].body));
  assert.deepEqual(init.source_info, { source: "FILE_UPLOAD", video_size: 70 * MB, chunk_size: 32 * MB, total_chunk_count: 2 });
  const puts = calls.filter((c) => c.method === "PUT").map((c) => c.headers["content-range"]);
  assert.deepEqual(puts, [`bytes 0-${32 * MB - 1}/${70 * MB}`, `bytes ${32 * MB}-${70 * MB - 1}/${70 * MB}`]);
});

test("Facebook: a Page Reel in three steps; a private test leaves a draft; the Page's own token is used", async () => {
  const f = video("fb.mp4", 5 * MB);
  const calls = fakeNet((c) => c.url.includes("video_reels") && String(c.body).includes("upload_phase=start") ? [200, { video_id: "v9", upload_url: "https://rupload.facebook.com/video-upload/v27.0/v9" }] : [200, { success: true }]);
  const r = await facebookPost({ access_token: "user", pages: { page1: "PAGE-TOKEN" } }, { file: f, caption: "hi", identity: "page1", test: true, live: true, duration: 45 }, () => {}, () => {});
  assert.equal(r.status, "draft");
  assert.equal(calls[1].headers.authorization, "OAuth PAGE-TOKEN");
  assert.equal(calls[1].headers.offset, "0");
  assert.match(String(calls[2].body), /video_state=DRAFT/);
  await assert.rejects(facebookPost({ access_token: "u", pages: {} }, { file: f, caption: "", identity: "page1", test: false, live: true }, () => {}, () => {}), /isn't connected/);
});

test("Instagram: container, upload, wait, publish, with the song at 1% (the lowest allowed); a private test skips it", async () => {
  const f = video("ig.mp4", 4 * MB);
  let polls = 0;
  const calls = fakeNet((c) => {
    if (c.url.endsWith("/media") && c.method === "POST") return [200, { id: "cont1", uri: "https://rupload.facebook.com/ig-api-upload/v27.0/cont1" }];
    if (c.url.startsWith("https://rupload")) return [200, { success: true }];
    if (c.url.includes("cont1?fields=status_code")) return [200, { status_code: ++polls < 2 ? "IN_PROGRESS" : "FINISHED" }];
    if (c.url.endsWith("/media_publish")) return [200, { id: "media7" }];
    return [200, { permalink: "https://instagram.com/reel/abc" }];
  });
  const r = await instagramPost({ access_token: "U", ig_page: { ig1: "page1" } }, { file: f, caption: "drums", identity: "ig1", test: false, live: true, song: { title: "The Final Countdown", artist: "Europe", igAudioId: "aud5" } }, () => {}, () => {}, 0);
  assert.deepEqual([r.status, r.link], ["done", "https://instagram.com/reel/abc"]);
  const created = new URLSearchParams(String(calls[0].body));
  assert.equal(created.get("upload_type"), "resumable");
  assert.deepEqual(JSON.parse(created.get("audio_configuration")!), { audio_id: "aud5", audio_volume: 1, video_volume: 100 });
  const skip = await instagramPost({ access_token: "U", ig_page: { ig1: "p" } }, { file: f, caption: "", identity: "ig1", test: true, live: true }, () => {}, () => {});
  assert.equal(skip.status, "skipped");
});

test("LinkedIn: parts uploaded with their ETags, finalized, then posted", async () => {
  const f = video("li.mp4", 6 * MB);
  const calls = fakeNet((c) => {
    if (c.url.includes("initializeUpload")) return [200, { value: { video: "urn:li:video:1", uploadToken: "", uploadInstructions: [{ uploadUrl: "https://up/1", firstByte: 0, lastByte: 4 * MB - 1 }, { uploadUrl: "https://up/2", firstByte: 4 * MB, lastByte: 6 * MB - 1 }] } }];
    if (c.method === "PUT") return [200, {}, { etag: c.url.endsWith("1") ? "e1" : "e2" }];
    if (c.url.endsWith("/rest/posts")) return [201, {}, { "x-restli-id": "urn:li:share:9" }];
    return [200, {}];
  });
  const r = await linkedinPost({ access_token: "a", user_id: "m1" }, { file: f, caption: "hi", identity: "m1", test: false, live: true }, () => {}, () => {});
  assert.equal(r.remoteId, "urn:li:share:9");
  assert.deepEqual(JSON.parse(String(calls.find((c) => c.url.includes("finalizeUpload"))!.body)).finalizeUploadRequest.uploadedPartIds, ["e1", "e2"]);
});

test("as whom: a Page posts officially, her personal profile through the Mac's browser", () => {
  saveConnection("dev2", { platform: "facebook", provider: "meta", account: "Skyler", identities: [{ id: "page1", name: "Skyler Drums", kind: "page", via: "official" }, { id: "profile", name: "My profile (the Mac's browser)", kind: "profile", via: "browser" }], scopes: [], connectedAt: new Date().toISOString() });
  assert.equal(targetFor("dev2", "facebook").via, "official");
  chooseIdentity("dev2", "facebook", "profile");
  assert.equal(targetFor("dev2", "facebook").via, "browser");
  assert.throws(() => chooseIdentity("dev2", "facebook", "someone-else"), /isn't one of/);
  assert.equal(targetFor("dev2", "x").via, "browser");
});

test("the song credit goes on the platforms she ticked, within each platform's limit", () => {
  const song = { title: "The Final Countdown", artist: "Europe", credit: { youtube: false } };
  assert.equal(withSongCredit("Drum cover!", "tiktok", song), "Drum cover!\n\n🎵 The Final Countdown by Europe");
  assert.equal(withSongCredit("Drum cover!", "youtube", song), "Drum cover!");
  const long = "a".repeat(600);
  const threads = withSongCredit(long, "threads", song);
  assert.ok([...threads].length <= 500 && threads.endsWith("🎵 The Final Countdown by Europe"));
  const x = withSongCredit("b ".repeat(200), "x", song);
  assert.ok(x.length <= 280);
  assert.equal(withSongCredit("same", "tiktok", null), "same");
});

test("the sign-in return page needs no key, but does nothing without a valid state", async () => {
  const { startServer, stopServer } = await import("../server.ts");
  const port = 47000 + Math.floor(Math.random() * 900);
  await startServer({ port, host: "127.0.0.1", open: false, token: "the-key" });
  const page = await (await fetch(`http://127.0.0.1:${port}/connect/finish?code=x&state=forged.sig`)).text();
  assert.match(page, /Not connected/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/connections`)).status, 401); // everything else still needs the key
  setFetch(null);
  await stopServer();
});
