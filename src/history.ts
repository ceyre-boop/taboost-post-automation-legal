import { DatabaseSync } from "node:sqlite";
import { HISTORY_DB, ensureDirs } from "./config.ts";

export function openHistory(): DatabaseSync {
  ensureDirs();
  const db = new DatabaseSync(HISTORY_DB);
  db.exec(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    video TEXT NOT NULL,
    caption TEXT,
    status TEXT NOT NULL,
    posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  return db;
}

export function recordPost(platform: string, video: string, caption: string, status: string): void {
  const db = openHistory();
  db.prepare("INSERT INTO posts (platform, video, caption, status) VALUES (?, ?, ?, ?)").run(platform, video, caption, status);
  db.close();
}
