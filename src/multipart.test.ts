// node --test src/multipart.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundaryOf, checkSpace, streamMultipart, UploadError } from "./multipart.ts";

const B = "----PosterTestBoundary7MA4YWxk";
const CT = `multipart/form-data; boundary=${B}`;
const field = (name: string, value: string) => `--${B}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
const filePart = (name: string, filename: string, body: string) => `--${B}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: video/quicktime\r\n\r\n${body}\r\n`;
const end = `--${B}--\r\n`;
const opts = (dir: string) => ({ dir, fileFields: ["videos"], name: (f: string, i: number, n: string) => `${f}-${i}-${n.replace(/[^\w.]/g, "_")}` });

async function* chunks(buf: Buffer, size: number) { for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size); }

test("fields and files come out whole however the body is split, captions keep their clip's number", async () => {
  // A file body that itself contains boundary-like text and line breaks.
  const tricky = `a\r\n--${B.slice(0, 10)}\r\n--not-it\r\n` + "x".repeat(300);
  const body = Buffer.from(
    "preamble to ignore\r\n" +
    field("caption", "Shared caption with émoji 🥁") +
    filePart("videos", "first clip.mov", tricky) +
    filePart("videos", "", "") + // an empty file input: counted, not written
    field("caption2", "third") +
    filePart("videos", "third.mov", "333") +
    field("platforms", "x") + field("platforms", "youtube") +
    end);
  for (const size of [1, 2, 3, 7, 13, 64, 1000, body.length]) {
    const dir = mkdtempSync(join(tmpdir(), "mp-"));
    const form = await streamMultipart(chunks(body, size), CT, opts(dir));
    assert.equal(form.fields.get("caption")?.[0], "Shared caption with émoji 🥁", `split ${size}`);
    assert.deepEqual(form.fields.get("platforms"), ["x", "youtube"]);
    assert.equal(form.fields.get("caption2")?.[0], "third");
    assert.deepEqual(form.files.map((f) => [f.index, f.filename, f.size]), [[0, "first clip.mov", Buffer.byteLength(tricky)], [1, "", 0], [2, "third.mov", 3]]);
    assert.equal(readFileSync(form.files[0].path, "utf8"), tricky);
    assert.equal(form.files[1].path, "");
    assert.equal(readFileSync(form.files[2].path, "utf8"), "333");
    assert.deepEqual(readdirSync(dir).sort(), ["videos-0-first_clip.mov", "videos-2-third.mov"]);
  }
});

test("a 600 MB upload goes to disk with memory staying flat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-big-"));
  const MB = 1024 * 1024, total = 600;
  async function* body() {
    yield Buffer.from(field("caption", "big one") + `--${B}\r\nContent-Disposition: form-data; name="videos"; filename="big.mov"\r\n\r\n`);
    // Fresh 64 KB chunks, the size a network socket hands over.
    for (let i = 0; i < total * 16; i++) yield Buffer.alloc(64 * 1024, i % 251);
    yield Buffer.from(`\r\n${end}`);
  }
  if (global.gc) global.gc();
  const before = process.memoryUsage().rss;
  let peak = before;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
  const form = await streamMultipart(body(), CT, opts(dir));
  clearInterval(timer);
  peak = Math.max(peak, process.memoryUsage().rss);
  assert.equal(form.files[0].size, total * MB);
  assert.equal(statSync(form.files[0].path).size, total * MB);
  const grew = (peak - before) / MB;
  assert.ok(grew < 120, `memory grew ${grew.toFixed(0)} MB while 600 MB went through`);
});

test("a dropped connection leaves no half-written file behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-drop-"));
  async function* body() {
    yield Buffer.from(filePart("videos", "a.mov", "whole") + `--${B}\r\nContent-Disposition: form-data; name="videos"; filename="b.mov"\r\n\r\n`);
    yield Buffer.alloc(200_000, 1);
    throw Object.assign(new Error("aborted"), { code: "ECONNRESET" });
  }
  await assert.rejects(streamMultipart(body(), CT, opts(dir)), (e: unknown) => e instanceof UploadError && /stopped before the whole video arrived/.test(e.message));
  assert.deepEqual(readdirSync(dir), []);
  // A body that just ends without its closing line is the same thing.
  await assert.rejects(streamMultipart(chunks(Buffer.from(filePart("videos", "a.mov", "x").slice(0, -2)), 5), CT, opts(dir)), UploadError);
  assert.deepEqual(readdirSync(dir), []);
});

test("refusals: a file in a text field, an oversized caption, a runaway request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-no-"));
  await assert.rejects(streamMultipart(chunks(Buffer.from(filePart("caption", "x.mov", "1") + end), 50), CT, opts(dir)), /a file where none was expected/);
  await assert.rejects(streamMultipart(chunks(Buffer.from(field("caption", "y".repeat(70_000)) + end), 4096), CT, opts(dir)), /too long/);
  await assert.rejects(streamMultipart(chunks(Buffer.from(filePart("videos", "a.mov", "z".repeat(5000)) + end), 1000), CT, { ...opts(dir), maxBytes: 2000 }), (e: unknown) => e instanceof UploadError && e.status === 413);
  assert.deepEqual(readdirSync(dir), []);
});

test("boundary is read from the header, quoted or not; a full disk is refused up front", () => {
  assert.equal(boundaryOf(`multipart/form-data; boundary="${B}"`), B);
  assert.equal(boundaryOf(`multipart/form-data; charset=utf-8; boundary=${B}`), B);
  assert.throws(() => boundaryOf("application/json"), UploadError);
  assert.throws(() => checkSpace(tmpdir(), 1e18), (e: unknown) => e instanceof UploadError && e.status === 413);
  assert.throws(() => checkSpace(tmpdir(), 1e18, 0, Infinity), (e: unknown) => e instanceof UploadError && e.status === 507 && /doesn't have room/.test(e.message));
  checkSpace(tmpdir(), 1024); // a small upload is fine
});
