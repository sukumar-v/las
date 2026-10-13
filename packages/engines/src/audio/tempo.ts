/**
 * Tempo and beat grids from onset times, plus the tap-test calibration of the device's output
 * delay. All inputs and outputs are in seconds unless a name says ms.
 */
import { linearFit, percentile } from "./dsp.js";

export interface TempoEstimate {
  bpm: number;
  /** tempo change from the first half to the second, percent (positive = sped up) */
  driftPct: number;
  /** share of onsets that sit on the fitted beat grid */
  confidence: number;
  /** fitted grid: beat k is at offset + k * period */
  offset: number;
  period: number;
}

/**
 * Tempo from onsets. The onsets become a train of small Gaussian bumps sampled every 5 ms; its
 * autocorrelation is high at lags where onsets repeat. Each lag between 40 and 240 BPM is
 * weighted by a broad preference for moderate tempos (one octave either side of 120 BPM, as
 * librosa does) so a beat and its double are told apart sensibly. The best lag is then refined
 * by fitting a straight line through the onsets that sit near that beat grid.
 */
export function estimateTempo(onsets: number[], opts: { minBpm?: number; maxBpm?: number } = {}): TempoEstimate {
  const t = onsets.filter(Number.isFinite).sort((a, b) => a - b);
  const none: TempoEstimate = { bpm: NaN, driftPct: NaN, confidence: 0, offset: NaN, period: NaN };
  if (t.length < 3) return none;
  const res = 0.005;
  const t0 = t[0];
  const n = Math.ceil((t[t.length - 1] - t0) / res) + 8;
  const train = new Float64Array(n);
  const sigma = 2; // bins (10 ms)
  for (const x of t) {
    const c = (x - t0) / res + 4;
    for (let k = Math.max(0, Math.floor(c - 3 * sigma)); k <= Math.min(n - 1, Math.ceil(c + 3 * sigma)); k++) train[k] += Math.exp(-0.5 * ((k - c) / sigma) ** 2);
  }
  const minLag = Math.max(1, Math.floor(60 / (opts.maxBpm ?? 240) / res));
  const maxLag = Math.min(n - 1, Math.ceil(60 / (opts.minBpm ?? 40) / res));
  const score = new Float64Array(maxLag + 2);
  let best = -1;
  for (let L = minLag; L <= maxLag; L++) {
    let s = 0;
    for (let i = 0; i + L < n; i++) s += train[i] * train[i + L];
    const bpm = 60 / (L * res);
    score[L] = s * Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    if (best < 0 || score[L] > score[best]) best = L;
  }
  if (best < 0 || score[best] <= 0) return none;
  // A beat and half its tempo explain a steady pulse equally well (every second onset repeats
  // too). Prefer the faster reading when its own repetition is nearly as strong, i.e. when the
  // onsets in between are really there.
  const ac = (L: number) => score[L] / Math.exp(-0.5 * Math.log2(60 / (L * res) / 120) ** 2);
  for (;;) {
    const h = Math.round(best / 2);
    if (h < minLag) break;
    let hb = h;
    for (let L = Math.max(minLag, h - 2); L <= Math.min(maxLag, h + 2); L++) if (score[L] > score[hb]) hb = L;
    if (ac(hb) >= 0.8 * ac(best)) best = hb;
    else break;
  }
  // parabolic interpolation around the best lag
  let lag = best;
  if (best > minLag && best < maxLag) {
    const a = score[best - 1];
    const b = score[best];
    const c = score[best + 1];
    const d = a - 2 * b + c;
    if (d < 0) lag = best + (0.5 * (a - c)) / d;
  }
  return fitGrid(t, lag * res);
}

