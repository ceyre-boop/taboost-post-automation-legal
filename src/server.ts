import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { APP_DIR, CDP_PORT, accountProfile, defaultProfile, type Profile } from "./config.ts";
import { getDevice, createDevice, profileOf, type Device } from "./devices.ts";
import { openView, getView, closeView } from "./remote-view.ts";
import { withBrowser, pageFor } from "./browser.ts";
import { PLATFORMS, getPlatform } from "./platforms/index.ts";
import { buildBatch, finishedVideos, recoverLatestBatch, runBatch as runBatchEngine, type Batch } from "./batch.ts";
import { autoTick, makerRoute, markSetConnected } from "./maker/routes.ts";
import { listMade, saveMade } from "./maker/store.ts";
import { openHistory, recordPost, setHistoryAccount } from "./history.ts";
import { APP_NAME, APP_PLATFORMS, addSet, allSets, appPlatformIds, isAppPlatform, cleanSpace, disconnect, displayName, explain, readSettings, uploadName, writeSettings } from "./app.ts";

const UPLOADS = join(APP_DIR, "uploads");

// Dashboard HTML: the packaged app points POSTER_DASHBOARD_HTML at its bundled copy;
// the CLI resolves it next to the source tree.
let HTML_CACHE: Buffer | null = null;
function dashboardHtml(): Buffer {
  if (HTML_CACHE) return HTML_CACHE;
  const packaged = process.env.POSTER_DASHBOARD_HTML;
  const p = packaged || join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "index.html");
  const html = readFileSync(p);
  if (packaged) HTML_CACHE = html; // from source, read fresh each time so an edit shows on refresh
  return html;
}

// Phone-first upload page (served at /m). Honors POSTER_MOBILE_HTML for the packaged app.
let MOBILE_CACHE: Buffer | null = null;
function mobileHtml(): Buffer {
  if (MOBILE_CACHE) return MOBILE_CACHE;
  const p = process.env.POSTER_MOBILE_HTML
    || join(dirname(fileURLToPath(import.meta.url)), "..", "mobile", "index.html");
  MOBILE_CACHE = readFileSync(p);
  return MOBILE_CACHE;
}

// When ACCESS_TOKEN is set (remote mode, reachable off-box), every /m and /api request
// must carry it — otherwise anyone with the public URL could post to the signed-in
// accounts. The dashboard on localhost runs with no token, so nothing changes there.
let ACCESS_TOKEN = process.env.POSTER_ACCESS_TOKEN || "";
function authorized(req: IncomingMessage, url: URL): boolean {
  if (!ACCESS_TOKEN) return true;
  const given = url.searchParams.get("k") || (req.headers["x-poster-key"] as string) || "";
  return given === ACCESS_TOKEN;
}

interface Job {
  id: string;
  status: "running" | "done";
  log: string[];
  results: Record<string, "posted" | "dry-run" | string>;
}
const jobs = new Map<string, Job>();

/** The phone's device (from the x-poster-device header or ?d=), if it has one. */
function deviceFor(req: IncomingMessage, url: URL): Device | null {
  return getDevice((req.headers["x-poster-device"] as string) || url.searchParams.get("d"));
}
/** A phone with a device id posts from ITS profile. An id we don't know is refused
 *  rather than silently falling back to the default profile's accounts. */
function profileFor(req: IncomingMessage, url: URL): Profile {
  const raw = (req.headers["x-poster-device"] as string) || url.searchParams.get("d");
  // On this computer: whichever set of accounts the person has switched to.
  if (!raw) return accountProfile(readSettings().activeSet);
  const d = getDevice(raw);
  if (!d) throw new Error("This phone isn't registered any more. Reopen the link and enter your name.");
  return profileOf(d);
}

async function status(profile: Profile = defaultProfile) {
  return withBrowser(async (ctx) => {
    const out: Record<string, { label: string; loggedIn: boolean; verified: boolean; postsUrl: string }> = {};
    // Only the platforms the app offers, in the order it shows them.
    for (const id of appPlatformIds()) {
      const p = PLATFORMS[id];
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      out[p.id] = { label: p.label, loggedIn: await p.isLoggedIn(page).catch(() => false), verified: p.verified ?? false, postsUrl: APP_PLATFORMS[id].postsUrl };
    }
    return out;
  }, "about:blank", profile);
}

