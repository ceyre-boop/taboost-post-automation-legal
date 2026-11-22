// A form upload (multipart/form-data) read as it arrives. Each file goes straight to disk,
// so a 3 GB phone video never sits in memory: the most held at once is one network chunk
// plus a few bytes of the boundary line. Text fields (captions, platform names) are small
// and kept in memory, with a cap.
//
// Written here rather than taken from a package so the app has nothing extra to ship, and
// so the rules that matter to it (a file is only kept if it arrived whole, a partial one is
// deleted, a field is capped, the disk is checked) live in one place with tests.
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statfsSync, type WriteStream } from "node:fs";
import { dirname, join } from "node:path";

export interface UploadedFile {
  /** The form field it came in (for example "videos"). */
  field: string;
  /** Its place among the parts with that field name, counting empty ones, so captions stay
   *  lined up with their clips the way the page numbered them. */
  index: number;
  /** The name on the person's device, as sent. Only for showing. */
  filename: string;
  contentType: string;
  /** Where it was written. Empty files are not written and have path "". */
  path: string;
  size: number;
}

export interface StreamedForm {
  fields: Map<string, string[]>;
  files: UploadedFile[];
  bytes: number;
}

export interface StreamOptions {
  /** Folder the files are written into. */
  dir: string;
  /** The file name to use on disk for a part (never the person's own name as-is). */
  name: (field: string, index: number, filename: string) => string;
  /** Only parts with these field names may be files; any other file part is refused. */
  fileFields: string[];
  /** The most one text field may hold. */
  maxFieldBytes?: number;
  /** A sanity limit on the whole request, far above any platform's own. */
  maxBytes?: number;
  /** Free space to leave on the disk after the upload. */
  keepFreeBytes?: number;
  /** Told how many bytes have arrived so far (for the log). */
  onProgress?: (bytes: number) => void;
  /** Called as each file starts, with the text fields so far. Throw an UploadError to refuse
   *  the upload before any of that file is written (the page sends its choices first). */
  beforeFile?: (fields: Map<string, string[]>) => void;
}

/** A plain-English reason the upload was refused. The server sends it to the page as is. */
export class UploadError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

const GB = 1024 ** 3;
/** Far above YouTube's 256 GB, the largest any platform takes. Only a runaway request hits it. */
export const SANITY_MAX_BYTES = Number(process.env.POSTER_MAX_UPLOAD_GB ?? 1024) * GB;

export function boundaryOf(contentType: string | undefined): string {
  const m = /^multipart\/form-data\s*;.*?\bboundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType ?? "");
  const b = m ? (m[1] ?? m[2]) : "";
  if (!b || b.length > 200) throw new UploadError("That upload wasn't understood. Try adding the video again.", 400);
  return b;
}

/** Free bytes on the disk that holds this folder (or the nearest folder above it that exists
 *  yet), or Infinity if it can't be told. */
export function freeBytes(dir: string): number {
  let d = dir;
  for (let i = 0; i < 20 && !existsSync(d) && dirname(d) !== d; i++) d = dirname(d);
  try { const s = statfsSync(d); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; }
}

const words = (n: number) => (n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);

/** Refuse an upload the disk can't hold before a single byte is written. */
export function checkSpace(dir: string, declared: number, keepFree = 2 * GB, maxBytes = SANITY_MAX_BYTES): void {
  if (declared > maxBytes) throw new UploadError(`That upload is over ${words(maxBytes)}, more than any platform takes.`, 413);
  const free = freeBytes(dir);
  if (declared > 0 && declared + keepFree > free) {
    throw new UploadError(`This Mac doesn't have room for that video. It needs about ${words(declared + keepFree)} free and has ${words(free)}. Free up some space, then try again.`, 507);
  }
}

