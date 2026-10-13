/**
 * Sensor engine: cadence, swing tempo, steadiness, step counts and impact from the phone's motion
 * sensors (accelerometer in m/s², optional gyroscope in rad/s). Configured by a sensor spec; it
 * doesn't know what activity produced the motion.
 */
import { SensorSpecSchema, type Analysis, type MetricValue, type SensorSpec } from "@las/schema";
import type { AnalyzeContext, SensorEvidence } from "../types.js";
import { evalCondition, finish, mean, median, metric, metricVars, reRecord, std, version } from "../common/analysis.js";

export { steppingSamples, swingSamples, stillSamples, syntheticSensor, type SensorSample, type SteppingOptions, type SwingSampleOptions, type StillOptions } from "./synthetic.js";

const STANDARD_GRAVITY = 9.80665;

/** Optional extra context: proof or drill criteria as `id -> expression` over the metrics and `target`. */
export interface SensorContext extends AnalyzeContext {
  criteria?: Record<string, string>;
}

type SensorSpecLike = Pick<SensorSpec, "detect"> & Partial<SensorSpec>;

const PLACEMENT_WORDS: Record<string, string> = {
  pocket: "in your pocket",
  hand: "in your hand",
  wrist: "on your wrist",
  strapped: "strapped on",
  "on-object": "attached to the object"
};

/** Evenly resampled signals at `rate` Hz (linear interpolation between samples). */
interface Uniform {
  rate: number;
  t: Float64Array;
  ax: Float64Array;
  ay: Float64Array;
  az: Float64Array;
  g?: [Float64Array, Float64Array, Float64Array];
}

function resample(samples: SensorEvidence["samples"]): Uniform {
  const s = [...samples].filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
  const dts: number[] = [];
  for (let i = 1; i < s.length; i++) if (s[i].t > s[i - 1].t) dts.push(s[i].t - s[i - 1].t);
  const rate = Math.max(20, Math.min(500, 1 / (median(dts) || 0.01)));
  const t0 = s[0].t;
  const n = Math.max(1, Math.floor((s[s.length - 1].t - t0) * rate) + 1);
  const t = Float64Array.from({ length: n }, (_, i) => t0 + i / rate);
  const hasGyro = s.every((x) => Number.isFinite(x.gx) && Number.isFinite(x.gy) && Number.isFinite(x.gz));
  const pick = (k: "ax" | "ay" | "az" | "gx" | "gy" | "gz") => {
    const out = new Float64Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      while (j + 1 < s.length && s[j + 1].t <= t[i]) j++;
      const a = s[j];
      const b = s[Math.min(s.length - 1, j + 1)];
      const va = a[k] ?? 0;
      const vb = b[k] ?? 0;
      out[i] = b.t > a.t ? va + ((vb - va) * (t[i] - a.t)) / (b.t - a.t) : va;
    }
    return out;
  };
  return { rate, t, ax: pick("ax"), ay: pick("ay"), az: pick("az"), g: hasGyro ? [pick("gx"), pick("gy"), pick("gz")] : undefined };
}

function movingAverage(v: Float64Array, w: number): Float64Array {
  const h = Math.max(0, Math.floor(w / 2));
  const out = new Float64Array(v.length);
  let s = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < v.length; i++) {
    const a = Math.max(0, i - h);
    const b = Math.min(v.length - 1, i + h);
    while (hi < b) s += v[++hi];
    while (lo < a) s -= v[lo++];
    out[i] = s / (hi - lo + 1);
  }
  return out;
}

/**
 * The dominant period of a signal in [minS, maxS] seconds by autocorrelation: correlate the signal
 * with itself shifted by each lag; a repeating motion correlates strongly at its period. Takes the
 * shortest lag whose correlation is within 80% of the best (so a two-step stride isn't mistaken for
 * the step), refined between samples with a parabola through the peak and its neighbours.
 */
function dominantPeriod(x: Float64Array, rate: number, minS: number, maxS: number): { periodS: number; strength: number } {
  const n = x.length;
  const m = mean(x);
  const c = Float64Array.from(x, (v) => v - m);
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += c[i] * c[i];
  const lo = Math.max(1, Math.floor(minS * rate));
  const hi = Math.min(n - 2, Math.ceil(maxS * rate));
  if (!(e0 > 0) || hi <= lo) return { periodS: NaN, strength: 0 };
  const r = new Float64Array(hi + 2);
  for (let L = lo - 1; L <= hi + 1; L++) {
    let s = 0;
    for (let i = 0; i + L < n; i++) s += c[i] * c[i + L];
    // unbiased: compensate for fewer overlapping samples at long lags
    r[L] = (s / e0) * (n / (n - L));
  }
  let best = lo;
  for (let L = lo; L <= hi; L++) if (r[L] > r[best]) best = L;
  let pick = best;
  for (let L = lo; L <= hi; L++) {
    if (r[L] >= 0.8 * r[best] && r[L] >= r[L - 1] && r[L] >= r[L + 1]) {
      pick = L;
      break;
    }
  }
  const a = r[pick - 1];
  const b = r[pick];
  const cc = r[pick + 1];
  const den = a - 2 * b + cc;
  const shift = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - cc)) / den)) : 0;
  return { periodS: (pick + shift) / rate, strength: Math.max(0, Math.min(1, b)) };
}

