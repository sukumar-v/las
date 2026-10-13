/**
 * Splitting a clip into segments (repetitions, moves, phrases, holds or the whole clip) and marking
 * the built-in phases inside each segment. All of it works on plain signals; nothing here knows
 * which movement it is looking at.
 */
import { argmax, fillGaps, movingAverage, noiseSigma, nearestIndex, quantile, runs } from "./signal.js";

export type SegmentKind = "reps" | "moves" | "phrases" | "holds" | "whole";

export interface Segment {
  /** first and last frame index (inclusive) */
  start: number;
  end: number;
  /** the turning point: bottom of a repetition, fastest frame of a move, first beat of a phrase */
  key: number;
  /** frames around the turning point that count as being at it (a pause at the bottom, say) */
  keyRange: [number, number];
}

/** `per rep`, `per moves`... to a segment kind. `segment` means the spec's own `segment.by`. */
export function segmentKindOf(word: string, fallback: SegmentKind): SegmentKind {
  switch (word) {
    case "rep":
    case "reps":
      return "reps";
    case "move":
    case "moves":
      return "moves";
    case "phrase":
    case "phrases":
      return "phrases";
    case "hold":
    case "holds":
      return "holds";
    case "whole":
      return "whole";
  }
  return fallback;
}

export function singular(kind: SegmentKind): string {
  return kind === "whole" ? "clip" : kind.replace(/s$/, "");
}

/**
 * Repetitions from a signal whose minima separate them (for a `.y` signal, the resting position is
 * the minimum and the turning point the maximum, since image y grows downward).
 *
 * 1. Find excursions with hysteresis: the signal rises above 40% of its range and later falls below 20%
 *    (low enough that a shallow repetition among deep ones still counts).
 * 2. The turning point of each excursion is its maximum.
 * 3. Walking outwards from the turning point, the repetition starts where the signal was last at its
 *    resting level (within a small tolerance) and ends where it first returns to it. Rests between
 *    repetitions are therefore not part of any repetition, so phase durations are not inflated.
 */
export function repSegments(signal: ArrayLike<number>, t: ArrayLike<number>, minDurS = 0.3): Segment[] {
  const s = fillGaps(signal);
  const n = s.length;
  if (n < 3) return [];
  const lo = quantile(s, 0.02);
  const hi = quantile(s, 0.98);
  const r = hi - lo;
  const noise = noiseSigma(s);
  if (!(r > 0) || r < 8 * noise) return [];
  const up = lo + 0.4 * r;
  const down = lo + 0.2 * r;
  const excursions: [number, number][] = [];
  let inside = false;
  let enter = 0;
  for (let i = 0; i < n; i++) {
    if (!inside && s[i] > up) {
      inside = true;
      enter = i;
    } else if (inside && s[i] < down) {
      excursions.push([enter, i]);
      inside = false;
    }
  }
  // an excursion still open at the end of the clip is an unfinished repetition: not counted
  const keys = excursions.map(([a, b]) => argmax(s, a, b));
  const tol = Math.max(0.005 * r, 3 * noise);
  const keyTol = Math.max(0.02 * r, 3 * noise);
  const out: Segment[] = [];
  keys.forEach((key, k) => {
    const prev = k > 0 ? keys[k - 1] : 0;
    const next = k + 1 < keys.length ? keys[k + 1] : n - 1;
    let m1 = Infinity;
    for (let i = prev; i <= key; i++) m1 = Math.min(m1, s[i]);
    let start = prev;
    for (let i = key - 1; i >= prev; i--) {
      if (s[i] <= m1 + tol) {
        start = i;
        break;
      }
    }
    let m2 = Infinity;
    for (let i = key; i <= next; i++) m2 = Math.min(m2, s[i]);
    let end = next;
    for (let i = key + 1; i <= next; i++) {
      if (s[i] <= m2 + tol) {
        end = i;
        break;
      }
    }
    let a = key;
    let b = key;
    while (a - 1 >= start && s[a - 1] >= s[key] - keyTol) a--;
    while (b + 1 <= end && s[b + 1] >= s[key] - keyTol) b++;
    if (t[end] - t[start] >= minDurS) out.push({ start, end, key, keyRange: [a, b] });
  });
  return out;
}

/** Speed below which a body part counts as still, from the clip's own speeds with an absolute floor. */
export function stillThreshold(speed: ArrayLike<number>): number {
  const p90 = quantile(speed, 0.9);
  return Math.max(0.15 * (Number.isFinite(p90) ? p90 : 0), 0.03);
}

/**
 * Moves from the speed of the hands and feet: a position is where they stop (a still stretch, or a
 * deep dip in speed between two fast stretches); each move runs from one position to the next.
 */
