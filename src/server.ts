import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { APP_DIR, CDP_PORT } from "./config.ts";
import { withBrowser, pageFor } from "./browser.ts";
import { PLATFORMS, getPlatform } from "./platforms/index.ts";
import { buildBatch, runBatch as runBatchEngine, type Batch } from "./batch.ts";
import { openHistory, recordPost } from "./history.ts";

const UPLOADS = join(APP_DIR, "uploads");

// Dashboard HTML: the packaged app points POSTER_DASHBOARD_HTML at its bundled copy;
// the CLI resolves it next to the source tree.
let HTML_CACHE: Buffer | null = null;
function dashboardHtml(): Buffer {
  if (HTML_CACHE) return HTML_CACHE;
  const p = process.env.POSTER_DASHBOARD_HTML
    || join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "index.html");
  HTML_CACHE = readFileSync(p);
  return HTML_CACHE;
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
  const given = url.searchParams.get("k") || (req.headers["x-taboost-key"] as string) || "";
  return given === ACCESS_TOKEN;
}

interface Job {
  id: string;
  status: "running" | "done";
  log: string[];
  results: Record<string, "posted" | "dry-run" | string>;
}
const jobs = new Map<string, Job>();

async function status() {
  return withBrowser(async (ctx) => {
    const out: Record<string, { label: string; loggedIn: boolean; verified: boolean }> = {};
    for (const p of Object.values(PLATFORMS)) {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      out[p.id] = { label: p.label, loggedIn: await p.isLoggedIn(page).catch(() => false), verified: p.verified ?? false };
    }
    return out;
  });
}

async function openLogin(platformId: string) {
  const p = getPlatform(platformId);
  await withBrowser(async (ctx) => {
    const page = await pageFor(ctx, p.host);
    await page.goto(p.loginUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.bringToFront();
    const s = await ctx.newCDPSession(page);
    const { windowId } = await s.send("Browser.getWindowForTarget");
    await s.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  }, p.loginUrl);
}

function runJob(video: string, caption: string, platformIds: string[], live: boolean): Job {
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
        });
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

function startBatch(videos: { path: string; caption?: string }[], platformIds: string[], live: boolean, spaceSec: number, sharedCaption: string): BatchRun {
  const batch = buildBatch({ videos, platforms: platformIds, live, spaceSec, sharedCaption });
  const entry: BatchRun = { batch, log: [], done: false };
  batches.set(batch.id, entry);
  batchRunning = true;
  const log = (m: string) => entry.log.push(`[${new Date().toLocaleTimeString()}] ${m}`);
  (async () => {
    try { await runBatchEngine(batch, log, (b) => { entry.batch = b; }); }
    catch (e) { log(`ERROR: ${(e as Error).message}`); }
    finally { entry.done = true; batchRunning = false; }
  })();
  return entry;
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

let PORT = Number(process.env.POSTER_PORT ?? 4747);
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  try {
    if (!authorized(req, url)) return json(res, 401, { error: "Unauthorized — this link needs its access key." });
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(dashboardHtml());
    }
    if (req.method === "GET" && (url.pathname === "/m" || url.pathname === "/m/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(mobileHtml());
    }
    if (req.method === "GET" && url.pathname === "/api/status") return json(res, 200, await status());
    if (req.method === "POST" && url.pathname === "/api/login") {
      const { platform } = JSON.parse((await readBody(req)).toString() || "{}");
      await openLogin(platform);
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
      const job = runJob(dest, String(form.get("caption") ?? ""), platformIds, form.get("live") === "on");
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
        const dest = join(UPLOADS, `${Date.now()}-${i}${extname(f.name) || ".mp4"}`);
        writeFileSync(dest, Buffer.from(await f.arrayBuffer()));
        const per = String(form.get(`caption${i}`) ?? "").trim();
        videos.push({ path: dest, caption: per || undefined });
      }
      if (!videos.length) return json(res, 400, { error: "pick at least one video" });
      const entry = startBatch(videos, platformIds, form.get("live") === "on", Number(form.get("space")) || 60, String(form.get("caption") ?? ""));
      return json(res, 200, { id: entry.batch.id });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/batches/")) {
      const b = batches.get(url.pathname.split("/").pop()!);
      return b ? json(res, 200, { items: b.batch.items, log: b.log, done: b.done }) : json(res, 404, { error: "no such batch" });
    }
    if (req.method === "GET" && url.pathname === "/api/history") {
      const db = await openHistory();
      if (!db) return json(res, 200, []);
      const rows = db.prepare("SELECT id, platform, video, caption, status, posted_at FROM posts ORDER BY id DESC LIMIT 50").all();
      db.close();
      return json(res, 200, rows);
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
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
      console.log(`TABOOST Poster dashboard: ${u}  (Chrome CDP :${CDP_PORT})`);
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
