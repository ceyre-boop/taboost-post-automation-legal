// Voice: one swappable step. Today it's the Mac's built-in `say`; later a clone of
// Colin's voice can replace speakLine() without touching anything else.
// Each line is spoken separately so we know exactly how long it lasts, then the
// lines are joined into one WAV (with a short pause between) for the video.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VOICE = process.env.PIPELINE_VOICE ?? "Samantha";
export const RATE = Number(process.env.PIPELINE_VOICE_RATE ?? 185); // words per minute
const GAP_SEC = 0.25;

interface Pcm { rate: number; channels: number; data: Buffer; }

function readWav(file: string): Pcm {
  const b = readFileSync(file);
  let off = 12, rate = 22050, channels = 1, data: Buffer | null = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === "fmt ") { channels = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); }
    if (id === "data") { data = b.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error(`no audio data in ${file}`);
  return { rate, channels, data };
}

function writeWav(file: string, p: Pcm): void {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + p.data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(p.channels, 22);
  h.writeUInt32LE(p.rate, 24); h.writeUInt32LE(p.rate * p.channels * 2, 28); h.writeUInt16LE(p.channels * 2, 32);
  h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(p.data.length, 40);
  writeFileSync(file, Buffer.concat([h, p.data]));
}

/** Speak one line to a 16-bit WAV. Swap this function to change the voice. */
export function speakLine(text: string, outWav: string): void {
  const aiff = outWav.replace(/\.wav$/, ".aiff");
  const s = spawnSync("say", ["-v", VOICE, "-r", String(RATE), "-o", aiff, text]);
  if (s.status !== 0) throw new Error(`say failed: ${s.stderr}`);
  const c = spawnSync("afconvert", ["-f", "WAVE", "-d", "LEI16@22050", "-c", "1", aiff, outWav]);
  if (c.status !== 0) throw new Error(`afconvert failed: ${c.stderr}`);
}

/** Speak each line, join them, and return each line's start/length in seconds. */
export function speakLines(lines: string[], outWav: string): { start: number; dur: number }[] {
  const tmp = mkdtempSync(join(tmpdir(), "pipeline-voice-"));
  const parts = lines.map((t, i) => { const f = join(tmp, `${i}.wav`); speakLine(t, f); return readWav(f); });
  const { rate, channels } = parts[0];
  const gap = Buffer.alloc(Math.round(GAP_SEC * rate) * channels * 2);
  const out: Buffer[] = [], timing: { start: number; dur: number }[] = [];
  let t = 0;
  for (const p of parts) {
    if (p.rate !== rate || p.channels !== channels) throw new Error("voice lines came out in different formats");
    const dur = p.data.length / (rate * channels * 2);
    timing.push({ start: t, dur });
    out.push(p.data, gap);
    t += dur + GAP_SEC;
  }
  writeWav(outWav, { rate, channels, data: Buffer.concat(out) });
  return timing;
}
