/**
 * The live framing guide (evaluation §4.1): the record button stays off until the needed body points are seen
 * (each at 60% confidence or more) for a full second, the light is bright enough and the phone is steady.
 * Pure math here; the capture screen feeds it frames and sensor readings.
 */
import { dottedNames, isKnownPoint, parseMetricExpr, POSE_GROUPS, type MetricSpec } from "@las/schema";

export const HOLD_MS = 1000;
/** Mean luma (0..1) below this is too dark to track reliably. */
export const LIGHT_MIN = 0.18;
/** Mean absolute frame difference (0..1) above this means the camera is moving. */
export const STILL_DIFF_MAX = 0.04;
/** Standard deviation of acceleration (m/s², gravity removed) above this means the phone is moving. */
export const STILL_ACCEL_MAX = 0.6;

/** Point names a metric spec measures: its `requires_visible`, else every body point its expressions read. */
export function neededPoints(spec: Pick<MetricSpec, "requires_visible" | "segment" | "metrics" | "phases">): string[] {
  if (spec.requires_visible?.length) return spec.requires_visible;
  const out = new Set<string>();
  const srcs = [spec.segment?.signal, ...Object.values(spec.metrics ?? {}), ...Object.values(spec.phases ?? {})];
  for (const src of srcs) {
    if (!src) continue;
    try {
      for (const n of dottedNames(parseMetricExpr(src).expr)) {
        const base = isKnownPoint(n) ? n : n.slice(0, n.lastIndexOf("."));
        if (base && isKnownPoint(base) && !["vertical", "horizontal", "ground"].includes(base)) out.add(base);
      }
    } catch {
      /* an unparsable expression is the validator's problem */
    }
  }
  return out.size ? [...out] : [...POSE_GROUPS.torso];
}

/** Mean luma of RGBA pixels, 0..1 (Rec. 709 weights). */
export function meanLuminance(data: ArrayLike<number>, step = 4): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 2 < data.length; i += 4 * step) {
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    n++;
  }
  return n ? sum / n / 255 : 0;
}

/** Mean absolute difference between two same-size RGBA frames, on the green channel, 0..1. */
export function frameDifference(a: ArrayLike<number>, b: ArrayLike<number>, step = 4): number {
  if (a.length !== b.length || !a.length) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < a.length; i += 4 * step) {
    sum += Math.abs(a[i] - b[i]);
    n++;
  }
  return n ? sum / n / 255 : 0;
}

/** Standard deviation of a list of numbers. */
export function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export interface GateInput {
  /** share of needed points visible, 0..1 */
  share: number;
  /** every needed point visible at the confidence floor */
  allVisible: boolean;
  light: boolean;
  steady: boolean;
}

export interface GateState {
  pointsVisible: number;
  light: boolean;
  steady: boolean;
  ready: boolean;
  /** how long the points have been in frame, seconds */
  seconds: number;
}

/** Holds the 1-second rule: ready once every needed point has stayed visible for HOLD_MS, with light and steadiness. */
export class ReadyGate {
  private since: number | undefined;
  constructor(private readonly holdMs = HOLD_MS) {}
  update(now: number, i: GateInput): GateState {
    if (i.allVisible) this.since ??= now;
    else this.since = undefined;
    const held = this.since === undefined ? 0 : now - this.since;
    return { pointsVisible: i.share, light: i.light, steady: i.steady, ready: i.allVisible && held >= this.holdMs && i.light && i.steady, seconds: held / 1000 };
  }
  reset(): void {
    this.since = undefined;
  }
}

/** Keeps the last second of acceleration magnitudes (gravity removed) to judge steadiness from DeviceMotion. */
export class MotionWindow {
  private samples: { t: number; a: number }[] = [];
  push(t: number, ax: number, ay: number, az: number): void {
    this.samples.push({ t, a: Math.hypot(ax, ay, az) });
    while (this.samples.length && t - this.samples[0].t > 1000) this.samples.shift();
  }
  get has(): boolean {
    return this.samples.length >= 5;
  }
  steady(): boolean {
    return stdDev(this.samples.map((s) => s.a)) <= STILL_ACCEL_MAX;
  }
}
