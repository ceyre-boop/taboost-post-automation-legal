// The kinds of post the maker can make. Each one has its own on-screen layout (render.html),
// its own rules for the script (checks.ts), and a line telling the AI what it is.
//
// Six are built from the person's photos (and their clips, used as moving backgrounds);
// "clip" finishes one of their own videos: a title, captions, music and an end card.

export type Format = "tips" | "steps" | "mythfact" | "problemfix" | "question" | "number" | "clip";

export interface FormatSpec {
  id: Format;
  label: string;
  /** For the ideas prompt: what this kind of post is. */
  idea: string;
  /** For the script prompt: what to write, card by card. */
  write: string;
  hookWords: number;
  points: { min: number; max: number };
  pointWords: number;
}

export const FORMATS: Record<Format, FormatSpec> = {
  tips: {
    id: "tips", label: "Quick tips",
    idea: "2 or 3 quick tips or things worth knowing",
    write: "points: 2 or 3 quick tips, each one short line.",
    hookWords: 6, points: { min: 1, max: 3 }, pointWords: 14,
  },
  steps: {
    id: "steps", label: "1-2-3 steps",
    idea: "how something works or gets done, in 3 or 4 steps",
    write: "points: 3 or 4 steps in order, each starting with a verb.",
    hookWords: 6, points: { min: 3, max: 4 }, pointWords: 12,
  },
  mythfact: {
    id: "mythfact", label: "Myth vs fact",
    idea: "something customers often believe that isn't true, and the truth (the truth must come from a fact)",
    write: "points: exactly 2. First the myth, said the way a customer would say it. Then the fact that corrects it, from the business's facts.",
    hookWords: 6, points: { min: 2, max: 2 }, pointWords: 14,
  },
  problemfix: {
    id: "problemfix", label: "Problem and fix",
    idea: "a problem customers run into, and how the business fixes it",
    write: "points: exactly 2. First the problem, the way the customer feels it. Then how the business fixes it.",
    hookWords: 6, points: { min: 2, max: 2 }, pointWords: 14,
  },
  question: {
    id: "question", label: "A question people ask",
    idea: "a question customers often ask, answered in a line or two",
    write: "hook: the question, the way a customer would ask it, ending with a question mark. points: 1 to 3 short lines that answer it.",
    hookWords: 12, points: { min: 1, max: 3 }, pointWords: 14,
  },
  number: {
    id: "number", label: "One number",
    idea: "one number from a fact, shown huge, and what it means for the customer (only for a fact that has a number in it)",
    write: "stat: the number exactly as the fact writes it (for example 412, 4.9 or 15%). hook: what the number counts, shown under it. points: 1 or 2 lines on why it matters to the customer.",
    hookWords: 6, points: { min: 1, max: 2 }, pointWords: 14,
  },
  clip: {
    id: "clip", label: "Your clip",
    idea: "the person's own video, finished with a title, captions and music",
    write: "hook: a title shown over the clip the whole time. points: 1 to 3 short captions shown one after another while the clip plays, in the order things happen in it.",
    hookWords: 8, points: { min: 1, max: 3 }, pointWords: 10,
  },
};

/** The formats built from photos, in the order the ideas prompt lists them. */
export const PHOTO_FORMATS: Format[] = ["tips", "steps", "mythfact", "problemfix", "question", "number"];

export const isFormat = (v: unknown): v is Format => typeof v === "string" && v in FORMATS;

/** Pick `n` ideas from `pool`: as many different formats and different facts as possible,
 *  keeping the pool's order otherwise, so a week doesn't look or say the same thing twice. */
export function varied<T extends { format?: Format; fact?: number }>(pool: T[], n: number): T[] {
  const out: T[] = [];
  const fmt = (i: T) => i.format ?? "tips";
  const take = (ok: (i: T) => boolean) => { for (const i of pool) if (out.length < n && !out.includes(i) && ok(i)) out.push(i); };
  take((i) => !out.some((o) => fmt(o) === fmt(i)) && !out.some((o) => o.fact === i.fact));
  take((i) => !out.some((o) => fmt(o) === fmt(i)));
  take((i) => !out.some((o) => o.fact === i.fact));
  take(() => true);
  return out;
}