export function moveSegments(speed: ArrayLike<number>, t: ArrayLike<number>, minDurS = 0.2): Segment[] {
  const n = speed.length;
  if (n < 3) return [];
  const dt = (t[n - 1] - t[0]) / (n - 1) || 1 / 30;
  const v = movingAverage(fillGaps(speed), Math.max(1, Math.round(0.1 / dt)));
  const still = stillThreshold(v);
  const window = Math.max(2, Math.round(1 / dt));
  const marks: { i: number; v: number }[] = [];
  for (const [a, b] of runs(Array.from(v, (x) => x < still))) marks.push({ i: (a + b) >> 1, v: 0 });
  for (let i = 1; i + 1 < n; i++) {
    if (v[i] < still || !(v[i] <= v[i - 1] && v[i] < v[i + 1])) continue;
    let lp = 0;
    let rp = 0;
    for (let j = Math.max(0, i - window); j < i; j++) lp = Math.max(lp, v[j]);
    for (let j = i + 1; j <= Math.min(n - 1, i + window); j++) rp = Math.max(rp, v[j]);
    if (v[i] <= 0.35 * Math.min(lp, rp)) marks.push({ i, v: v[i] });
  }
  marks.sort((a, b) => a.i - b.i);
  // merge positions closer than the minimum move duration, keeping the stillest
  const bounds: { i: number; v: number }[] = [];
  for (const m of marks) {
    const last = bounds[bounds.length - 1];
    if (last && t[m.i] - t[last.i] < minDurS) {
      if (m.v < last.v) bounds[bounds.length - 1] = m;
    } else bounds.push(m);
  }
  const edges = [0, ...bounds.map((b) => b.i), n - 1].filter((x, i, a) => i === 0 || x !== a[i - 1]);
  const out: Segment[] = [];
  for (let k = 0; k + 1 < edges.length; k++) {
    const a = edges[k];
    const b = edges[k + 1];
    const key = argmax(v, a, b);
    if (key < 0 || v[key] < 2 * still || t[b] - t[a] < minDurS) continue;
    out.push({ start: a, end: b, key, keyRange: [key, key] });
  }
  return out;
}

/** Mean body-point speed (frame heights per second) under which the body counts as holding still. */
export function holdThreshold(bodySpeed: ArrayLike<number>): number {
  const p90 = quantile(bodySpeed, 0.9);
  return Math.min(0.08, Math.max(0.03, 0.15 * (Number.isFinite(p90) ? p90 : 0)));
}

/** Holds: stretches where the whole body stays still for at least `minDurS`. */
export function holdSegments(bodySpeed: ArrayLike<number>, t: ArrayLike<number>, minDurS = 0.5): Segment[] {
  const n = bodySpeed.length;
  if (!n) return [];
  const dt = n > 1 ? (t[n - 1] - t[0]) / (n - 1) : 1 / 30;
  const v = movingAverage(fillGaps(bodySpeed), Math.max(1, Math.round(0.2 / dt)));
  const thr = holdThreshold(v);
  return runs(Array.from(v, (x) => x < thr))
    .filter(([a, b]) => t[b] - t[a] + dt >= minDurS)
    .map(([a, b]) => {
      const key = (a + b) >> 1;
      return { start: a, end: b, key, keyRange: [a, b] as [number, number] };
    });
}

/** Phrases of `beatsPer` beats, starting on the first beat. A last phrase counts if at least half of it was recorded. */
export function phraseSegments(beats: number[], beatsPer: number, t: ArrayLike<number>): Segment[] {
  const n = t.length;
  if (!beats.length || !n) return [];
  const sorted = [...beats].sort((a, b) => a - b);
  const interval = sorted.length > 1 ? (sorted[sorted.length - 1] - sorted[0]) / (sorted.length - 1) : 0.5;
  const out: Segment[] = [];
  for (let k = 0; k < sorted.length; k += beatsPer) {
    const beatsHere = Math.min(beatsPer, sorted.length - k);
    if (beatsHere < beatsPer / 2) break;
    const t0 = sorted[k];
    const t1 = k + beatsPer < sorted.length ? sorted[k + beatsPer] : sorted[sorted.length - 1] + interval;
    if (t0 > t[n - 1] || t1 < t[0]) continue;
    const start = nearestIndex(t, t0);
    let end = nearestIndex(t, t1);
    if (k + beatsPer < sorted.length) end = Math.max(start, end - 1);
    out.push({ start, end, key: start, keyRange: [start, start] });
  }
  return out;
}

export function wholeSegment(n: number, signal?: ArrayLike<number>): Segment[] {
  if (!n) return [];
  const key = signal ? Math.max(0, argmax(fillGaps(signal))) : n >> 1;
  return [{ start: 0, end: n - 1, key, keyRange: [key, key] }];
}

export const BUILTIN_PHASE_NAMES = ["down", "up", "bottom", "peak", "top", "start", "end", "hold"] as const;

/**
 * Built-in phases as frame masks over the whole clip:
 * - `down`: from the start of a segment to its turning point; `up`: from the turning point to the end
 * - `bottom` / `peak`: at the turning point (including a pause there)
 * - `top`: the segment's first and last frames (the resting position between repetitions)
 * - `start`, `end`: first and last frame; `hold`: frames inside a segment where the body is still
 */
export function builtinPhases(segments: Segment[], n: number, stillMask?: ArrayLike<boolean | number>): Record<string, Uint8Array> {
  const m: Record<string, Uint8Array> = {};
  for (const p of BUILTIN_PHASE_NAMES) m[p] = new Uint8Array(n);
  for (const s of segments) {
    for (let i = s.start; i < s.key; i++) m.down[i] = 1;
    for (let i = s.key; i <= s.end; i++) m.up[i] = 1;
    for (let i = s.keyRange[0]; i <= s.keyRange[1]; i++) {
      m.bottom[i] = 1;
      m.peak[i] = 1;
    }
    m.top[s.start] = 1;
    m.top[s.end] = 1;
    m.start[s.start] = 1;
    m.end[s.end] = 1;
    if (stillMask) for (let i = s.start; i <= s.end; i++) if (stillMask[i]) m.hold[i] = 1;
  }
  return m;
}
