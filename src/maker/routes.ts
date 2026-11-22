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
import { buildJob, isMaking, startMake } from "./make.ts";
import { discardMade, isMadeId, listMade, readIdeas, readMade, saveIdeas, saveMade, thumbPath, usedTitles, videoBytes, videoPath, type MadePost } from "./store.ts";
import { suggestIdeas, type Idea } from "./write.ts";

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

const TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4" };

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

function madeView(p: MadePost) {
  const bytes = videoBytes(p.set, p.id);
  return {
    id: p.id, status: p.status, createdAt: p.createdAt, idea: p.idea, platforms: p.platforms,
    script: p.script ? { hook: p.script.hook, points: p.script.points, cta: p.script.cta } : null,
    captions: p.captions ?? {}, seconds: p.seconds ?? 0, problem: p.problem ?? "", batchId: p.batchId ?? "", postedAt: p.postedAt ?? "", auto: !!p.auto,
    video: bytes ? `/api/maker/made/${p.id}/video.mp4?v=${bytes}` : "",
    thumb: bytes && existsSync(thumbPath(p.set, p.id)) ? `/api/maker/made/${p.id}/thumb.jpg?v=${bytes}` : "",
  };
}

function autoView(set: string) {
  const a = readAuto(set);
  return { ...a, unlocked: autoUnlocked(a), unlocksAt: autoUnlocksAt(a) ? new Date(autoUnlocksAt(a)).toISOString() : "", dailyCap: AUTO_DAILY_CAP };
}

export function makerState(set: string, platforms: { id: string; label: string }[]) {
  return {
    set,
    brief: readBrief(set),
    photos: listPhotos(set),
    logo: logoName(set),
    problem: notReady(set),
    limits: { ...LIMITS, captions: CAPTION_LIMITS },
    ai: aiStatus(readMode()),
    usage: usageSummary(),
    ideas: readIdeas(set).filter((i) => !usedTitles(set).includes(i.title)),
    made: listMade(set).filter((m) => m.status !== "discarded").map(madeView),
    making: isMaking(),
    auto: autoView(set),
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
  return { title: o.title.trim().slice(0, 140), angle: String(o.angle ?? "").trim().slice(0, 400), fact: Math.max(0, Math.floor(Number(o.fact) || 0)) };
};

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
    if (POST && path === "/api/maker/brief") { ctx.json(200, { brief: saveBrief(set, await bodyJson(ctx)), problem: notReady(set) }); return true; }

    // --- photos and the logo: raw image bytes, judged by their content, not their name ---
    if (POST && path === "/api/maker/photo") {
      if (listPhotos(set).length >= LIMITS.photos.max && url.searchParams.get("logo") !== "1") { ctx.json(400, { error: `That's the most photos the maker takes (${LIMITS.photos.max}). Remove one first.` }); return true; }
      const name = savePhoto(set, await ctx.readBody(LIMITS.photoBytes + 1), url.searchParams.get("logo") === "1");
      ctx.json(200, { name, photos: listPhotos(set), logo: logoName(set), problem: notReady(set) });
      return true;
    }
    if (POST && path === "/api/maker/photo/remove") {
      const { name } = await bodyJson(ctx);
      if (typeof name !== "string" || !removePhoto(set, name)) { ctx.json(404, { error: "That photo isn't there." }); return true; }
      ctx.json(200, { photos: listPhotos(set), logo: logoName(set), problem: notReady(set) });
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
      const missing = notReady(set);
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
      ctx.json(200, buildJob(p, brief, logoName(forSet!)));
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
  if (isMaking() || notReady(set)) return "not ready";
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

/** A set's accounts were seen connected: start its 24 hours (once). */
export { markSetConnected };
