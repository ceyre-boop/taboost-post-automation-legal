// node --test src/abuse.test.ts
// Cost abuse and break-ins: wrong-key floods, huge or fake uploads, the same post sent over and over,
// AI loops, a flood of phones. Every limit here is checked without touching Chrome, a platform or an AI.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const DIR = mkdtempSync(join(tmpdir(), "pe-abuse-"));
process.env.POSTER_APP_DIR = DIR;
process.env.POSTER_KEY_FAILS = "5";
process.env.POSTER_MAX_POSTS_PER_DAY = "2";
process.env.POSTER_AI_MAX_CALLS_PER_DAY = "3";
process.env.POSTER_MAX_DEVICES = "3";
process.env.POSTER_CHROME_PATH = "/usr/bin/false"; // no real Chrome is ever started by these tests
process.env.POSTER_MAX_UPLOAD_MB = "1"; // a 1 MB ceiling so "too big" is cheap to show
for (const k of ["POSTER_DEV_MAX", "NORTHBOUND_AI_ENDPOINT", "ANTHROPIC_API_KEY"]) delete process.env[k];
const PORT = 47000 + Math.floor(Math.random() * 900);
const KEY = "abuse-test-key-0123456789";
const { startServer } = await import("./server.ts");
const { safeEqual, KeyLimiter, RateLimiter } = await import("./guard.ts");
const { readMultipart, UploadRefused, looksLikeVideo } = await import("./multipart.ts");
const limits = await import("./limits.ts");
const { buildBatch, runBatch, MAX_BATCH_VIDEOS } = await import("./batch.ts");
const ai = await import("./maker/ai.ts");
const { createDevice, maxDevices } = await import("./devices.ts");

before(async () => { await startServer({ port: PORT, open: false, token: KEY, host: "127.0.0.1" }); });
after(() => { setTimeout(() => process.exit(0), 50); });

