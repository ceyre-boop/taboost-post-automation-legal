// "Too close to something already posted": same source fact, or word overlap
// above a threshold. Deliberately simple and explainable.
const STOP = new Set("a an and are as at be but by for from has have how i in is it its of on or so that the this to was what when why with you your".split(" "));

export function words(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9%$ ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));
}

export function jaccard(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export const TOO_CLOSE = 0.5;

/** Returns why `cand` is too close to one of `prior`, or null if it's fresh. */
export function tooClose(
  cand: { factId: string; title: string },
  prior: { factId: string; title: string }[],
): string | null {
  for (const p of prior) {
    if (p.factId === cand.factId) return `same source fact as "${p.title}"`;
    const s = jaccard(cand.title, p.title);
    if (s >= TOO_CLOSE) return `${Math.round(s * 100)}% word overlap with "${p.title}"`;
  }
  return null;
}
