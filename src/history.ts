import { HISTORY_DB, ensureDirs } from "./config.ts";

// node:sqlite is a built-in on the dev Node (24+) but may be absent or flagged in
// the packaged Electron runtime. Load it lazily so the whole engine never fails to
// import, and degrade to a no-op (posting still works, history just isn't recorded).
let Ctor: (new (path: string) => any) | null = null;
let tried = false;

async function loadCtor(): Promise<(new (path: string) => any) | null> {
  if (tried) return Ctor;
  tried = true;
  try {
    const mod: any = await import("node:sqlite");
    Ctor = mod.DatabaseSync ?? null;
  } catch {
    Ctor = null;
  }
  return Ctor;
}

/** Which set of accounts is posting right now ("" is the main set). The server sets this
 *  when the person switches; one batch runs at a time, so it cannot change mid-post. */
let currentAccount = "";
export function setHistoryAccount(id: string): void { currentAccount = id; }

/** Open the history DB, or null if sqlite isn't available in this runtime. */
export async function openHistory(): Promise<any | null> {
  const C = await loadCtor();
  if (!C) return null;
  try {
    ensureDirs();
    const db = new C(HISTORY_DB);
    db.exec(`CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      video TEXT NOT NULL,
      caption TEXT,
      status TEXT NOT NULL,
      posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    // Added later: older installs get the column the first time they open the file.
    const cols = db.prepare("PRAGMA table_info(posts)").all().map((c: any) => c.name);
    if (!cols.includes("account")) db.exec("ALTER TABLE posts ADD COLUMN account TEXT NOT NULL DEFAULT ''");
    // Official posting (Nov 2026): how it went out, as whom, and where it is now.
    for (const c of ["via", "identity", "remote_id", "link", "song", "device"]) if (!cols.includes(c)) db.exec(`ALTER TABLE posts ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''`);
    return db;
  } catch {
    return null;
  }
}

/** Fire-and-forget: callers don't await, and a storage failure is never fatal. */
export interface PostExtra { via?: string; identity?: string; remote_id?: string; link?: string; song?: string; device?: string }
export function recordPost(platform: string, video: string, caption: string, status: string, x: PostExtra = {}): void {
  void (async () => {
    try {
      const db = await openHistory();
      if (!db) return;
      db.prepare("INSERT INTO posts (platform, video, caption, status, account, via, identity, remote_id, link, song, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(platform, video, caption, status, currentAccount, x.via ?? "", x.identity ?? "", x.remote_id ?? "", x.link ?? "", x.song ?? "", x.device ?? "");
      db.close();
    } catch {}
  })();
}
