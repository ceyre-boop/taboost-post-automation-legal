// Phone devices. Each phone that opens the poster gets its own Chrome profile, so
// Skyler's accounts live in her profile and are still signed in next time she opens
// her link. The device id rides in her bookmarked link (&d=...) — that IS the memory.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR, type Profile } from "./config.ts";

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

export function createDevice(name: string, appDir = APP_DIR): Device {
  const clean = name.trim().replace(/[^\p{L}\p{N} ._'-]/gu, "").slice(0, 40) || "Phone";
  const all = loadDevices(appDir);
  const used = new Set(Object.values(all).map((d) => d.cdpPort));
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

