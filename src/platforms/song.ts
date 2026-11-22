// Picking the right song out of a platform's search results. Pure, so it's tested on its own.
// A wrong song is worse than no song (it credits the wrong artist), so a result is only taken
// when its title matches and, when the person gave an artist, its artist does too.

export interface SongResult { title: string; artist: string; }

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The index of the best match, or -1. An exact title beats one that only contains it
 *  ("The Final Countdown" over "The Final Countdown 2025"); "original sound" uploads by other
 *  people are never taken, since they aren't the artist's own recording. */
export function pickSong(results: SongResult[], title: string, artist: string): number {
  const t = norm(title), a = norm(artist);
  if (!t) return -1;
  let best = -1, bestScore = 0;
  results.forEach((r, i) => {
    const rt = norm(r.title), ra = norm(r.artist);
    if (!rt || /^original sound\b/.test(rt)) return;
    if (a && !(ra.includes(a) || a.includes(ra) && ra.length >= 3)) return;
    const score = rt === t ? 3 : rt.startsWith(t) ? 2 : rt.includes(t) ? 1 : 0;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}

/** TikTok lists a result as "The Final Countdown" over "01:00 · Europe". */
export function tiktokResult(text: string): SongResult {
  const [title = "", sub = ""] = text.split("\n").map((s) => s.trim()).filter(Boolean);
  const artist = sub.includes("·") ? sub.slice(sub.indexOf("·") + 1).trim() : sub;
  return { title, artist };
}
