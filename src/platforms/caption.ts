/** Caption helpers shared by the platform adapters. All pure except typeCaption. */

const URL_RE = /^https?:\/\/[^\s]+/i;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** X counts these ranges as 1, everything else (including emoji, CJK) as 2. */
function cpWeight(cp: number): number {
  if (cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247)) return 1;
  return 2;
}

/** Split into units that must never be broken apart: whole URLs, then grapheme clusters. */
function units(text: string): { s: string; w: number }[] {
  const out: { s: string; w: number }[] = [];
  let i = 0;
  while (i < text.length) {
    const url = (i === 0 || /\s/.test(text[i - 1])) ? URL_RE.exec(text.slice(i)) : null;
    if (url) {
      out.push({ s: url[0], w: 23 });
      i += url[0].length;
      continue;
    }
    // Take one grapheme, but stop before a URL start.
    const rest = text.slice(i);
    const seg = segmenter.segment(rest)[Symbol.iterator]().next().value!.segment;
    const cps = Array.from(seg);
    const w = cps.length > 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(seg)
      ? 2
      : cps.reduce((a, c) => a + cpWeight(c.codePointAt(0)!), 0);
    out.push({ s: seg, w });
    i += seg.length;
  }
  return out;
}

/** Length of a text the way X counts it. */
export function xWeight(text: string): number {
  return units(text).reduce((a, u) => a + u.w, 0);
}

function cutToBudget(text: string, budget: number): string {
  let used = 0;
  let out = "";
  for (const u of units(text)) {
    if (used + u.w > budget) {
      // Back up to a word boundary when we cut mid-word.
      if (!/\s$/.test(out) && !/^\s/.test(u.s)) {
        const m = /\s\S*$/.exec(out);
        if (m && m.index > 0) out = out.slice(0, m.index);
      }
      return out.trimEnd();
    }
    used += u.w;
    out += u.s;
  }
  return out;
}

/** Fit a caption into X's limit. Trailing hashtags are kept when they fit; the body is cut at a
 *  word boundary and gets an ellipsis. Nothing is changed when it already fits. */
export function fitX(caption: string, limit = 280): { text: string; shortened: boolean } {
  if (xWeight(caption) <= limit) return { text: caption, shortened: false };
  const tailMatch = /(?:\s+#[\p{L}\p{N}_]+)+\s*$/u.exec(caption);
  if (tailMatch && tailMatch.index > 0) {
    const tail = tailMatch[0].trimEnd();
    const body = caption.slice(0, tailMatch.index);
    const budget = limit - xWeight(tail) - xWeight("…");
    if (budget >= 10) {
      const cut = cutToBudget(body, budget);
      if (cut) return { text: cut + "…" + tail, shortened: true };
    }
  }
  return { text: cutToBudget(caption, limit - xWeight("…")) + "…", shortened: true };
}

/** First `max` code points of a string (never splits an emoji / surrogate pair). */
export function cutCodePoints(s: string, max: number): string {
  return Array.from(s).slice(0, max).join("");
}

const TAG_END = /[#@][^\s#@]+$/u;

/** Split a caption into lines, adding a trailing space to a line that ends in a #tag or @mention
 *  so the Enter that follows cannot pick an autocomplete suggestion. */
export function captionLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  return lines.map((l, i) => (i < lines.length - 1 && TAG_END.test(l) ? l + " " : l));
}

export interface KeyboardLike {
  type(text: string, opts?: { delay?: number }): Promise<void>;
  press(key: string): Promise<void>;
}

/** Type a (possibly multi-line) caption: lines typed as text, line breaks as Enter. */
export async function typeCaption(page: { keyboard: KeyboardLike }, text: string, delay: number): Promise<void> {
  const lines = captionLines(text);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.keyboard.type(lines[i], { delay });
    if (i < lines.length - 1) await page.keyboard.press("Enter");
  }
}

/** YouTube rejects < and > in titles and descriptions. */
export function stripAngle(s: string): string {
  return s.replace(/[<>]/g, "");
}

/** Title (first line, max 100 code points) and description (the rest) for YouTube. */
export function youtubeParts(caption: string): { title: string; description: string } {
  const [first, ...rest] = stripAngle(caption).split(/\r?\n/);
  return { title: cutCodePoints((first ?? "").trim(), 100).trim() || "Untitled", description: rest.join("\n") };
}
