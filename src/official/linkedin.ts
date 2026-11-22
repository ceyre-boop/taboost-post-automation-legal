// LinkedIn (optional): a post on her own profile with the video, through the official Videos and
// Posts APIs. Tokens last about 60 days; the poster says when to connect again.
import { statSync } from "node:fs";
import { api, ApiError, rawFetch, readChunk, redact } from "./http.ts";
import type { Log, OfficialPost, OfficialResult, Tokens, WhoAmI } from "./types.ts";

const REST = "https://api.linkedin.com/rest";
const VERSION = process.env.LINKEDIN_VERSION || "202510";
const h = (t: Tokens) => ({ authorization: `Bearer ${t.access_token}`, "linkedin-version": VERSION, "x-restli-protocol-version": "2.0.0", "content-type": "application/json" });

export async function linkedinWho(t: Tokens): Promise<WhoAmI> {
  const me = await api<any>("LinkedIn", "https://api.linkedin.com/v2/userinfo", { headers: { authorization: `Bearer ${t.access_token}` } });
  const name = String(me.name ?? "LinkedIn");
  return { account: name, identities: { linkedin: [{ id: String(me.sub), name, kind: "member", via: "official" }] }, tokens: { user_id: String(me.sub) } };
}

export async function linkedinPost(t: Tokens, p: OfficialPost, log: Log, clicked: () => void): Promise<OfficialResult> {
  if (p.test) return { status: "skipped", note: "LinkedIn has no drafts, so a private test skips it" };
  if (!p.live) { log("Would post the video to your LinkedIn profile."); return { status: "skipped", note: "preview: nothing uploaded" }; }
  const owner = `urn:li:person:${t.user_id ?? p.identity}`;
  const size = statSync(p.file).size;
  const init = await api<any>("LinkedIn", `${REST}/videos?action=initializeUpload`, { method: "POST", headers: h(t), body: JSON.stringify({ initializeUploadRequest: { owner, fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false } }) });
  const v = init.value ?? {};
  const etags: string[] = [];
  log(`Uploading to LinkedIn (${Math.round(size / 1048576)} MB)…`);
  for (const ins of v.uploadInstructions ?? []) {
    const a = Number(ins.firstByte), b = Number(ins.lastByte);
    const r = await rawFetch(ins.uploadUrl, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: await readChunk(p.file, a, b - a + 1) });
    if (!r.ok) throw new ApiError(`LinkedIn: upload failed (${r.status} ${redact((await r.text()).slice(0, 200))})`, r.status);
    etags.push(String(r.headers.get("etag") ?? ""));
  }
  await api("LinkedIn", `${REST}/videos?action=finalizeUpload`, { method: "POST", headers: h(t), body: JSON.stringify({ finalizeUploadRequest: { video: v.video, uploadToken: v.uploadToken ?? "", uploadedPartIds: etags } }) });
  clicked();
  const r = await rawFetch(`${REST}/posts`, { method: "POST", headers: h(t), body: JSON.stringify({ author: owner, commentary: p.caption, visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] }, content: { media: { id: v.video } }, lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false }) });
  if (!r.ok) throw new ApiError(`LinkedIn: couldn't publish (${r.status} ${redact((await r.text()).slice(0, 200))})`, r.status);
  const id = r.headers.get("x-restli-id") ?? "";
  return { status: "done", remoteId: id, link: id ? `https://www.linkedin.com/feed/update/${id}` : undefined };
}
