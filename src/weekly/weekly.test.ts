import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// draft.ts is pure given a Product — import directly.
import { draftSpot, draftCaption } from "./draft.ts";
import type { Product } from "./catalog.ts";

const base: Product = {
  id: "1", name: "Thing", brand: "Acme", category: "Beauty & Care", price: "$10",
  itemsSold: 1234, itemsSoldRaw: "1,234", commission: "20%", rating: "8", rank: 1,
  imageUrl: "http://x/y.webp",
};

test("parseCsv: quoted comma, embedded newline, escaped quotes", async () => {
  const { parseCsv } = await import("./catalog.ts");
  const csv = 'a,b,c\n"x,1","line1\nline2","he said ""hi"""\n';
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], ["a", "b", "c"]);
  assert.equal(rows[1][0], "x,1");
  assert.equal(rows[1][1], "line1\nline2");
  assert.equal(rows[1][2], 'he said "hi"');
});

test("draft: rating (0-8 score) never shown; sold + commission are", () => {
  const spot = draftSpot(base);
  assert.deepEqual(spot.stats.map((s) => s.label), ["units sold", "commission"]);
  assert.equal(spot.stats[0].value, "1,234");
  const cap = draftCaption(base);
  assert.ok(cap.includes("1,234 sold"));
  assert.ok(cap.includes("20% commission"));
  assert.ok(!/★|rating|8\.0/.test(cap), "caption must not mention the rating score");
});

test("draft: title trims trailing dash/ellipsis", () => {
  const spot = draftSpot({ ...base, name: "LIP LINER - Peel-Off Stain -..." });
  assert.ok(!/[-–—\s]$/.test(spot.productName), `got: "${spot.productName}"`);
});

test("pickProduct: best seller first, then excludes featured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tapcat-"));
  const header = "Product ID,Product Name,Shop Name,Category,Sale Price,Items Sold,Total Commission Rate,Rank,Rating";
  const csv = [header,
    "10,Big Seller,Acme,Beauty,$10,\"50,000\",20%,1,5",
    "11,Small Seller,Acme,Beauty,$9,\"1,000\",15%,2,4",
    "12,No Photo,Acme,Beauty,$9,\"99,999\",15%,3,4",
  ].join("\n") + "\n";
  writeFileSync(join(dir, "tap-products.csv"), csv);
  writeFileSync(join(dir, "product-images.json"), JSON.stringify({ "10": "http://x/a.webp", "11": "http://x/b.webp" }));
  process.env.TABOOST_SHOP_DIR = dir;

  const { pickProduct } = await import("./catalog.ts?pick=" + Date.now());
  const first = pickProduct(new Set());
  assert.equal(first?.id, "10", "highest units-sold WITH a photo");
  const second = pickProduct(new Set(["10"]));
  assert.equal(second?.id, "11", "No Photo (12) is skipped though it sold more");
});
