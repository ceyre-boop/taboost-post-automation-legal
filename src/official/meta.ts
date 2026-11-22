// Facebook Pages and Instagram (professional accounts), through one Meta sign-in.
//   Facebook Page: a Reel (3-90 s) or, when longer, a Page video. A private test leaves a draft.
//   Instagram: a Reel through the resumable upload; optionally a song from Instagram's own catalog
//   attached at the lowest volume Instagram allows (1%), so only her own sound is heard.
// A personal Facebook profile has no official posting at all (Meta removed it in 2018): it stays on
// the Mac's browser. So does a personal (non-professional) Instagram account.
import { statSync } from "node:fs";
import { api, ApiError, form, rawFetch, readChunk, redact } from "./http.ts";
import type { Log, OfficialPost, OfficialResult, Tokens, WhoAmI } from "./types.ts";
import type { Identity } from "./connections.ts";

export const GRAPH = "https://graph.facebook.com/v27.0";
const RUPLOAD = "https://rupload.facebook.com";
const CHUNK = 32 * 1024 * 1024;
export const BROWSER_PROFILE: Identity = { id: "profile", name: "My profile (the Mac's browser)", kind: "profile", via: "browser" };
export const BROWSER_IG: Identity = { id: "browser", name: "Personal account (the Mac's browser)", kind: "profile", via: "browser" };

export async function metaWho(t: Tokens): Promise<WhoAmI> {
  const me = await api<any>("Facebook", `${GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(t.access_token)}`);
  const acc = await api<any>("Facebook", `${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=100&access_token=${encodeURIComponent(t.access_token)}`);
  const pages: Record<string, string> = {}, igPage: Record<string, string> = {};
  const fb: Identity[] = [], ig: Identity[] = [];
  for (const p of acc.data ?? []) {
    pages[p.id] = p.access_token;
    fb.push({ id: String(p.id), name: String(p.name), kind: "page", via: "official" });
    const i = p.instagram_business_account;
    if (i?.id) { igPage[i.id] = p.id; ig.push({ id: String(i.id), name: `@${i.username ?? i.id}`, kind: "ig", via: "official" }); }
  }
  return { account: String(me.name ?? "Facebook"), identities: { facebook: [...fb, BROWSER_PROFILE], instagram: [...ig, BROWSER_IG] }, tokens: { pages, ig_page: igPage, user_id: String(me.id) } };
}

/** Send the file to rupload in pieces (each piece says where it starts). */
async function rupload(url: string, token: string, file: string, size: number, log: Log): Promise<void> {
  for (let offset = 0; offset < size; offset += CHUNK) {
    const len = Math.min(CHUNK, size - offset);
    const r = await rawFetch(url, { method: "POST", headers: { authorization: `OAuth ${token}`, offset: String(offset), file_size: String(size), "content-length": String(len) }, body: await readChunk(file, offset, len) });
    if (!r.ok) throw new ApiError(`upload failed (${r.status} ${redact((await r.text()).slice(0, 200))})`, r.status);
    if (size > CHUNK) log(`  ${Math.min(100, Math.round(((offset + len) / size) * 100))}% uploaded`);
  }
}

