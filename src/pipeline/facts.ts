// Turns the brief's allowed source files into a list of citable facts. This is
// deterministic (no model): every idea must point at one of these by id, so its
// source location and its exact numbers are known before Claude writes a word.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseCsv } from "../weekly/catalog.ts";
import { resolvePath, type Brief, type SourceSpec } from "./brief.ts";

export interface Fact {
  id: string;            // stable: "<file>#<row id or index>"
  subject: string;       // what the fact is about
  text: string;          // the fact, verbatim values from the source
  location: string;      // file + row/line + columns, for a human to check
  numbers: string[];     // every number in `text`, exactly as written
}

const NUM_RE = /\$?\d[\d,]*(?:\.\d+)?%?/g;
export function numbersIn(s: string): string[] {
  return (s.match(NUM_RE) ?? []).map((n) => n.replace(/[.,]$/, ""));
}
/** "75,371" and "75371" are the same number; "$17.49" and "17.49" too. */
export function normNum(n: string): string {
  return n.replace(/[$,]/g, "").replace(/%$/, "%");
}

function csvFacts(src: SourceSpec): Fact[] {
  const file = resolvePath(src.path);
  const rows = parseCsv(readFileSync(file, "utf8")).filter((r) => r.some((c) => c.trim()));
  const header = rows[0].map((h) => h.trim());
  const col = (name?: string) => (name ? header.indexOf(name) : -1);
  const idI = col(src.id_column), titleI = col(src.title_column);
  const factCols = (src.fact_columns ?? []).map((c) => ({ name: c, i: col(c) }));
  for (const f of factCols) if (f.i < 0) throw new Error(`${src.path}: no column "${f.name}"`);
  const out: Fact[] = [];
  const body = rows.slice(1, 1 + (src.max_rows ?? rows.length));
  body.forEach((r, k) => {
    const rowNo = k + 2; // 1-based, header is row 1
    const id = idI >= 0 ? r[idI].trim() : String(rowNo);
    const subject = (titleI >= 0 ? r[titleI] : id).replace(/\s+/g, " ").replace(/\.\.\.$/, "").trim();
    const parts = factCols.map((c) => `${c.name}: ${(r[c.i] ?? "").replace(/\s+/g, " ").trim()}`)
      .filter((p) => !p.endsWith(": "));
    const text = `${subject} — ${parts.join("; ")}`;
    out.push({
      id: `${basename(file)}#${id}`,
      subject,
      text,
      location: `${src.path} row ${rowNo} (${factCols.map((c) => c.name).join(", ")})`,
      numbers: [...new Set([...numbersIn(subject), ...parts.flatMap((p) => numbersIn(p.split(": ").slice(1).join(": ")))])],
    });
  });
  return out;
}

function lessonFacts(src: SourceSpec): Fact[] {
  const file = resolvePath(src.path);
  const lessons = JSON.parse(readFileSync(file, "utf8")) as { tag: string; hook: string; points: { label: string; body: string }[]; takeaway?: string }[];
  const out: Fact[] = [];
  lessons.forEach((l, i) => {
    const pts = l.points.map((p) => `${p.label}: ${p.body}`).join(" | ");
    const text = `${l.hook} ${pts}${l.takeaway ? ` | ${l.takeaway}` : ""}`;
    out.push({ id: `${basename(file)}#${i}`, subject: l.tag, text, location: `${src.path} [${i}] (${l.tag})`, numbers: numbersIn(text) });
  });
  return out;
}

function textFacts(src: SourceSpec): Fact[] {
  const file = resolvePath(src.path);
  return readFileSync(file, "utf8").split("\n").flatMap((line, i) => {
    const t = line.trim();
    if (!t || !numbersIn(t).length) return [];
    return [{ id: `${basename(file)}#L${i + 1}`, subject: t.slice(0, 60), text: t, location: `${src.path} line ${i + 1}`, numbers: numbersIn(t) }];
  });
}

export function extractFacts(brief: Brief): Fact[] {
  return brief.sources.flatMap((s) =>
    s.kind === "csv" ? csvFacts(s) : s.kind === "json-lessons" ? lessonFacts(s) : textFacts(s));
}