async function openLogin(platformId: string, profile: Profile = defaultProfile) {
  const p = getPlatform(platformId);
  await withBrowser(async (ctx) => {
    const page = await pageFor(ctx, p.host);
    await page.goto(p.loginUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.bringToFront();
    const s = await ctx.newCDPSession(page);
    const { windowId } = await s.send("Browser.getWindowForTarget");
    await s.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  }, p.loginUrl, profile);
}

function runJob(video: string, caption: string, platformIds: string[], live: boolean, profile: Profile = defaultProfile, deleteAfter = false): Job {
  const job: Job = { id: Date.now().toString(36), status: "running", log: [], results: {} };
  jobs.set(job.id, job);
  const log = (m: string) => job.log.push(`[${new Date().toLocaleTimeString()}] ${m}`);
  (async () => {
    for (const id of platformIds) {
      const p = getPlatform(id);
      log(`▶ ${p.label}`);
      try {
        await withBrowser(async (ctx) => {
          const page = await pageFor(ctx, p.host);
          if (!(await p.isLoggedIn(page))) throw new Error(`not logged in to ${p.label}. Click Connect first.`);
          await page.bringToFront();
          await p.post(page, { video, caption, dryRun: !live }, (m) => log(`  ${m}`));
          if (live && deleteAfter) {
            try {
              if (!p.remove) throw new Error(`${p.label} has no delete step yet`);
              await p.remove(page, caption, (m) => log(`  ${m}`));
            } catch (e) {
              log(`  ✖ POSTED BUT NOT DELETED: ${(e as Error).message.split("\n")[0]}`);
            }
          }
        }, "about:blank", profile);
        job.results[id] = live ? "posted" : "dry-run";
      } catch (e) {
        job.results[id] = `error: ${(e as Error).message.split("\n")[0]}`;
        log(`  ✖ ${job.results[id]}`);
      }
      recordPost(id, video, caption, job.results[id]);
    }
    job.status = "done";
    log("Finished.");
  })();
  return job;
}

interface BatchRun { batch: Batch; log: string[]; done: boolean; }
const batches = new Map<string, BatchRun>();
let batchRunning = false; // one batch at a time, so spacing is never defeated by overlap
let lastBatchId = ""; // so a refreshed page can pick its progress grid back up
/** Live batches that carry a made post: batch id -> the set it belongs to. */
const madeBatches = new Map<string, string>();

/** A batch has finished (or stopped). Clean up what it no longer needs, and tell any made post how it went. */
function afterBatch(batch: Batch): void {
  // Uploaded copies whose posts are all finished are deleted; the person's own file is never touched.
  for (const v of finishedVideos(batch)) {
    if (v.startsWith(UPLOADS + sep)) { try { rmSync(v, { force: true }); } catch { /* still in use; cleared later */ } }
  }
  const set = madeBatches.get(batch.id);
  if (set === undefined) return;
  const p = listMade(set).find((m) => m.batchId === batch.id);
  if (!p) return;
  const err = batch.items.find((i) => i.status === "error");
  const unsure = batch.items.filter((i) => i.status === "unconfirmed");
  if (err) { p.status = "failed"; p.problem = explain(err.note ?? "", PLATFORMS[err.platform]?.label ?? err.platform).problem + " Press Post again to retry the ones that didn't go out."; }
  else { p.status = "posted"; p.postedAt = new Date().toISOString(); p.problem = unsure.length ? `Check ${unsure.map((i) => PLATFORMS[i.platform]?.label ?? i.platform).join(" and ")}: the app pressed Post but couldn't see it go up.` : ""; }
  saveMade(p);
}

function runEntry(entry: BatchRun, profile: Profile): void {
  batchRunning = true;
  entry.done = false;
  const log = (m: string) => entry.log.push(`[${new Date().toLocaleTimeString()}] ${m}`);
  (async () => {
    try { await runBatchEngine(entry.batch, log, (b) => { entry.batch = b; }, profile); }
    catch (e) { log(`ERROR: ${(e as Error).message}`); }
    finally { entry.done = true; batchRunning = false; try { afterBatch(entry.batch); } catch (e) { console.error("after batch:", (e as Error).message); } }
  })();
}

function startBatch(videos: { path: string; caption?: string; captions?: Record<string, string> }[], platformIds: string[], live: boolean, spaceSec: number, sharedCaption: string, profile: Profile = defaultProfile, deleteAfter = false): BatchRun {
  const batch = buildBatch({ videos, platforms: platformIds, live, deleteAfter, spaceSec, sharedCaption });
  const entry: BatchRun = { batch, log: [], done: false };
  batches.set(batch.id, entry);
  lastBatchId = batch.id;
  runEntry(entry, profile);
  return entry;
}

/** The newest batch from before a restart, with anything that was mid-post marked unconfirmed. */
try {
  const recovered = recoverLatestBatch();
  if (recovered) { batches.set(recovered.id, { batch: recovered, log: [], done: true }); lastBatchId = recovered.id; }
} catch (e) { console.error("couldn't read the last batch:", (e as Error).message); }

/** The last account check for each Chrome profile, shown while posts are going out
 *  (a check has to wait for the posting to finish, and the screens shouldn't freeze). */
const lastStatus = new Map<string, unknown>();

/** Space taken by uploaded copies, and which of them a batch still needs. */
function uploadsUse(): { bytes: number; files: number; needed: Set<string> } {
  const needed = new Set<string>();
  for (const e of batches.values()) for (const i of e.batch.items) if (i.status === "pending" || i.status === "error" || i.status === "posting") needed.add(i.video);
  let bytes = 0, files = 0;
  try { for (const f of readdirSync(UPLOADS)) { try { bytes += statSync(join(UPLOADS, f)).size; files++; } catch { /* gone */ } } } catch { /* no uploads yet */ }
  return { bytes, files, needed };
}

/** A batch as the app shows it: each clip by the name the person knows, each platform by
 *  its label, and every failure with a plain-English fix beside the raw message. */
function batchView(entry: BatchRun) {
  const b = entry.batch;
  return {
    id: b.id,
    live: b.live,
    deleteAfter: !!b.deleteAfter,
    spaceSec: b.spaceSec,
    createdAt: b.createdAt,
    done: entry.done,
    log: entry.log,
    items: b.items.map((i) => {
      const label = PLATFORMS[i.platform]?.label ?? i.platform;
      const problem = i.status === "error" || i.status === "unconfirmed" || /NOT DELETED/.test(i.note ?? "");
      return { ...i, name: displayName(i.video), label, postsUrl: APP_PLATFORMS[i.platform]?.postsUrl ?? "", fix: problem ? explain(i.note ?? "", label) : null };
    }),
  };
}

/* ---- who may talk to this server -------------------------------------------------
 * The app listens on this computer only, but "only this computer" includes every web
 * page open in every browser on it. Without the checks below, any site the person
 * visits could quietly send a form to http://127.0.0.1:4747/api/batch and publish its
 * own video from their accounts, or sign them out. Three rules stop that:
 *
 *   1. The Host header must be this server's own address. A site that points its own
 *      domain name at 127.0.0.1 (DNS rebinding) fails here.
 *   2. A request that says which page sent it (Origin) must have been sent by the
 *      app's own page. Browsers always add Origin to a cross-site POST.
 *   3. A browser's own label for the request (Sec-Fetch-Site) must not be cross-site.
 *
 * A request with none of those headers is not from a web page at all (the CLI, a
 * script on this Mac), and anything running on the Mac could drive Chrome directly
 * anyway. Remote mode (an access key is set, for the phone link) is guarded by that
 * key instead: the phone reaches it through a tunnel with a different address.
 */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY", // no other page may put the app in a frame and trick clicks onto it
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
};
const PAGE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function allowedRequest(req: IncomingMessage, port: number, remote: boolean): { ok: true } | { ok: false; why: string } {
  if (remote) return { ok: true };
  const mine = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const host = String(req.headers.host ?? "").toLowerCase();
  if (!mine.has(host)) return { ok: false, why: "This address isn't the app's own." };
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "") {
    let from = "";
    try { const u = new URL(origin); from = u.protocol === "http:" ? u.host.toLowerCase() : ""; } catch { from = ""; }
    if (!mine.has(from)) return { ok: false, why: "Only the app's own page can do that." };
  }
  const site = String(req.headers["sec-fetch-site"] ?? "");
  if (site === "cross-site" || site === "same-site") return { ok: false, why: "Only the app's own page can do that." };
  return { ok: true };
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

