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

// Genie-brand palette (black mark on hot pink) — matches the app's own theme.
const PINK = "#FF0059";
const PINK_DEEP = "#B80040";
const INK = "#0E1414";
const PAPER = "#FFFFFF";
const POP = "#FFC247";
const POP_INK = "#3A2A00";
const MUTED = "rgba(255,255,255,0.74)";

// ---- Timing (30fps) ---------------------------------------------------------
export const HOOK_FRAMES = 78; // ~2.6s
export const PER_STEP_FRAMES = 102; // ~3.4s each
export const OUTRO_FRAMES = 102; // ~3.4s

export type DemoStep = {
  /** the app screen file in public/shots/ */
  shot: string;
  /** which bottom-nav tab this is */
  nav: string;
  /** big title for the step */
  title: string;
  /** one line of plain explanation */
  body: string;
};

export type BattleDemoProps = {
  steps: DemoStep[];
  url: string;
  handle: string;
};

export const battleDemoDuration = (steps: DemoStep[]): number =>
  HOOK_FRAMES + Math.max(steps.length, 1) * PER_STEP_FRAMES + OUTRO_FRAMES;

const fadeUp = (frame: number, start: number, dur = 16, dy = 34) => ({
  opacity: interpolate(frame, [start, start + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
  transform: `translateY(${interpolate(frame, [start, start + dur], [dy, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}px)`,
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

// A phone showing one real app screenshot, with a soft pink glow.
const Phone: React.FC<{ shot: string; style?: React.CSSProperties }> = ({ shot, style }) => (
  <div
    style={{
      width: 600,
      borderRadius: 46,
      overflow: "hidden",
      border: "3px solid rgba(255,255,255,0.16)",
      boxShadow: "0 36px 90px rgba(0,0,0,0.55), 0 0 70px rgba(255,0,89,0.28)",
      background: INK,
      ...style,
    }}
  >
    <Img src={staticFile(`shots/${shot}`)} style={{ width: "100%", display: "block" }} />
  </div>
);

// ---- Scene 1: Hook ----------------------------------------------------------
const Hook: React.FC<{ url: string }> = ({ url }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 14, mass: 0.7 } });
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${PINK}, ${PINK_DEEP})`, padding: 90, justifyContent: "center", alignItems: "flex-start", gap: 34 }}>
      <div style={{ ...fadeUp(frame, 2), transform: `scale(${0.9 + pop * 0.1})` }}>
        <Genie size={230} />
      </div>
      <div style={{ ...fadeUp(frame, 10), fontFamily, fontWeight: 800, fontSize: 36, color: "rgba(255,255,255,0.9)", letterSpacing: 1.5, textTransform: "uppercase" }}>
        TikTok LIVE · Battles
      </div>
      <div style={{ ...fadeUp(frame, 18), fontFamily, fontWeight: 900, fontSize: 96, lineHeight: 1.02, color: PAPER, letterSpacing: -2.5 }}>
        Stop hunting for battle partners.
      </div>
      <div style={{ ...fadeUp(frame, 30), fontFamily, fontWeight: 700, fontSize: 46, color: "rgba(255,255,255,0.92)", lineHeight: 1.15 }}>
        TABOOST Battles lines them up for you.
      </div>
      <div style={{ ...fadeUp(frame, 42), fontFamily, fontWeight: 800, fontSize: 40, color: POP_INK, background: POP, padding: "18px 34px", borderRadius: 999, marginTop: 10 }}>
        {url}
      </div>
    </AbsoluteFill>
  );
};

// ---- Scene 2: one walkthrough step -----------------------------------------
const StepScene: React.FC<{ step: DemoStep; index: number; total: number }> = ({ step, index, total }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = spring({ frame, fps, config: { damping: 18, mass: 0.9 } });
  return (
    <AbsoluteFill style={{ background: `linear-gradient(200deg, ${PINK_DEEP}, ${INK} 70%)`, padding: "70px 70px 0", alignItems: "center", gap: 20 }}>
      {/* top row: step counter + genie */}
      <div style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", ...fadeUp(frame, 0, 14) }}>
        <div style={{ fontFamily, fontWeight: 900, fontSize: 34, color: INK, background: POP, padding: "12px 26px", borderRadius: 999, letterSpacing: 1 }}>
          STEP {index + 1} / {total}
        </div>
        <Genie size={92} />
      </div>
      {/* nav tag */}
      <div style={{ alignSelf: "flex-start", ...fadeUp(frame, 6, 14), fontFamily, fontWeight: 800, fontSize: 30, color: PINK, letterSpacing: 2, textTransform: "uppercase", marginTop: 6 }}>
        ▸ {step.nav} tab
      </div>
      {/* title */}
      <div style={{ alignSelf: "flex-start", ...fadeUp(frame, 10, 16), fontFamily, fontWeight: 900, fontSize: 70, lineHeight: 1.04, color: PAPER, letterSpacing: -2 }}>
        {step.title}
      </div>
      {/* body */}
      <div style={{ alignSelf: "flex-start", ...fadeUp(frame, 20, 16), fontFamily, fontWeight: 600, fontSize: 42, lineHeight: 1.2, color: MUTED, maxWidth: 900 }}>
        {step.body}
      </div>
      {/* phone */}
      <Phone
        shot={step.shot}
        style={{ marginTop: 18, opacity: rise, transform: `translateY(${(1 - rise) * 70}px) scale(${0.96 + rise * 0.04})` }}
      />
    </AbsoluteFill>
  );
};

// ---- Scene 3: Outro ---------------------------------------------------------
const Outro: React.FC<{ url: string; handle: string }> = ({ url, handle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 13, mass: 0.6 } });
  return (
    <AbsoluteFill style={{ background: `linear-gradient(200deg, ${PINK}, ${PINK_DEEP} 60%, ${INK})`, padding: 90, justifyContent: "center", alignItems: "flex-start", gap: 34 }}>
      <div style={{ ...fadeUp(frame, 2), transform: `scale(${0.9 + pop * 0.1})` }}>
        <Genie size={230} />
      </div>
      <div style={{ ...fadeUp(frame, 10), fontFamily, fontWeight: 900, fontSize: 88, lineHeight: 1.05, color: PAPER, letterSpacing: -2 }}>
        Every battle, lined up before you go live.
      </div>
      <div style={{ ...fadeUp(frame, 22), fontFamily, fontWeight: 800, fontSize: 48, color: POP_INK, background: POP, padding: "22px 40px", borderRadius: 999 }}>
        {url}
      </div>
      <div style={{ ...fadeUp(frame, 32), fontFamily, fontWeight: 700, fontSize: 40, color: "rgba(255,255,255,0.9)" }}>
        Follow {handle}
      </div>
    </AbsoluteFill>
  );
};

export const BattleDemo: React.FC<BattleDemoProps> = (props) => {
  const steps = props.steps.length ? props.steps : defaultBattleDemoProps.steps;
  return (
    <AbsoluteFill style={{ background: INK }}>
      <Sequence durationInFrames={HOOK_FRAMES + 2}>
        <Hook url={props.url} />
      </Sequence>
      {steps.map((step, i) => (
        <Sequence key={i} from={HOOK_FRAMES + i * PER_STEP_FRAMES} durationInFrames={PER_STEP_FRAMES + 2}>
          <StepScene step={step} index={i} total={steps.length} />
        </Sequence>
      ))}
      <Sequence from={HOOK_FRAMES + steps.length * PER_STEP_FRAMES} durationInFrames={OUTRO_FRAMES}>
        <Outro url={props.url} handle={props.handle} />
      </Sequence>
    </AbsoluteFill>
  );
};

export const defaultBattleDemoProps: BattleDemoProps = {
  url: "battle-scheduler.vercel.app",
  handle: "@taboost.colin",
  steps: [
    {
      shot: "availability.jpg",
      nav: "My hours",
      title: "Tell it when you're free.",
      body: "Pick the nights and hours you can go live. Creators free at the same time can then ask you.",
    },
    {
      shot: "now.jpg",
      nav: "Now",
      title: "Need one right now?",
      body: "Tap \"Looking for a battle\" — anyone else looking taps I'm in, and you're matched for 10 minutes' time.",
    },
    {
      shot: "swipe.jpg",
      nav: "Match",
      title: "Or just swipe.",
      body: "Swipe right to battle, left to skip. Same night, same time — it's set automatically.",
    },
    {
      shot: "requests.jpg",
      nav: "Requests",
      title: "Pick exactly who you battle.",
      body: "Level bars mean you only match creators at your tier or higher. Accept and the battle is locked in.",
    },
    {
      shot: "battles.jpg",
      nav: "Battles",
      title: "It's handled.",
      body: "Every confirmed battle sits here on your own clock — plus a text 15 minutes before.",
    },
  ],
};
