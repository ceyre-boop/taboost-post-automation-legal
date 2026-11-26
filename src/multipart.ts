// A streaming multipart/form-data reader for uploads.
//
// The old way read the whole request into memory (and then again into a FormData), so one
// big or hostile upload could use several times its size in RAM, and a failed one left
// nothing to clean up only because nothing had reached the disk. This reader:
//   - writes each file part straight to disk as it arrives (backpressure respected),
//   - hashes it as it goes (sha256, used to spot the same video sent twice),
//   - stops the moment a cap is crossed, and deletes everything it wrote so far,
//   - never uses the sender's file name for a path: the caller names the file.
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, rmSync, statfsSync, type WriteStream } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname } from "node:path";

/** A request the app refuses, with the status to answer with and a sentence for the person. */
export class UploadRefused extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface SavedFile { field: string; filename: string; type: string; path: string; bytes: number; sha256: string; }
export interface Parsed { fields: Map<string, string[]>; files: SavedFile[]; }

export interface MultipartOptions {
  /** The whole request, in bytes. */
  maxTotal: number;
  /** One file part, in bytes. */
  maxFile: number;
  /** One text field, in bytes. */
  maxField?: number;
  maxFiles?: number;
  maxParts?: number;
  /** Where a file part goes. Return null to refuse that part (not a file we accept). */
  destFor: (info: { field: string; filename: string; type: string; index: number }) => string | null;
  /** Looks at the first bytes of a saved file; throw UploadRefused if it isn't what it claims. */
  check?: (file: SavedFile, head: Buffer) => void;
}

const HEADER_MAX = 16 * 1024;

function boundaryOf(contentType: string): string {
  const m = /^multipart\/form-data\s*;.*?boundary=(?:"([^"]{1,200})"|([^;\s]{1,200}))/i.exec(contentType);
  const b = m?.[1] ?? m?.[2];
  if (!b) throw new UploadRefused(400, "That request wasn't an upload the app understands.");
  return b;
}

function parseHeaders(raw: string): { name: string; filename: string | null; type: string } {
  let name = "", filename: string | null = null, type = "";
  for (const line of raw.split("\r\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === "content-disposition") {
      name = /\bname="((?:[^"\\]|\\.)*)"/i.exec(v)?.[1] ?? "";
      const f = /\bfilename="((?:[^"\\]|\\.)*)"/i.exec(v);
      filename = f ? f[1] : null;
    } else if (k === "content-type") type = v.split(";")[0].trim().toLowerCase();
  }
  return { name, filename, type };
}

