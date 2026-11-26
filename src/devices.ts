// Phone devices. Each phone that opens the poster gets its own Chrome profile, so
// Skyler's accounts live in her profile and are still signed in next time she opens
// her link. The device id rides in her bookmarked link (&d=...) — that IS the memory.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR, ROOT_DIR, type Profile } from "./config.ts";

export interface Device { id: string; name: string; profileDir: string; cdpPort: number; createdAt: string; }

const FIRST_PORT = 9230;
const ID_RE = /^[A-Za-z0-9_-]{12}$/;

export function devicesFile(appDir = APP_DIR): string { return join(appDir, "devices.json"); }

export function loadDevices(appDir = APP_DIR): Record<string, Device> {
  try { return JSON.parse(readFileSync(devicesFile(appDir), "utf8")); } catch { return {}; }
}

function save(all: Record<string, Device>, appDir: string): void {
  mkdirSync(appDir, { recursive: true });
  writeFileSync(devicesFile(appDir), JSON.stringify(all, null, 2));
}

export function getDevice(id: string | null | undefined, appDir = APP_DIR): Device | null {
  if (!id || !ID_RE.test(id)) return null;
  return loadDevices(appDir)[id] ?? null;
}

/** Every Chrome port already spoken for anywhere in the person's app folder: the main set (9226),
 *  every phone in the root and in every named set, and every set's own port. Two profiles on one
 *  port share one Chrome and post from the wrong accounts, so a new phone never takes one of these. */
export function portsInUse(root = ROOT_DIR): Set<number> {
  const used = new Set<number>([9226]);
  const add = (file: string) => { try { for (const d of Object.values(JSON.parse(readFileSync(file, "utf8")) as Record<string, Device>)) if (d?.cdpPort) used.add(d.cdpPort); } catch { /* none */ } };
  add(join(root, "devices.json"));
  try { for (const a of readdirSync(join(root, "accounts"))) add(join(root, "accounts", a, "devices.json")); } catch { /* no sets */ }
  try { for (const p of Object.values(JSON.parse(readFileSync(join(root, "set-ports.json"), "utf8")) as Record<string, number>)) used.add(p); } catch { /* none */ }
  return used;
}

const cleanName = (name: string) => name.trim().replace(/[^\p{L}\p{N} ._'-]/gu, "").slice(0, 40) || "Phone";

/** The phone already registered under this name (any case), so typing your name again on a new
 *  link or a cleared phone finds your own accounts instead of starting an empty profile. */
export function findDeviceByName(name: string, appDir = APP_DIR): Device | null {
  const want = cleanName(name).toLowerCase();
  return Object.values(loadDevices(appDir)).find((d) => d.name.toLowerCase() === want) ?? null;
}

/** Phones one app folder will register. Each one is a Chrome profile and a port on this Mac. */
export const maxDevices = (): number => { const n = Number(process.env.POSTER_MAX_DEVICES); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 25; };

export function createDevice(name: string, appDir = APP_DIR): Device {
  const clean = cleanName(name);
  const all = loadDevices(appDir);
  if (Object.keys(all).length >= maxDevices()) throw new Error("This poster already has as many phones as it allows. Use a name that's already on the list.");
  const used = new Set([...Object.values(all).map((d) => d.cdpPort), ...portsInUse(appDir === APP_DIR ? ROOT_DIR : appDir)]);
  let port = FIRST_PORT;
  while (used.has(port)) port++;
  let id = randomBytes(9).toString("base64url");
  while (all[id]) id = randomBytes(9).toString("base64url");
  const dev: Device = { id, name: clean, profileDir: join(appDir, "profiles", id), cdpPort: port, createdAt: new Date().toISOString() };
  all[id] = dev;
  save(all, appDir);
  return dev;
}

export function deleteDevice(id: string, appDir = APP_DIR): boolean {
  const all = loadDevices(appDir);
  if (!all[id]) return false;
  delete all[id];
  save(all, appDir);
  return true;
}

export function profileOf(d: Device): Profile { return { dir: d.profileDir, port: d.cdpPort }; }

