import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the TABOOST-Shop catalog lives. Override with TABOOST_SHOP_DIR. */
export const SHOP_DIR = process.env.TABOOST_SHOP_DIR ?? join(homedir(), "TABOOST-Shop", "data", "shop");
const PRODUCTS_CSV = join(SHOP_DIR, "tap-products.csv");
const IMAGES_JSON = join(SHOP_DIR, "product-images.json");

export interface Product {
  id: string;
  name: string;
  brand: string;
  category: string;
  price: string;
  itemsSold: number;
  itemsSoldRaw: string;
  commission: string; // e.g. "18%"
  rating: string; // e.g. "5"
  rank: number;
  imageUrl: string;
}

/** State-machine CSV parser: handles quoted fields, embedded commas,
 *  embedded newlines, and "" escaped quotes. The TAP export has all three. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* ignore, handled by \n */ }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const toInt = (s: string | undefined): number => parseInt(String(s ?? "").replace(/[^0-9]/g, ""), 10) || 0;
const firstPercent = (s: string | undefined): string => {
  const m = String(s ?? "").match(/\d+(\.\d+)?\s*%/);
  return m ? m[0].replace(/\s+/g, "") : "";
};

export function loadProducts(): Product[] {
  if (!existsSync(PRODUCTS_CSV)) throw new Error(`Catalog not found: ${PRODUCTS_CSV} (set TABOOST_SHOP_DIR)`);
  const rows = parseCsv(readFileSync(PRODUCTS_CSV, "utf8"));
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim());
  const col = (name: string) => head.indexOf(name);
  const idx = {
    id: col("Product ID"), name: col("Product Name"), brand: col("Shop Name"),
    category: col("Category"), price: col("Sale Price"), sold: col("Items Sold"),
    comm: col("Total Commission Rate"), rank: col("Rank"), rating: col("Rating"),
  };
  const images: Record<string, string> = existsSync(IMAGES_JSON)
    ? JSON.parse(readFileSync(IMAGES_JSON, "utf8")) : {};

  const out: Product[] = [];
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r];
    const id = (c[idx.id] ?? "").trim();
    if (!id) continue;
    out.push({
      id,
      name: (c[idx.name] ?? "").trim(),
      brand: (c[idx.brand] ?? "").trim(),
      category: (c[idx.category] ?? "").trim(),
      price: (c[idx.price] ?? "").trim(),
      itemsSold: toInt(c[idx.sold]),
      itemsSoldRaw: (c[idx.sold] ?? "").trim(),
      commission: firstPercent(c[idx.comm]),
      rating: (c[idx.rating] ?? "").trim(),
      rank: toInt(c[idx.rank]),
      imageUrl: (images[id] ?? "").replace(/&amp;/g, "&"),
    });
  }
  return out;
}

/** Best unfeatured product: has a real photo, most units sold.
 *  Ties broken by best rank. `featured` = product ids already used. */
export function pickProduct(featured: Set<string>): Product | undefined {
  const eligible = loadProducts().filter(
    (p) => p.imageUrl && p.name && !featured.has(p.id) && p.itemsSold > 0,
  );
  eligible.sort((a, b) => b.itemsSold - a.itemsSold || a.rank - b.rank);
  return eligible[0];
}
