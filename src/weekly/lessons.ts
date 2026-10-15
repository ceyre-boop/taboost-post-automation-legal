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
  {
    id: "playlists-make-videos-bingeable",
    source: "TikTok Creator Academy",
    sourceUrl: "https://www.tiktok.com/@creatoracademy/video/7696884616958938398",
    hook: "One view can become five — if your videos are easy to binge.",
    tips: [
      {
        title: "Group related videos",
        body: "Put a topic's videos in a Playlist so one good one pulls viewers into the rest.",
      },
      {
        title: "Name the series",
        body: "A clear playlist name tells viewers there's more — and gives them a reason to come back.",
      },
      {
        title: "Watch time compounds",
        body: "The easier you make it to keep watching, the more the algorithm shows you.",
      },
    ],
    cta: "I build the creator tools — and I give them away.",
    ctaSub: "Follow @taboost.colin",
    tags: ["creatortips", "tiktokgrowth", "playlists", "watchtime", "TABOOST"],
  },
  {
    id: "posting-routine-that-fits",
    source: "TikTok Creator Academy",
    sourceUrl: "https://www.tiktok.com/@creatoracademy/video/7696652564678331679",
    hook: "The best posting routine is the one that fits your actual life.",
    tips: [
      {
        title: "Collect ideas as they hit",
        body: "Keep a running note so you never start from a blank screen.",
      },
      {
        title: "Batch your filming",
        body: "Shoot several at once — posting is easy when the work is already done.",
      },
      {
        title: "Let TikTok Studio handle timing",
        body: "Schedule ahead and post when your audience is actually online.",
      },
    ],
    cta: "I build the creator tools — and I give them away.",
    ctaSub: "Follow @taboost.colin",
    tags: ["creatortips", "consistency", "tiktokstudio", "contentplanning", "TABOOST"],
  },
  {
    id: "make-every-post-rewards-ready",
    source: "TikTok Creator Academy",
    sourceUrl: "https://www.tiktok.com/@creatoracademy/video/7639053198392593694",
    hook: "Make every post rewards-ready before you hit publish.",
    tips: [
      {
        title: "Go past one minute",
        body: "The Creator Rewards Program only counts original videos longer than a minute.",
      },
      {
        title: "Keep it original and high-quality",
        body: "Reposted or low-effort content doesn't qualify — make something that's yours.",
      },
      {
        title: "Make it a pre-publish check",
        body: "Treat eligibility as a checklist you run every time, not an afterthought.",
      },
    ],
    cta: "I build the creator tools — and I give them away.",
    ctaSub: "Follow @taboost.colin",
    tags: ["creatortips", "creatorrewards", "tiktokmonetization", "getpaid", "TABOOST"],
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
