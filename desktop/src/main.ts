// Post Everywhere as a double-click Mac app.
//
// Two builds come from this file (desktop/build.mjs --flavor=me|client):
//   client  Everyone else's copy. Asks for a Northbound license key first, keeps its data in
//           its own folder (~/Library/Application Support/Post Everywhere), and its AI is the
//           person's own Anthropic key, asked for in the first-run setup.
//   me      Colin's own copy. No license screen, shares the folder his Terminal runs use, and
//           its AI is Claude Code on his Mac. The client build doesn't contain that code at all.
//
// The window shows the same local dashboard the Terminal version serves. Closing the
// window keeps the app running in the menu bar (posts in progress and auto-make carry on);
// Quit stops it.
import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FLAVOR } from "../../src/flavor.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../dist
const NAME = FLAVOR === "me" ? "Post Everywhere (Colin)" : "Post Everywhere";
const FIREBASE_PROJECT = "post-automation-12546";
const SITE = "https://taboost-poster.vercel.app";
const FIRST_PORT = Number(process.env.POSTER_PORT ?? 4747);
const SMOKE = process.env.POSTER_SMOKE === "1";

// ---- where things live, set before the engine is loaded (config.ts reads these once) ----
if (FLAVOR === "client") {
  // The app was called "TABOOST Poster" before: keep that folder where it exists, so an
  // update never signs anyone out or asks for the license key again.
  const legacy = join(app.getPath("appData"), "TABOOST Poster");
  // (Electron makes the new folder at start-up, so ask whether it holds a license yet.)
  if (existsSync(join(legacy, "license.json")) && !existsSync(join(app.getPath("userData"), "license.json"))) app.setPath("userData", legacy);
  if (!process.env.POSTER_APP_DIR) process.env.POSTER_APP_DIR = app.getPath("userData");
}
// "me" leaves POSTER_APP_DIR alone: config.ts then picks the same folder Terminal runs use.
// Only after the folder is decided: the lock itself creates a file in it.
if (!app.requestSingleInstanceLock()) app.quit();
process.env.POSTER_DASHBOARD_HTML = join(HERE, "dashboard.html");
process.env.POSTER_MOBILE_HTML = join(HERE, "mobile.html");
process.env.POSTER_ASSETS_DIR = HERE;
const bundledChrome = join(process.resourcesPath ?? "", "chrome", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
if (existsSync(bundledChrome)) process.env.POSTER_BUNDLED_CHROME = bundledChrome;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let engineUrl: string | null = null;
let quitting = false;

/* ---------------- the license (client build only) ---------------- */

const licenseFile = () => join(app.getPath("userData"), "license.json");
interface License { key: string; email?: string; activatedAt?: string }
function readLicense(): License | null {
  if (FLAVOR !== "client") return { key: "own-build" };
  try { return JSON.parse(readFileSync(licenseFile(), "utf8")); } catch { return null; }
}
function writeLicense(lic: License): void { mkdirSync(app.getPath("userData"), { recursive: true }); writeFileSync(licenseFile(), JSON.stringify(lic, null, 2)); }
function clearLicense(): void { try { rmSync(licenseFile(), { force: true }); } catch {} }

/** Check a key against the open-read `licenses/{KEY}` document. Only the key is sent. */
async function validateKey(raw: string): Promise<{ ok: boolean; email?: string; error?: string }> {
  const key = (raw || "").trim().toUpperCase();
  if (!key) return { ok: false, error: "Enter your license key." };
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/licenses/${encodeURIComponent(key)}`;
  try {
    const r = await fetch(url);
    if (r.status === 404) return { ok: false, error: "That key isn't recognized. Double-check it and try again." };
    if (!r.ok) return { ok: false, error: `Couldn't verify the key (server ${r.status}). Try again in a moment.` };
    const f = ((await r.json()) as { fields?: Record<string, { booleanValue?: boolean; stringValue?: string }> }).fields || {};
    if (f.active && f.active.booleanValue === false) return { ok: false, error: "This key has been deactivated. Contact Northbound Studio." };
    return { ok: true, email: f.email?.stringValue };
  } catch {
    return { ok: false, error: "No internet connection, so the key can't be checked right now." };
  }
}

/* ---------------- the engine (the local server) ---------------- */

