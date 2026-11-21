// node --test src/security.test.ts
// Plays the attacker: a web page the person happens to have open, trying to use the
// app behind their back. Every attempt must be refused before anything is touched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "pe-security-"));
process.env.POSTER_APP_DIR = DIR;
const PORT = 47000 + Math.floor(Math.random() * 900);
const { startServer } = await import("./server.ts");
const { readSettings } = await import("./app.ts");

let base = "";
before(async () => { base = (await startServer({ port: PORT, open: false })).url; });
after(() => { setTimeout(() => process.exit(0), 50); });

/** A raw request, so the test can send headers a browser's fetch would not let it set. */
function send(method: string, path: string, headers: Record<string, string>, body = ""): Promise<{ status: number; headers: Record<string, any>; text: string }> {
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
const form = (boundary: string, fields: [string, string][]) => fields.map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"${k === "videos" ? '; filename="evil.mp4"\r\nContent-Type: video/mp4' : ""}\r\n\r\n${v}\r\n`).join("") + `--${boundary}--\r\n`;

test("the app's own page works: same-origin and header-less local requests are served", async () => {
  assert.equal((await send("GET", "/api/app", {})).status, 200);
  assert.equal((await send("GET", "/api/app", { origin: `http://127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin" })).status, 200);
  assert.equal((await send("GET", "/api/app", { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` })).status, 200);
  const ok = await send("POST", "/api/settings", { origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" }, JSON.stringify({ spaceSec: 120 }));
  assert.equal(ok.status, 200);
  assert.equal(readSettings().spaceSec, 120);
});

test("another website cannot publish a video through the app (the drive-by post)", async () => {
  const b = "xEVILx";
  // Exactly what a hidden <form> on evil.example can send: no preflight is needed for this.
  const body = form(b, [["videos", "not really a video"], ["caption0", "Buy my scam"], ["platforms", "tiktok"], ["platforms", "youtube"], ["live", "on"], ["space", "0"]]);
  const attempts: Record<string, string>[] = [
    { origin: "https://evil.example" },
    { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "cross-site" },
    { origin: "null" }, // a sandboxed frame or a local file
    { origin: `https://127.0.0.1:${PORT}` }, // right address, wrong scheme
    { origin: `http://127.0.0.1:${PORT + 1}` }, // another app on this Mac
    { origin: `http://127.0.0.1.evil.example:${PORT}` },
  ];
  for (const headers of attempts) {
    const r = await send("POST", "/api/batch", { ...headers, "content-type": `multipart/form-data; boundary=${b}` }, body);
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.match(r.text, /Only the app's own page/);
  }
  // Nothing was saved, queued or started.
  assert.equal(existsSync(join(DIR, "uploads")), false);
  assert.equal(existsSync(join(DIR, "batches")), false);
  assert.equal(JSON.parse((await send("GET", "/api/batches/current", {})).text), null);
});

test("another website cannot change settings, add sets, sign anyone out or open a sign-in window", async () => {
  const before = JSON.stringify(readSettings());
  for (const [path, body] of [
    ["/api/settings", JSON.stringify({ spaceSec: 0, onboarded: true })],
    ["/api/sets", JSON.stringify({ name: "Hacked" })],
    ["/api/sets/active", JSON.stringify({ id: "hacked" })],
    ["/api/disconnect", JSON.stringify({ platform: "tiktok" })],
    ["/api/login", JSON.stringify({ platform: "tiktok" })],
    ["/api/batches/anything/resume", ""],
  ] as const) {
    // text/plain is what lets a page send JSON without a preflight.
    const r = await send("POST", path, { origin: "https://evil.example", "content-type": "text/plain" }, body);
    assert.equal(r.status, 403, path);
  }
  assert.equal(JSON.stringify(readSettings()), before);
  assert.equal(existsSync(join(DIR, "chrome-profile")), false, "no Chrome was launched for the attacker");
});

test("a website cannot read the person's history or accounts, even by pointing its own name at this Mac", async () => {
  for (const path of ["/api/history", "/api/app", "/api/status", "/", "/api/batches/current"]) {
    assert.equal((await send("GET", path, { host: "evil.example" })).status, 403, `rebinding ${path}`);
    assert.equal((await send("GET", path, { host: `evil.example:${PORT}` })).status, 403, `rebinding with port ${path}`);
    assert.equal((await send("GET", path, { origin: "https://evil.example" })).status, 403, `cross-origin ${path}`);
    assert.equal((await send("GET", path, { "sec-fetch-site": "cross-site" })).status, 403, `cross-site ${path}`);
  }
  // And no response invites another origin in.
  const r = await send("GET", "/api/app", {});
  assert.equal(r.headers["access-control-allow-origin"], undefined);
});

test("the page cannot be framed, and says what it may load", async () => {
  const r = await send("GET", "/", {});
  assert.equal(r.status, 200);
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.match(String(r.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.match(String(r.headers["content-security-policy"]), /default-src 'self'/);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  // The page itself asks no other server for anything.
  assert.doesNotMatch(r.text, /<(script|link|img|iframe)[^>]+(src|href)=["']https?:\/\//i);
});

test("odd input is refused politely, not crashed on", async () => {
  const own = { origin: `http://127.0.0.1:${PORT}` };
  assert.equal((await send("POST", "/api/settings", { ...own, "content-type": "application/json" }, "{not json")).status, 400);
  assert.equal((await send("POST", "/api/disconnect", { ...own, "content-type": "application/json" }, JSON.stringify({ platform: "../../etc" }))).status, 400);
  assert.equal((await send("POST", "/api/disconnect", { ...own, "content-type": "application/json" }, JSON.stringify({ platform: "pinterest" }))).status, 400);
  assert.equal((await send("POST", "/api/sets", { ...own, "content-type": "application/json" }, JSON.stringify({ name: "<script>alert(1)</script>" }))).status, 200);
  assert.deepEqual(readSettings().sets.map((s) => s.name), ["scriptalert1script"]); // markup characters never reach the file
  assert.equal((await send("GET", "/api/batches/..%2F..%2Fsettings", {})).status, 404);
  assert.equal((await send("GET", "/../../etc/passwd", {})).status, 404);
  const b = "xBx";
  const bad = await send("POST", "/api/batch", { ...own, "content-type": `multipart/form-data; boundary=${b}` }, form(b, [["videos", "x"], ["platforms", "not-a-platform"]]));
  assert.equal(bad.status, 400);
  assert.equal(existsSync(join(DIR, "uploads")), false, "a refused post writes no file");
  // A declared body beyond the limit is refused before it is read.
  const big = await new Promise<number>((resolve) => {
    const req = request({ host: "127.0.0.1", port: PORT, method: "POST", path: "/api/batch", headers: { host: `127.0.0.1:${PORT}`, ...own, "content-type": `multipart/form-data; boundary=${b}`, "content-length": String(50 * 1024 ** 3) } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", () => resolve(-1));
    req.write("x"); req.end();
  });
  assert.equal(big, 413);
});

test("nothing the app keeps holds a password, a token or a cookie", () => {
  const files = readdirSync(DIR);
  assert.deepEqual(files.sort(), ["settings.json"]);
});