/** Local maxima above `threshold`, at least `minGap` samples apart (the higher one wins). */
function findPeaks(x: Float64Array, threshold: number, minGap: number): number[] {
  const peaks: number[] = [];
  for (let i = 1; i + 1 < x.length; i++) {
    if (x[i] < threshold || x[i] < x[i - 1] || x[i] < x[i + 1]) continue;
    const last = peaks[peaks.length - 1];
    if (last !== undefined && i - last < minGap) {
      if (x[i] > x[last]) peaks[peaks.length - 1] = i;
    } else peaks.push(i);
  }
  return peaks;
}

interface SwingPhases {
  start: number;
  top: number;
  peak: number;
}

/**
 * Swing phases around the fastest moment, from the gyroscope: take the rotation axis that moves
 * most; the peak is the fastest rotation; the top is where the rotation last reversed before it
 * (interpolated between samples); the start is where the backswing's rotation began (speed under 5%
 * of the backswing's own maximum). Indices are fractional samples.
 */
function swingPhases(rate: number, gyro: [Float64Array, Float64Array, Float64Array]): SwingPhases | null {
  const vars = gyro.map((a) => std(a));
  const om = movingAverage(gyro[vars.indexOf(Math.max(...vars))], Math.max(1, Math.round(0.02 * rate)));
  let peak = 0;
  for (let i = 0; i < om.length; i++) if (Math.abs(om[i]) > Math.abs(om[peak])) peak = i;
  const s = Math.sign(om[peak]);
  let top = -1;
  for (let i = peak; i > 0; i--) {
    if (om[i] * s > 0 && om[i - 1] * s <= 0) {
      top = i;
      break;
    }
  }
  if (top < 0) return null;
  const topF = top - 1 + (0 - om[top - 1] * s) / (om[top] * s - om[top - 1] * s);
  let ext = top - 1;
  for (let i = top - 1; i >= 0 && om[i] * s <= 0; i--) if (om[i] * s < om[ext] * s) ext = i;
  const backMax = Math.abs(om[ext]);
  if (!(backMax > 0.2)) return null;
  let start = 0;
  for (let i = ext; i > 0; i--) {
    if (Math.abs(om[i]) < 0.05 * backMax) {
      start = i;
      break;
    }
  }
  return { start, top: topF, peak };
}

