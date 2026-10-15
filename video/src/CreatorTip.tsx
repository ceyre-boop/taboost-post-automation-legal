import React from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
import { BRAND } from "./brand";

const { fontFamily } = loadFont();

// ---- Timing (30fps) ---------------------------------------------------------
export const HOOK_FRAMES = 78; // ~2.6s
export const PER_TIP_FRAMES = 96; // ~3.2s each — enough to read a title + line
export const CTA_FRAMES = 108; // ~3.6s

export type Tip = { title: string; body: string };

export type CreatorTipProps = {
  /** who/where the lesson comes from, e.g. "Ugo Lord · TikTok Creator Academy" */
  source: string;
  /** the one-line thesis shown on the opening card */
  hook: string;
  /** the numbered lessons, shown one full card at a time */
  tips: Tip[];
  cta: string;
  ctaSub: string;
  /** optional voiceover in public/, e.g. "voice-20261015.mp3"; empty = silent */
  voiceFile: string;
};

/** Total length is driven by how many tips the lesson has. */
export const creatorTipDuration = (tips: Tip[]): number =>
  HOOK_FRAMES + Math.max(tips.length, 1) * PER_TIP_FRAMES + CTA_FRAMES;

const fadeUp = (frame: number, start: number, dur = 16) => {
  const o = interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(frame, [start, start + dur], [34, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return { opacity: o, transform: `translateY(${y}px)` };
};

const Logo: React.FC<{ size?: number; dark?: boolean }> = ({ size = 48, dark }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 12,
      fontFamily,
      fontWeight: 800,
      fontSize: size,
      letterSpacing: -1.5,
      color: dark ? BRAND.ink : BRAND.paper,
    }}
  >
    <span>TAB</span>
    <span
      style={{
        width: size * 0.62,
        height: size * 0.62,
        borderRadius: "50%",
        background: dark ? BRAND.teal : BRAND.paper,
        display: "inline-block",
      }}
    />
    <span>OST</span>
  </div>
);

const Dots: React.FC<{ count: number; active: number; dark?: boolean }> = ({ count, active, dark }) => (
  <div style={{ display: "flex", gap: 14, marginTop: "auto" }}>
    {Array.from({ length: count }).map((_, i) => (
      <span
        key={i}
        style={{
          width: i === active ? 56 : 18,
          height: 18,
          borderRadius: 999,
          background:
            i === active
              ? BRAND.pop
              : dark
                ? "rgba(255,255,255,0.28)"
                : "rgba(0,112,111,0.22)",
          transition: "none",
        }}
      />
    ))}
  </div>
);

