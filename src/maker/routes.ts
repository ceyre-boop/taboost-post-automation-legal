// The post maker's part of the local server. Every route here sits behind the same
// checks as the rest of the app (server.ts: Host, Origin, Sec-Fetch-Site), and is not
// offered at all in phone-link (remote) mode.
//
// The render page (/render) runs in a separate headless Chrome the app starts. Its
// requests carry a one-time render key (rk) made for that one video, so only that page
// can read the render job or hand back video bytes.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aiStatus, AiError, forgetApiKey, isApiKey, readMode, saveApiKey, usageSummary, writeMode } from "./ai.ts";
import { AutoLocked, autoDue, autoUnlocked, autoUnlocksAt, markSetConnected, noteMade, readAuto, writeAuto, AUTO_DAILY_CAP } from "./auto.ts";
import { BriefError, isPhotoName, LIMITS, listPhotos, logoName, notReady, photosDir, readBrief, removePhoto, saveBrief, savePhoto } from "./brief.ts";
import { CAPTION_LIMITS, fullCaption, type PlatformCaption } from "./checks.ts";
import { CLIP_LIMITS, clipPath, isClipName, listClips, readClip, removeClip, saveClip, updateClip } from "./clips.ts";
import { FORMATS, isFormat, varied } from "./formats.ts";
import { buildJob, isMaking, startMake } from "./make.ts";
import { MISSED_AFTER_MS, PLAN_PER_WEEK, newPlan, planNow, planOver, readPlan, savePlan, slotDue, slotState, type WeekPlan } from "./plan.ts";
import { discardMade, isMadeId, listMade, readIdeas, readMade, saveIdeas, saveMade, thumbPath, usedTitles, videoBytes, videoPath, type MadePost } from "./store.ts";
import { clipIdea, suggestIdeas, type Idea } from "./write.ts";

/** Ready to make a photo-format post? (Clips count toward the photos.) */
const missingFor = (set: string) => notReady(set, listClips(set).length);

export interface MakerContext {
  /** The set of accounts the Mac is on. */
  set: string;
  port: number;
  platforms: { id: string; label: string }[];
  json: (code: number, body: unknown) => void;
  readBody: (limit?: number) => Promise<Buffer>;
  batchRunning: () => boolean;
  /** Post a made video through the normal batch engine. Returns the batch id. */
  startPost: (video: string, captions: Record<string, string>, platforms: string[], live: boolean, deleteAfter: boolean) => string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** The render page and its library. The packaged app points POSTER_ASSETS_DIR at its own copies. */
const ASSETS = process.env.POSTER_ASSETS_DIR || join(HERE, "..", "..", "dashboard");

/* ---------------- render keys ---------------- */

const renderKeys = new Map<string, { key: string; set: string; until: number }>();
function newRenderKey(set: string, id: string): string {
  const key = randomBytes(18).toString("base64url");
  renderKeys.set(id, { key, set, until: Date.now() + 10 * 60_000 });
  return key;
}
function renderAllowed(url: URL, id: string): string | null {
  const given = url.searchParams.get("rk") ?? "";
  const rk = renderKeys.get(id);
  if (!rk || Date.now() > rk.until) return null;
  const a = Buffer.from(rk.key), b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b) ? rk.set : null;
}
/** A photo may be read by the dashboard (the set it's on) or by a render page for that set. */
function renderSetFor(url: URL): string | null {
  const given = url.searchParams.get("rk") ?? "";
  if (!given) return null;
  for (const [id] of renderKeys) { const s = renderAllowed(url, id); if (s !== null) return s; }
  return null;
}

/* ---------------- files ---------------- */

const TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime" };