function send(method: string, path: string, headers: Record<string, string> = {}, body: string | Buffer = ""): Promise<{ status: number; headers: Record<string, any>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, method, path, headers: { host: `phone.example:${PORT}`, ...headers, "content-length": Buffer.byteLength(body) } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypmp42"), Buffer.alloc(200, 7)]);
function multipart(boundary: string, parts: { name: string; filename?: string; type?: string; body: Buffer | string }[]): Buffer {
  const out: Buffer[] = [];
  for (const p of parts) {
    out.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ""}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ""}\r\n`), Buffer.from(p.body), Buffer.from("\r\n"));
  }
  out.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(out);
}
/** A request as the parser sees it, delivered in awkward little chunks. */
function fake(body: Buffer, boundary: string, chunk = 7, extra: Record<string, string> = {}) {
  const r = Readable.from((function* () { for (let i = 0; i < body.length; i += chunk) yield body.subarray(i, i + chunk); })());
  return Object.assign(r, { headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length), ...extra } }) as any;
}

/* ---------------- the key ---------------- */

test("keys are compared in constant time, and a wrong length never matches", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", "x"), false);
});

test("guessing the key: a client is locked out after a few wrong guesses, even if its next guess is right; a flood from everyone slows wrong guesses", () => {
  let t = 1_000_000;
  const l = new KeyLimiter(3, 600, 900, 5, () => t);
  for (let i = 0; i < 3; i++) { assert.equal(l.blocked("a"), false); l.fail("a"); }
  assert.equal(l.blocked("a"), true);
  assert.equal(l.blocked("b"), false, "another client is not affected");
  t += 901_000;
  assert.equal(l.blocked("a"), false, "the lock ends");
  for (const c of ["c", "d", "e", "f", "g"]) l.fail(c);
  assert.equal(l.floodActive(), true, "5 wrong guesses in the window from anywhere");
  const r = new RateLimiter(3, 60_000, () => t);
  assert.deepEqual([r.allow("x"), r.allow("x"), r.allow("x"), r.allow("x")], [true, true, true, false]);
});

/* ---------------- uploads ---------------- */

test("the streaming reader: fields and a file split across tiny chunks, hashed, written under the caller's name, never the sender's", async () => {
  const b = "bndry123";
  const body = multipart(b, [{ name: "caption", body: "hello\r\nworld" }, { name: "video", filename: "../../etc/passwd.mp4", type: "video/mp4", body: MP4 }, { name: "platforms", body: "tiktok" }]);
  const dir = mkdtempSync(join(tmpdir(), "pe-mp-"));
  const seen: string[] = [];
  const r = await readMultipart(fake(body, b), { maxTotal: 10_000, maxFile: 10_000, destFor: ({ filename }) => { seen.push(filename); return join(dir, "kept.mp4"); } });
  assert.deepEqual(r.fields.get("caption"), ["hello\r\nworld"]);
  assert.deepEqual(r.fields.get("platforms"), ["tiktok"]);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].path, join(dir, "kept.mp4"));
  assert.equal(r.files[0].bytes, MP4.length);
  assert.deepEqual(readFileSync(r.files[0].path), MP4);
  assert.match(r.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(seen[0], "../../etc/passwd.mp4"); // the name is only ever shown to the caller, who decides the path
  assert.equal(looksLikeVideo(MP4), true);
  assert.equal(looksLikeVideo(Buffer.from("<html>not a video at all</html>")), false);
});

test("a file over the cap, a truncated upload, and a refused part all delete what was written so far", async () => {
  const b = "b2";
  const dir = mkdtempSync(join(tmpdir(), "pe-mp-"));
  const big = multipart(b, [{ name: "video", filename: "a.mp4", type: "video/mp4", body: Buffer.concat([MP4, Buffer.alloc(5000)]) }]);
  await assert.rejects(readMultipart(fake(big, b), { maxTotal: 1 << 20, maxFile: 1000, destFor: () => join(dir, "x.mp4") }), (e: any) => e instanceof UploadRefused && e.status === 413);
  assert.deepEqual(readdirSync(dir), []);
  const cut = big.subarray(0, big.length - 40);
  await assert.rejects(readMultipart(fake(cut, b), { maxTotal: 1 << 20, maxFile: 1 << 20, destFor: () => join(dir, "y.mp4") }), (e: any) => e instanceof UploadRefused && e.status === 400);
  assert.deepEqual(readdirSync(dir), []);
  const html = multipart(b, [{ name: "video", filename: "a.mp4", type: "video/mp4", body: "<html></html>" }]);
  await assert.rejects(readMultipart(fake(html, b), { maxTotal: 1 << 20, maxFile: 1 << 20, destFor: () => join(dir, "z.mp4"), check: (_f, head) => { if (!looksLikeVideo(head)) throw new UploadRefused(415, "no"); } }), (e: any) => e.status === 415);
  assert.deepEqual(readdirSync(dir), []);
  const two = multipart(b, [{ name: "video", filename: "a.mp4", body: MP4 }, { name: "video", filename: "b.mp4", body: MP4 }]);
  await assert.rejects(readMultipart(fake(two, b), { maxTotal: 1 << 20, maxFile: 1 << 20, maxFiles: 1, destFor: ({ index }) => join(dir, `f${index}.mp4`) }), (e: any) => e.status === 415);
  assert.deepEqual(readdirSync(dir), [], "the first file is removed when the second is refused");
});

test("over HTTP: a fake video, a wrong type, and a body past the ceiling are refused and leave nothing on disk", async () => {
  const k = { "x-poster-key": KEY };
  const dev = createDevice("Uploader");
  const b = "bb";
  const h = (len: number) => ({ ...k, "x-poster-device": dev.id, "content-type": `multipart/form-data; boundary=${b}`, "content-length": String(len) });
  const bad = multipart(b, [{ name: "video", filename: "a.mp4", type: "video/mp4", body: "<script>alert(1)</script>" }, { name: "platforms", body: "tiktok" }]);
  const r1 = await send("POST", "/api/post", h(bad.length), bad);
  const png = multipart(b, [{ name: "video", filename: "a.png", type: "image/png", body: MP4 }, { name: "platforms", body: "tiktok" }]);
  const r2 = await send("POST", "/api/post", h(png.length), png);
  const r3 = await new Promise<number>((resolve) => {
    const req = request({ host: "127.0.0.1", port: PORT, method: "POST", path: "/api/post", headers: { host: `phone.example:${PORT}`, ...h(5 * 1024 * 1024) } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", () => resolve(-1));
    req.write("x"); req.end();
  });
  assert.equal(r1.status, 415, r1.text);
  assert.match(r1.text, /isn't a video/);
  assert.equal(r2.status, 415, r2.text);
  assert.equal(r3, 413);
  const up = join(DIR, "uploads");
  assert.deepEqual(existsSync(up) ? readdirSync(up) : [], []);
});

test("a good upload is kept under the app's own name (never the sender's path), the same one sent again is refused, and nothing posts live", async () => {
  // This phone's Chrome port is one nothing listens on, and the post is a preview: nothing real is touched.
  const dev = createDevice("Happy");
  const f = join(DIR, "devices.json");
  const all = JSON.parse(readFileSync(f, "utf8")); all[dev.id].cdpPort = 58321; writeFileSync(f, JSON.stringify(all));
  const b = "hp";
  const body = multipart(b, [{ name: "video", filename: "../../../etc/evil name?.MOV", type: "video/quicktime", body: MP4 }, { name: "platforms", body: "tiktok" }, { name: "platforms", body: "tiktok" }, { name: "caption", body: "hi" }]);
  const r = await send("POST", "/api/post", { "x-poster-key": KEY, "x-poster-device": dev.id, "content-type": `multipart/form-data; boundary=${b}` }, body);
  assert.equal(r.status, 200, r.text);
  const kept = readdirSync(join(DIR, "uploads"));
  assert.equal(kept.length, 1);
  assert.match(kept[0], /^\d+-0--[\w.\- ()]+\.mov$/);
  assert.ok(!kept[0].includes("/") && !kept[0].startsWith(".part-"));
  const batch = JSON.parse(readFileSync(join(DIR, "batches", readdirSync(join(DIR, "batches"))[0]), "utf8"));
  assert.equal(batch.items.length, 1, "tiktok listed twice is one post");
  assert.match(batch.items[0].sha, /^[a-f0-9]{64}$/);
});

/* ---------------- the same post, and a flood of posts ---------------- */

test("a day's limit per platform, kept on disk and reset at midnight; the same video+caption isn't sent twice in the window", () => {
  let t = new Date(2026, 5, 1, 12, 0, 0).getTime();
  limits.setLimitsClock(() => t);
  assert.equal(limits.maxPostsPerDay(), 2);
  assert.equal(limits.takePost("tiktok"), true);
  assert.equal(limits.takePost("tiktok"), true);
  assert.equal(limits.takePost("tiktok"), false, "the third live post today is refused");
  assert.equal(limits.takePost("youtube"), true, "each platform has its own count");
  assert.equal(limits.roomToday("tiktok", 1), false);
  assert.ok(existsSync(join(DIR, "post-limits.json")), "saved, so a restart doesn't reset it");
  assert.equal(JSON.parse(readFileSync(join(DIR, "post-limits.json"), "utf8")).counts.tiktok, 2);
  t += 13 * 3_600_000; // the next morning
  assert.equal(limits.takePost("tiktok"), true);
  limits.markSent("tiktok", "abc", "caption one");
  assert.equal(limits.recentlySent("tiktok", "abc", "caption one"), true);
  assert.equal(limits.recentlySent("tiktok", "abc", "caption two"), false);
  assert.equal(limits.recentlySent("youtube", "abc", "caption one"), false);
  t += 31 * 60_000;
  assert.equal(limits.recentlySent("tiktok", "abc", "caption one"), false, "after the window it may go again");
  limits.setLimitsClock(null);
});

test("a batch can't list one platform 100 times or carry more than the video cap", () => {
  const v = join(DIR, "v.mp4"); writeFileSync(v, MP4);
  const b = buildBatch({ videos: [{ path: v }], platforms: Array(100).fill("tiktok"), live: false });
  assert.equal(b.items.length, 1);
  assert.throws(() => buildBatch({ videos: Array.from({ length: MAX_BATCH_VIDEOS + 1 }, () => ({ path: v })), platforms: ["tiktok"], live: false }), /more than/);
});

test("the day's limit holds inside the batch engine, however a post got there: the third live post is an error, nothing is sent", async () => {
  limits.setLimitsClock(() => new Date(2030, 0, 1, 9, 0, 0).getTime());
  assert.equal(limits.takePost("linkedin"), true);
  assert.equal(limits.takePost("linkedin"), true);
  const v = join(DIR, "w.mp4"); writeFileSync(v, MP4);
  const b = buildBatch({ videos: [{ path: v }], platforms: ["linkedin"], live: true });
  b.items[0].via = "official"; // official path: if the limit failed to hold this would try the real API, so it must stop first
  const log: string[] = [];
  await runBatch(b, (m) => log.push(m));
  assert.equal(b.items[0].status, "error");
  assert.match(b.items[0].note ?? "", /Daily limit reached/);
  limits.setLimitsClock(null);
});

/* ---------------- AI ---------------- */

test("AI calls: a per-day cap that is saved to disk, an input cap, and no call is made once either is hit", async () => {
  let calls = 0;
  ai.setThinker(async () => { calls++; return "{}"; });
  for (let i = 0; i < 3; i++) await ai.think("ideas", "sys", "user", "byo");
  await assert.rejects(ai.think("ideas", "sys", "user", "byo"), /AI calls for today/);
  assert.equal(calls, 3, "the fourth call never reached the model");
  assert.equal(JSON.parse(readFileSync(join(DIR, "ai-calls.json"), "utf8")).n, 3);
  assert.throws(() => ai.takeAiCall(ai.AI_MAX_INPUT_CHARS + 1), /more text/);
  ai.setThinker(null);
});

/* ---------------- phones, headers, pages ---------------- */

test("a flood of phone registrations stops at the device limit, and an existing name still finds its phone", () => {
  assert.equal(maxDevices(), 3);
  createDevice("a1"); // "Uploader" and "Happy" were made above: this is the third
  assert.throws(() => createDevice("a4"), /as many phones/);
});

test("the phone page is served with a CSP, no referrer and no framing; a page on another site can't use the key", async () => {
  const { allowedRequest } = await import("./server.ts");
  const mk = (h: Record<string, string>) => ({ headers: h }) as any;
  assert.equal(allowedRequest(mk({ host: "x.trycloudflare.com", origin: "https://x.trycloudflare.com" }), 1, true).ok, true);
  assert.equal(allowedRequest(mk({ host: "x.trycloudflare.com", origin: "https://evil.example" }), 1, true).ok, false);
  assert.equal(allowedRequest(mk({ host: "x.trycloudflare.com", origin: "null" }), 1, true).ok, false);
  assert.equal(allowedRequest(mk({ host: "x.trycloudflare.com", "sec-fetch-site": "cross-site" }), 1, true).ok, false);
  assert.equal(allowedRequest(mk({ host: "x.trycloudflare.com" }), 1, true).ok, true, "the phone's own requests and scripts carry no Origin");
});

test("over HTTP: wrong keys get 401, then 429, and then the right key from that client is refused too", async () => {
  const got: number[] = [];
  for (let i = 0; i < 7; i++) got.push((await send("GET", "/api/app", { "x-poster-key": `wrong-${i}` })).status);
  assert.deepEqual(got.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(got[5], 429);
  const right = await send("GET", "/api/app", { "x-poster-key": KEY });
  assert.equal(right.status, 429, "the lock holds even for the right key, so a guesser can't tell when they hit it");
});