let engine: Promise<string> | null = null;
/** Start the engine once; every caller waits on the same start. */
function ensureEngine(): Promise<string> {
  engine ??= (async () => {
    // Imported only now, after the folders above are set.
    const { startOnFreePort } = await import("../../src/server.ts");
    const r = await startOnFreePort(FIRST_PORT, false);
    if (r.note) console.log(r.note);
    engineUrl = r.url;
    return r.url;
  })();
  engine.catch(() => { engine = null; });
  return engine;
}

async function showDashboard(): Promise<void> {
  try { await win?.loadURL(await ensureEngine()); }
  catch (e) { win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<body style="font:16px -apple-system;padding:48px;max-width:520px"><h1>${NAME} couldn't start</h1><p>${String((e as Error).message).replace(/</g, "&lt;")}</p><p>Quit the app and open it again. If it keeps happening, restart the Mac.</p></body>`)}`); }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180, height: 840, minWidth: 860, minHeight: 600,
    title: NAME, backgroundColor: "#f6f7f9", show: !SMOKE,
    webPreferences: { preload: join(HERE, "preload.cjs"), contextIsolation: true, sandbox: false },
  });
  // Links to other sites open in the person's own browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !(engineUrl && url.startsWith(engineUrl))) { shell.openExternal(url); return { action: "deny" }; }
    return { action: "allow" };
  });
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win?.hide(); } });
  if (readLicense()?.key) void showDashboard();
  else win.loadFile(join(HERE, "license.html"));
}

function openWindow(): void { if (!win) createWindow(); else { win.show(); win.focus(); } }

/* ---------------- menus, menu bar, start at login ---------------- */

const prefsFile = () => join(app.getPath("userData"), "mac-app.json");
function readPrefs(): { openAtLogin?: boolean } { try { return JSON.parse(readFileSync(prefsFile(), "utf8")); } catch { return {}; } }
function setOpenAtLogin(on: boolean): void {
  app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(prefsFile(), JSON.stringify({ ...readPrefs(), openAtLogin: on }));
  buildTray();
}

function buildTray(): void {
  const menu = Menu.buildFromTemplate([
    { label: `Open ${NAME}`, click: openWindow },
    { type: "separator" },
    { label: "Start at login", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: (i) => setOpenAtLogin(i.checked) },
    { type: "separator" },
    { label: `Quit ${NAME}`, click: () => { quitting = true; app.quit(); } },
  ]);
  if (!tray) {
    const icon = nativeImage.createFromPath(join(HERE, "trayTemplate.png"));
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip(`${NAME}: posts in progress keep going while this is here`);
  }
  tray.setContextMenu(menu);
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    ...(FLAVOR === "client" ? [{
      label: "Account",
      submenu: [
        { label: "Change license key…", click: () => { clearLicense(); win?.loadFile(join(HERE, "license.html")); } },
        { label: "Get a key / manage account", click: () => shell.openExternal(`${SITE}/app`) },
      ],
    } as Electron.MenuItemConstructorOptions] : []),
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("license:current", () => readLicense());
ipcMain.handle("license:activate", async (_e, key: string) => {
  const res = await validateKey(key);
  if (res.ok) { writeLicense({ key: key.trim().toUpperCase(), email: res.email, activatedAt: new Date().toISOString() }); await showDashboard(); }
  return res;
});

app.on("second-instance", openWindow);
app.on("activate", openWindow);
app.on("before-quit", () => { quitting = true; });

app.whenReady().then(async () => {
  app.setName(NAME);
  buildMenu();
  if (!SMOKE) {
    if (readPrefs().openAtLogin === undefined) setOpenAtLogin(false); // Post Everywhere starts only when opened, unless switched on
    buildTray();
  }
  createWindow();
  if (SMOKE) {
    // Boot, say what loaded, quit. Used by the build checks.
    const screen = readLicense()?.key ? "dashboard" : "license";
    let ai = { mode: "?", ready: false, dev: false };
    if (screen === "dashboard") {
      try { const url = await ensureEngine(); ai = ((await (await fetch(`${url}/api/maker`)).json()) as { ai: typeof ai }).ai; } catch (e) { console.log("SMOKE_ERR", (e as Error).message); }
    }
    console.log(`SMOKE_OK flavor=${FLAVOR} screen=${screen} ai_mode=${ai.mode} ai_ready=${ai.ready} dev=${ai.dev} chrome=${process.env.POSTER_BUNDLED_CHROME ? "bundled-available" : "none-bundled"} url=${engineUrl ?? "not-started"}`);
    setTimeout(() => { quitting = true; app.quit(); }, 300);
  }
});
