// TikTok: the official upload sends the video to Skyler's TikTok inbox as a draft. She opens it in
// the TikTok app, adds the song (volume 0, so only her drums play, and TikTok links the song), pastes
// the caption (the phone page copies it for her) and posts. TikTok's upload takes no caption.
import { statSync } from "node:fs";
import { api, ApiError, rawFetch, readChunk, redact } from "./http.ts";
import type { Log, OfficialPost, OfficialResult, Tokens, WhoAmI } from "./types.ts";

const API = "https://open.tiktokapis.com/v2";
const MB = 1024 * 1024;

export async function tiktokWho(t: Tokens): Promise<WhoAmI> {
  const r = await api<any>("TikTok", `${API}/user/info/?fields=open_id,display_name`, { headers: { authorization: `Bearer ${t.access_token}` } });
  const u = r.data?.user ?? {};
  const name = String(u.display_name || "TikTok");
  return { account: name, identities: { tiktok: [{ id: String(u.open_id ?? "me"), name, kind: "tiktok", via: "official" }] }, tokens: { user_id: String(u.open_id ?? "") } };
}

/** TikTok's chunk rules: one piece up to 64 MB; above that 32 MB pieces, the last one taking the rest. */
export function chunkPlan(size: number): { chunk_size: number; total_chunk_count: number } {
  if (size <= 64 * MB) return { chunk_size: size, total_chunk_count: 1 };
  const chunk_size = 32 * MB;
  return { chunk_size, total_chunk_count: Math.floor(size / chunk_size) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function tiktokPost(t: Tokens, p: OfficialPost, log: Log, clicked: () => void, waitMs = 3000): Promise<OfficialResult> {
  if (!p.live) { log("Would send it to your TikTok inbox as a draft."); return { status: "skipped", note: "preview: nothing uploaded" }; }
  const size = statSync(p.file).size;
  const plan = chunkPlan(size);
  const init = await api<any>("TikTok", `${API}/post/publish/inbox/video/init/`, { method: "POST", headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify({ source_info: { source: "FILE_UPLOAD", video_size: size, ...plan } }) });
  const { publish_id, upload_url } = init.data ?? {};
  if (!publish_id || !upload_url) throw new ApiError("TikTok: it didn't give an upload address");
  log(`Sending it to your TikTok inbox (${Math.round(size / MB)} MB)…`);
  for (let i = 0; i < plan.total_chunk_count; i++) {
    const start = i * plan.chunk_size;
    const end = i === plan.total_chunk_count - 1 ? size - 1 : start + plan.chunk_size - 1;
    if (i === plan.total_chunk_count - 1) clicked();
    const r = await rawFetch(upload_url, { method: "PUT", headers: { "content-type": "video/mp4", "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` }, body: await readChunk(p.file, start, end - start + 1) });
    if (!r.ok) throw new ApiError(`TikTok: upload failed (${r.status} ${redact((await r.text()).slice(0, 200))})`, r.status);
  }
  for (let i = 0; i < 60; i++) {
    const s = await api<any>("TikTok", `${API}/post/publish/status/fetch/`, { method: "POST", headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify({ publish_id }) });
    const st = String(s.data?.status ?? "");
    if (st === "SEND_TO_USER_INBOX" || st === "PUBLISH_COMPLETE") break;
    if (st === "FAILED") throw new ApiError(`TikTok couldn't take the video: ${s.data?.fail_reason ?? "no reason given"}`);
    await sleep(waitMs);
  }
  return { status: "draft", remoteId: String(publish_id), note: "in your TikTok inbox: open TikTok, add the song (volume 0), paste the caption, post" };
}