/** Fits beat k at offset + k*period through the onsets near a grid of roughly `period`. */
function fitGrid(t: number[], period0: number): TempoEstimate {
  // phase: circular mean of the onsets' positions within the beat
  let sx = 0;
  let sy = 0;
  for (const x of t) {
    const a = (2 * Math.PI * x) / period0;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  let offset = ((Math.atan2(sy, sx) / (2 * Math.PI)) * period0 + period0) % period0;
  let period = period0;
  let ks: number[] = [];
  let ts: number[] = [];
  for (let iter = 0; iter < 3; iter++) {
    ks = [];
    ts = [];
    for (const x of t) {
      const k = Math.round((x - offset) / period);
      if (Math.abs(x - offset - k * period) <= 0.2 * period) {
        ks.push(k);
        ts.push(x);
      }
    }
    if (new Set(ks).size < 2) break;
    const f = linearFit(ks, ts);
    if (!Number.isFinite(f.b) || f.b <= 0) break;
    offset = f.a;
    period = f.b;
  }
  const bpm = 60 / period;
  // drift: the typical beat length (each gap between onsets divided by how many beats it spans)
  // in the first half against the second half, so a steady acceleration shows up in full
  let driftPct = 0;
  const per: number[] = [];
  for (let i = 1; i < t.length; i++) {
    const beats = Math.round((t[i] - t[i - 1]) / period);
    if (beats >= 1 && Math.abs(t[i] - t[i - 1] - beats * period) <= 0.25 * period) per.push((t[i] - t[i - 1]) / beats);
  }
  const half = per.length >> 1;
  if (half >= 2) {
    const p1 = percentile(per.slice(0, half), 50);
    const p2 = percentile(per.slice(per.length - half), 50);
    if (p1 > 0 && p2 > 0) driftPct = (p1 / p2 - 1) * 100;
  }
  return { bpm, driftPct, confidence: ks.length / t.length, offset, period };
}

/** A beat grid from onsets: the movement engine uses this as its beat source when music is playing. */
export function beatsFromOnsets(onsets: number[]): { bpm: number; beats: number[]; confidence: number } {
  const est = estimateTempo(onsets);
  if (!Number.isFinite(est.bpm)) return { bpm: NaN, beats: [], confidence: 0 };
  const t = onsets.filter(Number.isFinite).sort((a, b) => a - b);
  const kFirst = Math.ceil((t[0] - est.period / 2 - est.offset) / est.period);
  const kLast = Math.floor((t[t.length - 1] + est.period / 2 - est.offset) / est.period);
  const beats: number[] = [];
  for (let k = kFirst; k <= kLast; k++) beats.push(est.offset + k * est.period);
  return { bpm: est.bpm, beats, confidence: est.confidence };
}

/**
 * The 10-second tap test. The learner taps along with clicks they hear; each tap lands late by
 * the device's output delay (Bluetooth headphones add a lot) plus their own small, random error.
 * Each tap is paired with the click it most likely answers (the one between a quarter interval
 * after and three quarters before it), and the delay is the median gap; jitter is the spread.
 */
export function calibrateOutputDelay(tapTimes: number[], clickTimes: number[]): { delayMs: number; jitterMs: number } {
  const clicks = clickTimes.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clicks.length || !tapTimes.length) return { delayMs: NaN, jitterMs: NaN };
  const gaps = clicks.slice(1).map((c, i) => c - clicks[i]);
  const interval = gaps.length ? percentile(gaps, 50) : 1;
  const d: number[] = [];
  for (const tap of tapTimes) {
    let best: number | undefined;
    for (const c of clicks) {
      const x = tap - c;
      if (x > -0.25 * interval && x <= 0.75 * interval && (best === undefined || Math.abs(x) < Math.abs(best))) best = x;
    }
    if (best !== undefined) d.push(best);
  }
  if (!d.length) return { delayMs: NaN, jitterMs: NaN };
  const med = percentile(d, 50);
  const sd = d.length > 1 ? Math.sqrt(d.reduce((s, x) => s + (x - med) ** 2, 0) / (d.length - 1)) : 0;
  return { delayMs: med * 1000, jitterMs: sd * 1000 };
}
