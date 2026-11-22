// Posting permissions (OAuth tokens) live only in the macOS Keychain: never in a file, a log,
// an API response or a command line. The `security` tool is used with the secret written to its
// stdin (`security -i`), so `ps` never shows it.
//
// Tests (and only tests) point POSTER_KEYCHAIN_FAKE at a temp folder outside the app folder.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SERVICE = "com.northbound.post-everywhere";
const SAFE = /^[A-Za-z0-9_./-]{1,120}$/;

const fakeDir = () => process.env.POSTER_KEYCHAIN_FAKE || "";
function fakeRead(): Record<string, string> { try { return JSON.parse(readFileSync(join(fakeDir(), "keychain.json"), "utf8")); } catch { return {}; } }
function fakeWrite(all: Record<string, string>): void { mkdirSync(fakeDir(), { recursive: true }); writeFileSync(join(fakeDir(), "keychain.json"), JSON.stringify(all), { mode: 0o600 }); }

function check(account: string): void { if (!SAFE.test(account)) throw new Error("bad keychain account name"); }

/** The stored value for `account`, or null. */
export function kcGet(account: string): string | null {
  check(account);
  if (fakeDir()) return fakeRead()[account] ?? null;
  const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const b64 = r.stdout.trim();
  try { return Buffer.from(b64, "base64").toString("utf8"); } catch { return null; }
}

/** Store (or replace) the value for `account`. The value travels base64-encoded on stdin. */
export function kcSet(account: string, value: string): void {
  check(account);
  if (fakeDir()) { const all = fakeRead(); all[account] = value; fakeWrite(all); return; }
  const b64 = Buffer.from(value, "utf8").toString("base64");
  const r = spawnSync("security", ["-i"], { input: `add-generic-password -U -s ${SERVICE} -a ${account} -w ${b64}\n`, encoding: "utf8" });
  if (r.status !== 0 || /error|could not/i.test(r.stderr ?? "")) throw new Error("couldn't save to the Keychain (is the Mac's login keychain unlocked?)");
}

export function kcDelete(account: string): void {
  check(account);
  if (fakeDir()) { const all = fakeRead(); delete all[account]; fakeWrite(all); return; }
  spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { encoding: "utf8" });
}

/** Can this process use the Keychain at all? (connect-check) */
export function kcReachable(): boolean {
  if (fakeDir()) return existsSync(fakeDir()) || true;
  return spawnSync("security", ["show-keychain-info"], { encoding: "utf8" }).status === 0;
}

/** JSON helpers for token bundles. */
export function kcGetJson<T>(account: string): T | null { const v = kcGet(account); if (!v) return null; try { return JSON.parse(v) as T; } catch { return null; } }
export const kcSetJson = (account: string, v: unknown) => kcSet(account, JSON.stringify(v));
