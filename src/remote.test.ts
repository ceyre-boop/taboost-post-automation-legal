// node --test src/remote.test.ts
// Phone-link mode (an access key is set). Holding the link is not enough: every request
// must come from a phone that registered, so it only ever reaches that phone's own Chrome
// profile, never the Mac's accounts. The post maker isn't reachable at all.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "pe-remote-"));
process.env.POSTER_APP_DIR = DIR;
const PORT = 48900 + Math.floor(Math.random() * 90);
const KEY = "test-link-key-123";
const { startServer } = await import("./server.ts");

before(async () => { await startServer({ port: PORT, open: false, token: KEY }); });
after(() => { setTimeout(() => process.exit(0), 50); });

function send(method: string, path: string, headers: Record<string, string> = {}, body = ""): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, method, path, headers: { host: `phone.example:${PORT}`, ...headers, "content-length": Buffer.byteLength(body) } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("without the link's key nothing is served", async () => {
  for (const p of ["/api/app", "/api/status", "/api/history", "/m"]) assert.equal((await send("GET", p)).status, 401, p);
});

test("with the key but no registered phone, nothing but registering is allowed", async () => {
  const k = { "x-poster-key": KEY, "content-type": "application/json" };
  for (const [m, p, b] of [
    ["GET", "/api/app", ""], ["GET", "/api/status", ""], ["GET", "/api/history", ""], ["POST", "/api/sets", '{"name":"x"}'],
    ["POST", "/api/sets/active", '{"id":""}'], ["POST", "/api/disconnect", '{"platform":"tiktok"}'], ["POST", "/api/login", '{"platform":"tiktok"}'],
    ["POST", "/api/remote/open", '{"platform":"youtube"}'], ["POST", "/api/remote/input", '{"type":"tap"}'], ["POST", "/api/batch", ""],
  ] as const) {
    const r = await send(m, p, k, b);
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.match(r.text, /isn't registered/);
  }
  // A made-up device id is refused the same way.
  assert.equal((await send("GET", "/api/app", { ...k, "x-poster-device": "AAAAAAAAAAAA" })).status, 401);
});

test("a phone that registers can use its own link", async () => {
  const k = { "x-poster-key": KEY, "content-type": "application/json" };
  const d = JSON.parse((await send("POST", "/api/device", k, '{"name":"Sam"}')).text);
  assert.match(d.id, /^[A-Za-z0-9_-]{12}$/);
  assert.equal((await send("GET", "/api/app", { ...k, "x-poster-device": d.id })).status, 200);
  assert.equal((await send("GET", "/m", { "x-poster-key": KEY })).status, 200);
});

test("the post maker and its render page aren't reachable from the phone link", async () => {
  const k = { "x-poster-key": KEY, "content-type": "application/json" };
  const d = JSON.parse((await send("POST", "/api/device", k, '{"name":"Ann"}')).text);
  for (const p of ["/api/maker", "/render", "/vendor/mp4-muxer.mjs", "/api/maker/job/m-0000000000"]) assert.equal((await send("GET", p, { ...k, "x-poster-device": d.id })).status, 404, p);
});
