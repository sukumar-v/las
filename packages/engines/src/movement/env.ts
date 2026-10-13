/**
 * The expression environment for metric specs: what each name in a spec means for one clip, and
 * the movement functions registered on top of the standard library.
 *
 * Every expression is evaluated in a *view*: a set of frames (the whole clip, one repetition, the
 * frames of one phase...). Points resolve to their track over the view's frames; functions that need
 * time derivatives (velocity, speed, jerk) differentiate over the whole clip first and then keep the
 * view's frames, so a view made of separate frames doesn't produce false jumps.
 */
import {
  ExprRuntimeError,
  FACE_LANDMARKS,
  HAND_LANDMARKS,
  METRIC_KEYWORDS,
  OBJECT_CLASSES,
  POSE_GROUPS,
  STANDARD_FUNCTIONS,
  isKnownPoint,
  isPoints,
  isSeries,
  series,
  toArray,
  toNumber,
  truthy,
  type Env,
  type ExprFn,
  type PointSeries,
  type Series,
  type Value
} from "@las/schema";
import type { PoseFrame } from "../types.js";
import { alignToBeats } from "./beats.js";
import { compareToReference, type ReferenceComparison } from "./reference.js";
import type { Segment, SegmentKind } from "./segment.js";
import { derivative, movingAverage, runs } from "./signal.js";
import { constituents, isDirection, type Track, type Tracks } from "./tracks.js";

/** A point series that remembers its name and the whole-clip track it was cut from. */
export type NamedPoints = PointSeries & { name?: string; full?: PointSeries; idx?: Int32Array };
/** A series that remembers what produced it, so `overlay(angle(a, b, c))` knows which points to draw. */
export type TaggedSeries = Series & { src?: { fn: string; points: string[] } };

export interface StoredMetric {
  /** scalar: one number; frame: one value per frame of the clip; per: one per segment; items: one per event */
  kind: "scalar" | "frame" | "per" | "items";
  value: number;
  confidence: number;
  series?: Series;
  per?: number[];
  perKind?: SegmentKind;
}

export interface View {
  /** frame indices in the view, increasing */
  idx: Int32Array;
  kind?: SegmentKind;
  segIndex?: number;
  segment?: Segment;
}

/** Everything about one clip that views share. Built by the analyzer. */
export interface World {
  tracks: Tracks;
  frames: PoseFrame[];
  reference?: PoseFrame[];
  beats: number[];
  baseline: Record<string, number>;
  learner: Record<string, number | string>;
  capture: { angle: string; fps: number };
  pixelHeight: number;
  defaultKind: SegmentKind;
  phaseNames: string[];
  segments(kind: SegmentKind): Segment[];
  phaseMask(name: string, kind: SegmentKind): Uint8Array | null;
  stored: Map<string, StoredMetric>;
  /** landing times for a set of points, cached */
  landings(points: string[]): number[];
  /** the last whole-clip reference comparison, for drawing a ghost */
  lastComparison?: ReferenceComparison;
  /** landings that were matched to beats, for the beat timeline */
  beatEvents: Map<number, number | null>;
}

const DIRECTIONS: Record<string, [number, number]> = { vertical: [0, -1], horizontal: [1, 0] };

type Direction = { kind: "direction"; name: string };
function isDir(v: Value): v is Direction {
  return typeof v === "object" && v !== null && !Array.isArray(v) && (v as Record<string, Value>).kind === "direction";
}
function isReference(v: Value): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v) && (v as Record<string, Value>).kind === "reference";
}

export function allFrames(n: number): Int32Array {
  return Int32Array.from({ length: n }, (_, i) => i);
}

function sliceArr(a: Float64Array, idx: Int32Array, whole: boolean): Float64Array {
  if (whole) return a;
  const out = new Float64Array(idx.length);
  for (let j = 0; j < idx.length; j++) out[j] = a[idx[j]];
  return out;
}

function trackToPoints(tr: Track, t: Float64Array, name?: string): NamedPoints {
  return { kind: "points", x: tr.x, y: tr.y, z: tr.z, conf: tr.conf, t, name };
}

/** Points the evaluation read, for confidence: point names, `__seg:<kind>` and `__metric:<name>`. */
export type Accessed = Set<string>;

