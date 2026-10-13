/** Small numeric helpers for evenly or unevenly sampled signals. */

/** Derivative by central differences using the sample times (one-sided at the ends). NaN stays NaN. */
export function derivative(v: ArrayLike<number>, t: ArrayLike<number>): Float64Array {
  const n = v.length;
  const out = new Float64Array(n).fill(NaN);
  if (n < 2) return out.fill(0);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const dt = t[b] - t[a];
    if (dt > 0) out[i] = (v[b] - v[a]) / dt;
  }
  return out;
}

/** Centered moving average over `window` samples, ignoring NaN. */
export function movingAverage(v: ArrayLike<number>, window: number): Float64Array {
  const n = v.length;
  const h = Math.max(0, Math.floor(window / 2));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let k = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) {
      if (Number.isFinite(v[j])) {
        s += v[j];
        k++;
      }
    }
    out[i] = k ? s / k : NaN;
  }
  return out;
}

/** Contiguous runs of `true` as [first, last] index pairs (inclusive). */
export function runs(mask: ArrayLike<boolean | number>): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < mask.length; i++) {
    const on = !!mask[i];
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) out.push([start, mask.length - 1]);
  return out;
}

export function quantile(v: ArrayLike<number>, q: number): number {
  const s = Array.from(v).filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Standard deviation of the sample-to-sample noise, from second differences
 * (smooth motion barely changes them; jitter does). Robust: uses the median absolute value.
 */
export function noiseSigma(v: ArrayLike<number>): number {
  const d: number[] = [];
  for (let i = 1; i + 1 < v.length; i++) {
    const x = v[i - 1] - 2 * v[i] + v[i + 1];
    if (Number.isFinite(x)) d.push(Math.abs(x));
  }
  if (!d.length) return 0;
  return (1.4826 * quantile(d, 0.5)) / Math.sqrt(6);
}

/** Index of the largest finite value in [from, to]. */
export function argmax(v: ArrayLike<number>, from = 0, to = v.length - 1): number {
  let best = -1;
  for (let i = from; i <= to; i++) if (Number.isFinite(v[i]) && (best < 0 || v[i] > v[best])) best = i;
  return best;
}
export function argmin(v: ArrayLike<number>, from = 0, to = v.length - 1): number {
  let best = -1;
  for (let i = from; i <= to; i++) if (Number.isFinite(v[i]) && (best < 0 || v[i] < v[best])) best = i;
  return best;
}

/** Fill NaN gaps by linear interpolation (ends hold the nearest value). */
export function fillGaps(v: ArrayLike<number>): Float64Array {
  const out = Float64Array.from(v);
  const n = out.length;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(out[i])) continue;
    if (last < 0) for (let j = 0; j < i; j++) out[j] = out[i];
    else if (i - last > 1) for (let j = last + 1; j < i; j++) out[j] = out[last] + ((out[i] - out[last]) * (j - last)) / (i - last);
    last = i;
  }
  if (last >= 0) for (let j = last + 1; j < n; j++) out[j] = out[last];
  return out;
}

/** Index of the time closest to `x` in sorted times. */
export function nearestIndex(times: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - x) <= Math.abs(times[lo] - x)) return lo - 1;
  return lo;
}