function headerParams(raw: string): { name: string; filename?: string; contentType: string } {
  let name = "", filename: string | undefined, contentType = "text/plain";
  for (const line of raw.split("\r\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === "content-disposition") {
      const n = /\bname="((?:[^"\\]|\\.)*)"/i.exec(value) ?? /\bname=([^;\s]+)/i.exec(value);
      if (n) name = n[1].replace(/\\(.)/g, "$1");
      const f = /\bfilename="((?:[^"\\]|\\.)*)"/i.exec(value) ?? /\bfilename=([^;\s]+)/i.exec(value);
      if (f) filename = f[1].replace(/\\(.)/g, "$1");
    } else if (key === "content-type") contentType = value;
  }
  return { name, filename, contentType };
}

function write(ws: WriteStream, data: Buffer): Promise<void> {
  if (!data.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ok = ws.write(data, (e) => { if (e) reject(e); });
    if (ok) return resolve();
    // Wait for the disk to catch up before reading more of the request (this is what keeps memory flat).
    const done = (e?: Error) => { ws.off("drain", onDrain); ws.off("error", done); e ? reject(e) : resolve(); };
    const onDrain = () => done();
    ws.on("drain", onDrain);
    ws.on("error", done);
  });
}
function finish(ws: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => { ws.once("error", reject); ws.end(() => resolve()); });
}

/**
 * Read a multipart form from `body` (the request) as it arrives. Files are written to
 * `opts.dir` under a ".part" name and renamed when they have arrived whole; anything left
 * half-written by a dropped connection or a refusal is deleted before this throws.
 */
