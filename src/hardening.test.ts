// node --test src/hardening.test.ts
// What testing found, pinned so it stays fixed: the post maker's routes are guarded like
// the rest of the app, the render page needs its one-time key, sets never share a Chrome,
// a restart never leads to a double post, the phone's sign-in view stays on sign-in pages,
// and auto-make can't start in the first 24 hours.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "pe-hard-"));
process.env.POSTER_APP_DIR = DIR;
for (const k of ["POSTER_DEV_MAX", "NORTHBOUND_AI_ENDPOINT", "ANTHROPIC_API_KEY"]) delete process.env[k];
const PORT = 48000 + Math.floor(Math.random() * 900);
const { startServer } = await import("./server.ts");
const { portFor, hashPort, accountProfile } = await import("./config.ts");
const batch = await import("./batch.ts");
const { signInAllowed } = await import("./remote-view.ts");
const auto = await import("./maker/auto.ts");
const brief = await import("./maker/brief.ts");
const store = await import("./maker/store.ts");

before(async () => { await startServer({ port: PORT, open: false }); });
after(() => { setTimeout(() => process.exit(0), 50); });

function send(method: string, path: string, headers: Record<string, string> = {}, body: string | Buffer = ""): Promise<{ status: number; headers: Record<string, any>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, method, path, headers: { host: `127.0.0.1:${PORT}`, ...headers, "content-length": Buffer.byteLength(body) } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const OWN = { origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };
const EVIL = { origin: "https://evil.example", "content-type": "application/json" };
const JPG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
const BRIEF = { business: "Ridge Roofing", whatYouDo: "Roof repair in Lansing.", audience: "Homeowners", facts: "We have replaced 412 roofs\nMost repairs take 1 day\nWe clean up the same day", avoid: "", cta: "Call for a quote", color: "#c8102e", mood: "bold" };

/* ---------------- the post maker through the server ---------------- */

test("the maker's screens work from the app's own page, and a brief and photos are saved", async () => {
  const r = await send("POST", "/api/maker/brief", OWN, JSON.stringify(BRIEF));
  assert.equal(r.status, 200, r.text);
  for (let i = 0; i < 3; i++) assert.equal((await send("POST", "/api/maker/photo", { origin: OWN.origin, "content-type": "image/jpeg" }, JPG)).status, 200);
  const s = JSON.parse((await send("GET", "/api/maker", {})).text);
  assert.equal(s.brief.business, "Ridge Roofing");
  assert.equal(s.photos.length, 3);
  assert.equal(s.problem, "");
  assert.equal(s.ai.mode, "hosted");
  assert.equal(s.auto.on, false);
  assert.equal(s.auto.unlocked, false);
  const photo = await send("GET", `/api/maker/photo/${s.photos[0]}`, {});
  assert.equal(photo.status, 200);
  assert.equal(photo.headers["content-type"], "image/jpeg");
});

test("a bad brief, a fake photo and a photo path trick are refused in plain words", async () => {
  assert.match((await send("POST", "/api/maker/brief", OWN, JSON.stringify({ ...BRIEF, facts: "one" }))).text, /at least 3 facts/);
  const fake = await send("POST", "/api/maker/photo", { origin: OWN.origin, "content-type": "image/jpeg" }, "<svg onload=alert(1)>");
  assert.equal(fake.status, 400);
  assert.match(fake.text, /isn't a photo/);
  for (const p of ["/api/maker/photo/..%2Fbrief.json", "/api/maker/photo/brief.json", "/api/maker/photo/..%2F..%2Fsecrets.json"]) assert.equal((await send("GET", p, {})).status, 404, p);
});

test("another website can't read the brief, upload photos, make or post a video, or switch on auto-make", async () => {
  const before = readFileSync(join(brief.makerDir(""), "brief.json"), "utf8");
  for (const [m, p, body] of [
    ["GET", "/api/maker", ""], ["POST", "/api/maker/brief", JSON.stringify({ ...BRIEF, business: "Evil" })], ["POST", "/api/maker/photo", "x"],
    ["POST", "/api/maker/ideas", "{}"], ["POST", "/api/maker/make", JSON.stringify({ idea: { title: "x" }, platforms: ["tiktok"] })],
    ["POST", "/api/maker/ai", JSON.stringify({ apiKey: "sk-ant-" + "e".repeat(40) })], ["POST", "/api/maker/auto", JSON.stringify({ on: true })],
    ["POST", "/api/maker/made/m-0000000000/post", JSON.stringify({ platforms: ["tiktok"], live: true })], ["GET", "/render", ""],
    ["POST", "/api/maker/clip?name=a.mp4", "x"], ["POST", "/api/maker/clip/update", JSON.stringify({ name: "c-000000000000.mp4", note: "evil" })],
    ["POST", "/api/maker/clip/remove", JSON.stringify({ name: "c-000000000000.mp4" })], ["POST", "/api/maker/clip/finish", JSON.stringify({ name: "c-000000000000.mp4", platforms: ["tiktok"] })],
    ["GET", "/api/maker/clip/c-000000000000.mp4", ""], ["POST", "/api/maker/plan", JSON.stringify({ every: true })], ["POST", "/api/maker/plan/make", JSON.stringify({ platforms: ["tiktok"] })],
    ["POST", "/api/maker/plan/approve", JSON.stringify({ madeId: "m-0000000000", approved: true })], ["POST", "/api/maker/plan/replace", JSON.stringify({ index: 0 })],
  ] as const) {
    for (const h of [EVIL, { ...OWN, "sec-fetch-site": "cross-site" }, { host: "evil.example" }] as Record<string, string>[]) {
      const r = await send(m, p, h, body);
      assert.equal(r.status, 403, `${m} ${p} ${JSON.stringify(h)}`);
    }
  }
  assert.equal(readFileSync(join(brief.makerDir(""), "brief.json"), "utf8"), before);
  assert.equal(existsSync(join(DIR, "secrets.json")), false);
});

test("a clip is uploaded from the app's own page, read back by it, and nothing outside the clips folder can be reached by name", async () => {
  const box = (type: string, ...parts: Buffer[]) => { const body = Buffer.concat(parts); const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, "latin1"); return Buffer.concat([h, body]); };
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(600, 12); mvhd.writeUInt32BE(600 * 12, 16);
  const tkhd = Buffer.alloc(84); tkhd.writeInt32BE(0x10000, 40); tkhd.writeInt32BE(0x10000, 56); tkhd.writeUInt32BE(1280 * 65536, 76); tkhd.writeUInt32BE(720 * 65536, 80);
  const hdlr = Buffer.alloc(24); hdlr.write("vide", 8, "latin1");
  const clip = Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom", "latin1")), box("mdat", Buffer.alloc(500)), box("moov", box("mvhd", mvhd), box("trak", box("tkhd", tkhd), box("mdia", box("hdlr", hdlr))))]);
  const up = await send("POST", "/api/maker/clip?name=walkthrough.mp4", { origin: OWN.origin, "content-type": "application/octet-stream" }, clip);
  assert.equal(up.status, 200, up.text);
  const c = JSON.parse(up.text).clip;
  assert.deepEqual([c.seconds, c.width, c.height, c.file], [12, 1280, 720, "walkthrough.mp4"]);
  const back = await send("GET", `/api/maker/clip/${c.name}`, { range: "bytes=0-7" });
  assert.equal(back.status, 206);
  for (const p of ["/api/maker/clip/..%2Fbrief.json", "/api/maker/clip/clips.json", "/api/maker/clip/c-000000000000.mp4", `/api/maker/clip/${c.name}?rk=guess`]) assert.equal((await send("GET", p, {})).status, 404, p);
  const bad = await send("POST", "/api/maker/clip?name=x.mp4", { origin: OWN.origin, "content-type": "application/octet-stream" }, "<script>alert(1)</script>");
  assert.match(bad.text, /isn't a video the app can read/);
  assert.match((await send("POST", "/api/maker/clip/update", OWN, JSON.stringify({ name: c.name, start: 0, end: 200 }))).text, /"end":12/);
  assert.match((await send("POST", "/api/maker/plan/approve", OWN, JSON.stringify({ madeId: "m-0000000000", approved: true }))).text, /isn't in this week's plan/);
});

test("only the render page, holding its one-time key, can read a render job or hand back a video", async () => {
  const p = store.newMade("", { title: "t", angle: "a", fact: 0 }, ["tiktok"]);
  p.script = { hook: "Roof trouble?", points: ["Most repairs take 1 day"], cta: "Call for a quote", platforms: { tiktok: { caption: "c", hashtags: ["#roof"] } } };
  store.saveMade(p);
  for (const q of ["", "?rk=", "?rk=guess", "?set=&rk=AAAAAAAAAAAAAAAAAAAAAAAA"]) {
    assert.equal((await send("GET", `/api/maker/job/${p.id}${q}`, {})).status, 404, q);
    assert.equal((await send("POST", `/api/maker/made/${p.id}/video${q}`, { origin: OWN.origin, "content-type": "video/mp4" }, Buffer.alloc(2000))).status, 404, q);
  }
  assert.equal(store.videoBytes("", p.id), 0);
});

test("a made post's captions are checked against each platform's limit when edited", async () => {
  const p = store.newMade("", { title: "t2", angle: "a", fact: 0 }, ["x", "youtube"]);
  p.status = "ready";
  p.captions = { x: { caption: "short", hashtags: ["#a"] }, youtube: { caption: "Title\nmore", hashtags: ["#a"] } };
  store.saveMade(p);
  const long = await send("POST", `/api/maker/made/${p.id}/captions`, OWN, JSON.stringify({ captions: { x: { caption: "a".repeat(300), hashtags: [] } } }));
  assert.equal(long.status, 400);
  assert.match(long.text, /x allows 280/);
  const title = await send("POST", `/api/maker/made/${p.id}/captions`, OWN, JSON.stringify({ captions: { youtube: { caption: "T".repeat(120), hashtags: [] } } }));
  assert.match(title.text, /at most 100 characters/);
  const ok = await send("POST", `/api/maker/made/${p.id}/captions`, OWN, JSON.stringify({ captions: { x: { caption: "Edited by me", hashtags: ["roofing"] } } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(store.readMade("", p.id)!.captions!.x, { caption: "Edited by me", hashtags: ["#roofing"] });
  // A made post with no video can't be posted.
  assert.match((await send("POST", `/api/maker/made/${p.id}/post`, OWN, JSON.stringify({ platforms: ["x"], live: true }))).text, /no video/);
});

test("with Northbound hosting not set up, asking for ideas says so instead of failing silently", async () => {
  const r = await send("POST", "/api/maker/ideas", OWN, "{}");
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.text).error, /Northbound hosting isn't set up yet/);
});

/* ---------------- auto-make's 24 hours ---------------- */

test("auto-make can't be switched on before the set has been connected for 24 hours, then needs accounts chosen", async () => {
  let now = Date.parse("2026-11-21T12:00:00Z");
  auto.setAutoClock(() => now);
  try {
    const set = "autoset";
    assert.throws(() => auto.writeAuto(set, { on: true }, ["tiktok"]), auto.AutoLocked); // never connected
    auto.markSetConnected(set);
    assert.throws(() => auto.writeAuto(set, { on: true }, ["tiktok"]), auto.AutoLocked);
    now += 23 * 3_600_000;
    assert.throws(() => auto.writeAuto(set, { on: true }, ["tiktok"]), auto.AutoLocked);
    now += 2 * 3_600_000;
    assert.throws(() => auto.writeAuto(set, { on: true }, ["tiktok"]), /Choose at least one account/);
    const a = auto.writeAuto(set, { on: true, platforms: ["tiktok", "not-a-platform"], perWeek: 99 }, ["tiktok"]);
    assert.equal(a.on, true);
    assert.deepEqual(a.platforms, ["tiktok"]);
    assert.equal(a.perWeek, 14);
    // Connecting again doesn't restart or reset anything.
    auto.markSetConnected(set);
    assert.equal(auto.readAuto(set).on, true);
    // Spaced through the week, capped per day, and never two on the way at once.
    assert.equal(auto.autoDue(a, []), "");
    auto.noteMade(set);
    assert.equal(auto.autoDue(auto.readAuto(set), []), "not yet");
    const made = (status: string, hoursAgo: number) => ({ auto: true, status, createdAt: new Date(now - hoursAgo * 3_600_000).toISOString() }) as never;
    assert.equal(auto.autoDue({ ...a, lastMadeAt: "" }, [made("rendering", 0)]), "one is already on its way");
    assert.equal(auto.autoDue({ ...a, lastMadeAt: "" }, [made("posted", 1), made("posted", 2)]), "daily cap");
    // The server route says it in plain words.
    const r = await send("POST", "/api/maker/auto", OWN, JSON.stringify({ on: true }));
    assert.equal(r.status, 400);
  } finally { auto.setAutoClock(null); }
});

/* ---------------- sets never share a Chrome ---------------- */

test("two sets whose names hash to the same port still get different ports, and keep them", () => {
  // Find two ids that collide under the old hash.
  const seen = new Map<number, string>();
  let pair: [string, string] | null = null;
  for (let i = 0; i < 5000 && !pair; i++) { const id = `set${i}`; const h = hashPort(id); if (seen.has(h)) pair = [seen.get(h)!, id]; else seen.set(h, id); }
  assert.ok(pair);
  const [a, b] = pair!;
  assert.equal(hashPort(a), hashPort(b));
  const pa = portFor(a), pb = portFor(b);
  assert.notEqual(pa, pb);
  assert.equal(portFor(a), pa);
  assert.equal(portFor(b), pb);
  assert.equal(accountProfile(a).port, pa);
  assert.deepEqual(JSON.parse(readFileSync(join(DIR, "set-ports.json"), "utf8"))[b], pb);
});

/* ---------------- batches: captions per platform, restarts, clean-up ---------------- */

test("a made video carries one caption per platform into the batch", () => {
  const clip = join(DIR, "clip.mp4");
  writeFileSync(clip, "x");
  const b = batch.buildBatch({ videos: [{ path: clip, caption: "shared", captions: { x: "for X", youtube: "Title\nfor YouTube" } }], platforms: ["x", "youtube", "tiktok"], live: false });
  assert.deepEqual(b.items.map((i) => [i.platform, i.caption]), [["x", "for X"], ["youtube", "Title\nfor YouTube"], ["tiktok", "shared"]]);
});

test("after a restart, a post that was mid-way is marked to check, never retried blindly", () => {
  const clip = join(DIR, "clip2.mp4");
  writeFileSync(clip, "x");
  const b = batch.buildBatch({ videos: [{ path: clip }], platforms: ["x", "tiktok", "youtube"], live: true });
  b.items[0].status = "done"; b.items[1].status = "posting"; b.items[2].status = "error";
  b.createdAt = new Date(Date.now() + 60_000).toISOString(); // the newest
  batch.saveBatch(b);
  const r = batch.recoverLatestBatch()!;
  assert.equal(r.id, b.id);
  assert.deepEqual(r.items.map((i) => i.status), ["done", "unconfirmed", "error"]);
  assert.match(r.items[1].note!, /may have gone out/);
  // Only the error is left to try again; the unconfirmed one counts as finished for clean-up.
  assert.deepEqual(batch.finishedVideos(r), []);
  r.items[2].status = "done";
  assert.deepEqual(batch.finishedVideos(r), [clip]);
});

test("the space uploads take is shown, and clearing it keeps what a batch still needs", async () => {
  const up = join(DIR, "uploads");
  mkdirSync(up, { recursive: true });
  writeFileSync(join(up, "old.mp4"), Buffer.alloc(5000));
  const app = JSON.parse((await send("GET", "/api/app", {})).text);
  assert.ok(app.uploads.bytes >= 5000);
  const r = JSON.parse((await send("POST", "/api/uploads/clear", OWN, "{}")).text);
  assert.ok(r.removed >= 1);
  assert.equal(existsSync(join(up, "old.mp4")), false);
});

/* ---------------- the phone's sign-in view ---------------- */

test("the phone's sign-in view only shows the platform's sign-in sites", () => {
  for (const [p, u] of [["youtube", "https://accounts.google.com/signin"], ["youtube", "https://studio.youtube.com/"], ["x", "https://x.com/i/flow/login"], ["threads", "https://www.threads.net/login"], ["tiktok", "https://www.tiktok.com/login"], ["instagram", "about:blank"]]) assert.equal(signInAllowed(p, u), true, u);
  for (const [p, u] of [["youtube", "https://mail.google.com/"], ["youtube", "https://myaccount.google.com/"], ["x", "https://www.dropbox.com/x.com"], ["x", "http://x.com/"], ["tiktok", "https://tiktok.com.evil.example/"], ["facebook", "https://evil.example/facebook.com"], ["linkedin", "javascript:alert(1)"]]) assert.equal(signInAllowed(p, u), false, u);
});

test("the app attaches to its own Chrome as a local browser, so videos over 50 MB upload (a creator's 147 MB clip failed on every platform without it)", () => {
  const src = readFileSync(join(import.meta.dirname, "chrome.ts"), "utf8");
  assert.match(src, /export const LOCAL = \{ isLocal: true \}/);
  const calls = src.match(/connectOverCDP\([^)]*\)/g) ?? [];
  assert.ok(calls.length >= 2);
  for (const c of calls) assert.match(c, /LOCAL\)$/, c);
});
