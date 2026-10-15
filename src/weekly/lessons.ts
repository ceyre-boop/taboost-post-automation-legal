// Teaching-video source data. Each lesson is distilled from a public creator-
// education video (e.g. a TikTok Creator Academy spotlight) into the handful of
// points worth teaching, then poured into the CreatorTip Remotion template the
// same way products are poured into ProductSpot.
//
// Rule: a lesson states only what the source actually teaches, in our own words.
// We never put words in the original creator's mouth or invent numbers.

export interface Tip {
  title: string;
  body: string;
}

export interface Lesson {
  /** stable slug, used for dedup + the job id */
  id: string;
  /** who/where it came from, shown on the hook card and credited in the caption */
  source: string;
  /** the source video (for our records / the caption credit) */
  sourceUrl: string;
  /** one-line thesis on the opening card */
  hook: string;
  /** the numbered lessons, shown one full card at a time */
  tips: Tip[];
  /** closing line */
  cta: string;
  ctaSub: string;
  /** hashtags appended to the caption (without the leading #) */
  tags: string[];
}

export const LESSONS: Lesson[] = [
  {
    id: "ugolord-build-your-brand",
    source: "Ugo Lord · TikTok Creator Academy",
    sourceUrl: "https://www.tiktok.com/@creatoracademy/video/7447256483605105938",
    hook: "You don't go viral by making videos. You build a brand.",
    tips: [
      {
        title: "Pick a lane",
        body: "If someone can't describe you in one sentence, the algorithm can't either.",
      },
      {
        title: "Show up on a schedule",
        body: "Consistency is the only growth signal you fully control.",
      },
      {
        title: "Be a person, not a logo",
        body: "People follow people. Your face and your voice are the brand.",
      },
      {
        title: "Treat it like a job",
        body: "The pros are just amateurs who refused to quit.",
      },
    ],
    cta: "I build the creator tools — and I give them away.",
    ctaSub: "Follow @taboost.colin",
    tags: ["creatortips", "tiktokgrowth", "buildinpublic", "creatoreconomy", "TABOOST"],
  },
];

export function getLesson(id: string): Lesson | undefined {
  return LESSONS.find((l) => l.id === id);
}

/** The next lesson not yet featured (featured ids come from the weekly store). */
export function pickLesson(exclude: Set<string>): Lesson | undefined {
  return LESSONS.find((l) => !exclude.has(l.id));
}

/** The TikTok caption for a teaching video. Editable by Colin before approval. */
export function draftLessonCaption(l: Lesson): string {
  const points = l.tips.map((t) => `• ${t.title}`).join("\n");
  const tags = l.tags.map((t) => "#" + t).join(" ");
  return [
    `${l.hook}`,
    ``,
    `Distilled from ${l.source}:`,
    points,
    ``,
    `I'm a developer — I build the tools creators pay for, and I'm handing them out here for free. Follow along.`,
    ``,
    `👉 @taboost.colin`,
    tags,
  ].join("\n");
}
