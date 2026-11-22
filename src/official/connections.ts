// Which accounts each phone has connected officially, and as whom it posts. Names only:
// the tokens themselves are in the Keychain (keychain.ts). APP_DIR/connections.json.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "../config.ts";

export type Via = "official" | "browser";
export type Provider = "google" | "meta" | "tiktok" | "linkedin";
export interface Identity { id: string; name: string; kind: "page" | "ig" | "channel" | "member" | "tiktok" | "profile"; via: Via }
export interface Connection { platform: string; provider: Provider; account: string; identities: Identity[]; chosen?: string; scopes: string[]; connectedAt: string; expiresAt?: string }

/** The Mac's own page (no phone device) keeps its connections under this id. */
export const MAC = "mac";
export const PROVIDER_OF: Record<string, Provider> = { youtube: "google", facebook: "meta", instagram: "meta", tiktok: "tiktok", linkedin: "linkedin" };
export const PLATFORMS_OF: Record<Provider, string[]> = { google: ["youtube"], meta: ["facebook", "instagram"], tiktok: ["tiktok"], linkedin: ["linkedin"] };

const file = () => join(APP_DIR, "connections.json");
function readAll(): Record<string, Record<string, Connection>> { try { return JSON.parse(readFileSync(file(), "utf8")); } catch { return {}; } }
function writeAll(all: Record<string, Record<string, Connection>>): void { mkdirSync(APP_DIR, { recursive: true }); writeFileSync(file(), JSON.stringify(all, null, 2)); }

export const connectionsFor = (device: string): Record<string, Connection> => readAll()[device] ?? {};
export const connectionFor = (device: string, platform: string): Connection | undefined => connectionsFor(device)[platform];

export function saveConnection(device: string, c: Connection): void {
  const all = readAll();
  const mine = all[device] ?? {};
  const keep = mine[c.platform]?.chosen;
  mine[c.platform] = { ...c, chosen: c.identities.some((i) => i.id === keep) ? keep : c.chosen ?? c.identities.find((i) => i.via === "official")?.id };
  all[device] = mine;
  writeAll(all);
}

export function removeProvider(device: string, provider: Provider): void {
  const all = readAll();
  for (const p of PLATFORMS_OF[provider]) delete all[device]?.[p];
  writeAll(all);
}

export function chooseIdentity(device: string, platform: string, id: string): Connection {
  const all = readAll();
  const c = all[device]?.[platform];
  if (!c) throw new Error(`${platform} isn't connected yet.`);
  if (!c.identities.some((i) => i.id === id)) throw new Error("That account isn't one of the connected ones.");
  c.chosen = id;
  writeAll(all);
  return c;
}

/** As whom a post to this platform goes, and how: the chosen identity, or the Mac's browser. */
export function targetFor(device: string, platform: string): { via: Via; identity?: Identity } {
  const c = connectionFor(device, platform);
  const id = c?.identities.find((i) => i.id === c.chosen);
  return id ? { via: id.via, identity: id } : { via: "browser" };
}
