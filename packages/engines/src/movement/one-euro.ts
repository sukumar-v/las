/**
 * The One Euro filter (Casiez, Roussel and Vogel, CHI 2012): a low-pass filter whose cutoff
 * frequency rises with the speed of the signal. When a point is nearly still, the cutoff is low
 * and jitter is smoothed away; when it moves fast, the cutoff rises so the output keeps up
 * without lag. It's a published algorithm, implemented here, not a dependency.
 *
 * For a recorded clip we also run it backwards in time and average both passes. Each pass lags
 * in its own direction, so the average has (almost) no lag: events like a foot landing keep
 * their true time. The live framing guide uses the forward pass only (`zeroLag: false`).
 */
import type { Point, PoseFrame } from "../types.js";

export interface OneEuroOptions {
  /** cutoff in Hz when the signal is still: lower means smoother */
  minCutoff?: number;
  /** how quickly the cutoff rises with speed (per unit/second): higher means less lag */
  beta?: number;
  /** cutoff in Hz for the speed estimate itself */
  dCutoff?: number;
}

/** Defaults tuned for landmarks in normalized frame coordinates (speeds of about 0.1 to 3 units per second). */
export const ONE_EURO_DEFAULTS: Required<OneEuroOptions> = { minCutoff: 2, beta: 20, dCutoff: 5 };

function alpha(cutoffHz: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
}

/** One scalar channel. Feed it samples in time order with `filter(x, t)`. */
export class OneEuroFilter {
  readonly minCutoff: number;
  readonly beta: number;
  readonly dCutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(opts: OneEuroOptions = {}) {
    this.minCutoff = opts.minCutoff ?? ONE_EURO_DEFAULTS.minCutoff;
    this.beta = opts.beta ?? ONE_EURO_DEFAULTS.beta;
    this.dCutoff = opts.dCutoff ?? ONE_EURO_DEFAULTS.dCutoff;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  filter(x: number, t: number): number {
    if (!Number.isFinite(x)) return x;
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }
    // time can run backwards in the backward pass; only the step size matters
    const dt = Math.abs(t - this.tPrev);
    if (dt <= 0) return this.xPrev;
    // 1. estimate the speed and smooth it with a fixed cutoff
    const dx = (x - this.xPrev) / dt;
    const aD = alpha(this.dCutoff, dt);
    const edx = aD * dx + (1 - aD) * this.dxPrev;
    // 2. the faster the signal moves, the higher the cutoff (less smoothing, less lag)
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const a = alpha(cutoff, dt);
    const out = a * x + (1 - a) * this.xPrev;
    this.xPrev = out;
    this.dxPrev = edx;
    this.tPrev = t;
    return out;
  }
}

/**
 * Smooth one signal sampled at `times`. NaN samples pass through and don't disturb the filter.
 * With `zeroLag` (default) the forward and backward passes are averaged.
 */
export function oneEuro(values: ArrayLike<number>, times: ArrayLike<number>, opts: OneEuroOptions & { zeroLag?: boolean } = {}): Float64Array {
  const n = values.length;
  const fwd = new Float64Array(n);
  const f = new OneEuroFilter(opts);
  for (let i = 0; i < n; i++) fwd[i] = f.filter(values[i], times[i]);
  if (opts.zeroLag === false) return fwd;
  const b = new OneEuroFilter(opts);
  const out = new Float64Array(n);
  const bwd = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) bwd[i] = b.filter(values[i], times[i]);
  for (let i = 0; i < n; i++) out[i] = (fwd[i] + bwd[i]) / 2;
  return out;
}

export interface SmoothOptions extends OneEuroOptions {
  /** average a forward and a backward pass so smoothing adds no lag (recorded clips); default true */
  zeroLag?: boolean;
  /** points below this visibility are left as they are and not fed to the filter; default 0.3 */
  minVisibility?: number;
}

type Slot = (f: PoseFrame) => Point | undefined;

/** Every tracked point present anywhere in the clip, as a getter for one frame. */
function slots(frames: PoseFrame[]): Slot[] {
  const pose = new Set<string>();
  const face = new Set<string>();
  const hands = { left: new Set<string>(), right: new Set<string>() };
  const objects = new Set<string>();
  for (const f of frames) {
    for (const k of Object.keys(f.pose ?? {})) pose.add(k);
    for (const k of Object.keys(f.face ?? {})) face.add(k);
    for (const k of Object.keys(f.hands?.left ?? {})) hands.left.add(k);
    for (const k of Object.keys(f.hands?.right ?? {})) hands.right.add(k);
    for (const k of Object.keys(f.objects ?? {})) objects.add(k);
  }
  const out: Slot[] = [];
  for (const k of pose) out.push((f) => f.pose?.[k]);
  for (const k of face) out.push((f) => f.face?.[k]);
  for (const side of ["left", "right"] as const) for (const k of hands[side]) out.push((f) => f.hands?.[side]?.[k]);
  for (const k of objects) out.push((f) => f.objects?.[k]?.center);
  return out;
}

function cloneFrame(f: PoseFrame): PoseFrame {
  const c: PoseFrame = { t: f.t };
  if (f.pose) c.pose = Object.fromEntries(Object.entries(f.pose).map(([k, p]) => [k, [...p] as Point]));
  if (f.face) c.face = Object.fromEntries(Object.entries(f.face).map(([k, p]) => [k, [...p] as Point]));
  if (f.hands) {
    c.hands = {};
    if (f.hands.left) c.hands.left = Object.fromEntries(Object.entries(f.hands.left).map(([k, p]) => [k, [...p] as Point]));
    if (f.hands.right) c.hands.right = Object.fromEntries(Object.entries(f.hands.right).map(([k, p]) => [k, [...p] as Point]));
  }
  if (f.objects) c.objects = Object.fromEntries(Object.entries(f.objects).map(([k, o]) => [k, { center: [...o.center] as Point, w: o.w, h: o.h }]));
  return c;
}

/**
 * Smooth every landmark of a clip with the One Euro filter. Visibility is kept as tracked.
 * Frames without a timestamp spacing fall back to 1/fps. Returns new frames; the input is untouched.
 */
export function smoothFrames(frames: PoseFrame[], fps: number, opts: SmoothOptions = {}): PoseFrame[] {
  const out = frames.map(cloneFrame);
  const minVis = opts.minVisibility ?? 0.3;
  const times = frames.map((f, i) => (Number.isFinite(f.t) ? f.t : i / fps));
  for (const slot of slots(frames)) {
    for (let axis = 0; axis < 3; axis++) {
      const vals = new Float64Array(frames.length);
      for (let i = 0; i < frames.length; i++) {
        const p = slot(frames[i]);
        vals[i] = p && p[3] >= minVis ? p[axis] : NaN;
      }
      const sm = oneEuro(vals, times, opts);
      for (let i = 0; i < out.length; i++) {
        const p = slot(out[i]);
        if (p && Number.isFinite(sm[i])) p[axis] = sm[i];
      }
    }
  }
  return out;
}