export async function streamMultipart(body: AsyncIterable<Buffer | Uint8Array>, contentType: string | undefined, opts: StreamOptions): Promise<StreamedForm> {
  const boundary = boundaryOf(contentType);
  const open = Buffer.from(`--${boundary}`);
  const delim = Buffer.from(`\r\n--${boundary}`);
  const maxField = opts.maxFieldBytes ?? 64 * 1024;
  const maxBytes = opts.maxBytes ?? SANITY_MAX_BYTES;
  const keepFree = opts.keepFreeBytes ?? 2 * GB;

  const fields = new Map<string, string[]>();
  const files: UploadedFile[] = [];
  const counts = new Map<string, number>();
  const written: string[] = []; // every path touched, to clean up on failure

  type State = "preamble" | "headers" | "body" | "after" | "done";
  let state: State = "preamble";
  let buf: Buffer = Buffer.alloc(0);
  let total = 0;
  let sinceCheck = 0;
  // The part being read.
  let part: { name: string; filename?: string; contentType: string } | null = null;
  let ws: WriteStream | null = null;
  let tmp = "";
  let file: UploadedFile | null = null;
  let text: Buffer[] = [];
  let textLen = 0;

  const startPart = (raw: string) => {
    part = headerParams(raw);
    if (!part.name) throw new UploadError("That upload wasn't understood. Try adding the video again.", 400);
    if (part.filename !== undefined) {
      if (!opts.fileFields.includes(part.name)) throw new UploadError("That upload had a file where none was expected.", 400);
      opts.beforeFile?.(fields);
      const index = counts.get(part.name) ?? 0;
      counts.set(part.name, index + 1);
      file = { field: part.name, index, filename: part.filename, contentType: part.contentType, path: "", size: 0 };
      tmp = "";
    } else {
      text = []; textLen = 0;
    }
  };
  const bodyBytes = async (data: Buffer) => {
    if (!data.length || !part) return;
    if (file) {
      if (!ws) {
        // Opened on the first byte, so an empty file input writes nothing at all.
        tmp = join(opts.dir, opts.name(file.field, file.index, file.filename)) + ".part";
        mkdirSync(opts.dir, { recursive: true }); // only once there is something to keep
        written.push(tmp);
        ws = createWriteStream(tmp, { flags: "wx" });
      }
      file.size += data.length;
      await write(ws, data);
    } else {
      textLen += data.length;
      if (textLen > maxField) throw new UploadError("A caption in that upload is too long.", 413);
      text.push(Buffer.from(data));
    }
  };
  const endPart = async () => {
    if (!part) return;
    if (file) {
      if (ws) {
        await finish(ws);
        const dest = tmp.slice(0, -".part".length);
        renameSync(tmp, dest);
        written.push(dest);
        file.path = dest;
        ws = null;
      }
      files.push(file);
      file = null;
    } else {
      const list = fields.get(part.name) ?? [];
      list.push(Buffer.concat(text).toString("utf8"));
      fields.set(part.name, list);
    }
    part = null;
  };

  try {
    for await (const raw of body) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      total += chunk.length;
      sinceCheck += chunk.length;
      if (total > maxBytes) throw new UploadError(`That upload is over ${words(maxBytes)}, more than any platform takes.`, 413);
      // Check the disk every 256 MB, for an upload that didn't say its size up front.
      if (sinceCheck > 256 * 1024 * 1024) { sinceCheck = 0; if (freeBytes(opts.dir) < keepFree) throw new UploadError("This Mac ran out of room while the video arrived. Free up some space, then try again.", 507); }
      opts.onProgress?.(total);
      // Inside a file, only a few bytes of the last chunk are held back (in case the boundary
      // is split across two chunks). When no boundary starts in them, write them out and use
      // the new chunk as it is, instead of copying it onto them: at gigabit speed that copy
      // was most of the memory the upload used.
      if (state === "body" && buf.length > 0 && buf.length < delim.length && chunk.length >= delim.length) {
        const seam = Buffer.concat([buf, chunk.subarray(0, delim.length - 1)]);
        const at = seam.indexOf(delim);
        if (at < 0 || at >= buf.length) { await bodyBytes(buf); buf = Buffer.alloc(0); }
      }
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

      for (;;) {
        if (state === "preamble") {
          const at = buf.indexOf(open);
          if (at < 0) { buf = buf.subarray(Math.max(0, buf.length - open.length)); break; }
          buf = buf.subarray(at + open.length);
          state = "after";
        } else if (state === "after") {
          if (buf.length < 2) break;
          const two = buf.toString("latin1", 0, 2);
          if (two === "--") { state = "done"; buf = Buffer.alloc(0); break; }
          // Some senders put spaces before the line break; allow them.
          const nl = buf.indexOf("\r\n");
          if (nl < 0) { if (buf.length > 256) throw new UploadError("That upload wasn't understood.", 400); break; }
          buf = buf.subarray(nl + 2);
          state = "headers";
        } else if (state === "headers") {
          const end = buf.indexOf("\r\n\r\n");
          if (end < 0) { if (buf.length > 16 * 1024) throw new UploadError("That upload wasn't understood.", 400); break; }
          startPart(buf.toString("utf8", 0, end));
          buf = buf.subarray(end + 4);
          state = "body";
        } else if (state === "body") {
          const at = buf.indexOf(delim);
          if (at >= 0) {
            await bodyBytes(buf.subarray(0, at));
            await endPart();
            buf = buf.subarray(at + delim.length);
            state = "after";
            continue;
          }
          // Keep just enough of the end to catch a boundary split across two chunks.
          const safe = buf.length - (delim.length - 1);
          if (safe > 0) {
            await bodyBytes(buf.subarray(0, safe));
            buf = Buffer.from(buf.subarray(safe)); // copy, so the big chunk can be freed
          }
          break;
        } else break; // done: ignore anything after the closing boundary
      }
      if (state === "done") break;
    }
    if (state !== "done") throw new UploadError("The upload stopped before the whole video arrived. Check the connection and try again.", 400);
    return { fields, files, bytes: total };
  } catch (e) {
    try { (ws as WriteStream | null)?.destroy(); } catch { /* already closed */ }
    for (const p of written) { try { rmSync(p, { force: true }); } catch { /* gone */ } }
    if (e instanceof UploadError) throw e;
    const msg = String((e as Error)?.message ?? e);
    if (/aborted|ECONNRESET|socket hang up|premature/i.test(msg)) throw new UploadError("The upload stopped before the whole video arrived. Check the connection and try again.", 400);
    if (/ENOSPC/.test(msg)) throw new UploadError("This Mac ran out of room while the video arrived. Free up some space, then try again.", 507);
    throw e;
  }
}
