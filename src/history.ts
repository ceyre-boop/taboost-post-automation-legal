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
    return db;
  } catch {
    return null;
  }
}

/** Fire-and-forget: callers don't await, and a storage failure is never fatal. */
export function recordPost(platform: string, video: string, caption: string, status: string): void {
  void (async () => {
    try {
      const db = await openHistory();
      if (!db) return;
      db.prepare("INSERT INTO posts (platform, video, caption, status) VALUES (?, ?, ?, ?)").run(platform, video, caption, status);
      db.close();
    } catch {}
  })();
}
