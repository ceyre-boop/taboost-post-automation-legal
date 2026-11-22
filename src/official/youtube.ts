// YouTube: the official upload (Data API v3, resumable). Uploads count against a cheap daily quota;
// a private test uploads as private, for Skyler to watch and delete.
import { statSync } from "node:fs";
import { api, ApiError, rawFetch, readChunk, redact } from "./http.ts";
import type { Log, OfficialPost, OfficialResult, Tokens, WhoAmI } from "./types.ts";
import { youtubeParts } from "../platforms/caption.ts";

const CHUNK = 32 * 256 * 1024; // 8 MiB: chunks must be multiples of 256 KiB

export async function youtubeWho(t: Tokens): Promise<WhoAmI> {
  const r = await api<any>("YouTube", "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { authorization: `Bearer ${t.access_token}` } });
  const ch = (r.items ?? []).map((c: any) => ({ id: String(c.id), name: String(c.snippet?.title ?? "My channel"), kind: "channel" as const, via: "official" as const }));
  if (!ch.length) throw new ApiError("YouTube: this Google account has no YouTube channel yet. Make one in the YouTube app, then connect again.");
  return { account: ch[0].name, identities: { youtube: ch } };
}

export async function youtubePost(t: Tokens, p: OfficialPost, log: Log, clicked: () => void): Promise<OfficialResult> {
  const parts = youtubeParts(p.caption);
  const title = (p.title?.trim() || parts.title).slice(0, 100);
  const privacy = p.test ? "private" : process.env.POSTER_YT_VISIBILITY || "public";
  if (!p.live) { log(`Would upload to YouTube as "${title}" (${privacy}).`); return { status: "skipped", note: "preview: nothing uploaded" }; }
  const size = statSync(p.file).size;
  const init = await rawFetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json; charset=UTF-8", "x-upload-content-length": String(size), "x-upload-content-type": "video/*" },
    body: JSON.stringify({ snippet: { title, description: parts.description, categoryId: "10" }, status: { privacyStatus: privacy, selfDeclaredMadeForKids: false } }),
  });
  const session = init.headers.get("location");
  if (!init.ok || !session) throw new ApiError(`YouTube: couldn't start the upload (${init.status} ${redact((await init.text()).slice(0, 200))})`, init.status);
  log(`Uploading to YouTube (${Math.round(size / 1048576)} MB, ${privacy})…`);
  for (let offset = 0; offset < size;) {
    const end = Math.min(size, offset + CHUNK) - 1;
    if (end === size - 1) clicked(); // the last piece publishes it
    const r = await rawFetch(session, { method: "PUT", headers: { "content-length": String(end - offset + 1), "content-range": `bytes ${offset}-${end}/${size}` }, body: await readChunk(p.file, offset, end - offset + 1) });
    if (r.status === 308) { const range = r.headers.get("range"); offset = range ? Number(range.split("-")[1]) + 1 : end + 1; continue; }
    if (r.status === 200 || r.status === 201) {
      const j = (await r.json()) as { id: string };
      return { status: "done", remoteId: j.id, link: `https://youtube.com/shorts/${j.id}`, note: p.test ? "uploaded as private (a test): watch it, then delete it in YouTube" : undefined };
    }
    throw new ApiError(`YouTube: upload failed (${r.status} ${redact((await r.text()).slice(0, 200))})`, r.status);
  }
  throw new ApiError("YouTube: the upload ended without an answer");
}