export function createEnv(world: World, view: View, accessed: Accessed, extraFns: Record<string, ExprFn> = {}): Env {
  const { tracks } = world;
  const n = tracks.n;
  const idx = view.idx;
  const whole = idx.length === n;
  const inView = new Uint8Array(n);
  idx.forEach((i) => (inView[i] = 1));
  const tView = sliceArr(tracks.t, idx, whole);
  const dt = tracks.dt;
  const aspect = tracks.aspect;

  const cut = (p: PointSeries): NamedPoints => ({
    kind: "points",
    x: sliceArr(p.x, idx, whole),
    y: sliceArr(p.y, idx, whole),
    z: p.z ? sliceArr(p.z, idx, whole) : undefined,
    conf: p.conf ? sliceArr(p.conf, idx, whole) : undefined,
    t: tView
  });

  const point = (name: string): NamedPoints => {
    const tr = tracks.get(name);
    for (const c of constituents(name)) accessed.add(c);
    if (!tr) throw new ExprRuntimeError(`"${name}" was not tracked in this clip`);
    const full = trackToPoints(tr, tracks.t, name);
    return { ...cut(full), name, full, idx };
  };

  /** `left_hand.index_tip`, `object.sports_ball`: objects whose properties are points, built on access. */
  const pointGroup = (prefix: string, members: string[]): Record<string, Value> => {
    const o: Record<string, Value> = {};
    for (const m of members) Object.defineProperty(o, m, { enumerable: true, configurable: true, get: () => point(`${prefix}.${m}`) });
    return o;
  };

  const pts = (v: Value, fn: string): NamedPoints => {
    if (isPoints(v)) return v as NamedPoints;
    throw new ExprRuntimeError(`${fn}() needs a body point here`);
  };
  const nameOf = (v: Value): string => (isDir(v) ? v.name : isPoints(v) ? ((v as NamedPoints).name ?? "point") : typeof v === "string" ? v : "value");

  /** Run `f` on whole-clip arrays of a point and keep the view's frames. */
  const onFull = (p: NamedPoints, f: (q: PointSeries, t: Float64Array) => Float64Array[]): Float64Array[] => {
    if (p.full && p.idx) return f(p.full, tracks.t).map((a) => sliceArr(a, idx, whole));
    return f(p, p.t ?? tView);
  };

  const withT = (values: Float64Array, conf?: Float64Array, src?: TaggedSeries["src"]): TaggedSeries => {
    const s: TaggedSeries = { kind: "series", values, t: tView };
    if (conf) s.conf = conf;
    if (src) s.src = src;
    return s;
  };

  const minConf = (...ps: (NamedPoints | null)[]): Float64Array => {
    const len = idx.length;
    const out = new Float64Array(len).fill(1);
    for (const p of ps) if (p?.conf) for (let i = 0; i < len; i++) out[i] = Math.min(out[i], p.conf[i]);
    return out;
  };

  const seriesOf = (v: Value): Series => {
    if (isSeries(v)) return v;
    if (Array.isArray(v)) return series(toArray(v));
    return series([toNumber(v)]);
  };

  const stature = () => {
    const s = tracks.stature();
    if (!(s > 0)) throw new ExprRuntimeError("can't estimate body height: the head and ankles must be visible");
    return s;
  };

  const unitScale = (unit: string): number => {
    switch (unit) {
      case "":
      case "norm":
      case "frame":
        return 1;
      case "px":
        return world.pixelHeight;
      case "body":
        return 1 / stature();
      case "torso": {
        const t = tracks.torso();
        if (!(t > 0)) throw new ExprRuntimeError("can't measure the torso: shoulders and hips must be visible");
        return 1 / t;
      }
      case "cm":
      case "m": {
        const h = world.baseline.height_cm;
        if (!(h > 0)) throw new ExprRuntimeError('distance in cm needs the learner\'s height as baseline.height_cm');
        return ((unit === "m" ? h / 100 : h) as number) / stature();
      }
    }
    throw new ExprRuntimeError(`unknown unit "${unit}": use cm, m, body, torso, px or leave it out`);
  };

  const viewDuration = () => (idx.length ? idx.length * dt : 0);

  /** Contiguous runs of truthy samples in a view-length mask, as durations in seconds. */
  const runDurations = (mask: ArrayLike<number>): number[] => {
    const m = Array.from(mask, (x) => x !== 0 && !Number.isNaN(x));
    // a run must also be contiguous in the clip, not just in the view
    const out: number[] = [];
    for (const [a, b] of runs(m)) {
      let start = a;
      for (let j = a + 1; j <= b + 1; j++) {
        if (j > b || idx[j] !== idx[j - 1] + 1) {
          out.push((j - start) * dt);
          start = j;
        }
      }
    }
    return out;
  };

  const maskOf = (v: Value, fn: string): Float64Array => {
    if (typeof v === "string") {
      const m = world.phaseMask(v, view.kind ?? world.defaultKind);
      if (!m) throw new ExprRuntimeError(`unknown phase "${v}"`);
      accessed.add(`__seg:${view.kind ?? world.defaultKind}`);
      return Float64Array.from(idx, (i) => m[i]);
    }
    if (isSeries(v)) return v.values;
    if (typeof v === "boolean" || typeof v === "number") return new Float64Array(idx.length).fill(truthy(v) ? 1 : 0);
    throw new ExprRuntimeError(`${fn}() needs a phase or a condition`);
  };

  const eventPoints = (args: Value[]): string[] => {
    const names = args.filter(isPoints).map((p) => (p as NamedPoints).name).filter((x): x is string => !!x);
    return names.length ? names : ["left_ankle", "right_ankle"];
  };
  const viewEvents = (names: string[]): number[] => {
    names.forEach((nm) => constituents(nm).forEach((c) => accessed.add(c)));
    if (!world.beats.length) throw new ExprRuntimeError("no beat information: record with the music or a metronome playing");
    const t0 = tracks.t[idx[0]] - dt / 2;
    const t1 = tracks.t[idx[idx.length - 1]] + dt / 2;
    return world.landings(names).filter((e) => {
      if (e < t0 || e > t1) return false;
      let k = Math.round((e - tracks.t[0]) / dt);
      k = Math.max(0, Math.min(n - 1, k));
      return inView[k] === 1;
    });
  };

  const fns: Record<string, ExprFn> = {
    ...STANDARD_FUNCTIONS,

    /** angle at b in degrees between b→a and b→c; `vertical` (up) or `horizontal` may replace a or c */
    angle: (args, named) => {
      const [a, b, c] = args;
      if (args.length < 3) throw new ExprRuntimeError("angle() needs three points: angle(a, b, c) measures at b");
      if (isDir(b)) throw new ExprRuntimeError("angle(): the middle argument must be a point");
      const B = pts(b, "angle");
      const A = isDir(a) ? null : pts(a, "angle");
      const C = isDir(c) ? null : pts(c, "angle");
      const use3d = toNumber(named.dims ?? 2) === 3;
      const unsigned = (isDir(a) && a.name === "horizontal") || (isDir(c) && c.name === "horizontal");
      const len = B.x.length;
      const out = new Float64Array(len);
      const vec = (v: Value, P: NamedPoints | null, i: number): [number, number, number] => {
        if (isDir(v)) {
          const d = DIRECTIONS[v.name];
          return [d[0], d[1], 0];
        }
        return [(P!.x[i] - B.x[i]) * aspect, P!.y[i] - B.y[i], use3d && P!.z && B.z ? (P!.z[i] - B.z[i]) * aspect : 0];
      };
      for (let i = 0; i < len; i++) {
        const u = vec(a, A, i);
        const w = vec(c, C, i);
        const nu = Math.hypot(...u);
        const nw = Math.hypot(...w);
        let deg = (Math.acos(Math.max(-1, Math.min(1, (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (nu * nw)))) * 180) / Math.PI;
        if (unsigned) deg = Math.min(deg, 180 - deg);
        out[i] = nu > 0 && nw > 0 ? deg : NaN;
      }
      return withT(out, minConf(A, B, C), { fn: "angle", points: [nameOf(a), nameOf(b), nameOf(c)] });
    },

    /** distance between two points in frame heights, or `unit: "cm"` (needs baseline.height_cm), "body", "torso", "px" */
    distance: (args, named) => {
      const A = pts(args[0], "distance");
      const B = pts(args[1], "distance");
      const scale = unitScale(String(named.unit ?? ""));
      const use3d = toNumber(named.dims ?? 2) === 3;
      const out = new Float64Array(A.x.length);
      for (let i = 0; i < out.length; i++) {
        const dz = use3d && A.z && B.z ? (A.z[i] - B.z[i]) * aspect : 0;
        out[i] = Math.hypot((A.x[i] - B.x[i]) * aspect, A.y[i] - B.y[i], dz) * scale;
      }
      return withT(out, minConf(A, B), { fn: "distance", points: [nameOf(args[0]), nameOf(args[1])] });
    },

    /** velocity of a point in frame heights per second (x scaled to true proportions); of a series, its rate of change */
    velocity: (args) => {
      const v = args[0];
      if (isSeries(v)) return series(derivative(v.values, v.t ?? tView), v.conf, v.t ?? tView);
      const P = pts(v, "velocity");
      const [vx, vy, vz] = onFull(P, (q, t) => [derivative(Float64Array.from(q.x, (x) => x * aspect), t), derivative(q.y, t), derivative(Float64Array.from(q.z ?? new Float64Array(q.x.length), (z) => z * aspect), t)]);
      return { kind: "points", x: vx, y: vy, z: vz, conf: P.conf, t: tView } as NamedPoints;
    },

    /** speed (magnitude of velocity) in frame heights per second */
    speed: (args, named) => {
      const v = args[0];
      if (isSeries(v)) return series(Array.from(derivative(v.values, v.t ?? tView), Math.abs), v.conf, v.t ?? tView);
      const P = pts(v, "speed");
      const use3d = toNumber(named.dims ?? 2) === 3;
      const [s] = onFull(P, (q, t) => {
        const vx = derivative(Float64Array.from(q.x, (x) => x * aspect), t);
        const vy = derivative(q.y, t);
        const vz = use3d && q.z ? derivative(Float64Array.from(q.z, (z) => z * aspect), t) : null;
        return [Float64Array.from(vx, (x, i) => Math.hypot(x, vy[i], vz ? vz[i] : 0))];
      });
      return withT(s, P.conf ? Float64Array.from(P.conf) : undefined);
    },

    /** jerk: how abruptly acceleration changes (third derivative), frame heights per second³; lower is smoother */
    jerk: (args) => {
      const P = pts(args[0], "jerk");
      const w = Math.max(3, Math.round(0.1 / dt) | 1);
      const [j] = onFull(P, (q, t) => {
        const d3 = (a: Float64Array) => derivative(movingAverage(derivative(movingAverage(derivative(a, t), w), t), w), t);
        const jx = d3(Float64Array.from(q.x, (x) => x * aspect));
        const jy = d3(q.y);
        return [Float64Array.from(jx, (x, i) => Math.hypot(x, jy[i]))];
      });
      return withT(j, P.conf ? Float64Array.from(P.conf) : undefined);
    },

    /** height in the frame: 1 at the top, 0 at the bottom */
    height: (args) => {
      const P = pts(args[0], "height");
      return withT(Float64Array.from(P.y, (y) => 1 - y), P.conf);
    },

    x: (args) => {
      const P = pts(args[0], "x");
      return withT(P.x, P.conf);
    },
    y: (args) => {
      const P = pts(args[0], "y");
      return withT(P.y, P.conf);
    },
    z: (args) => {
      const P = pts(args[0], "z");
      return withT(P.z ?? new Float64Array(P.x.length), P.conf);
    },

    /** between(p, a, b): 1 where p projects onto the segment a–b (e.g. the centre of mass between the feet); with numbers, a ≤ p ≤ b */
    between: (args) => {
      const [p, a, b] = args;
      if (isPoints(p) && isPoints(a) && isPoints(b)) {
        const P = p as NamedPoints;
        const A = a as NamedPoints;
        const B = b as NamedPoints;
        const out = new Float64Array(P.x.length);
        for (let i = 0; i < out.length; i++) {
          const ux = (B.x[i] - A.x[i]) * aspect;
          const uy = B.y[i] - A.y[i];
          const l2 = ux * ux + uy * uy;
          const s = l2 > 0 ? (((P.x[i] - A.x[i]) * aspect) * ux + (P.y[i] - A.y[i]) * uy) / l2 : NaN;
          out[i] = s >= 0 && s <= 1 ? 1 : Number.isNaN(s) ? NaN : 0;
        }
        return withT(out, minConf(P, A, B));
      }
      const lo = Math.min(toNumber(a), toNumber(b));
      const hi = Math.max(toNumber(a), toNumber(b));
      if (isSeries(p)) return series(Array.from(p.values, (x) => (x >= lo && x <= hi ? 1 : 0)), p.conf, p.t);
      const x = toNumber(p);
      return x >= lo && x <= hi;
    },

    /** the point on the line a–b closest to p */
    projection: (args) => {
      const P = pts(args[0], "projection");
      const A = pts(args[1], "projection");
      const B = pts(args[2], "projection");
      const len = P.x.length;
      const x = new Float64Array(len);
      const y = new Float64Array(len);
      for (let i = 0; i < len; i++) {
        const ux = (B.x[i] - A.x[i]) * aspect;
        const uy = B.y[i] - A.y[i];
        const l2 = ux * ux + uy * uy;
        const s = l2 > 0 ? (((P.x[i] - A.x[i]) * aspect) * ux + (P.y[i] - A.y[i]) * uy) / l2 : 0;
        x[i] = A.x[i] + (s * ux) / aspect;
        y[i] = A.y[i] + s * uy;
      }
      return { kind: "points", x, y, z: new Float64Array(len), conf: minConf(P, A, B), t: tView } as NamedPoints;
    },

    midpoint: (args) => {
      const A = pts(args[0], "midpoint");
      const B = pts(args[1], "midpoint");
      const mid = (p: PointSeries, q: PointSeries, t: Float64Array): NamedPoints => ({
        kind: "points",
        x: Float64Array.from(p.x, (v, i) => (v + q.x[i]) / 2),
        y: Float64Array.from(p.y, (v, i) => (v + q.y[i]) / 2),
        z: Float64Array.from(p.x, (_, i) => ((p.z?.[i] ?? 0) + (q.z?.[i] ?? 0)) / 2),
        conf: Float64Array.from(p.x, (_, i) => Math.min(p.conf?.[i] ?? 1, q.conf?.[i] ?? 1)),
        t
      });
      const out = mid(A, B, tView);
      if (A.full && B.full) {
        out.full = mid(A.full, B.full, tracks.t);
        out.idx = idx;
      }
      return out;
    },

    /** 1 where the point is seen (visibility ≥ `min`, default 0.5) */
    visible: (args, named) => {
      const P = pts(args[0], "visible");
      const m = named.min === undefined ? 0.5 : toNumber(named.min);
      return withT(Float64Array.from(P.conf ?? new Float64Array(P.x.length).fill(1), (c) => (c >= m ? 1 : 0)));
    },

    /**
     * symmetry(left, right) in 0..1. For two series (say left and right knee angles): 1 − mean |l − r| / mean of their sizes.
     * For two points: compares their heights and their distances from the body's midline, in torso lengths.
     */
    symmetry: (args) => {
      const [a, b] = args;
      if (isPoints(a) && isPoints(b)) {
        const A = a as NamedPoints;
        const B = b as NamedPoints;
        const mid = point("mid_hip");
        let torso = tracks.torso();
        if (!(torso > 0)) torso = 0.25;
        let s = 0;
        let k = 0;
        for (let i = 0; i < A.x.length; i++) {
          const da = Math.abs(A.x[i] - mid.x[i]) * aspect;
          const db = Math.abs(B.x[i] - mid.x[i]) * aspect;
          const d = Math.abs(da - db) + Math.abs(A.y[i] - B.y[i]);
          if (Number.isFinite(d)) {
            s += d / torso;
            k++;
          }
        }
        return k ? Math.max(0, Math.min(1, 1 - s / k)) : NaN;
      }
      const sa = toArray(a);
      const sb = toArray(b);
      let diff = 0;
      let size = 0;
      let k = 0;
      for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
        if (!Number.isFinite(sa[i]) || !Number.isFinite(sb[i])) continue;
        diff += Math.abs(sa[i] - sb[i]);
        size += (Math.abs(sa[i]) + Math.abs(sb[i])) / 2;
        k++;
      }
      if (!k) return NaN;
      return size > 0 ? Math.max(0, Math.min(1, 1 - diff / size)) : 1;
    },

    /** moving average of a series or a point over `window` frames (default 5) */
    smooth: (args, named) => {
      const w = Math.max(1, Math.round(toNumber(args[1] ?? named.window ?? 5)));
      const v = args[0];
      if (isPoints(v)) {
        const P = v as NamedPoints;
        return { kind: "points", x: movingAverage(P.x, w), y: movingAverage(P.y, w), z: P.z ? movingAverage(P.z, w) : undefined, conf: P.conf, t: P.t } as NamedPoints;
      }
      const s = seriesOf(v);
      return series(movingAverage(s.values, w), s.conf, s.t);
    },

    /** how many repetitions (segments) fall in the view */
    reps: () => {
      const kind: SegmentKind = world.defaultKind === "whole" || world.defaultKind === "phrases" ? "reps" : world.defaultKind;
      accessed.add(`__seg:${kind}`);
      return world.segments(kind).filter((s) => inView[s.key]).length;
    },

    /** seconds in the view, or in which a condition holds */
    duration: (args) => {
      if (!args.length) return viewDuration();
      const m = maskOf(args[0], "duration");
      let k = 0;
      for (const x of m) if (x !== 0 && !Number.isNaN(x)) k++;
      return k * dt;
    },

    /** the longest unbroken stretch, in seconds, in which a condition holds */
    hold_time: (args) => {
      if (!args.length) throw new ExprRuntimeError("hold_time() needs a condition");
      const d = runDurations(maskOf(args[0], "hold_time"));
      return d.length ? Math.max(...d) : 0;
    },

    /** mean duration in seconds of a phase (one value per repetition inside `per rep`) */
    phase_duration: (args) => {
      if (!args.length) throw new ExprRuntimeError("phase_duration() needs a phase, e.g. phase_duration(down)");
      const d = runDurations(maskOf(args[0], "phase_duration"));
      return d.length ? d.reduce((s, x) => s + x, 0) / d.length : 0;
    },

    /** share of landings (feet by default) within `tolerance_ms` (default 100) of a beat */
    on_beat: (args, named) => {
      const events = viewEvents(eventPoints(args));
      if (!events.length) throw new ExprRuntimeError("no steps found: make sure your feet are in the frame");
      const tol = named.tolerance_ms === undefined ? 100 : toNumber(named.tolerance_ms);
      const r = alignToBeats(events, world.beats, tol);
      events.forEach((e, i) => world.beatEvents.set(e, r.offsetsMs[i]));
      return r.onBeatShare;
    },

    /** signed offset of each landing to the nearest beat in ms (negative = early) */
    step_offset_ms: (args) => {
      const events = viewEvents(eventPoints(args));
      if (!events.length) throw new ExprRuntimeError("no steps found: make sure your feet are in the frame");
      const r = alignToBeats(events, world.beats, Infinity);
      events.forEach((e, i) => world.beatEvents.set(e, r.offsetsMs[i]));
      const kept = events.map((e, i) => [e, r.offsetsMs[i]] as const).filter(([, o]) => o !== null) as [number, number][];
      return series(
        kept.map(([, o]) => o),
        undefined,
        kept.map(([e]) => e)
      );
    },

    /** similarity 0..1 to the reference clip over `joints` (body groups or points), aligned by `align` (dtw, linear, none) */
    pose_similarity: (args, named) => {
      if (args.length && !isReference(args[0])) throw new ExprRuntimeError("pose_similarity() compares with `reference`");
      if (!world.reference?.length) throw new ExprRuntimeError("no reference clip was supplied");
      const jointsV = named.joints;
      const joints = Array.isArray(jointsV) ? jointsV.map(nameOf) : jointsV === undefined ? undefined : [nameOf(jointsV)];
      const align = String(named.align ?? "dtw") as "dtw" | "linear" | "none";
      const frames = Array.from(idx, (i) => world.frames[i]);
      const cmp = compareToReference(frames, world.reference, joints, { align, subsequence: !whole, aspect });
      (joints ?? ["torso", "arms", "legs"]).forEach((j) => (j in POSE_GROUPS ? POSE_GROUPS[j] : constituents(j)).forEach((c) => accessed.add(c)));
      if (whole) world.lastComparison = cmp;
      return cmp.similarity;
    },

    /** what to draw for a mistake: overlay(angle(a, b, c)) draws an arc, overlay(distance(a, b)) a line */
    overlay: (args) => {
      const v = args[0];
      if (isSeries(v) && (v as TaggedSeries).src) {
        const src = (v as TaggedSeries).src!;
        return { kind: "overlay", draw: src.fn === "angle" ? "arc" : "line", points: src.points };
      }
      if (isPoints(v)) return { kind: "overlay", draw: "point", points: [nameOf(v)] };
      if (typeof v === "string") return { kind: "overlay", draw: v, points: [] };
      return { kind: "overlay", draw: "series", points: [] };
    },
    ...extraFns
  };

  const bindStored = (name: string, m: StoredMetric): Value => {
    accessed.add(`__metric:${name}`);
    switch (m.kind) {
      case "scalar":
        return m.value;
      case "items":
        return m.series!;
      case "frame":
        return whole ? m.series! : series(sliceArr(m.series!.values, idx, false), m.series!.conf ? sliceArr(m.series!.conf, idx, false) : undefined, tView);
      case "per":
        if (view.kind === m.perKind && view.segIndex !== undefined) return m.per![view.segIndex];
        return m.series!;
    }
  };

  /** standard object classes plus any class the clip's detector reported */
  const objectNames = () => {
    const names = new Set(OBJECT_CLASSES.map((o) => o.replace(/ /g, "_")));
    for (const f of world.frames) for (const k of Object.keys(f.objects ?? {})) names.add(k.replace(/ /g, "_"));
    return [...names];
  };

  const get = (name: string): Value | undefined => {
    const m = world.stored.get(name);
    if (m) return bindStored(name, m);
    if (isDirection(name)) return { kind: "direction", name };
    if (isKnownPoint(name)) return point(name);
    switch (name) {
      case "left_hand":
      case "right_hand":
        return pointGroup(name, [...HAND_LANDMARKS]);
      case "object":
        return pointGroup("object", objectNames());
      case "baseline":
        return { ...world.baseline };
      case "learner":
        return { ...world.learner };
      case "beat":
        return series(world.beats, undefined, world.beats);
      case "reference":
        return { kind: "reference", available: !!world.reference?.length };
      case "fps":
        return world.tracks.fps;
      case "t":
        return series(tView, undefined, tView);
      case "capture":
        return { ...world.capture };
      case "rep":
      case "segment": {
        const s = view.segment;
        const t0 = tracks.t[idx[0]] ?? 0;
        const t1 = tracks.t[idx[idx.length - 1]] ?? 0;
        return { index: view.segIndex ?? -1, start: s ? tracks.t[s.start] : t0, end: s ? tracks.t[s.end] : t1, duration: viewDuration() };
      }
      case "reps":
      case "duration":
        return fns[name]([], {}, env);
      case "phase": {
        // `phase.down` etc.: the same masks as the bare phase names
        const o: Record<string, Value> = {};
        for (const p of world.phaseNames) Object.defineProperty(o, p, { enumerable: true, configurable: true, get: () => get(p)! });
        return o;
      }
    }
    if (world.phaseNames.includes(name)) {
      const kind = view.kind ?? world.defaultKind;
      const mk = world.phaseMask(name, kind);
      if (!mk) return undefined;
      accessed.add(`__seg:${kind}`);
      return series(Float64Array.from(idx, (i) => mk[i]), undefined, tView);
    }
    if (name in FACE_LANDMARKS) return point(name);
    if (METRIC_KEYWORDS.has(name)) return name;
    return undefined;
  };

  const env: Env = { get, fns };
  return env;
}