/** Send a file, with byte ranges so the browser's video player can seek. */
function sendFile(req: IncomingMessage, res: ServerResponse, path: string, type: string): void {
  const size = statSync(path).size;
  const base = { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin", "accept-ranges": "bytes" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start); end = Math.min(size - 1, end);
    if (start > end) { res.writeHead(416, { ...base, "content-range": `bytes */${size}` }); res.end(); return; }
    res.writeHead(206, { ...base, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    createReadStream(path, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...base, "content-length": size });
  createReadStream(path).pipe(res);
}

/* ---------------- what the dashboard sees ---------------- */

function madeView(p: MadePost, plan?: WeekPlan) {
  const bytes = videoBytes(p.set, p.id);
  const slot = plan?.slots.find((s) => s.madeId === p.id);
  const format = p.script?.format ?? p.idea.format ?? "tips";
  return {
    id: p.id, status: p.status, createdAt: p.createdAt, idea: p.idea, platforms: p.platforms,
    format, formatLabel: FORMATS[format]?.label ?? "", planAt: slot?.at ?? "", approved: !!slot?.approved,
    script: p.script ? { hook: p.script.hook, points: p.script.points, cta: p.script.cta, stat: p.script.stat ?? "" } : null,
    captions: p.captions ?? {}, seconds: p.seconds ?? 0, problem: p.problem ?? "", batchId: p.batchId ?? "", postedAt: p.postedAt ?? "", auto: !!p.auto,
    video: bytes ? `/api/maker/made/${p.id}/video.mp4?v=${bytes}` : "",
    thumb: bytes && existsSync(thumbPath(p.set, p.id)) ? `/api/maker/made/${p.id}/thumb.jpg?v=${bytes}` : "",
  };
}

function autoView(set: string) {
  const a = readAuto(set);
  return { ...a, unlocked: autoUnlocked(a), unlocksAt: autoUnlocksAt(a) ? new Date(autoUnlocksAt(a)).toISOString() : "", dailyCap: AUTO_DAILY_CAP };
}

function planView(set: string) {
  const p = readPlan(set);
  const now = planNow();
  return {
    every: p.every, perWeek: p.perWeek, platforms: p.platforms, plannedAt: p.plannedAt, over: planOver(p, now),
    sizes: PLAN_PER_WEEK,
    slots: p.slots.map((s, i) => {
      const m = s.madeId ? readMade(set, s.madeId) : null;
      return { index: i, at: s.at, title: s.idea.title, format: s.idea.format ?? "tips", formatLabel: FORMATS[s.idea.format ?? "tips"]?.label ?? "", madeId: s.madeId, approved: s.approved, state: slotState(s, m, now), problem: s.problem ?? m?.problem ?? "" };
    }),
  };
}

export function makerState(set: string, platforms: { id: string; label: string }[]) {
  const plan = readPlan(set);
  return {
    set,
    brief: readBrief(set),
    photos: listPhotos(set),
    logo: logoName(set),
    clips: listClips(set),
    problem: missingFor(set),
    limits: { ...LIMITS, captions: CAPTION_LIMITS, clips: CLIP_LIMITS },
    ai: aiStatus(readMode()),
    usage: usageSummary(),
    ideas: readIdeas(set).filter((i) => !usedTitles(set).includes(i.title)),
    made: listMade(set).filter((m) => m.status !== "discarded").map((m) => madeView(m, plan)),
    making: isMaking(),
    auto: autoView(set),
    plan: planView(set),
    platforms,
  };
}

const bodyJson = async (ctx: MakerContext, limit = 256 * 1024): Promise<Record<string, unknown>> => {
  const text = (await ctx.readBody(limit)).toString();
  if (!text.trim()) return {};
  const v = JSON.parse(text);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new SyntaxError("not an object");
  return v as Record<string, unknown>;
};

const cleanIdea = (v: unknown): Idea | null => {
  const o = v as Partial<Idea> | null;
  if (!o || typeof o.title !== "string" || !o.title.trim()) return null;
  const format = isFormat(o.format) && o.format !== "clip" ? o.format : "tips";
  return { title: o.title.trim().slice(0, 140), angle: String(o.angle ?? "").trim().slice(0, 400), fact: Math.max(0, Math.floor(Number(o.fact) || 0)), format };
};

const cleanPlatforms = (v: unknown, allowed: string[]): string[] => (Array.isArray(v) ? [...new Set(v.map(String).filter((p) => allowed.includes(p)))] : []);

/** Start a new week. The old week's posts that weren't approved are thrown away; approved
 *  ones still to come keep their day and stay approved. Called only once the new ideas are in hand. */
export function replacePlan(set: string, ideas: Idea[], settings: { perWeek: number; platforms: string[]; every: boolean }): WeekPlan {
  const old = readPlan(set);
  const now = planNow();
  const kept = old.slots.filter((s) => {
    const mp = s.madeId ? readMade(set, s.madeId) : null;
    return s.approved && mp?.status === "ready" && Date.parse(s.at) + MISSED_AFTER_MS > now;
  });
  for (const s of old.slots) {
    if (kept.includes(s)) continue;
    const mp = s.madeId ? readMade(set, s.madeId) : null;
    if (mp && (mp.status === "ready" || mp.status === "failed") && !mp.batchId) discardMade(set, mp.id);
  }
  const p = newPlan(set, ideas, settings);
  if (kept.length) { p.slots = [...p.slots, ...kept].sort((a, b) => a.at.localeCompare(b.at)); savePlan(set, p); }
  return p;
}

/** Choose a week's posts: unused clips (that say what they show) first, then ideas in varied formats. */
export async function planIdeas(set: string, n: number): Promise<Idea[]> {
  const brief = readBrief(set);
  if (!brief) throw new BriefError("Fill in your business details first.");
  const usedClips = new Set(listMade(set).filter((m) => m.idea.clip && m.status !== "discarded").map((m) => m.idea.clip));
  const clips = listClips(set).filter((c) => c.note.trim().length >= 3 && !usedClips.has(c.name)).slice(0, Math.min(2, n)).map(clipIdea);
  let fresh: Idea[] = [];
  const need = n - clips.length;
  if (need > 0) {
    const missing = missingFor(set);
    if (missing && !clips.length) throw new BriefError(missing);
    if (!missing) {
      const saved = readIdeas(set).filter((i) => !usedTitles(set).includes(i.title));
      const pool = saved.length >= need + 2 ? saved : await suggestIdeas(brief, usedTitles(set), need + 3);
      fresh = varied(pool, need);
      saveIdeas(set, pool.filter((i) => !fresh.includes(i)));
    }
  }
  // Spread the clips out: one first, one in the middle.
  const out = [...fresh];
  clips.forEach((c, i) => out.splice(i === 0 ? 0 : Math.ceil(out.length / 2) + 1, 0, c));
  return out.slice(0, n);
}

/** The person's edited caption for one platform, checked against that platform's limit. */
function cleanCaption(platform: string, v: unknown): PlatformCaption | string {
  const o = v as { caption?: unknown; hashtags?: unknown } | null;
  if (!o || typeof o.caption !== "string") return `The ${platform} caption is missing.`;
  const tags = Array.isArray(o.hashtags) ? o.hashtags.map((t) => String(t).trim()).filter(Boolean).map((t) => (t.startsWith("#") ? t : `#${t}`)) : [];
  if (tags.some((t) => !/^#[\p{L}\p{N}_]{1,60}$/u.test(t))) return `A ${platform} hashtag has a space or symbol in it.`;
  const c = { caption: o.caption.replace(/\r/g, "").trim(), hashtags: tags.slice(0, 10) };
  if (!c.caption) return `The ${platform} caption is empty.`;
  const limit = CAPTION_LIMITS[platform] ?? 2200;
  const len = Array.from(fullCaption(c)).length;
  if (len > limit) return `The ${platform} caption with hashtags is ${len} characters; ${platform} allows ${limit}.`;
  if (platform === "youtube" && Array.from(c.caption.split("\n")[0]).length > 100) return "The first line of the YouTube caption is the video's title, and it can be at most 100 characters.";
  return c;
}

const fail = (ctx: MakerContext, e: unknown): void => {
  if (e instanceof AiError) return ctx.json(e.setup ? 400 : 502, { error: e.plain, setup: e.setup });
  if (e instanceof BriefError) return ctx.json(400, { error: e.message });
  throw e;
};

/** Handle a maker route. Returns false when the path isn't one of them. */
export async function makerRoute(req: IncomingMessage, res: ServerResponse, url: URL, ctx: MakerContext): Promise<boolean> {
  const GET = req.method === "GET", POST = req.method === "POST";
  const path = url.pathname;
  const set = ctx.set;
  const baseUrl = `http://127.0.0.1:${ctx.port}`;

  // --- the render page and its one library ---
  if (GET && path === "/render") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
    res.end(readFileSync(join(ASSETS, "render.html")));
    return true;
  }
  if (GET && path === "/vendor/mp4-muxer.mjs") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=3600", "x-content-type-options": "nosniff" });
    res.end(readFileSync(join(ASSETS, "vendor", "mp4-muxer.mjs")));
    return true;
  }
  if (!path.startsWith("/api/maker")) return false;

  try {
    if (GET && path === "/api/maker") { ctx.json(200, makerState(set, ctx.platforms)); return true; }

    // --- the business brief ---
    if (POST && path === "/api/maker/brief") { ctx.json(200, { brief: saveBrief(set, await bodyJson(ctx)), problem: missingFor(set) }); return true; }

    // --- photos and the logo: raw image bytes, judged by their content, not their name ---
    if (POST && path === "/api/maker/photo") {
      if (listPhotos(set).length >= LIMITS.photos.max && url.searchParams.get("logo") !== "1") { ctx.json(400, { error: `That's the most photos the maker takes (${LIMITS.photos.max}). Remove one first.` }); return true; }
      const name = savePhoto(set, await ctx.readBody(LIMITS.photoBytes + 1), url.searchParams.get("logo") === "1");
      ctx.json(200, { name, photos: listPhotos(set), logo: logoName(set), problem: missingFor(set) });
      return true;
    }
    if (POST && path === "/api/maker/photo/remove") {
      const { name } = await bodyJson(ctx);
      if (typeof name !== "string" || !removePhoto(set, name)) { ctx.json(404, { error: "That photo isn't there." }); return true; }
      ctx.json(200, { photos: listPhotos(set), logo: logoName(set), problem: missingFor(set) });
      return true;
    }
    let m = /^\/api\/maker\/photo\/([^/]+)$/.exec(path);
    if (GET && m) {
      const name = decodeURIComponent(m[1]);
      const forSet = url.searchParams.has("rk") ? renderSetFor(url) : set;
      if (forSet === null || !isPhotoName(name)) { ctx.json(404, { error: "Not found." }); return true; }
      const file = join(photosDir(forSet), name);
      if (!existsSync(file)) { ctx.json(404, { error: "Not found." }); return true; }
      sendFile(req, res, file, TYPES[extname(name)] ?? "application/octet-stream");
      return true;
    }

    // --- AI: where it comes from ---
    if (POST && path === "/api/maker/ai") {
      const b = await bodyJson(ctx);
      if (typeof b.apiKey === "string") {
        const key = b.apiKey.trim();
        if (key === "") forgetApiKey();
        else if (!isApiKey(key)) { ctx.json(400, { error: "That doesn't look like an Anthropic API key. It starts with sk-ant-." }); return true; }
        else { saveApiKey(key); if (b.mode === undefined) writeMode("byo"); }
      }
      if (b.mode !== undefined) {
        if (b.mode !== "hosted" && b.mode !== "byo") { ctx.json(400, { error: "Choose Northbound hosting or your own API key." }); return true; }
        writeMode(b.mode);
      }
      ctx.json(200, { ai: aiStatus(readMode()), usage: usageSummary() });
      return true;
    }

    // --- ideas ---
    if (POST && path === "/api/maker/ideas") {
      const missing = missingFor(set);
      if (missing) { ctx.json(400, { error: missing }); return true; }
      const brief = readBrief(set)!;
      const ideas = await suggestIdeas(brief, usedTitles(set));
      saveIdeas(set, ideas);
      ctx.json(200, { ideas });
      return true;
    }

    // --- make one ---
    if (POST && path === "/api/maker/make") {
      const b = await bodyJson(ctx);
      const idea = cleanIdea(b.idea);
      if (!idea) { ctx.json(400, { error: "Pick an idea first." }); return true; }
      const allowed = ctx.platforms.map((p) => p.id);
      const platforms = Array.isArray(b.platforms) ? [...new Set(b.platforms.map(String).filter((p) => allowed.includes(p)))] : [];
      if (!platforms.length) { ctx.json(400, { error: "Choose at least one account to write captions for." }); return true; }
      if (isMaking()) { ctx.json(409, { error: "A post is being made right now. Wait for it to finish." }); return true; }
      const p = startMake(set, idea, platforms, baseUrl, (id) => newRenderKey(set, id), false);
      ctx.json(200, { id: p.id });
      return true;
    }

    // --- the render page's job, and its finished video ---
    m = /^\/api\/maker\/job\/([^/]+)$/.exec(path);
    if (GET && m) {
      const id = decodeURIComponent(m[1]);
      const forSet = isMadeId(id) ? renderAllowed(url, id) : null;
      const p = forSet !== null ? readMade(forSet, id) : null;
      const brief = forSet !== null ? readBrief(forSet) : null;
      if (!p || !brief || !p.script) { ctx.json(404, { error: "Not found." }); return true; }
      ctx.json(200, buildJob(p, brief, logoName(forSet!), p.idea.clip ? readClip(forSet!, p.idea.clip) : null));
      return true;
    }
    m = /^\/api\/maker\/made\/([^/]+)\/(video|thumb)$/.exec(path);
    if (POST && m) {
      const id = decodeURIComponent(m[1]);
      const forSet = isMadeId(id) ? renderAllowed(url, id) : null;
      if (forSet === null || !readMade(forSet, id)) { ctx.json(404, { error: "Not found." }); return true; }
      const bytes = await ctx.readBody(m[2] === "video" ? 300 * 1024 * 1024 : 5 * 1024 * 1024);
      const ok = m[2] === "video" ? bytes.length > 1000 && bytes.subarray(4, 8).toString("latin1") === "ftyp" : bytes[0] === 0xff && bytes[1] === 0xd8;
      if (!ok) { ctx.json(400, { error: "That isn't the expected file." }); return true; }
      const dest = m[2] === "video" ? videoPath(forSet, id) : thumbPath(forSet, id);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest + ".tmp", bytes);
      renameSync(dest + ".tmp", dest);
      ctx.json(200, { ok: true, bytes: bytes.length });
      return true;
    }
    m = /^\/api\/maker\/made\/([^/]+)\/(video\.mp4|thumb\.jpg)$/.exec(path);
    if (GET && m) {
      const id = decodeURIComponent(m[1]);
      const file = isMadeId(id) ? (m[2] === "video.mp4" ? videoPath(set, id) : thumbPath(set, id)) : "";
      if (!file || !existsSync(file)) { ctx.json(404, { error: "Not found." }); return true; }
      sendFile(req, res, file, m[2] === "video.mp4" ? "video/mp4" : "image/jpeg");
      return true;
    }

    // --- review: captions, post, discard ---
    m = /^\/api\/maker\/made\/([^/]+)\/(captions|post|discard)$/.exec(path);
    if (POST && m) {
      const id = decodeURIComponent(m[1]);
      const p = isMadeId(id) ? readMade(set, id) : null;
      if (!p || p.status === "discarded") { ctx.json(404, { error: "That post isn't here any more." }); return true; }
      if (m[2] === "discard") {
        if (p.status === "posting") { ctx.json(409, { error: "This one is being posted right now." }); return true; }
        discardMade(set, id);
        ctx.json(200, { ok: true });
        return true;
      }
      const b = await bodyJson(ctx);
      if (m[2] === "captions") {
        const raw = (b.captions ?? {}) as Record<string, unknown>;
        const next = { ...(p.captions ?? {}) };
        for (const [platform, v] of Object.entries(raw)) {
          if (!p.platforms.includes(platform)) continue;
          const c = cleanCaption(platform, v);
          if (typeof c === "string") { ctx.json(400, { error: c }); return true; }
          next[platform] = c;
        }
        p.captions = next;
        saveMade(p);
        ctx.json(200, madeView(p));
        return true;
      }
      // post
      if (p.status !== "ready" && p.status !== "posted" && p.status !== "failed") { ctx.json(409, { error: "This post isn't ready yet." }); return true; }
      if (!videoBytes(set, id)) { ctx.json(409, { error: "This post has no video. Make it again." }); return true; }
      if (ctx.batchRunning()) { ctx.json(409, { error: "Posts are going out right now. Wait for them to finish." }); return true; }
      const platforms = Array.isArray(b.platforms) ? [...new Set(b.platforms.map(String))] : [];
      if (!platforms.length) { ctx.json(400, { error: "Choose at least one account." }); return true; }
      const captions: Record<string, string> = {};
      for (const pl of platforms) {
        const c = p.captions?.[pl];
        if (!c) { ctx.json(400, { error: `There's no caption for ${ctx.platforms.find((x) => x.id === pl)?.label ?? pl}. Make the post again with that account ticked.` }); return true; }
        captions[pl] = fullCaption(c);
      }
      const live = b.live === true;
      const batchId = ctx.startPost(videoPath(set, id), captions, platforms, live, live && b.deleteAfter === true);
      if (live) { p.status = "posting"; p.batchId = batchId; p.problem = ""; saveMade(p); }
      ctx.json(200, { batchId });
      return true;
    }

    // --- clips: the person's own videos ---
    if (POST && path === "/api/maker/clip") {
      const clip = await saveClip(set, req, url.searchParams.get("name") ?? "clip.mp4");
      ctx.json(200, { clip, clips: listClips(set), problem: missingFor(set) });
      return true;
    }
    if (POST && path === "/api/maker/clip/update") {
      const b = await bodyJson(ctx);
      if (typeof b.name !== "string" || !isClipName(b.name)) { ctx.json(404, { error: "That clip isn't there any more." }); return true; }
      ctx.json(200, { clip: updateClip(set, b.name, { note: b.note, start: b.start, end: b.end }), clips: listClips(set) });
      return true;
    }
    if (POST && path === "/api/maker/clip/remove") {
      const b = await bodyJson(ctx);
      if (typeof b.name !== "string" || !removeClip(set, b.name)) { ctx.json(404, { error: "That clip isn't there any more." }); return true; }
      ctx.json(200, { clips: listClips(set), problem: missingFor(set) });
      return true;
    }
    if (POST && path === "/api/maker/clip/finish") {
      const b = await bodyJson(ctx);
      const clip = typeof b.name === "string" ? readClip(set, b.name) : null;
      if (!clip) { ctx.json(404, { error: "That clip isn't there any more." }); return true; }
      const platforms = cleanPlatforms(b.platforms, ctx.platforms.map((p) => p.id));
      if (!platforms.length) { ctx.json(400, { error: "Choose at least one account to write captions for." }); return true; }
      if (isMaking()) { ctx.json(409, { error: "A post is being made right now. Wait for it to finish." }); return true; }
      const p = startMake(set, clipIdea(clip), platforms, baseUrl, (id) => newRenderKey(set, id), false);
      ctx.json(200, { id: p.id });
      return true;
    }
    m = /^\/api\/maker\/clip\/([^/]+)$/.exec(path);
    if (GET && m) {
      const name = decodeURIComponent(m[1]);
      const forSet = url.searchParams.has("rk") ? renderSetFor(url) : set;
      if (forSet === null || !isClipName(name) || !existsSync(clipPath(forSet, name))) { ctx.json(404, { error: "Not found." }); return true; }
      sendFile(req, res, clipPath(forSet, name), TYPES[extname(name)] ?? "video/mp4");
      return true;
    }

    // --- plan my week ---
    if (POST && path === "/api/maker/plan") {
      const b = await bodyJson(ctx);
      const p = readPlan(set);
      if (b.perWeek !== undefined) p.perWeek = Math.min(PLAN_PER_WEEK.max, Math.max(PLAN_PER_WEEK.min, Math.round(Number(b.perWeek) || p.perWeek)));
      if (b.platforms !== undefined) p.platforms = cleanPlatforms(b.platforms, ctx.platforms.map((x) => x.id));
      if (b.every !== undefined) p.every = b.every === true;
      savePlan(set, p);
      ctx.json(200, { plan: planView(set) });
      return true;
    }
    if (POST && path === "/api/maker/plan/make") {
      const b = await bodyJson(ctx);
      const old = readPlan(set);
      const platforms = b.platforms !== undefined ? cleanPlatforms(b.platforms, ctx.platforms.map((x) => x.id)) : old.platforms;
      if (!platforms.length) { ctx.json(400, { error: "Choose at least one account for the week's posts." }); return true; }
      const perWeek = Math.min(PLAN_PER_WEEK.max, Math.max(PLAN_PER_WEEK.min, Math.round(Number(b.perWeek ?? old.perWeek) || PLAN_PER_WEEK.default)));
      const ideas = await planIdeas(set, perWeek);
      if (!ideas.length) { ctx.json(400, { error: "There's nothing to plan from yet. Add photos, or a clip that says what it shows." }); return true; }
      replacePlan(set, ideas, { perWeek, platforms, every: b.every !== undefined ? b.every === true : old.every });
      ctx.json(200, { plan: planView(set) });
      return true;
    }
    if (POST && path === "/api/maker/plan/approve") {
      const b = await bodyJson(ctx);
      const p = readPlan(set);
      const slot = p.slots.find((s) => s.madeId && s.madeId === b.madeId);
      const mp = slot ? readMade(set, slot.madeId) : null;
      if (!slot || !mp) { ctx.json(404, { error: "That post isn't in this week's plan." }); return true; }
      if (b.approved === true) {
        if (mp.status !== "ready") { ctx.json(409, { error: "This one isn't ready yet." }); return true; }
        if (!p.platforms.some((pl) => mp.captions?.[pl])) { ctx.json(400, { error: "It has no caption for the plan's accounts. Make it again." }); return true; }
        slot.approved = true;
        // A time that has already gone by means "post it at the next check" (within a minute).
        if (Date.parse(slot.at) < planNow()) slot.at = new Date(planNow()).toISOString();
      } else slot.approved = false;
      savePlan(set, p);
      ctx.json(200, { plan: planView(set) });
      return true;
    }
    if (POST && path === "/api/maker/plan/replace") {
      const b = await bodyJson(ctx);
      const p = readPlan(set);
      const i = Math.floor(Number(b.index));
      const slot = Number.isInteger(i) ? p.slots[i] : undefined;
      if (!slot) { ctx.json(404, { error: "That day isn't in this week's plan." }); return true; }
      const mp = slot.madeId ? readMade(set, slot.madeId) : null;
      if (mp && (mp.status === "posting" || mp.status === "posted")) { ctx.json(409, { error: "That one has already gone out." }); return true; }
      if (mp && (mp.status === "writing" || mp.status === "rendering")) { ctx.json(409, { error: "That one is being made right now." }); return true; }
      const brief = readBrief(set);
      const missing = missingFor(set);
      if (!brief || missing) { ctx.json(400, { error: missing || "Fill in your business details first." }); return true; }
      const taken = new Set([...p.slots.map((s) => s.idea.title), ...usedTitles(set), ...(mp ? [mp.idea.title] : [])]);
      let pool = readIdeas(set).filter((x) => !taken.has(x.title));
      if (!pool.length) { pool = (await suggestIdeas(brief, [...taken], 4)).filter((x) => !taken.has(x.title)); }
      const next = pool.find((x) => x.format !== slot.idea.format) ?? pool[0];
      if (!next) { ctx.json(400, { error: "No fresh idea came up. Add a fact or two and try again." }); return true; }
      saveIdeas(set, pool.filter((x) => x !== next));
      // The plan may have changed while the AI was thinking (an approval undone, a post made):
      // read it again and change this one day only, if it's still the same day.
      const now = readPlan(set);
      const same = now.slots[i];
      if (!same || same.at !== slot.at || same.idea.title !== slot.idea.title) { ctx.json(409, { error: "The plan changed while that was thinking. Try again." }); return true; }
      const was = same.madeId ? readMade(set, same.madeId) : null;
      if (was && (was.status === "posting" || was.status === "posted")) { ctx.json(409, { error: "That one has already gone out." }); return true; }
      if (was && (was.status === "writing" || was.status === "rendering")) { ctx.json(409, { error: "That one is being made right now." }); return true; }
      if (was) discardMade(set, was.id);
      now.slots[i] = { at: slot.at, idea: next, madeId: "", approved: false };
      savePlan(set, now);
      ctx.json(200, { plan: planView(set) });
      return true;
    }

    // --- auto-make ---
    if (POST && path === "/api/maker/auto") {
      const b = await bodyJson(ctx);
      try { writeAuto(set, { on: b.on, perWeek: b.perWeek, platforms: b.platforms }, ctx.platforms.map((p) => p.id)); }
      catch (e) {
        if (e instanceof AutoLocked) {
          const hours = Math.max(1, Math.ceil((e.unlocksAt - Date.now()) / 3_600_000));
          ctx.json(400, { error: e.unlocksAt ? `Auto-make unlocks in about ${hours} hour${hours === 1 ? "" : "s"}. For the first 24 hours after you connect your accounts, every post waits for you.` : "Connect an account in this set first." });
          return true;
        }
        if (e instanceof Error && /Choose at least one/.test(e.message)) { ctx.json(400, { error: e.message }); return true; }
        throw e;
      }
      ctx.json(200, { auto: autoView(set) });
      return true;
    }

    ctx.json(404, { error: "Not found." });
    return true;
  } catch (e) {
    fail(ctx, e);
    return true;
  }
}

/* ---------------- the auto-make timer ---------------- */

/** One tick for one set: post a finished auto post, or make the next one when it's due. */
export async function autoTick(set: string, port: number, ctx: Pick<MakerContext, "batchRunning" | "startPost">): Promise<string> {
  const a = readAuto(set);
  if (!a.on || !autoUnlocked(a)) return "off";
  const made = listMade(set);
  const ready = made.find((m) => m.auto && m.status === "ready");
  if (ready) {
    if (ctx.batchRunning()) return "waiting for posts to finish";
    const platforms = a.platforms.filter((p) => ready.captions?.[p]);
    if (!platforms.length) return "no captions";
    const captions = Object.fromEntries(platforms.map((p) => [p, fullCaption(ready.captions![p])]));
    ready.batchId = ctx.startPost(videoPath(set, ready.id), captions, platforms, true, false);
    ready.status = "posting";
    saveMade(ready);
    return "posting";
  }
  const why = autoDue(a, made);
  if (why) return why;
  if (isMaking() || missingFor(set)) return "not ready";
  const brief = readBrief(set)!;
  let ideas = readIdeas(set).filter((i) => !usedTitles(set).includes(i.title));
  if (!ideas.length) { ideas = await suggestIdeas(brief, usedTitles(set)); saveIdeas(set, ideas); }
  const idea = ideas[0];
  if (!idea) return "no ideas";
  startMake(set, idea, a.platforms, `http://127.0.0.1:${port}`, (id) => newRenderKey(set, id), true);
  saveIdeas(set, ideas.slice(1));
  noteMade(set);
  return "making";
}

/* ---------------- the plan timer ---------------- */

let planning = false;
/** One tick for one set's plan: post an approved one that's due, make the next one, or plan the next week. */
export async function planTick(set: string, port: number, ctx: Pick<MakerContext, "batchRunning" | "startPost">): Promise<string> {
  const p = readPlan(set);
  const now = planNow();
  for (const slot of p.slots) {
    const mp = slot.madeId ? readMade(set, slot.madeId) : null;
    if (!slotDue(slot, mp, now) || !mp) continue;
    if (ctx.batchRunning()) return "waiting for posts to finish";
    const platforms = p.platforms.filter((pl) => mp.captions?.[pl]);
    if (!platforms.length) {
      slot.approved = false;
      slot.problem = "It has no caption for the accounts the plan posts to now, so it didn't go out. Press Another idea, or post it yourself from Made for you.";
      savePlan(set, p);
      continue;
    }
    const captions = Object.fromEntries(platforms.map((pl) => [pl, fullCaption(mp.captions![pl])]));
    mp.batchId = ctx.startPost(videoPath(set, mp.id), captions, platforms, true, false);
    mp.status = "posting";
    mp.problem = "";
    saveMade(mp);
    return "posting";
  }
  if (!isMaking() && p.platforms.length) {
    const i = p.slots.findIndex((s) => !s.madeId && !s.problem && Date.parse(s.at) + MISSED_AFTER_MS > now);
    if (i >= 0) {
      try {
        const made = startMake(set, p.slots[i].idea, p.platforms, `http://127.0.0.1:${port}`, (id) => newRenderKey(set, id), false);
        p.slots[i].madeId = made.id;
      } catch (e) {
        p.slots[i].problem = e instanceof AiError ? e.plain : "It couldn't be made. Press Another idea to replace it.";
      }
      savePlan(set, p);
      return "making";
    }
  }
  if (p.every && p.platforms.length && planOver(p, now) && !planning && (!p.plannedAt || now - Date.parse(p.plannedAt) > 20 * 60 * 60 * 1000)) {
    planning = true;
    savePlan(set, { ...p, plannedAt: new Date(now).toISOString() }); // a failed try waits a day, not a minute
    try {
      const ideas = await planIdeas(set, p.perWeek);
      if (!ideas.length) return "nothing to plan";
      replacePlan(set, ideas, { perWeek: p.perWeek, platforms: p.platforms, every: true });
      return "planned";
    } catch (e) {
      console.error("[plan] the next week couldn't be planned:", String((e as Error).message ?? e).split("\n")[0]);
      return "plan failed";
    } finally { planning = false; }
  }
  return "idle";
}

/** A set's accounts were seen connected: start its 24 hours (once). */
export { markSetConnected };
