/**
 * Timing against a beat: when does a point come down and land (a foot stepping, a hand striking),
 * and how far is each landing from the nearest beat.
 */
import { fillGaps, noiseSigma, quantile } from "./signal.js";

export interface AlignResult {
  /** per event: signed offset to the nearest beat in ms (negative = early), or null when no beat is near */
  offsetsMs: (number | null)[];
  /** share of events within the tolerance of a beat */
  onBeatShare: number;
}

/**
 * Match each event to its nearest beat. Events more than half a beat interval outside the span of
 * beats get no offset (null) and count as off the beat.
 */
export function alignToBeats(eventTimes: number[], beats: number[], toleranceMs: number): AlignResult {
  const b = [...beats].filter(Number.isFinite).sort((x, y) => x - y);
  if (!b.length) return { offsetsMs: eventTimes.map(() => null), onBeatShare: 0 };
  const interval = b.length > 1 ? (b[b.length - 1] - b[0]) / (b.length - 1) : Infinity;
  const offsetsMs = eventTimes.map((e) => {
    if (e < b[0] - interval / 2 || e > b[b.length - 1] + interval / 2) return null;
    let lo = 0;
    let hi = b.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (b[mid] < e) lo = mid + 1;
      else hi = mid;
    }
    let best = b[lo];
    if (lo > 0 && Math.abs(b[lo - 1] - e) <= Math.abs(best - e)) best = b[lo - 1];
    return (e - best) * 1000;
  });
  const on = offsetsMs.filter((o) => o !== null && Math.abs(o) <= toleranceMs).length;
  return { offsetsMs, onBeatShare: eventTimes.length ? on / eventTimes.length : 0 };
}

/**
 * Landing times of one point from its image y (which grows downward). Use the unsmoothed track:
 * any smoothing rounds the sharp stop at contact and shifts it in time.
 *
 * The point's resting level is where it spends most time low (90th percentile of y) and its lift is
 * how far it rises from there. A landing is a rise of at least half that height followed by a
 * descent back down. For each descent we fit a straight line (least squares) through the samples
 * between 75% and 10% of the lift height and find where that line meets the ground level right
 * after landing. The line uses several frames, so the estimate is accurate to a few milliseconds
 * even at 30 fps and tolerant of jitter.
 */
export function landingTimes(y: ArrayLike<number>, conf: ArrayLike<number>, t: ArrayLike<number>, minLift = 0.01): number[] {
  const n = y.length;
  if (n < 3) return [];
  const masked = Array.from(y, (v, i) => (conf[i] >= 0.3 ? v : NaN));
  if (masked.filter(Number.isFinite).length < 3) return [];
  const s = fillGaps(masked);
  const ground = quantile(s, 0.9);
  const top = quantile(s, 0.02);
  const lift = ground - top;
  if (!(lift > Math.max(minLift, 8 * noiseSigma(s)))) return [];
  const airLevel = ground - 0.5 * lift;
  const crossLevel = ground - 0.3 * lift;
  const dt = (t[n - 1] - t[0]) / (n - 1);
  const settle = Math.max(2, Math.round(0.2 / dt));
  const out: number[] = [];
  let inAir = false;
  for (let i = 1; i < n; i++) {
    if (!inAir && s[i] < airLevel) inAir = true;
    if (!(inAir && s[i - 1] < crossLevel && s[i] >= crossLevel)) continue;
    inAir = false;
    // the ground where this landing settles: median height over the next 0.2 s
    const after = Array.from(s.subarray(i, Math.min(n, i + settle)));
    const g = Math.max(quantile(after, 0.5), crossLevel);
    // samples on the way down between 75% and 10% of the lift above that ground, walking out from
    // the crossing while the point keeps descending (so jitter on the ground isn't included)
    const xs: number[] = [];
    const ys: number[] = [];
    const inBand = (j: number) => g - s[j] <= 0.75 * lift && g - s[j] >= 0.1 * lift;
    for (let j = i; j < n && j <= i + settle && inBand(j) && (j === i || s[j] > s[j - 1]); j++) {
      xs.push(t[j]);
      ys.push(s[j]);
    }
    for (let j = i - 1; j >= 0 && j >= i - settle && inBand(j) && s[j] < s[j + 1]; j--) {
      xs.push(t[j]);
      ys.push(s[j]);
    }
    let landing = NaN;
    if (xs.length >= 2) {
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let num = 0;
      let den = 0;
      for (let k = 0; k < xs.length; k++) {
        num += (xs[k] - mx) * (ys[k] - my);
        den += (xs[k] - mx) ** 2;
      }
      const slope = den > 0 ? num / den : 0;
      if (slope > 0) landing = mx + (g - my) / slope;
    }
    if (!Number.isFinite(landing) || landing < t[i - 1] || landing > t[i] + 0.15) {
      // fallback: interpolate the crossing and continue at the descent speed to the ground
      const v = (s[i] - s[i - 1]) / (t[i] - t[i - 1]);
      const tc = t[i - 1] + ((crossLevel - s[i - 1]) / (s[i] - s[i - 1])) * (t[i] - t[i - 1]);
      landing = tc + Math.min(0.15, (g - crossLevel) / Math.max(v, 1e-6));
    }
    out.push(landing);
  }
  return out;
}

/** Merge landing times from several points into one sorted list, joining near-duplicates (within 60 ms). */
export function mergeEvents(lists: number[][], minGapS = 0.06): number[] {
  const all = lists.flat().sort((a, b) => a - b);
  const out: number[] = [];
  for (const e of all) {
    if (out.length && e - out[out.length - 1] < minGapS) continue;
    out.push(e);
  }
  return out;
}