// ---- Scene 1: Hook ----------------------------------------------------------
const Hook: React.FC<{ source: string; hook: string }> = ({ source, hook }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 14, mass: 0.7 } });
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(160deg, ${BRAND.teal}, ${BRAND.tealDeep})`,
        padding: 90,
        justifyContent: "center",
        alignItems: "flex-start",
        gap: 34,
      }}
    >
      <div style={{ ...fadeUp(frame, 2), transform: `scale(${0.9 + pop * 0.1})` }}>
        <Logo />
      </div>
      <div
        style={{
          ...fadeUp(frame, 10),
          fontFamily,
          fontWeight: 700,
          fontSize: 38,
          color: BRAND.mutedOnDark,
          letterSpacing: 0.5,
          textTransform: "uppercase",
        }}
      >
        What I learned from {source}
      </div>
      <div
        style={{
          ...fadeUp(frame, 20),
          fontFamily,
          fontWeight: 800,
          fontSize: 96,
          lineHeight: 1.03,
          color: BRAND.paper,
          letterSpacing: -2,
        }}
      >
        {hook}
      </div>
    </AbsoluteFill>
  );
};

// ---- Scene 2: one lesson card ----------------------------------------------
const TipCard: React.FC<{ tip: Tip; index: number; total: number }> = ({ tip, index, total }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const dark = index % 2 === 1;
  const numIn = spring({ frame, fps, config: { damping: 16, mass: 0.8 } });
  const bg = dark ? BRAND.ink : BRAND.paper;
  const ink = dark ? BRAND.paper : BRAND.ink;
  const muted = dark ? BRAND.mutedOnDark : "rgba(14,20,20,0.64)";
  return (
    <AbsoluteFill style={{ background: bg, padding: 90, gap: 36, justifyContent: "center" }}>
      <div style={{ position: "absolute", top: 72, left: 90, ...fadeUp(frame, 0) }}>
        <Logo dark={!dark} size={36} />
      </div>
      <div
        style={{
          fontFamily,
          fontWeight: 800,
          fontSize: 150,
          lineHeight: 1,
          color: BRAND.teal,
          letterSpacing: -4,
          transform: `translateX(${(1 - numIn) * -40}px)`,
          opacity: numIn,
        }}
      >
        {String(index + 1).padStart(2, "0")}
      </div>
      <div
        style={{
          ...fadeUp(frame, 10),
          fontFamily,
          fontWeight: 800,
          fontSize: 84,
          lineHeight: 1.04,
          color: ink,
          letterSpacing: -2,
        }}
      >
        {tip.title}
      </div>
      <div
        style={{
          ...fadeUp(frame, 22),
          fontFamily,
          fontWeight: 600,
          fontSize: 50,
          lineHeight: 1.22,
          color: muted,
          maxWidth: 880,
        }}
      >
        {tip.body}
      </div>
      <Dots count={total} active={index} dark={dark} />
    </AbsoluteFill>
  );
};

// ---- Scene 3: CTA -----------------------------------------------------------
const Cta: React.FC<{ cta: string; ctaSub: string }> = ({ cta, ctaSub }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 13, mass: 0.6 } });
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(200deg, ${BRAND.tealDark}, ${BRAND.ink})`,
        padding: 90,
        justifyContent: "center",
        alignItems: "flex-start",
        gap: 36,
      }}
    >
      <div style={{ ...fadeUp(frame, 2), transform: `scale(${0.9 + pop * 0.1})` }}>
        <Logo />
      </div>
      <div
        style={{
          ...fadeUp(frame, 10),
          fontFamily,
          fontWeight: 800,
          fontSize: 86,
          lineHeight: 1.04,
          color: BRAND.paper,
          letterSpacing: -2,
        }}
      >
        {cta}
      </div>
      <div
        style={{
          ...fadeUp(frame, 22),
          fontFamily,
          fontWeight: 700,
          fontSize: 44,
          color: BRAND.ink,
          background: BRAND.pop,
          padding: "22px 40px",
          borderRadius: 999,
        }}
      >
        {ctaSub}
      </div>
    </AbsoluteFill>
  );
};

export const CreatorTip: React.FC<CreatorTipProps> = (props) => {
  const tips = props.tips.length ? props.tips : [{ title: "No tips", body: "" }];
  return (
    <AbsoluteFill style={{ background: BRAND.ink }}>
      {props.voiceFile ? <Audio src={staticFile(props.voiceFile)} /> : null}
      <Sequence durationInFrames={HOOK_FRAMES + 2}>
        <Hook source={props.source} hook={props.hook} />
      </Sequence>
      {tips.map((tip, i) => (
        <Sequence
          key={i}
          from={HOOK_FRAMES + i * PER_TIP_FRAMES}
          durationInFrames={PER_TIP_FRAMES + 2}
        >
          <TipCard tip={tip} index={i} total={tips.length} />
        </Sequence>
      ))}
      <Sequence from={HOOK_FRAMES + tips.length * PER_TIP_FRAMES} durationInFrames={CTA_FRAMES}>
        <Cta cta={props.cta} ctaSub={props.ctaSub} />
      </Sequence>
    </AbsoluteFill>
  );
};

export const defaultCreatorTipProps: CreatorTipProps = {
  source: "Ugo Lord · TikTok Creator Academy",
  hook: "You don't go viral by making videos. You build a brand.",
  tips: [
    { title: "Pick a lane", body: "If someone can't describe you in one sentence, the algorithm can't either." },
    { title: "Show up on a schedule", body: "Consistency is the only growth signal you fully control." },
    { title: "Be a person, not a logo", body: "People follow people. Your face and your voice are the brand." },
    { title: "Treat it like a job", body: "The pros are just amateurs who refused to quit." },
  ],
  cta: "I build the creator tools — and I give them away.",
  ctaSub: "Follow @taboost.colin",
  voiceFile: "",
};
