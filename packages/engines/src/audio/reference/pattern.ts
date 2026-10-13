/**
 * Onset patterns: one string per bar such as "x.x.xx.x" or "D_DU_UDU". Every character is one
 * equal step of the bar; "." "_" and "-" are silent steps, any other character is an onset and
 * is kept as its symbol (so "U"/"D" strokes can be graded separately). Bars may be separated by
 * "|"; the written bars repeat until `bars` bars are filled.
 *
 * A pattern may instead list beat positions within the bar as numbers ("0 1 1.5 2.5" or the
 * 1-based count "1 2 2.5 4"); counts are read as 1-based when no number is 0 and all fit in
 * 1..beats_per_bar+1.
 */
import type { ExpectedEvent } from "./types.js";

const SILENT = new Set([".", "_", "-"]);

export function parsePattern(pattern: string, beatsPerBar = 4, bars = 4): ExpectedEvent[] {
  const written = pattern.split("|").map((b) => b.trim()).filter(Boolean);
  if (!written.length) return [];
  const numeric = /\d/.test(pattern) && /^[\d.\s,;|]+$/.test(pattern);
  const barEvents: { pos: number; symbol: string; dur: number }[][] = written.map((bar) => {
    if (numeric) {
      const nums = bar.split(/[\s,;]+/).filter(Boolean).map(Number).filter(Number.isFinite);
      const oneBased = nums.length > 0 && nums.every((n) => n >= 1 && n < beatsPerBar + 1);
      const pos = nums.map((n) => (oneBased ? n - 1 : n)).sort((a, b) => a - b);
      return pos.map((p, i) => ({ pos: p, symbol: "x", dur: (pos[i + 1] ?? beatsPerBar) - p }));
    }
    const steps = Array.from(bar.replace(/\s+/g, ""));
    const step = beatsPerBar / steps.length;
    const out: { pos: number; symbol: string; dur: number }[] = [];
    steps.forEach((c, i) => {
      if (SILENT.has(c)) {
        if (out.length) out[out.length - 1].dur += step;
      } else out.push({ pos: i * step, symbol: c, dur: step });
    });
    return out;
  });
  const total = Math.max(bars, written.length);
  const events: ExpectedEvent[] = [];
  for (let b = 0; b < total; b++) {
    for (const e of barEvents[b % barEvents.length]) events.push({ beat: b * beatsPerBar + e.pos, dur: e.dur, midis: [], symbol: e.symbol });
  }
  return events;
}