export function analyzeSensor(specIn: SensorSpecLike, evidence: SensorEvidence, ctx: SensorContext = {}): Analysis {
  const v = version("sensor", ctx.specId, ctx.modelVersion);
  const parsed = SensorSpecSchema.safeParse(specIn);
  if (!parsed.success) return finish({ engine: "sensor", quality: { ok: false, issues: parsed.error.issues.map((i) => `spec ${i.path.join(".")}: ${i.message}`) }, version: v });
  const spec = parsed.data;
  const where = PLACEMENT_WORDS[spec.placement] ?? "in place";
  const samples = evidence.samples ?? [];
  const minS = spec.detect === "swing-tempo" || spec.detect === "impact" ? 2 : Math.min(5, spec.duration_s * 0.3);
  const span = samples.length ? samples[samples.length - 1].t - samples[0].t : 0;
  if (samples.length < 20 || span < minS) {
    return reRecord("sensor", [`too few samples: ${samples.length} over ${span.toFixed(1)} s`], `The recording was too short. Keep the phone ${where} and record for at least ${Math.ceil(Math.max(minS, spec.detect === "swing-tempo" ? 3 : spec.duration_s * 0.5))} seconds.`, v);
  }
  const u = resample(samples);
  const mag = Float64Array.from(u.ax, (x, i) => Math.hypot(x, u.ay[i], u.az[i]));
  // gravity is the steady part of the magnitude; what's left is the motion
  const g0 = median(mag);
  const dyn = Float64Array.from(mag, (m) => m - g0);
  const motion = std(dyn);
  const gyroMotion = u.g ? Math.max(...u.g.map((a) => std(a))) : 0;
  const issues: string[] = [];
  if (Math.abs(g0 - STANDARD_GRAVITY) > 2) issues.push(`gravity reads ${g0.toFixed(1)} m/s²: check the sensor units`);
  if (spec.detect !== "steadiness" && motion < 0.15 && gyroMotion < 0.1) {
    return reRecord("sensor", ["no motion detected"], `I didn't feel any movement. Keep the phone ${where} and start moving once recording begins.`, v);
  }

  const metrics: Record<string, MetricValue> = {};
  const markers: { t: number; label: string; role: "good" | "attention" | "reference" | "neutral" }[] = [];
  let segments: [number, number][] | undefined;
  const events: { t: number; label: string }[] = [];
  const placementConf = spec.placement === "hand" ? 0.9 : 1;

  metrics.peak_g = metric(Math.max(...mag) / STANDARD_GRAVITY, "g", 1);

  if (spec.detect === "cadence" || spec.detect === "step-count") {
    // keep the step-rate band: remove slow drift (1 s average) and jitter (50 ms average)
    const hp = dyn;
    const slow = movingAverage(hp, Math.round(u.rate));
    const band = movingAverage(Float64Array.from(hp, (x, i) => x - slow[i]), Math.max(1, Math.round(0.05 * u.rate)));
    const { periodS, strength } = dominantPeriod(band, u.rate, 60 / 240, 60 / 40);
    const conf = Math.max(0, Math.min(1, (strength - 0.2) / 0.5)) * placementConf;
    if (Number.isFinite(periodS)) metrics.cadence_spm = metric(60 / periodS, "spm", conf);
    const thr = mean(band) + 0.5 * std(band);
    const peaks = findPeaks(band, thr, Math.max(1, Math.round((Number.isFinite(periodS) ? periodS : 0.3) * 0.6 * u.rate)));
    metrics.steps = metric(peaks.length, "steps", conf);
    peaks.forEach((p) => events.push({ t: u.t[p], label: "step" }));
    if (peaks.length) segments = [[u.t[peaks[0]], u.t[peaks[peaks.length - 1]]]];
  }

  if (spec.detect === "swing-tempo") {
    // acceleration alone mixes gravity, centripetal and tangential parts and can't time the phases
    // reliably, so swing tempo needs the gyroscope rather than guessing
    if (!u.g) return reRecord("sensor", ["no gyroscope samples"], "Swing tempo needs the phone's gyroscope. Allow motion access when asked, then record again.", v);
    const ph = swingPhases(u.rate, u.g);
    if (!ph) return reRecord("sensor", ["no swing found"], `I couldn't find a swing. Keep the phone ${where}, start still, and make one full swing per recording.`, v);
    const at = (i: number) => u.t[0] + i / u.rate;
    const back = (at(ph.top) - at(ph.start)) * 1000;
    const down = (at(ph.peak) - at(ph.top)) * 1000;
    const conf = 0.9 * placementConf;
    metrics.backswing_ms = metric(back, "ms", conf);
    metrics.downswing_ms = metric(down, "ms", conf);
    metrics.tempo_ratio = metric(back / down, "ratio", conf);
    markers.push({ t: at(ph.start), label: "start", role: "neutral" }, { t: at(ph.top), label: "top", role: "neutral" }, { t: at(ph.peak), label: "peak", role: "neutral" });
    segments = [
      [at(ph.start), at(ph.top)],
      [at(ph.top), at(ph.peak)]
    ];
  }

  if (spec.detect === "steadiness" || spec.detect === "impact") {
    // inverse variance: the less the phone wobbles around its average, the closer to 1
    const varA = std(u.ax) ** 2 + std(u.ay) ** 2 + std(u.az) ** 2;
    const varG = u.g ? u.g.reduce((s, a) => s + std(a) ** 2, 0) : 0;
    metrics.steadiness = metric(1 / (1 + varA / 0.05 + varG / 0.01), "0-1", placementConf);
  }

  const target = spec.target ?? {};
  const vars = metricVars(metrics, { target: { ...target }, baseline: { ...(ctx.baseline ?? {}) }, learner: { ...(ctx.learner ?? {}) } });
  const criteria: Record<string, boolean> = {};
  if (spec.pass) criteria.pass = evalCondition(spec.pass, vars) === true;
  for (const [id, src] of Object.entries(ctx.criteria ?? {})) criteria[id] = evalCondition(src, vars) === true;

  // praise: the metric closest to its target, when within 10%
  let praise: { metric: string; label: string } | undefined;
  let bestDev = 0.1;
  for (const [k, want] of Object.entries(target)) {
    const m = metrics[k];
    if (!m || !(want !== 0)) continue;
    const dev = Math.abs(m.value - want) / Math.abs(want);
    if (dev <= bestDev && m.confidence >= 0.7) {
      bestDev = dev;
      praise = { metric: k, label: `${k.replace(/_/g, " ")}: ${Math.round(m.value * 10) / 10}${m.unit ? ` ${m.unit}` : ""}`.slice(0, 60) };
    }
  }

  // a downsampled trace of the motion for the studio to plot (at most 600 points)
  const step = Math.max(1, Math.ceil(dyn.length / 600));
  const trace = { t: [] as number[], motion: [] as number[] };
  for (let i = 0; i < dyn.length; i += step) {
    trace.t.push(u.t[i]);
    trace.motion.push(dyn[i]);
  }

  return finish({
    engine: "sensor",
    quality: { ok: true, issues },
    metrics,
    markers,
    mistakes: [],
    criteria,
    ...(praise ? { praise } : {}),
    keyFrames: [],
    overlay: { kind: "sensor-trace", rate: u.rate, gravity: g0, ...trace, events },
    version: v,
    ...(segments ? { segments } : {}),
    precision: "full"
  });
}
