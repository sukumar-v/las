/**
 * Lining up what was played with what was expected. Expected events are in beats; a grid maps
 * beats to seconds (time = offset + beat * period). Given a grid, a dynamic-programming
 * alignment (like Needleman-Wunsch over two time-ordered lists) pairs each expected event with
 * at most one detected event, keeping both lists in order. A pair costs its squared timing
 * error relative to a window (plus a penalty for a different pitch); leaving either side
 * unpaired costs 1. Pairs farther apart than the window are not allowed.
 *
 * When the grid isn't known (no click), it is fitted: a few anchor guesses, then alternate
 * "align, then refit the grid to the pairs" a few times, and keep the cheapest result.
 */
import { linearFit, percentile } from "./dsp.js";
import type { ExpectedEvent } from "./reference/types.js";

export interface PlayedEvent {
  /** time in seconds, output delay already removed */
  t: number;
  /** fractional MIDI number, when pitched */
  midi?: number;
}

export interface Grid {
  offset: number;
  period: number;
}

export interface Alignment {
  grid: Grid;
  /** for each expected event, the index of its detected event or -1 */
  match: number[];
  cost: number;
}

const GAP = 1;

/** Per expected event: how far (s) a played event may be and still count as that event. */
export function matchWindows(expected: ExpectedEvent[], period: number, toleranceS: number): number[] {
  return expected.map((e, i) => {
    const prev = i > 0 ? e.beat - expected[i - 1].beat : Infinity;
    const next = i + 1 < expected.length ? expected[i + 1].beat - e.beat : Infinity;
    let spacing = Math.min(prev, next);
    if (!Number.isFinite(spacing)) spacing = 1;
    return Math.min(0.6, Math.max(2 * toleranceS, 0.08, 0.75 * spacing * period));
  });
}

function pitchCost(e: ExpectedEvent, d: PlayedEvent): number {
  if (!e.midis.length) return 0;
  if (d.midi === undefined) return 0.3;
  const dist = Math.min(...e.midis.map((m) => Math.abs(d.midi! - m)));
  // a semitone off still pairs (a wrong note); three or more semitones costs more than two gaps
  return 1.2 * Math.min(1, Math.max(0, dist - 0.5) / 2.5);
}

/** Order-preserving alignment of expected events to played events on a fixed grid. */
export function alignOnGrid(expected: ExpectedEvent[], played: PlayedEvent[], grid: Grid, toleranceS: number): Alignment {
  const N = expected.length;
  const M = played.length;
  const win = matchWindows(expected, grid.period, toleranceS);
  const D = new Float64Array((N + 1) * (M + 1));
  const B = new Uint8Array((N + 1) * (M + 1)); // 1 = skip expected, 2 = skip played, 3 = pair
  const at = (i: number, j: number) => i * (M + 1) + j;
  for (let i = 1; i <= N; i++) {
    D[at(i, 0)] = i * GAP;
    B[at(i, 0)] = 1;
  }
  for (let j = 1; j <= M; j++) {
    D[at(0, j)] = j * GAP;
    B[at(0, j)] = 2;
  }
  for (let i = 1; i <= N; i++) {
    const e = expected[i - 1];
    const te = grid.offset + e.beat * grid.period;
    for (let j = 1; j <= M; j++) {
      let best = D[at(i - 1, j)] + GAP;
      let dir = 1;
      const s2 = D[at(i, j - 1)] + GAP;
      if (s2 < best) {
        best = s2;
        dir = 2;
      }
      const dt = Math.abs(played[j - 1].t - te);
      if (dt <= win[i - 1]) {
        const s3 = D[at(i - 1, j - 1)] + (dt / win[i - 1]) ** 2 + pitchCost(e, played[j - 1]);
        if (s3 < best) {
          best = s3;
          dir = 3;
        }
      }
      D[at(i, j)] = best;
      B[at(i, j)] = dir;
    }
  }
  const match = new Array<number>(N).fill(-1);
  let i = N;
  let j = M;
  while (i > 0 || j > 0) {
    const dir = B[at(i, j)];
    if (dir === 3) {
      match[i - 1] = j - 1;
      i--;
      j--;
    } else if (dir === 1) i--;
    else j--;
  }
  return { grid, match, cost: D[at(N, M)] };
}

function pairs(expected: ExpectedEvent[], played: PlayedEvent[], match: number[]): { b: number[]; t: number[] } {
  const b: number[] = [];
  const t: number[] = [];
  match.forEach((j, i) => {
    if (j >= 0) {
      b.push(expected[i].beat);
      t.push(played[j].t);
    }
  });
  return { b, t };
}

/**
 * Aligns with a grid that is fully known (`offset` and `period`), known up to its offset
 * (`period` only: a tempo without a click), or unknown (both fitted).
 */
export function fitAndAlign(expected: ExpectedEvent[], played: PlayedEvent[], known: { offset?: number; period?: number }, toleranceS: number): Alignment {
  if (!expected.length || !played.length) return { grid: { offset: known.offset ?? 0, period: known.period ?? 0.5 }, match: expected.map(() => -1), cost: (expected.length + played.length) * GAP };
  if (known.offset !== undefined && known.period !== undefined) return alignOnGrid(expected, played, { offset: known.offset, period: known.period }, toleranceS);

  const candidates: Grid[] = [];
  const firstE = expected.slice(0, 3);
  const firstP = played.slice(0, 3);
  if (known.period !== undefined) {
    const p = known.period;
    for (const e of firstE) for (const d of firstP) candidates.push({ offset: d.t - e.beat * p, period: p });
  } else {
    const lastE = expected.slice(-3);
    const lastP = played.slice(-3);
    for (const e0 of firstE)
      for (const d0 of firstP)
        for (const e1 of lastE)
          for (const d1 of lastP) {
            if (e1.beat - e0.beat <= 0 || d1.t - d0.t <= 0) continue;
            const period = (d1.t - d0.t) / (e1.beat - e0.beat);
            if (period < 0.1 || period > 3) continue;
            candidates.push({ offset: d0.t - e0.beat * period, period });
          }
    if (!candidates.length) candidates.push({ offset: played[0].t - expected[0].beat * 0.5, period: 0.5 });
  }

  // drop near-duplicate guesses (same start within 5 ms and period within 1 ms)
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const k = `${Math.round(c.offset / 0.005)}:${Math.round(c.period / 0.001)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  let best: Alignment | null = null;
  for (const c of unique) {
    let a = alignOnGrid(expected, played, c, toleranceS);
    for (let iter = 0; iter < 4; iter++) {
      const { b, t } = pairs(expected, played, a.match);
      if (!b.length) break;
      let g: Grid;
      if (known.period !== undefined) {
        // tempo known, start unknown: the offset that centres the timing errors (median, so one
        // badly timed note doesn't move everyone else)
        g = { offset: percentile(t.map((x, k) => x - b[k] * known.period!), 50), period: known.period };
      } else {
        if (new Set(b).size < 2) break;
        const f = linearFit(b, t);
        if (!(f.b > 0)) break;
        g = { offset: f.a, period: f.b };
      }
      const next = alignOnGrid(expected, played, g, toleranceS);
      const same = next.match.every((m, k) => m === a.match[k]) && Math.abs(g.offset - a.grid.offset) < 1e-6 && Math.abs(g.period - a.grid.period) < 1e-9;
      a = next;
      if (same) break;
    }
    if (!best || a.cost < best.cost - 1e-9) best = a;
  }
  return best!;
}
