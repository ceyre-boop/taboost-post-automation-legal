import { app, BrowserWindow, ipcMain, shell, Menu } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { startServer } from "../../src/server.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../dist
const FIREBASE_PROJECT = "post-automation-12546";
const PORT = Number(process.env.POSTER_PORT ?? 4747);

let win: BrowserWindow | null = null;
let engineUrl: string | null = null;

const licenseFile = () => join(app.getPath("userData"), "license.json");

interface License { key: string; email?: string; activatedAt?: string }

function readLicense(): License | null {
  try { return JSON.parse(readFileSync(licenseFile(), "utf8")); } catch { return null; }
}
function writeLicense(lic: License): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(licenseFile(), JSON.stringify(lic, null, 2));
}
function clearLicense(): void {
  try { rmSync(licenseFile(), { force: true }); } catch {}
}

/** Validate a key against the open-read `licenses/{KEY}` doc in Firestore. No SDK,
 *  no secrets — a single unauthenticated GET. The key is the only thing sent. */
async function validateKey(raw: string): Promise<{ ok: boolean; email?: string; error?: string }> {
  const key = (raw || "").trim().toUpperCase();
  if (!key) return { ok: false, error: "Enter your license key." };
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/licenses/${encodeURIComponent(key)}`;
  try {
    const r = await fetch(url);
    if (r.status === 404) return { ok: false, error: "That key isn't recognized. Double-check it and try again." };
    if (!r.ok) return { ok: false, error: `Couldn't verify the key (server ${r.status}). Try again in a moment.` };
    const body: any = await r.json();
    const f = body.fields || {};
    if (f.active && f.active.booleanValue === false) return { ok: false, error: "This key has been deactivated. Contact TABOOST." };
    return { ok: true, email: f.email?.stringValue };
  } catch {
    return { ok: false, error: "No internet connection — can't verify your key right now." };
  }
}

async function ensureEngine(): Promise<string> {
  if (engineUrl) return engineUrl;
  process.env.POSTER_APP_DIR = app.getPath("userData");
  process.env.POSTER_DASHBOARD_HTML = join(HERE, "dashboard.html");
  const { url } = await startServer({ port: PORT, open: false });
  engineUrl = url;
  return url;
}

async function showDashboard(): Promise<void> {
  const url = await ensureEngine();
  await win?.loadURL(url);
}

function showLicense(): void {
  win?.loadFile(join(HERE, "license.html"));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1120, height: 820, minWidth: 860, minHeight: 600,
    title: "TABOOST Poster",
    backgroundColor: "#0E1414",
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      sandbox: false,
    },
  });
  // External links open in the real browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(`http://127.0.0.1:${PORT}`)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  if (readLicense()?.key) showDashboard();
  else showLicense();
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { role: "editMenu" },
    {
      label: "Account",
      submenu: [
        {
          label: "Change license key…",
          click: () => { clearLicense(); showLicense(); },
        },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "Get a key / manage account", click: () => shell.openExternal("https://taboost-post-automation-legal.vercel.app/app") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("license:current", () => readLicense());
ipcMain.handle("license:activate", async (_e, key: string) => {
  const res = await validateKey(key);
  if (res.ok) {
    writeLicense({ key: key.trim().toUpperCase(), email: res.email, activatedAt: new Date().toISOString() });
    await showDashboard();
  }
  return res;
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // Smoke test: boot, report which screen loaded, then quit. Used by CI / local verify.
  if (process.env.TABOOST_SMOKE) {
    setTimeout(() => {
      console.log(`SMOKE_OK screen=${readLicense()?.key ? "dashboard" : "license"} engine=${engineUrl ?? "not-started"}`);
      app.quit();
    }, 2500);
  }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
