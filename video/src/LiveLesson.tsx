import React from "react";
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";

const { fontFamily } = loadFont();

// Genie-brand palette (black mark on hot pink).
const PINK = "#FF0059";
const PINK_DEEP = "#B80040";
const INK = "#0E1414";
const PAPER = "#FFFFFF";
const POP = "#FFC247";
const POP_INK = "#3A2A00";
const MUTED_DARK = "rgba(255,255,255,0.74)";
const MUTED_LIGHT = "rgba(14,20,20,0.62)";

// ---- Timing (30fps) ---------------------------------------------------------
export const HOOK_FRAMES = 78; // ~2.6s
export const PER_POINT_FRAMES = 90; // ~3.0s each
export const TAKEAWAY_FRAMES = 96; // ~3.2s

export type Point = { label: string; body: string };

export type LiveLessonProps = {
  /** small uppercase category, e.g. "TIKTOK LIVE · THE MONEY" */
  tag: string;
  /** the myth/question headline */
  hook: string;
  /** teaching beats, shown one card at a time (basic -> advanced) */
  points: Point[];
  /** the one-line "so what" */
  takeaway: string;
  handle: string;
};

export const liveLessonDuration = (points: Point[]): number =>
  HOOK_FRAMES + Math.max(points.length, 1) * PER_POINT_FRAMES + TAKEAWAY_FRAMES;

const fadeUp = (frame: number, start: number, dur = 16) => ({
  opacity: interpolate(frame, [start, start + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
  transform: `translateY(${interpolate(frame, [start, start + dur], [34, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}px)`,
});

// The genie mark, framed as a rounded badge so it reads on any background.
const Genie: React.FC<{ size?: number }> = ({ size = 220 }) => (
  <Img
    src={staticFile("taboost-genie.jpg")}
    style={{
      width: size,
      height: size,
      borderRadius: size * 0.26,
      boxShadow: "0 18px 50px rgba(0,0,0,0.28)",
      objectFit: "cover",
    }}
  />
);

const Dots: React.FC<{ count: number; active: number; dark: boolean }> = ({ count, active, dark }) => (
  <div style={{ display: "flex", gap: 14, marginTop: "auto" }}>
    {Array.from({ length: count }).map((_, i) => (
      <span key={i} style={{
        width: i === active ? 56 : 18, height: 18, borderRadius: 999,
        background: i === active ? POP : dark ? "rgba(255,255,255,0.26)" : "rgba(184,0,64,0.22)",
      }} />
    ))}
  </div>
);

// ---- Scene 1: Hook ----------------------------------------------------------
const Hook: React.FC<{ tag: string; hook: string }> = ({ tag, hook }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 14, mass: 0.7 } });
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${PINK}, ${PINK_DEEP})`, padding: 90, justifyContent: "center", alignItems: "flex-start", gap: 36 }}>
      <div style={{ ...fadeUp(frame, 2), transform: `scale(${0.9 + pop * 0.1})` }}>
        <Genie size={230} />
      </div>
      <div style={{ ...fadeUp(frame, 10), fontFamily, fontWeight: 800, fontSize: 36, color: "rgba(255,255,255,0.9)", letterSpacing: 1.5, textTransform: "uppercase" }}>
        {tag}
      </div>
      <div style={{ ...fadeUp(frame, 20), fontFamily, fontWeight: 900, fontSize: 96, lineHeight: 1.02, color: PAPER, letterSpacing: -2.5 }}>
        {hook}
      </div>
    </AbsoluteFill>
  );
};

// ---- Scene 2: one teaching card --------------------------------------------
const PointCard: React.FC<{ point: Point; index: number; total: number }> = ({ point, index, total }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const dark = index % 2 === 1;
  const numIn = spring({ frame, fps, config: { damping: 16, mass: 0.8 } });
  const bg = dark ? INK : PAPER;
  const ink = dark ? PAPER : INK;
  const muted = dark ? MUTED_DARK : MUTED_LIGHT;
  return (
    <AbsoluteFill style={{ background: bg, padding: 90, gap: 30, justifyContent: "center" }}>
      <div style={{ position: "absolute", top: 72, right: 90, ...fadeUp(frame, 0) }}>
        <Genie size={96} />
      </div>
      <div style={{ fontFamily, fontWeight: 900, fontSize: 140, lineHeight: 1, color: PINK, letterSpacing: -4, transform: `translateX(${(1 - numIn) * -40}px)`, opacity: numIn }}>
        {String(index + 1).padStart(2, "0")}
      </div>
      <div style={{ ...fadeUp(frame, 10), fontFamily, fontWeight: 900, fontSize: 86, lineHeight: 1.03, color: ink, letterSpacing: -2 }}>
        {point.label}
      </div>
      <div style={{ ...fadeUp(frame, 22), fontFamily, fontWeight: 600, fontSize: 52, lineHeight: 1.22, color: muted, maxWidth: 900 }}>
        {point.body}
      </div>
      <Dots count={total} active={index} dark={dark} />
    </AbsoluteFill>
  );
};

// ---- Scene 3: Takeaway ------------------------------------------------------
const Takeaway: React.FC<{ takeaway: string; handle: string }> = ({ takeaway, handle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 13, mass: 0.6 } });
  return (
    <AbsoluteFill style={{ background: `linear-gradient(200deg, ${PINK_DEEP}, ${INK})`, padding: 90, justifyContent: "center", alignItems: "flex-start", gap: 36 }}>
      <div style={{ ...fadeUp(frame, 2), transform: `scale(${0.9 + pop * 0.1})` }}>
        <Genie size={230} />
      </div>
      <div style={{ ...fadeUp(frame, 10), fontFamily, fontWeight: 900, fontSize: 88, lineHeight: 1.05, color: PAPER, letterSpacing: -2 }}>
        {takeaway}
      </div>
      <div style={{ ...fadeUp(frame, 22), fontFamily, fontWeight: 800, fontSize: 44, color: POP_INK, background: POP, padding: "22px 40px", borderRadius: 999 }}>
        Follow {handle}
      </div>
    </AbsoluteFill>
  );
};

export const LiveLesson: React.FC<LiveLessonProps> = (props) => {
  const points = props.points.length ? props.points : [{ label: "No points", body: "" }];
  return (
    <AbsoluteFill style={{ background: INK }}>
      <Sequence durationInFrames={HOOK_FRAMES + 2}>
        <Hook tag={props.tag} hook={props.hook} />
      </Sequence>
      {points.map((point, i) => (
        <Sequence key={i} from={HOOK_FRAMES + i * PER_POINT_FRAMES} durationInFrames={PER_POINT_FRAMES + 2}>
          <PointCard point={point} index={i} total={points.length} />
        </Sequence>
      ))}
      <Sequence from={HOOK_FRAMES + points.length * PER_POINT_FRAMES} durationInFrames={TAKEAWAY_FRAMES}>
        <Takeaway takeaway={props.takeaway} handle={props.handle} />
      </Sequence>
    </AbsoluteFill>
  );
};

export const defaultLiveLessonProps: LiveLessonProps = {
  tag: "TIKTOK LIVE · THE MONEY",
  hook: "Coins, Diamonds and cash are not the same thing.",
  points: [
    { label: "Coins", body: "Viewers buy Coins to send you Gifts during a LIVE." },
    { label: "Diamonds", body: "TikTok's separate reward metric, earned from eligible Gifts." },
    { label: "The trap", body: "There's no fixed Diamond-to-dollar rate. Check your own LIVE rewards balance." },
  ],
  takeaway: "Know what you're actually earning.",
  handle: "@taboost.colin",
};
