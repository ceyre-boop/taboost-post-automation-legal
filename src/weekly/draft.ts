import type { Product } from "./catalog.ts";

export interface SpotProps {
  hook: string;
  productName: string;
  brand: string;
  price: string;
  stats: { label: string; value: string }[];
  cta: string;
  ctaSub: string;
  imageFile: string;
}

const trimEdges = (s: string) => s.replace(/^[\s\-–—·|,]+|[\s\-–—·|,]+$/g, "").trim();

/** CSV names are often truncated ("...") and very long. Clean for a title card. */
function cleanName(raw: string): string {
  let n = trimEdges(raw.replace(/\.\.\.$/, "").replace(/\s+/g, " "));
  if (n.length > 44) {
    const cut = n.slice(0, 44);
    const sp = cut.lastIndexOf(" ");
    n = sp > 20 ? cut.slice(0, sp) : cut;
  }
  return trimEdges(n);
}

// The TAP "Rating" column is a 0-8 internal score, not a 1-5 star rating, so we
// never show it as stars. Units-sold and commission are the real, unambiguous numbers.

export function draftSpot(p: Product): SpotProps {
  const name = cleanName(p.name);
  const stats: { label: string; value: string }[] = [];
  if (p.itemsSold > 0) stats.push({ label: "units sold", value: p.itemsSold.toLocaleString("en-US") });
  if (p.commission) stats.push({ label: "commission", value: p.commission });

  return {
    hook: "The product TABOOST creators are pushing right now",
    productName: name,
    brand: p.brand,
    price: p.price,
    stats: stats.slice(0, 3),
    cta: "Want these in your shop?",
    ctaSub: "Join TABOOST → link in bio",
    imageFile: "", // filled by the renderer once the photo is staged
  };
}

/** The TikTok caption. Editable by Colin before approval. */
export function draftCaption(p: Product): string {
  const name = cleanName(p.name);
  const bits: string[] = [];
  bits.push(`🔥 This week's TABOOST top seller: ${name}${p.brand ? ` by ${p.brand}` : ""}.`);
  const nums: string[] = [];
  if (p.itemsSold > 0) nums.push(`${p.itemsSold.toLocaleString("en-US")} sold`);
  if (p.commission) nums.push(`${p.commission} commission`);
  if (nums.length) bits.push(nums.join(" · ") + ".");
  bits.push("Our creators move products like this every day. Want in?");
  const tags = ["#TABOOST", "#TikTokShop", "#creatoreconomy", "#sidehustle"];
  const cat = p.category.split(/[&,/]/)[0].trim().replace(/\s+/g, "");
  if (cat) tags.push("#" + cat);
  return `${bits.join(" ")}\n\n👉 Join TABOOST — link in bio\n${tags.join(" ")}`;
}
