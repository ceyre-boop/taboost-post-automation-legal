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
import { BRAND } from "./brand";

const { fontFamily } = loadFont();

export type Stat = { label: string; value: string };

export type ProductSpotProps = {
  hook: string;
  productName: string;
  brand: string;
  price: string;
  stats: Stat[];
  cta: string;
  ctaSub: string;
  /** file in public/, e.g. "current-product.webp"; empty = no photo */
  imageFile: string;
};

export const productSpotSchema = undefined; // props validated by the generator, not zod

const fadeUp = (frame: number, start: number, dur = 18) => {
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

// The real TABOOST mark. Black-on-transparent asset; on dark backgrounds we
// knock it to white with a filter. `dark` = sitting on a light card (keep black).
const Logo: React.FC<{ size?: number; dark?: boolean }> = ({ size = 54, dark }) => (
  <Img
    src={staticFile("taboost-mark.png")}
    style={{ height: size * 1.5, width: "auto", filter: dark ? "none" : "brightness(0) invert(1)" }}
  />
);

// ---- Scene 1: Hook ----------------------------------------------------------
const Hook: React.FC<{ text: string }> = ({ text }) => {
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
        gap: 40,
      }}
    >
      <div style={{ ...fadeUp(frame, 4), transform: `scale(${0.9 + pop * 0.1})` }}>
        <Logo />
      </div>
      <div
        style={{
          ...fadeUp(frame, 12),
          fontFamily,
          fontWeight: 800,
          fontSize: 104,
          lineHeight: 1.02,
          color: BRAND.paper,
          letterSpacing: -2,
        }}
      >
        {text}
      </div>
      <div
        style={{
          ...fadeUp(frame, 24),
          fontFamily,
          fontWeight: 600,
          fontSize: 40,
          color: BRAND.mutedOnDark,
        }}
      >
        Real products · real numbers
      </div>
    </AbsoluteFill>
  );
};

// ---- Scene 2: Product + stats ----------------------------------------------
const Product: React.FC<ProductSpotProps> = (p) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const imgIn = spring({ frame, fps, config: { damping: 18, mass: 0.9 } });
  return (
    <AbsoluteFill style={{ background: BRAND.paper, padding: 72, gap: 40 }}>
      <div style={{ ...fadeUp(frame, 2) }}>
        <Logo dark size={40} />
      </div>

      <div
        style={{
          borderRadius: 48,
          overflow: "hidden",
          background: "#F1F4F4",
          height: 820,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 30px 80px rgba(0,80,80,0.18)",
          transform: `scale(${0.86 + imgIn * 0.14})`,
          opacity: imgIn,
        }}
      >
        {p.imageFile ? (
          <Img src={staticFile(p.imageFile)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <span style={{ fontFamily, fontSize: 200 }}>🛍️</span>
        )}
      </div>

      <div style={{ ...fadeUp(frame, 22), display: "flex", flexDirection: "column", gap: 16 }}>
        {p.brand ? (
          <span
            style={{
              alignSelf: "flex-start",
              fontFamily,
              fontWeight: 700,
              fontSize: 34,
              color: BRAND.tealDark,
              background: "rgba(0,153,153,0.12)",
              padding: "10px 24px",
              borderRadius: 999,
            }}
          >
            {p.brand}
          </span>
        ) : null}
        <span style={{ fontFamily, fontWeight: 800, fontSize: 62, lineHeight: 1.03, color: BRAND.ink, letterSpacing: -1.5 }}>
          {p.productName}
        </span>
        {p.price ? (
          <span style={{ fontFamily, fontWeight: 700, fontSize: 48, color: BRAND.tealDark }}>{p.price}</span>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 24, marginTop: "auto" }}>
        {p.stats.map((s, i) => {
          const start = 40 + i * 12;
          const statSpring = spring({ frame: frame - start, fps, config: { damping: 16 }, durationInFrames: 20 });
          return (
            <div
              key={s.label}
              style={{
                flex: 1,
                background: i === 0 ? BRAND.pop : BRAND.ink,
                borderRadius: 32,
                padding: "34px 22px",
                opacity: interpolate(frame, [start, start + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
                transform: `translateY(${(1 - statSpring) * 26}px)`,
              }}
            >
              <div style={{ fontFamily, fontWeight: 800, fontSize: 58, color: i === 0 ? BRAND.popInk : BRAND.paper, letterSpacing: -1 }}>
                {s.value}
              </div>
              <div style={{ fontFamily, fontWeight: 600, fontSize: 28, color: i === 0 ? BRAND.popInk : BRAND.mutedOnDark, marginTop: 4 }}>
                {s.label}
              </div>
            </div>
          );
        })}
      </div>
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
      <div style={{ ...fadeUp(frame, 10), fontFamily, fontWeight: 800, fontSize: 96, lineHeight: 1.02, color: BRAND.paper, letterSpacing: -2 }}>
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

export const ProductSpot: React.FC<ProductSpotProps> = (props) => {
  // 0-90 hook | 90-390 product | 390-540 cta  (30fps, 18s)
  return (
    <AbsoluteFill style={{ background: BRAND.ink }}>
      <Sequence durationInFrames={95}>
        <Hook text={props.hook} />
      </Sequence>
      <Sequence from={90} durationInFrames={305}>
        <Product {...props} />
      </Sequence>
      <Sequence from={392} durationInFrames={148}>
        <Cta cta={props.cta} ctaSub={props.ctaSub} />
      </Sequence>
    </AbsoluteFill>
  );
};

export const defaultProductSpotProps: ProductSpotProps = {
  hook: "The product TABOOST creators are pushing right now",
  productName: "GO POP+ True Wireless Earbuds",
  brand: "JLab",
  price: "$17.49–$22.47",
  stats: [
    { label: "units sold", value: "75,371" },
    { label: "commission", value: "18%" },
    { label: "rating", value: "★ 5.0" },
  ],
  cta: "Want these in your shop?",
  ctaSub: "Join TABOOST → link in bio",
  imageFile: "",
};