export async function readMultipart(req: IncomingMessage, opts: MultipartOptions): Promise<Parsed> {
  const boundary = boundaryOf(String(req.headers["content-type"] ?? ""));
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > opts.maxTotal) throw new UploadRefused(413, "That's more video than the app can take in one go.");
  const maxField = opts.maxField ?? 1024 * 1024, maxFiles = opts.maxFiles ?? 10, maxParts = opts.maxParts ?? 200;
  const delim = Buffer.from(`\r\n--${boundary}`);
  const fields = new Map<string, string[]>();
  const files: SavedFile[] = [];
  const written: string[] = [];

  let state: "preamble" | "after" | "headers" | "body" | "end" = "preamble";
  let buf: Buffer = Buffer.from("\r\n"); // so the first delimiter, which has no CRLF before it, matches
  let total = 0, parts = 0;
  let sink: { out: WriteStream; file: SavedFile; hash: ReturnType<typeof createHash>; head: Buffer } | null = null;
  let field: { name: string; chunks: Buffer[]; size: number } | null = null;

  const write = (s: NonNullable<typeof sink>, data: Buffer) => new Promise<void>((resolve, reject) => {
    if (!data.length) return resolve();
    s.file.bytes += data.length;
    if (s.file.bytes > opts.maxFile) return reject(new UploadRefused(413, "That video is bigger than the app accepts."));
    s.hash.update(data);
    if (s.head.length < 64) s.head = Buffer.concat([s.head, data.subarray(0, 64 - s.head.length)]);
    s.out.write(data, (e) => (e ? reject(e) : resolve()));
  });
  const finishSink = async () => {
    if (!sink) return;
    const s = sink; sink = null;
    await new Promise<void>((resolve, reject) => { s.out.once("error", reject); s.out.end(() => resolve()); });
    s.file.sha256 = s.hash.digest("hex");
    opts.check?.(s.file, s.head);
    files.push(s.file);
  };
  const cleanup = () => {
    try { sink?.out.destroy(); } catch { /* already closed */ }
    for (const p of written) rmSync(p, { force: true });
  };

  try {
    // Pulled by hand, not with for-await: leaving a for-await early destroys the socket, and then the
    // person would see "network error" instead of the sentence saying why it was refused.
    const it = (req as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
    for (;;) {
      const next = await it.next();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.length;
      if (total > opts.maxTotal) throw new UploadRefused(413, "That's more video than the app can take in one go.");
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (state === "end") { buf = Buffer.alloc(0); break; }
        if (state === "preamble") {
          const i = buf.indexOf(delim);
          if (i < 0) { if (buf.length > delim.length) buf = buf.subarray(buf.length - delim.length); break; }
          buf = buf.subarray(i + delim.length); state = "after";
        }
        if (state === "after") {
          if (buf.length < 2) break;
          const two = buf.toString("latin1", 0, 2);
          if (two === "--") { state = "end"; continue; }
          if (two !== "\r\n") throw new UploadRefused(400, "That upload was damaged.");
          buf = buf.subarray(2); state = "headers";
        }
        if (state === "headers") {
          const i = buf.indexOf("\r\n\r\n");
          if (i < 0) { if (buf.length > HEADER_MAX) throw new UploadRefused(400, "That upload was damaged."); break; }
          if (++parts > maxParts) throw new UploadRefused(400, "That upload has too many parts.");
          const h = parseHeaders(buf.toString("latin1", 0, i));
          buf = buf.subarray(i + 4);
          // An empty file box (no file chosen) arrives as filename="" with no bytes: it is just an empty field.
          if (h.filename !== null && h.filename !== "") {
            const dest = files.length >= maxFiles ? null : opts.destFor({ field: h.name, filename: h.filename, type: h.type, index: parts - 1 });
            if (dest === null) throw new UploadRefused(415, "Only video files can be uploaded (MP4, MOV, M4V or WebM).");
            mkdirSync(dirname(dest), { recursive: true });
            written.push(dest);
            const out = createWriteStream(dest, { mode: 0o600 });
            out.on("error", () => { /* surfaced by write() */ });
            sink = { out, file: { field: h.name, filename: h.filename, type: h.type, path: dest, bytes: 0, sha256: "" }, hash: createHash("sha256"), head: Buffer.alloc(0) };
          } else field = { name: h.name, chunks: [], size: 0 };
          state = "body";
        }
        if (state === "body") {
          const i = buf.indexOf(delim);
          const upto = i >= 0 ? i : Math.max(0, buf.length - (delim.length - 1));
          const data = buf.subarray(0, upto);
          if (sink) await write(sink, data);
          else if (field) {
            field.size += data.length;
            if (field.size > maxField) throw new UploadRefused(413, "A form field in that upload is too long.");
            field.chunks.push(Buffer.from(data));
          }
          buf = buf.subarray(upto);
          if (i < 0) break;
          buf = buf.subarray(delim.length);
          if (sink) await finishSink();
          else if (field) { const list = fields.get(field.name) ?? []; list.push(Buffer.concat(field.chunks).toString("utf8")); fields.set(field.name, list); field = null; }
          state = "after";
          continue;
        }
        break;
      }
    }
    if (state !== "end") throw new UploadRefused(400, "The upload stopped before it finished. Try again.");
    return { fields, files };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** Free bytes on the disk that holds `dir` (null if the system won't say). */
export function freeBytes(dir: string): number | null {
  try {
    let at = dir; // the folder may not exist yet: ask about the nearest one that does
    while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
    const s = statfsSync(at);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return null; }
}

/** What a video really is, by its first bytes (never by its name): MP4/MOV/M4V ("ftyp") or WebM/Matroska. */
export function looksLikeVideo(head: Buffer): boolean {
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp") return true;
  return head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
}
