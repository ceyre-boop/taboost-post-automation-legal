// The business brief: what the post maker knows about the person's business. Filled in
// once on the Make screen, saved per set of accounts (Personal and Northbound get their
// own), and the only source of facts a made post may state.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ROOT_DIR, cleanAccountId } from "../config.ts";

export type Mood = "upbeat" | "calm" | "bold";
export const MOODS: Mood[] = ["upbeat", "calm", "bold"];

export interface ClientBrief {
  business: string;
  whatYouDo: string;
  audience: string;
  /** One per line on the form. The only numbers a made post may use are in here. */
  facts: string[];
  /** Words and claims never to use. */
  avoid: string[];
  cta: string;
  color: string;
  mood: Mood;
  updatedAt: string;
}

export const LIMITS = { facts: { min: 3, max: 10 }, photos: { min: 3, max: 30 }, photoBytes: 25 * 1024 * 1024 };

const root = () => process.env.POSTER_APP_DIR || ROOT_DIR;
/** Each set of accounts keeps its own maker folder. */
export function makerDir(set: string): string {
  const id = cleanAccountId(set);
  return id ? join(root(), "accounts", id, "maker") : join(root(), "maker");
}
const briefFile = (set: string) => join(makerDir(set), "brief.json");
export const photosDir = (set: string) => join(makerDir(set), "photos");

export class BriefError extends Error {}

const text = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
const lines = (v: unknown, maxEach: number, maxCount: number) =>
  (Array.isArray(v) ? v : String(v ?? "").split("\n")).map((l) => text(l, maxEach).replace(/^[-•*]\s*/, "")).filter(Boolean).slice(0, maxCount);

/** Clean and check what the form sent. Throws a BriefError a person can read. */
export function validateBrief(raw: Record<string, unknown>): ClientBrief {
  const b: ClientBrief = {
    business: text(raw.business, 80),
    whatYouDo: text(raw.whatYouDo, 300),
    audience: text(raw.audience, 200),
    facts: lines(raw.facts, 200, LIMITS.facts.max),
    avoid: lines(raw.avoid, 60, 20),
    cta: text(raw.cta, 80),
    color: /^#[0-9a-f]{6}$/i.test(String(raw.color ?? "")) ? String(raw.color).toLowerCase() : "#4f5bd5",
    mood: MOODS.includes(raw.mood as Mood) ? (raw.mood as Mood) : "upbeat",
    updatedAt: new Date().toISOString(),
  };
  if (!b.business) throw new BriefError("Add your business name.");
  if (b.whatYouDo.length < 10) throw new BriefError("Say what you do in a sentence or two.");
  if (b.audience.length < 3) throw new BriefError("Say who your customers are.");
  if (b.facts.length < LIMITS.facts.min) throw new BriefError(`Add at least ${LIMITS.facts.min} facts about your business, one per line. Posts only say what's in here.`);
  if (!b.cta) throw new BriefError('Add what you want people to do, for example "Call for a free quote".');
  return b;
}

export function readBrief(set: string): ClientBrief | null {
  try { return JSON.parse(readFileSync(briefFile(set), "utf8")) as ClientBrief; } catch { return null; }
}
export function saveBrief(set: string, raw: Record<string, unknown>): ClientBrief {
  const b = validateBrief(raw);
  mkdirSync(makerDir(set), { recursive: true });
  writeFileSync(briefFile(set) + ".tmp", JSON.stringify(b, null, 2));
  renameSync(briefFile(set) + ".tmp", briefFile(set));
  return b;
}

/* ---------------- photos and the logo ---------------- */

type Kind = "jpg" | "png" | "webp" | "heic";
/** Decide what a file really is from its first bytes, not its name. */
export function sniff(bytes: Uint8Array): Kind | null {
  const s = (a: number, b: number) => String.fromCharCode(...bytes.subarray(a, b));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes[0] === 0x89 && s(1, 4) === "PNG") return "png";
  if (s(0, 4) === "RIFF" && s(8, 12) === "WEBP") return "webp";
  if (s(4, 8) === "ftyp" && /^(heic|heix|hevc|mif1|msf1|heim|heis)$/.test(s(8, 12))) return "heic";
  return null;
}

const PHOTO_RE = /^p-[a-f0-9]{12}\.(jpg|png|webp)$/;
export const isPhotoName = (n: string): boolean => PHOTO_RE.test(n) || /^logo\.(jpg|png|webp)$/.test(n);

export function listPhotos(set: string): string[] {
  try { return readdirSync(photosDir(set)).filter((n) => PHOTO_RE.test(n)).sort(); } catch { return []; }
}
export function logoName(set: string): string {
  return ["png", "jpg", "webp"].map((e) => `logo.${e}`).find((n) => existsSync(join(photosDir(set), n))) ?? "";
}

/** macOS's built-in image tool. Every Mac has it; nothing to install. */
const sips = (args: string[]) => platform() === "darwin" && spawnSync("/usr/bin/sips", args, { stdio: "ignore", timeout: 60_000 }).status === 0;

/** Save one uploaded photo (or the logo). iPhone HEIC photos are converted to JPEG, and very
 *  large photos are scaled down so the video renders quickly. Returns the saved name. */
export function savePhoto(set: string, bytes: Uint8Array, asLogo = false): string {
  if (bytes.length > LIMITS.photoBytes) throw new BriefError("That photo is over 25 MB. Use a smaller copy.");
  const kind = sniff(bytes);
  if (!kind) throw new BriefError("That file isn't a photo the app can use. Use JPEG, PNG, WebP or an iPhone (HEIC) photo.");
  if (!asLogo && listPhotos(set).length >= LIMITS.photos.max) throw new BriefError(`You already have ${LIMITS.photos.max} photos. Remove one first.`);
  mkdirSync(photosDir(set), { recursive: true });
  const ext = kind === "heic" ? "jpg" : kind;
  const name = asLogo ? `logo.${ext}` : `p-${randomBytes(6).toString("hex")}.${ext}`;
  const dest = join(photosDir(set), name);
  if (asLogo) for (const old of ["png", "jpg", "webp"]) rmSync(join(photosDir(set), `logo.${old}`), { force: true });
  if (kind === "heic") {
    const tmp = join(photosDir(set), `.upload-${randomBytes(4).toString("hex")}.heic`);
    writeFileSync(tmp, bytes);
    const ok = sips(["-s", "format", "jpeg", tmp, "--out", dest]);
    rmSync(tmp, { force: true });
    if (!ok || !existsSync(dest)) throw new BriefError("That iPhone photo couldn't be converted. Export it as JPEG and try again.");
  } else {
    writeFileSync(dest, bytes);
  }
  // Longest side 2160 pixels at most. A photo that can't be resized is still usable.
  if (!asLogo && statSync(dest).size > 2_500_000) sips(["-Z", "2160", dest]);
  return name;
}

export function removePhoto(set: string, name: string): boolean {
  if (!isPhotoName(name)) return false;
  const f = join(photosDir(set), name);
  if (!existsSync(f)) return false;
  rmSync(f);
  return true;
}

/** Ready to make a post: a valid brief and enough photos. Returns what's missing, or "". */
export function notReady(set: string): string {
  if (!readBrief(set)) return "Fill in your business details first.";
  const n = listPhotos(set).length;
  if (n < LIMITS.photos.min) return `Add at least ${LIMITS.photos.min} photos (you have ${n}). Five or more gives better variety.`;
  return "";
}