export async function facebookPost(t: Tokens, p: OfficialPost, log: Log, clicked: () => void): Promise<OfficialResult> {
  const token = t.pages?.[p.identity];
  if (!token) throw new ApiError("Facebook: that Page isn't connected any more. Connect Facebook again.");
  const state = p.test ? "DRAFT" : "PUBLISHED";
  const long = (p.duration ?? 0) > 90;
  if (!p.live) { log(`Would post to the Page as a ${long ? "video" : "Reel"} (${state.toLowerCase()}).`); return { status: "skipped", note: "preview: nothing uploaded" }; }
  const size = statSync(p.file).size;
  if (!long) {
    const start = await api<any>("Facebook", `${GRAPH}/${p.identity}/video_reels`, { method: "POST", body: form({ upload_phase: "start", access_token: token }) });
    log(`Uploading the Reel to the Page (${Math.round(size / 1048576)} MB)…`);
    await rupload(start.upload_url ?? `${RUPLOAD}/video-upload/v27.0/${start.video_id}`, token, p.file, size, log).catch((e) => { throw new ApiError(`Facebook: ${(e as Error).message}`); });
    clicked();
    await api("Facebook", `${GRAPH}/${p.identity}/video_reels`, { method: "POST", body: form({ upload_phase: "finish", video_id: start.video_id, video_state: state, description: p.caption, access_token: token }) });
    return { status: p.test ? "draft" : "done", remoteId: String(start.video_id), link: `https://www.facebook.com/reel/${start.video_id}`, note: p.test ? "saved as a draft on the Page (a test)" : undefined };
  }
  /* Longer than a Reel allows: a normal Page video, sent in pieces. */
  const base = `https://graph-video.facebook.com/v27.0/${p.identity}/videos`;
  let s = await api<any>("Facebook", base, { method: "POST", body: form({ upload_phase: "start", file_size: size, access_token: token }) });
  log(`Uploading the video to the Page (${Math.round(size / 1048576)} MB; over 90 s, so a Page video, not a Reel)…`);
  while (Number(s.start_offset) < Number(s.end_offset)) {
    const a = Number(s.start_offset), len = Number(s.end_offset) - a;
    const body = new FormData();
    body.set("upload_phase", "transfer"); body.set("upload_session_id", s.upload_session_id ?? s.upload_session); body.set("start_offset", String(a)); body.set("access_token", token);
    body.set("video_file_chunk", new Blob([await readChunk(p.file, a, len)]), "chunk");
    const next = await api<any>("Facebook", base, { method: "POST", body });
    s = { ...s, ...next };
  }
  clicked();
  await api("Facebook", base, { method: "POST", body: form({ upload_phase: "finish", upload_session_id: s.upload_session_id, description: p.caption, published: !p.test, access_token: token }) });
  return { status: p.test ? "draft" : "done", remoteId: String(s.video_id ?? ""), link: s.video_id ? `https://www.facebook.com/watch/?v=${s.video_id}` : undefined };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function instagramPost(t: Tokens, p: OfficialPost, log: Log, clicked: () => void, waitMs = 5000): Promise<OfficialResult> {
  if (p.test) return { status: "skipped", note: "Instagram has no drafts, so a private test skips it" };
  if (!t.ig_page?.[p.identity]) throw new ApiError("Instagram: that account isn't connected any more. Connect Instagram again (it must be a Creator or Business account linked to a Facebook Page).");
  const audio = p.song?.igAudioId ? { audio_configuration: JSON.stringify({ audio_id: p.song.igAudioId, audio_volume: 1, video_volume: 100 }) } : {};
  if (!p.live) { log(`Would post a Reel to Instagram${p.song?.igAudioId ? " with the song at 1%" : ""}.`); return { status: "skipped", note: "preview: nothing uploaded" }; }
  const size = statSync(p.file).size;
  const c = await api<any>("Instagram", `${GRAPH}/${p.identity}/media`, { method: "POST", body: form({ media_type: "REELS", upload_type: "resumable", caption: p.caption, share_to_feed: true, ...audio, access_token: t.access_token }) });
  log(`Uploading the Reel to Instagram (${Math.round(size / 1048576)} MB)…`);
  await rupload(c.uri ?? `${RUPLOAD}/ig-api-upload/v27.0/${c.id}`, t.access_token, p.file, size, log).catch((e) => { throw new ApiError(`Instagram: ${(e as Error).message}`); });
  for (let i = 0; ; i++) {
    const s = await api<any>("Instagram", `${GRAPH}/${c.id}?fields=status_code,status&access_token=${encodeURIComponent(t.access_token)}`);
    if (s.status_code === "FINISHED") break;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new ApiError(`Instagram couldn't process the video: ${s.status ?? s.status_code}`);
    if (i > 120) throw new ApiError("Instagram: still processing after 10 minutes");
    if (i % 6 === 0) log("  Instagram is processing it…");
    await sleep(waitMs);
  }
  clicked();
  const pub = await api<any>("Instagram", `${GRAPH}/${p.identity}/media_publish`, { method: "POST", body: form({ creation_id: c.id, access_token: t.access_token }) });
  const info = await api<any>("Instagram", `${GRAPH}/${pub.id}?fields=permalink&access_token=${encodeURIComponent(t.access_token)}`).catch(() => ({}));
  return { status: "done", remoteId: String(pub.id), link: info.permalink, note: p.song?.igAudioId ? `song attached at 1% volume` : undefined };
}

/** Songs Instagram lets apps attach (only ones cleared for third-party use). */
export async function instagramSongs(t: Tokens, igId: string, q: string): Promise<{ id: string; title: string; artist: string; seconds?: number }[]> {
  const r = await api<any>("Instagram", `${GRAPH}/ig_audio?audio_type=music&user_id=${encodeURIComponent(igId)}&search_query=${encodeURIComponent(q.slice(0, 80))}&access_token=${encodeURIComponent(t.access_token)}`);
  return (r.data ?? []).slice(0, 15).map((a: any) => ({ id: String(a.id ?? a.audio_id), title: String(a.title ?? a.name ?? ""), artist: String(a.artist_name ?? a.display_artist ?? a.artist ?? ""), seconds: a.duration_in_ms ? Math.round(a.duration_in_ms / 1000) : a.duration ? Number(a.duration) : undefined })).filter((a: { id: string }) => a.id && a.id !== "undefined");
}
