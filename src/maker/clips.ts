// The person's own video clips, kept per set of accounts in <set>/maker/clips/.
//
// A clip can be finished on its own (a title, captions, music, an end card) or used as a
// moving background in the photo formats. Uploads are written straight to disk as they
// arrive, so a big clip never sits in memory, and each one is checked by reading the MP4
// itself (length, size, sound, codec), never by trusting its name.
import { randomBytes } from "node:crypto";
import { closeSync, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { BriefError, makerDir } from "./brief.ts";

export const CLIP_LIMITS = { count: 20, bytes: 1024 * 1024 * 1024, seconds: { min: 2, max: 600 }, use: 56, note: 200 };

export interface Clip {
  name: string;
  /** The file's name on the person's Mac, for showing only. */
  file: string;
  bytes: number;
  seconds: number;
  width: number;
  height: number;
  audio: boolean;
  /** What the clip shows, in the person's words. The script is written from this. */
  note: string;
  /** The part to use, in seconds from the start (at most CLIP_LIMITS.use long). */
  start: number;
  end: number;
  addedAt: string;
}

const NAME_RE = /^c-[a-f0-9]{12}\.(mp4|mov|m4v)$/;
export const isClipName = (n: string): boolean => NAME_RE.test(n);
export const clipsDir = (set: string) => join(makerDir(set), "clips");
const indexFile = (set: string) => join(clipsDir(set), "clips.json");
export const clipPath = (set: string, name: string) => join(clipsDir(set), name);

export function listClips(set: string): Clip[] {
  try {
    const all = JSON.parse(readFileSync(indexFile(set), "utf8")) as Clip[];
    return all.filter((c) => isClipName(c.name) && existsSync(clipPath(set, c.name)));
  } catch { return []; }
}
export const readClip = (set: string, name: string): Clip | null => listClips(set).find((c) => c.name === name) ?? null;

function saveIndex(set: string, clips: Clip[]): void {
  mkdirSync(clipsDir(set), { recursive: true });
  writeFileSync(indexFile(set) + ".tmp", JSON.stringify(clips, null, 2));
  renameSync(indexFile(set) + ".tmp", indexFile(set));
}

/* ---------------- reading an MP4 / QuickTime file ---------------- */

export interface Probe { seconds: number; width: number; height: number; audio: boolean; codec: string; fragmented?: boolean; }

/** Read the movie header (moov) from a file without loading the video data. */
export function probeFile(path: string): Probe | null {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(16);
    let at = 0, sawFtyp = false;
    while (at + 8 <= size) {
      readSync(fd, head, 0, 16, at);
      let len = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      let hdr = 8;
      if (len === 1) { len = Number(head.readBigUInt64BE(8)); hdr = 16; }
      else if (len === 0) len = size - at;
      if (len < hdr) return null;
      if (at === 0 && type === "ftyp") sawFtyp = true;
      if (at === 0 && !["ftyp", "wide", "free", "mdat", "moov", "skip"].includes(type)) return null;
      if (type === "moov") {
        if (len > 64 * 1024 * 1024) return null;
        const moov = Buffer.alloc(len - hdr);
        readSync(fd, moov, 0, moov.length, at + hdr);
        return parseMoov(moov, sawFtyp);
      }
      at += len;
    }
    return null;
  } finally { closeSync(fd); }
}

/** The child boxes of a box body. */
function* boxes(b: Buffer): Generator<{ type: string; body: Buffer }> {
  let at = 0;
  while (at + 8 <= b.length) {
    let len = b.readUInt32BE(at);
    const type = b.toString("latin1", at + 4, at + 8);
    let hdr = 8;
    if (len === 1) { if (at + 16 > b.length) return; len = Number(b.readBigUInt64BE(at + 8)); hdr = 16; }
    else if (len === 0) len = b.length - at;
    if (len < hdr || at + len > b.length) return;
    yield { type, body: b.subarray(at + hdr, at + len) };
    at += len;
  }
}
const child = (b: Buffer, type: string) => { for (const x of boxes(b)) if (x.type === type) return x.body; return null; };

export function parseMoov(moov: Buffer, _ftyp = true): Probe | null {
  const mvhd = child(moov, "mvhd");
  if (!mvhd) return null;
  const v1 = mvhd[0] === 1;
  const timescale = v1 ? mvhd.readUInt32BE(20) : mvhd.readUInt32BE(12);
  let duration = v1 ? Number(mvhd.readBigUInt64BE(24)) : mvhd.readUInt32BE(16);
  if (!timescale) return null;
  // A fragmented MP4 (some screen recorders and streaming exports) keeps its length in mvex/mehd, if anywhere.
  const mehd = !duration ? child(child(moov, "mvex") ?? Buffer.alloc(0), "mehd") : null;
  if (mehd && mehd.length >= 8) duration = mehd[0] === 1 && mehd.length >= 12 ? Number(mehd.readBigUInt64BE(4)) : mehd.readUInt32BE(4);
  const fragmented = !duration && !!child(moov, "mvex");
  let width = 0, height = 0, audio = false, codec = "";
  for (const t of boxes(moov)) {
    if (t.type !== "trak") continue;
    const mdia = child(t.body, "mdia");
    const hdlr = mdia && child(mdia, "hdlr");
    const kind = hdlr && hdlr.length >= 12 ? hdlr.toString("latin1", 8, 12) : "";
    if (kind === "soun") audio = true;
    if (kind !== "vide" || width) continue;
    const tkhd = child(t.body, "tkhd");
    if (!tkhd) continue;
    const m = tkhd[0] === 1 ? 52 : 40; // where the matrix starts (after the times, ids, layer and volume)
    if (tkhd.length < m + 44) continue;
    const a = tkhd.readInt32BE(m), d = tkhd.readInt32BE(m + 16);
    let w = tkhd.readUInt32BE(m + 36) / 65536, h = tkhd.readUInt32BE(m + 40) / 65536;
    if (a === 0 && d === 0) [w, h] = [h, w];   // turned 90 degrees (an iPhone held upright)
    width = Math.round(w); height = Math.round(h);
    const stsd = child(child(child(mdia!, "minf") ?? Buffer.alloc(0), "stbl") ?? Buffer.alloc(0), "stsd");
    if (stsd && stsd.length >= 16) codec = stsd.toString("latin1", 12, 16);
  }
  if (!width || !height) return null;
  return { seconds: duration / timescale, width, height, audio, codec, ...(fragmented ? { fragmented: true } : {}) };
}