/** The most a single request may carry. Videos are big, so this is generous, but it is
 *  not endless: a request is held in memory while it arrives. */
const MAX_BODY = Number(process.env.POSTER_MAX_UPLOAD_MB ?? 4096) * 1024 * 1024;
class TooBig extends Error {}

async function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
  const max = Math.min(limit, MAX_BODY);
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > max) throw new TooBig();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new TooBig();
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}


let batchClaimed = false;
/** Read an upload batch and start it. Called with the one-batch claim held. */
async function takeBatch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const body = await readBody(req);
  const form = await new Response(new Uint8Array(body), { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
  const platformIds = form.getAll("platforms").map(String);
  if (!platformIds.length) return json(res, 400, { error: "pick at least one platform" });
  try { for (const id of platformIds) getPlatform(id); } // validate before writing any file
  catch (e) { return json(res, 400, { error: (e as Error).message }); }
  mkdirSync(UPLOADS, { recursive: true });
  const all = form.getAll("videos");
  const videos: { path: string; caption?: string }[] = [];
  for (let i = 0; i < all.length; i++) {
    const f = all[i];
    if (!(f instanceof File) || f.size === 0) continue; // keep the ORIGINAL index so captions stay aligned
    const dest = join(UPLOADS, uploadName(i, f.name || `clip${extname(f.name) || ".mp4"}`));
    writeFileSync(dest, Buffer.from(await f.arrayBuffer()));
    const per = String(form.get(`caption${i}`) ?? "").trim();
    videos.push({ path: dest, caption: per || undefined });
  }
  if (!videos.length) return json(res, 400, { error: "pick at least one video" });
  // Spacing comes from the form; a blank field means the saved setting (on by default).
  const rawSpace = form.get("space");
  const spaceSec = rawSpace === null || String(rawSpace).trim() === "" ? readSettings().spaceSec : cleanSpace(rawSpace);
  const entry = startBatch(videos, platformIds, form.get("live") === "on", spaceSec, String(form.get("caption") ?? ""), profileFor(req, url), form.get("deleteAfter") === "on");
  return json(res, 200, { id: entry.batch.id });
}

setHistoryAccount(readSettings().activeSet); // history rows carry the set they went out from
let PORT = Number(process.env.POSTER_PORT ?? 4747);
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  try {
    // The logo is non-sensitive and loaded by an <img> that can't send the key header.
    if (req.method === "GET" && url.pathname === "/logo.png") {
      const p = process.env.POSTER_MOBILE_HTML
        ? join(dirname(process.env.POSTER_MOBILE_HTML), "logo.png")
        : join(dirname(fileURLToPath(import.meta.url)), "..", "mobile", "logo.png");
      try {
        res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
        return res.end(readFileSync(p));
      } catch { return json(res, 404, { error: "no logo" }); }
    }
    if (!authorized(req, url)) return json(res, 401, { error: "Unauthorized — this link needs its access key." });
    const allowed = allowedRequest(req, PORT, !!ACCESS_TOKEN);
    if (!allowed.ok) return json(res, 403, { error: allowed.why });
    if (ACCESS_TOKEN) {
      // Phone-link mode. The link's key alone isn't enough: every request must come from a
      // phone that registered (entered its name), so it can only ever reach that phone's own
      // Chrome profile, never the Mac's accounts. The post maker isn't offered here.
      if (url.pathname === "/render" || url.pathname.startsWith("/api/maker") || url.pathname.startsWith("/vendor/")) return json(res, 404, { error: "not found" });
      if (url.pathname.startsWith("/api/") && url.pathname !== "/api/device" && !deviceFor(req, url)) return json(res, 401, { error: "This phone isn't registered. Reopen the link and enter your name." });
    } else {
      const ctx = {
        set: readSettings().activeSet, port: PORT,
        platforms: appPlatformIds().map((id) => ({ id, label: PLATFORMS[id].label })),
        json: (code: number, body: unknown) => json(res, code, body),
        readBody: (limit?: number) => readBody(req, limit),
        batchRunning: () => batchRunning,
        startPost: (video: string, captions: Record<string, string>, platforms: string[], live: boolean, deleteAfter: boolean) => {
          const set = readSettings().activeSet;
          const entry = startBatch([{ path: video, captions }], platforms, live, readSettings().spaceSec, "", accountProfile(set), deleteAfter);
          if (live) madeBatches.set(entry.batch.id, set);
          return entry.batch.id;
        },
      };
      if (await makerRoute(req, res, url, ctx)) return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": PAGE_CSP, ...SECURITY_HEADERS });
      return res.end(dashboardHtml());
    }
    if (req.method === "GET" && (url.pathname === "/m" || url.pathname === "/m/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(mobileHtml());
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      const profile = profileFor(req, url);
      if (batchRunning && lastStatus.has(profile.dir)) { res.setHeader("x-poster-busy", "1"); return json(res, 200, lastStatus.get(profile.dir)); }
      try {
        const s = await status(profile);
        lastStatus.set(profile.dir, s);
        // The first time any account in this set is connected, its 24 hours before auto-make start.
        if (!ACCESS_TOKEN && Object.values(s).some((x) => x.loggedIn)) markSetConnected(readSettings().activeSet);
        return json(res, 200, s);
      }
      catch (e) {
        // The one setup problem a new person can hit: no Chrome. Say so in a way the page can act on.
        const msg = (e as Error).message;
        if (/Chrome not found/i.test(msg)) return json(res, 200, { error: "chrome-missing", message: msg });
        throw e;
      }
    }
    if (req.method === "GET" && url.pathname === "/api/app") {
      const s = readSettings();
      setHistoryAccount(s.activeSet);
      const u = uploadsUse();
      return json(res, 200, { name: APP_NAME, settings: s, sets: allSets(s), platforms: appPlatformIds().map((id) => ({ id, label: PLATFORMS[id].label })), batchRunning, uploads: { bytes: u.bytes, files: u.files } });
    }
    // Delete uploaded copies no batch still needs. The person's own files are never touched.
    if (req.method === "POST" && url.pathname === "/api/uploads/clear") {
      const u = uploadsUse();
      let removed = 0;
      try { for (const f of readdirSync(UPLOADS)) { const p = join(UPLOADS, f); if (!u.needed.has(p)) { rmSync(p, { force: true }); removed++; } } } catch { /* nothing there */ }
      const after = uploadsUse();
      return json(res, 200, { removed, bytes: after.bytes, files: after.files });
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      // Only the plain preferences are set here; sets have their own routes below.
      const { onboarded, spaceSec, mainName } = JSON.parse((await readBody(req)).toString() || "{}");
      return json(res, 200, writeSettings({ onboarded, spaceSec, mainName }));
    }
    if (req.method === "POST" && url.pathname === "/api/sets") {
      const { name } = JSON.parse((await readBody(req)).toString() || "{}");
      try { const { settings, set } = addSet(String(name ?? "")); return json(res, 200, { set, sets: allSets(settings) }); }
      catch (e) { return json(res, 400, { error: (e as Error).message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/sets/active") {
      if (batchRunning) return json(res, 409, { error: "Posts are going out right now. Switch when they finish." });
      const { id } = JSON.parse((await readBody(req)).toString() || "{}");
      const s = writeSettings({ activeSet: String(id ?? "") });
      setHistoryAccount(s.activeSet);
      return json(res, 200, { activeSet: s.activeSet, sets: allSets(s) });
    }
    if (req.method === "POST" && url.pathname === "/api/disconnect") {
      const { platform } = JSON.parse((await readBody(req)).toString() || "{}");
      if (!isAppPlatform(String(platform))) return json(res, 400, { error: "Unknown platform." });
      if (batchRunning) return json(res, 409, { error: "Posts are going out right now. Disconnect when they finish." });
      await withBrowser((ctx) => disconnect(ctx, String(platform)), "about:blank", profileFor(req, url));
      return json(res, 200, { ok: true });
    }
    // --- phone devices: each phone gets its own Chrome profile ---
    if (req.method === "GET" && url.pathname === "/api/device") {
      const d = deviceFor(req, url);
      return d ? json(res, 200, { id: d.id, name: d.name }) : json(res, 404, { error: "unknown device" });
    }
    if (req.method === "POST" && url.pathname === "/api/device") {
      const { name } = JSON.parse((await readBody(req)).toString() || "{}");
      const d = createDevice(String(name ?? ""));
      return json(res, 200, { id: d.id, name: d.name });
    }
    // --- sign in from the phone: stream the Mac's login page, replay taps/typing ---
    if (req.method === "POST" && url.pathname === "/api/remote/open") {
      if (batchRunning) return json(res, 409, { error: "Posts are going out right now. Sign in when they finish." });
      const { platform } = JSON.parse((await readBody(req)).toString() || "{}");
      const p = getPlatform(String(platform));
      await openView(profileFor(req, url), p.loginUrl, p.id);
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/remote/stream") {
      const v = getView(profileFor(req, url));
      if (!v) return json(res, 404, { error: "no sign-in window open" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const off = v.subscribe((ev) => {
        if (ev.type === "frame") res.write(`data: ${ev.data}\n\n`);
        else res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        if (ev.type === "closed") res.end();
      });
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => { off(); clearInterval(ping); });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/remote/input") {
      const v = getView(profileFor(req, url));
      if (!v) return json(res, 404, { error: "no sign-in window open" });
      await v.input(JSON.parse((await readBody(req)).toString() || "{}"));
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/remote/close") {
      closeView(profileFor(req, url));
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/login") {
      if (batchRunning) return json(res, 409, { error: "Posts are going out right now. Connect when they finish." });
      const { platform } = JSON.parse((await readBody(req)).toString() || "{}");
      await openLogin(platform, profileFor(req, url));
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/post") {
      const body = await readBody(req);
      const form = await new Response(new Uint8Array(body), { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
      const file = form.get("video");
      if (!(file instanceof File) || file.size === 0) return json(res, 400, { error: "pick a video" });
      const platformIds = form.getAll("platforms").map(String);
      if (!platformIds.length) return json(res, 400, { error: "pick at least one platform" });
      mkdirSync(UPLOADS, { recursive: true });
      const dest = join(UPLOADS, `${Date.now()}${extname(file.name) || ".mp4"}`);
      writeFileSync(dest, Buffer.from(await file.arrayBuffer()));
      const job = runJob(dest, String(form.get("caption") ?? ""), platformIds, form.get("live") === "on", profileFor(req, url), form.get("deleteAfter") === "on");
      return json(res, 200, { id: job.id });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      const job = jobs.get(url.pathname.split("/").pop()!);
      return job ? json(res, 200, job) : json(res, 404, { error: "no such job" });
    }
    if (req.method === "POST" && url.pathname === "/api/batch") {
      if (batchRunning || batchClaimed) return json(res, 409, { error: "A batch is already running — wait for it to finish." });
      batchClaimed = true;
      try { return await takeBatch(req, res, url); } finally { batchClaimed = false; }
    }
    if (req.method === "GET" && url.pathname === "/api/batches/current") {
      const b = lastBatchId ? batches.get(lastBatchId) : undefined;
      return json(res, 200, b ? batchView(b) : null);
    }
    // Try the failed posts again. Posts that already went out are never repeated.
    if (req.method === "POST" && /^\/api\/batches\/[^/]+\/resume$/.test(url.pathname)) {
      const entry = batches.get(url.pathname.split("/")[3]);
      if (!entry) return json(res, 404, { error: "no such batch" });
      if (batchRunning || batchClaimed) return json(res, 409, { error: "Posts are already going out. Wait for them to finish." });
      if (!entry.batch.items.some((i) => i.status === "error" || i.status === "pending")) return json(res, 400, { error: "Nothing here needs trying again. Posts marked \"check\" may already be up, so the app won't post them twice." });
      lastBatchId = entry.batch.id;
      runEntry(entry, profileFor(req, url));
      return json(res, 200, { id: entry.batch.id });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/batches/")) {
      const b = batches.get(url.pathname.split("/").pop()!);
      return b ? json(res, 200, batchView(b)) : json(res, 404, { error: "no such batch" });
    }
    if (req.method === "GET" && url.pathname === "/api/history") {
      const db = await openHistory();
      if (!db) return json(res, 200, []);
      // History is per set of accounts: you see what went out from the set you're in.
      const rows = db.prepare("SELECT id, platform, video, caption, status, posted_at FROM posts WHERE account = ? ORDER BY id DESC LIMIT 300").all(readSettings().activeSet);
      db.close();
      // What happened, in the app's words, with a link to that platform's list of the person's posts.
      return json(res, 200, rows.map((r: any) => {
        const label = PLATFORMS[r.platform]?.label ?? r.platform;
        const failed = String(r.status).startsWith("error");
        const unsure = String(r.status).startsWith("unconfirmed");
        const kind = r.status === "posted" ? "posted" : r.status === "dry-run" ? "preview" : r.status === "deleted" ? "deleted" : failed ? "failed" : unsure ? "check" : "other";
        return { ...r, name: displayName(r.video), label, kind, link: APP_PLATFORMS[r.platform]?.postsUrl ?? "", fix: failed ? explain(String(r.status).replace(/^error:\s*/, ""), label) : unsure ? explain("UNCONFIRMED", label) : null };
      }));
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof TooBig) return json(res, 413, { error: "That's more video than the app can take in one go. Post fewer clips at a time." });
    if (e instanceof SyntaxError) return json(res, 400, { error: "That request wasn't understood." });
    json(res, 500, { error: (e as Error).message.split("\n")[0] });
  }
});

/** Start the dashboard server. The Electron app calls this with open:false and then
 *  loads the URL in its own window; the CLI lets it auto-open in the browser. */
export function startServer(
  opts: { port?: number; open?: boolean; host?: string; token?: string } = {},
): Promise<{ url: string; port: number }> {
  if (opts.port) PORT = opts.port;
  if (opts.token !== undefined) ACCESS_TOKEN = opts.token;
  const host = opts.host || "127.0.0.1";
  return new Promise(async (resolve, reject) => {
    // On a Mac, one program on 0.0.0.0:4747 and another on 127.0.0.1:4747 can both listen,
    // and then two apps drive the same Chrome. Ask first: if anything answers, the port is taken.
    if (await answersOn(PORT)) return reject(Object.assign(new Error(`port ${PORT} is in use`), { code: "EADDRINUSE" }));
    const onErr = (e: Error) => { server.removeListener("error", onErr); reject(e); };
    server.once("error", onErr);
    server.listen(PORT, host, () => {
      server.removeListener("error", onErr);
      const u = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${PORT}`;
      console.log(`${APP_NAME} by Northbound: ${u}  (Chrome CDP :${CDP_PORT})`);
      if (opts.open !== false && !process.argv.includes("--no-open")) {
        spawn("open", [u], { stdio: "ignore" }).unref();
      }
      resolve({ url: u, port: PORT });
      startAutoMake();
    });
  });
}

async function answersOn(port: number): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/logo.png`, { signal: AbortSignal.timeout(800) }); return true; } catch { return false; }
}

/** Is Post Everywhere itself (this Mac's dashboard, not the phone service) on that port? */
async function ourAppOn(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/app`, { signal: AbortSignal.timeout(1500) });
    return r.ok && ((await r.json()) as { name?: string }).name === APP_NAME;
  } catch { return false; }
}

/** Auto-make, for the set the app is on, checked every 10 minutes. Never in phone-link mode. */
let autoTimer: ReturnType<typeof setInterval> | null = null;
function startAutoMake(): void {
  if (autoTimer || ACCESS_TOKEN) return;
  autoTimer = setInterval(() => {
    const set = readSettings().activeSet;
    void autoTick(set, PORT, {
      batchRunning: () => batchRunning || batchClaimed,
      startPost: (video, captions, platforms, live, deleteAfter) => {
        const entry = startBatch([{ path: video, captions }], platforms, live, readSettings().spaceSec, "", accountProfile(set), deleteAfter);
        if (live) madeBatches.set(entry.batch.id, set);
        return entry.batch.id;
      },
    }).catch((e) => console.error("[auto-make]", String((e as Error).message ?? e).split("\n")[0]));
  }, 10 * 60_000);
  autoTimer.unref();
}

// Run directly from the CLI (`node src/server.ts`), but not when imported by the app.
const invokedDirectly = (() => {
  try { return process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false; }
  catch { return false; }
})();
/** Start on the first free port from `first`. If this app is already running on one of
 *  them, return that one instead of starting a second copy (existing: true). */
export async function startOnFreePort(first = PORT, open = false): Promise<{ url: string; port: number; existing: boolean; note: string }> {
  for (let port = first; port <= first + 13; port++) {
    try {
      const r = await startServer({ port, open });
      return { ...r, existing: false, note: port !== first ? `Port ${first} is used by another program, so ${APP_NAME} is on ${port}.` : "" };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
      if (await ourAppOn(port)) return { url: `http://127.0.0.1:${port}`, port, existing: true, note: `${APP_NAME} is already running at http://127.0.0.1:${port}.` };
    }
  }
  throw new Error(`ports ${first} to ${first + 13} are all in use`);
}

if (invokedDirectly) {
  // Port taken? If it's this app already, open it. Otherwise use the next free port and say so.
  startOnFreePort(PORT, !process.argv.includes("--no-open")).then((r) => {
    if (r.note) console.log(r.note);
    if (r.existing) {
      if (!process.argv.includes("--no-open")) spawn("open", [r.url], { stdio: "ignore" }).unref();
      process.exit(0);
    }
  }).catch((e) => { console.error(`${APP_NAME} couldn't start: ${(e as Error).message}`); process.exit(1); });
}
