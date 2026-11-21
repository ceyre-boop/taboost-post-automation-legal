import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { APP_DIR, CDP_PORT, accountProfile, defaultProfile, type Profile } from "./config.ts";
import { getDevice, createDevice, profileOf, type Device } from "./devices.ts";
import { openView, getView, closeView } from "./remote-view.ts";
import { withBrowser, pageFor } from "./browser.ts";
import { PLATFORMS, getPlatform } from "./platforms/index.ts";
import { buildBatch, runBatch as runBatchEngine, type Batch } from "./batch.ts";
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

function startBatch(videos: { path: string; caption?: string }[], platformIds: string[], live: boolean, spaceSec: number, sharedCaption: string, profile: Profile = defaultProfile, deleteAfter = false): BatchRun {
  const batch = buildBatch({ videos, platforms: platformIds, live, deleteAfter, spaceSec, sharedCaption });
  const entry: BatchRun = { batch, log: [], done: false };
  batches.set(batch.id, entry);
  batchRunning = true;
  const log = (m: string) => entry.log.push(`[${new Date().toLocaleTimeString()}] ${m}`);
  (async () => {
    try { await runBatchEngine(batch, log, (b) => { entry.batch = b; }, profile); }
    catch (e) { log(`ERROR: ${(e as Error).message}`); }
    finally { entry.done = true; batchRunning = false; }
  })();
  return entry;
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
      const problem = i.status === "error" || /NOT DELETED/.test(i.note ?? "");
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

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY) throw new TooBig();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new TooBig();
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
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
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": PAGE_CSP, ...SECURITY_HEADERS });
      return res.end(dashboardHtml());
    }
    if (req.method === "GET" && (url.pathname === "/m" || url.pathname === "/m/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(mobileHtml());
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      try { return json(res, 200, await status(profileFor(req, url))); }
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
      return json(res, 200, { name: APP_NAME, settings: s, sets: allSets(s), platforms: appPlatformIds().map((id) => ({ id, label: PLATFORMS[id].label })), batchRunning });
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
      const { platform } = JSON.parse((await readBody(req)).toString() || "{}");
      const p = getPlatform(String(platform));
      await openView(profileFor(req, url), p.loginUrl);
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
      if (batchRunning) return json(res, 409, { error: "A batch is already running — wait for it to finish." });
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
      lastBatchId = entry.batch.id;
      return json(res, 200, { id: entry.batch.id });
    }
    if (req.method === "GET" && url.pathname === "/api/batches/current") {
      const b = lastBatchId ? batches.get(lastBatchId) : undefined;
      return json(res, 200, b ? batchView(b) : null);
    }
    // Try the failed posts again. Posts that already went out are never repeated.
    if (req.method === "POST" && /^\/api\/batches\/[^/]+\/resume$/.test(url.pathname)) {
      const entry = batches.get(url.pathname.split("/")[3]);
      if (!entry) return json(res, 404, { error: "no such batch" });
      if (batchRunning) return json(res, 409, { error: "Posts are already going out. Wait for them to finish." });
      entry.done = false;
      batchRunning = true;
      const log = (m: string) => entry.log.push(`[${new Date().toLocaleTimeString()}] ${m}`);
      const profile = profileFor(req, url);
      (async () => {
        try { await runBatchEngine(entry.batch, log, (b) => { entry.batch = b; }, profile); }
        catch (e) { log(`ERROR: ${(e as Error).message}`); }
        finally { entry.done = true; batchRunning = false; }
      })();
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
        const kind = r.status === "posted" ? "posted" : r.status === "dry-run" ? "preview" : r.status === "deleted" ? "deleted" : failed ? "failed" : "other";
        return { ...r, name: displayName(r.video), label, kind, link: APP_PLATFORMS[r.platform]?.postsUrl ?? "", fix: failed ? explain(String(r.status).replace(/^error:\s*/, ""), label) : null };
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
  return new Promise((resolve, reject) => {
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
    });
  });
}

// Run directly from the CLI (`node src/server.ts`), but not when imported by the app.
const invokedDirectly = (() => {
  try { return process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false; }
  catch { return false; }
})();
if (invokedDirectly) startServer();