/** Codecs Chrome can't open. QuickTime's ProRes is the common one. */
const PRORES = /^(apch|apcn|apcs|apco|ap4h|ap4x)$/;

/* ---------------- adding, changing, removing ---------------- */

/** Write an upload to disk as it arrives, then check it. Returns the clip. */
export async function saveClip(set: string, req: IncomingMessage, fileName: string): Promise<Clip> {
  const have = listClips(set);
  if (have.length >= CLIP_LIMITS.count) throw new BriefError(`That's the most clips the maker keeps (${CLIP_LIMITS.count}). Remove one first.`);
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > CLIP_LIMITS.bytes) throw new BriefError("That clip is over 1 GB. Export a shorter or smaller copy.");
  mkdirSync(clipsDir(set), { recursive: true });
  const tmp = join(clipsDir(set), `.upload-${randomBytes(6).toString("hex")}`);
  let bytes = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(tmp);
      let ended = false;
      const fail = (e: Error) => { out.destroy(); reject(e); };
      req.on("data", (c: Buffer) => {
        bytes += c.length;
        if (bytes > CLIP_LIMITS.bytes) { req.destroy(); fail(new BriefError("That clip is over 1 GB. Export a shorter or smaller copy.")); return; }
        if (!out.write(c)) { req.pause(); out.once("drain", () => req.resume()); }
      });
      req.on("end", () => { ended = true; out.end(() => resolve()); });
      req.on("error", (e) => fail(e));
      // A browser that gives up halfway closes the request without ending it: close the file too, so its space comes back.
      req.on("close", () => { if (!ended) fail(new BriefError("The upload stopped before it finished. Try again.")); });
      out.on("error", (e) => fail(e));
    });
    const p = probeFile(tmp);
    if (!p) throw new BriefError("That file isn't a video the app can read. Use an MP4 or MOV, for example one exported from Photos or QuickTime.");
    if (PRORES.test(p.codec)) throw new BriefError("That clip is ProRes, which Chrome can't open. In QuickTime choose File > Export As > 1080p and add that copy.");
    if (p.fragmented) throw new BriefError("That clip was saved in a streaming format that doesn't say how long it is. Open it in QuickTime, choose File > Export As > 1080p, and add that copy.");
    if (p.seconds < CLIP_LIMITS.seconds.min) throw new BriefError("That clip is under 2 seconds.");
    if (p.seconds > CLIP_LIMITS.seconds.max) throw new BriefError("That clip is over 10 minutes. Trim it first; a post uses at most 56 seconds of it.");
    const ext = /\.mov$/i.test(fileName) ? "mov" : /\.m4v$/i.test(fileName) ? "m4v" : "mp4";
    const name = `c-${randomBytes(6).toString("hex")}.${ext}`;
    renameSync(tmp, clipPath(set, name));
    const clip: Clip = {
      name, file: String(fileName || "clip").replace(/[\u0000-\u001f]/g, "").slice(0, 120), bytes,
      seconds: Math.round(p.seconds * 100) / 100, width: p.width, height: p.height, audio: p.audio,
      note: "", start: 0, end: Math.round(Math.min(p.seconds, CLIP_LIMITS.use) * 100) / 100, addedAt: new Date().toISOString(),
    };
    saveIndex(set, [...listClips(set), clip]);
    return clip;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Change what the clip shows, or which part of it to use. */
export function updateClip(set: string, name: string, patch: { note?: unknown; start?: unknown; end?: unknown }): Clip {
  const all = listClips(set);
  const c = all.find((x) => x.name === name);
  if (!c) throw new BriefError("That clip isn't there any more.");
  if (patch.note !== undefined) c.note = String(patch.note ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, CLIP_LIMITS.note);
  const start = patch.start !== undefined ? Number(patch.start) : c.start;
  const end = patch.end !== undefined ? Number(patch.end) : c.end;
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new BriefError("Use seconds for the start and end, for example 0 and 20.");
  const s = Math.max(0, Math.min(start, c.seconds - CLIP_LIMITS.seconds.min));
  const e = Math.min(c.seconds, Math.max(end, s + CLIP_LIMITS.seconds.min));
  if (e - s > CLIP_LIMITS.use + 0.01) throw new BriefError(`A post uses at most ${CLIP_LIMITS.use} seconds of a clip, so it fits every platform. Move the start or the end.`);
  c.start = Math.round(s * 100) / 100; c.end = Math.round(e * 100) / 100;
  saveIndex(set, all);
  return c;
}

export function removeClip(set: string, name: string): boolean {
  if (!isClipName(name)) return false;
  const all = listClips(set);
  if (!all.some((c) => c.name === name)) return false;
  rmSync(clipPath(set, name), { force: true });
  saveIndex(set, all.filter((c) => c.name !== name));
  return true;
}
