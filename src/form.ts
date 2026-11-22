// What the Mac's upload form asks for, turned into the clips a batch posts. Kept apart from the
// server so the rules (which caption goes where) are tested on their own.
//
//   caption                  the shared caption
//   caption<i>               clip i's own caption (i is the clip's place in the form)
//   caption@<platform>       one platform's own caption, for every clip ("change it for each platform")
//   caption<i>@<platform>    clip i's caption on one platform
//   song_title, song_artist  the song, once; song@<platform>=on adds the credit line there
//                            (the same line the phone's song card adds: withSongCredit)
//   songlib@<platform>=on    add the song from that platform's own library on its website (TikTok)
//   song_mute=on             ...at 0%, so only the video's own sound is heard
import type { UploadedFile } from "./multipart.ts";
import { withSongCredit } from "./platforms/caption.ts";

export interface FormVideo { path: string; caption?: string; captions?: Record<string, string>; }

const one = (form: Map<string, string[]>, k: string): string | null => form.get(k)?.[0] ?? null;
const clean = (v: string | null, max: number) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function videosFromForm(form: Map<string, string[]>, files: UploadedFile[], platformIds: string[]): FormVideo[] {
  const shared = (one(form, "caption") ?? "").trim();
  const title = clean(one(form, "song_title"), 120);
  const credited = platformIds.filter((id) => one(form, `song@${id}`) === "on");
  const song = title ? { title, artist: clean(one(form, "song_artist"), 120), credit: Object.fromEntries(platformIds.map((id) => [id, credited.includes(id)])) } : null;
  const out: FormVideo[] = [];
  for (const f of files) {
    if (!f.path || f.size === 0) continue; // the index stays the page's own, so captions stay aligned
    const per = (one(form, `caption${f.index}`) ?? "").trim();
    const base = per || shared;
    const captions: Record<string, string> = {};
    for (const id of platformIds) {
      const own = (one(form, `caption${f.index}@${id}`) ?? one(form, `caption@${id}`) ?? "").trim();
      let text = own || base;
      if (song && credited.includes(id)) text = withSongCredit(text, id, song);
      if (text !== base) captions[id] = text;
    }
    out.push({ path: f.path, caption: per || undefined, ...(Object.keys(captions).length ? { captions } : {}) });
  }
  return out;
}

/** The song to add from the platforms' own libraries on their websites (TikTok Studio can). */
export function songFromForm(form: Map<string, string[]>, platformIds: string[]): { title: string; artist: string; mute: boolean; platforms: string[] } | undefined {
  const title = clean(one(form, "song_title"), 120);
  const platforms = platformIds.filter((id) => one(form, `songlib@${id}`) === "on");
  if (!title || !platforms.length) return undefined;
  return { title, artist: clean(one(form, "song_artist"), 120), mute: one(form, "song_mute") === "on", platforms };
}
