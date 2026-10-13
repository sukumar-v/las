/**
 * The metric-spec interpreter: turns tracked body points plus a metric spec into an Analysis.
 *
 * 1. Quality: enough frames, the needed points visible in ≥ 60% of frames, the camera where the spec
 *    asked. A bad recording gets a re-record request with one specific instruction, never feedback.
 * 2. Smoothing: One Euro filter on every landmark (zero-lag for recorded clips).
 * 3. Segments and phases: repetitions, moves, phrases, holds or the whole clip, and the phases inside.
 * 4. Metrics, in the spec's order: `per <segment>` gives one value per segment, `at <phase>` measures
 *    only the phase's frames. Later metrics can use earlier ones.
 * 5. Mistakes from the spec's detectors, kept only at or above their confidence (never below the floor).
 * 6. Criteria, praise, markers, segments and the overlay the studio draws.
 */
import {
  CONFIDENCE_FLOOR,
  ExprRuntimeError,
  MetricSpecSchema,
  calledFunctions,
  POSE_LANDMARKS,
  dottedNames,
  evaluate,
  isKnownPoint,
  isPoints,
  isSeries,
  parseExpr,
  parseMetricExpr,
  rootNames,
  series,
  toArray,
  toNumber,
  truthy,
  walk,
  type Analysis,
  type AnalysisInput,
  type Expr,
  type ExprFn,
  type MetricExpr,
  type MetricSpec,
  type MetricSpecInput,
  type MetricValue,
  type Series,
  type Value
} from "@las/schema";
import type { AnalyzeContext, MovementEvidence, PoseFrame } from "../types.js";
import { applyConfidenceFloor, finish, metric, reRecord, version } from "../common/analysis.js";
import { landingTimes, mergeEvents } from "./beats.js";
import { allFrames, createEnv, type Accessed, type StoredMetric, type View, type World } from "./env.js";
import { smoothFrames } from "./one-euro.js";
import { angleFactor, angleInstruction, framingInstruction } from "./quality.js";
import { compareToReference } from "./reference.js";
import { BUILTIN_PHASE_NAMES, builtinPhases, holdSegments, holdThreshold, moveSegments, phraseSegments, repSegments, segmentKindOf, singular, wholeSegment, type Segment, type SegmentKind } from "./segment.js";
import { derivative, fillGaps, movingAverage, nearestIndex, quantile } from "./signal.js";
import { VISIBLE, constituents, isDirection, Tracks } from "./tracks.js";

/**
 * Optional context for the movement engine on top of AnalyzeContext.
 * `criteria`: proof or drill criteria as `id -> expression` over the metrics (and points, phases,
 * baseline, learner), evaluated in the same environment as mistakes. A series result passes only
 * when every item passes (every repetition, say).
 */
export interface MovementContext extends AnalyzeContext {
  criteria?: Record<string, string>;
}

/** Bones drawn between landmarks for the skeleton overlay (MediaPipe pose topology; data, not style). */
export const POSE_EDGES: [string, string][] = [
  ["left_shoulder", "right_shoulder"],
  ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"],
  ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"],
  ["left_shoulder", "left_hip"],
  ["right_shoulder", "right_hip"],
  ["left_hip", "right_hip"],
  ["left_hip", "left_knee"],
  ["left_knee", "left_ankle"],
  ["left_ankle", "left_heel"],
  ["left_heel", "left_foot_index"],
  ["left_ankle", "left_foot_index"],
  ["right_hip", "right_knee"],
  ["right_knee", "right_ankle"],
  ["right_ankle", "right_heel"],
  ["right_heel", "right_foot_index"],
  ["right_ankle", "right_foot_index"],
  ["left_wrist", "left_index"],
  ["left_wrist", "left_pinky"],
  ["left_wrist", "left_thumb"],
  ["right_wrist", "right_index"],
  ["right_wrist", "right_pinky"],
  ["right_wrist", "right_thumb"],
  ["nose", "left_eye"],
  ["nose", "right_eye"],
  ["left_eye", "left_ear"],
  ["right_eye", "right_ear"],
  ["mouth_left", "mouth_right"]
];

const REDUCERS = new Set(["min", "max", "mean", "avg", "median", "sum", "first", "last", "std", "range"]);
const SHARES = new Set(["share", "any", "all"]);
const COMPARISONS = new Set(["<", "<=", ">", ">=", "==", "!="]);
const UNIT_OF_FN: Record<string, string> = {
  angle: "deg",
  distance: "frame",
  velocity: "frame/s",
  speed: "frame/s",
  jerk: "frame/s³",
  height: "frame",
  phase_duration: "s",
  duration: "s",
  hold_time: "s",
  step_offset_ms: "ms",
  on_beat: "share",
  pose_similarity: "0-1",
  symmetry: "0-1",
  share: "share",
  visible: "share",
  reps: "reps",
  count: "count"
};

/** A unit for display, read off the expression: `min(angle(...))` is in degrees, a comparison is a share. */
function inferUnit(e: Expr): string {
  if (e.kind === "binary") {
    if (COMPARISONS.has(e.op) || e.op === "&&" || e.op === "||") return "share";
    if (e.op === "+" || e.op === "-") return inferUnit(e.left);
    return "";
  }
  if (e.kind === "unary") return e.op === "!" ? "share" : inferUnit(e.operand);
  if (e.kind === "call") {
    if (e.fn === "distance") {
      const u = e.named.unit;
      return u && u.kind === "str" ? u.value : "frame";
    }
    if (UNIT_OF_FN[e.fn]) return UNIT_OF_FN[e.fn];
    if ((REDUCERS.has(e.fn) || e.fn === "abs" || e.fn === "round" || e.fn === "smooth") && e.args[0]) return inferUnit(e.args[0]);
  }
  return "";
}

function meanFinite(a: ArrayLike<number>): number {
  let s = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (Number.isFinite(a[i])) {
      s += a[i];
      k++;
    }
  }
  return k ? s / k : NaN;
}

function rangeIdx(a: number, b: number): Int32Array {
  return Int32Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
}

function maskIdx(mask: Uint8Array, within?: Int32Array): Int32Array {
  const out: number[] = [];
  if (within) for (const i of within) {
    if (mask[i]) out.push(i);
  }
  else for (let i = 0; i < mask.length; i++) if (mask[i]) out.push(i);
  return Int32Array.from(out);
}

/** Speed in frame heights per second of one track, 0 where it isn't seen. */
function trackSpeed(tracks: Tracks, name: string): Float64Array | null {
  const tr = tracks.get(name);
  if (!tr) return null;
  const x = fillGaps(Array.from(tr.x, (v, i) => (tr.conf[i] >= 0.3 ? v * tracks.aspect : NaN)));
  const y = fillGaps(Array.from(tr.y, (v, i) => (tr.conf[i] >= 0.3 ? v : NaN)));
  const vx = derivative(x, tracks.t);
  const vy = derivative(y, tracks.t);
  return Float64Array.from(vx, (v, i) => (tr.conf[i] >= 0.3 ? Math.hypot(v, vy[i]) : NaN));
}

/** Combined speed of the hands and feet (velocity minima mark positions between moves). */
function extremitySpeed(tracks: Tracks): Float64Array {
  const parts = ["left_wrist", "right_wrist", "left_ankle", "right_ankle"].map((p) => trackSpeed(tracks, p)).filter((s): s is Float64Array => !!s);
  const out = new Float64Array(tracks.n);
  for (let i = 0; i < tracks.n; i++) for (const s of parts) if (Number.isFinite(s[i])) out[i] += s[i];
  return out;
}

/** Mean speed over every seen body point (for holds). */
function bodySpeed(tracks: Tracks): Float64Array {
  const parts = POSE_LANDMARKS.map((p) => trackSpeed(tracks, p)).filter((s): s is Float64Array => !!s);
  return Float64Array.from({ length: tracks.n }, (_, i) => meanFinite(parts.map((s) => s[i])));
}

function prettyName(name: string): string {
  return name.replace(/_/g, " ");
}

function formatValue(v: number, unit: string): string {
  if (unit === "share" || unit === "0-1") return `${Math.round(v * 100)}%`;
  const r = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return unit && unit !== "frame" ? `${r} ${unit}` : `${r}`;
}

export function analyzeMovement(specIn: MetricSpec | MetricSpecInput, evidence: MovementEvidence, ctx: MovementContext = {}): Analysis {
  const v = version("movement", ctx.specId, ctx.modelVersion);
  const parsedSpec = MetricSpecSchema.safeParse(specIn);
  if (!parsedSpec.success) {
    return finish({ engine: "movement", quality: { ok: false, issues: parsedSpec.error.issues.map((i) => `spec ${i.path.join(".")}: ${i.message}`) }, version: v, precision: "full" });
  }
  const spec = parsedSpec.data;
  const issues: string[] = [];
  const hints: string[] = [];
  const raw = evidence.frames ?? [];
  const fps = evidence.fps > 0 ? evidence.fps : spec.capture.fps;

  // ---- 1. quality: length -------------------------------------------------
  const minFrames = Math.max(10, Math.round(fps));
  if (raw.length < minFrames) {
    const want = Math.max(2, Math.round(spec.capture.duration_s ?? 3));
    return reRecord("movement", [`clip too short: ${raw.length} frames`], `The clip was too short. Record at least ${want} seconds.`, v);
  }
  const clipS = raw[raw.length - 1].t - raw[0].t;
  if (spec.capture.duration_s && clipS < spec.capture.duration_s * 0.5) issues.push(`clip is ${clipS.toFixed(1)} s; this drill asks for ${spec.capture.duration_s} s`);
  let factor = 1;
  if (fps < spec.capture.fps * 0.75) {
    issues.push(`recorded at ${Math.round(fps)} fps; this drill asks for ${spec.capture.fps} fps`);
    factor *= 0.9;
  }
  const af = angleFactor(spec.capture.angle, evidence.detectedAngle);
  if (af < 1) issues.push(`filmed from ${evidence.detectedAngle}; this drill needs ${spec.capture.angle}`);
  factor *= af;

  // ---- parse every expression once ---------------------------------------
  const metricExprs = new Map<string, MetricExpr>();
  for (const [name, src] of Object.entries(spec.metrics)) {
    try {
      metricExprs.set(name, parseMetricExpr(src));
    } catch (e) {
      issues.push(`${name}: ${(e as Error).message}`);
    }
  }
  const phaseExprs = new Map<string, Expr>();
  for (const [name, src] of Object.entries(spec.phases ?? {})) {
    try {
      phaseExprs.set(name, parseExpr(src));
    } catch (e) {
      issues.push(`phase ${name}: ${(e as Error).message}`);
    }
  }
  const mistakeExprs = spec.mistakes.map((m) => {
    try {
      return { m, when: parseExpr(m.when), show: m.show ? parseExpr(m.show) : undefined };
    } catch (e) {
      issues.push(`mistake ${m.id}: ${(e as Error).message}`);
      return null;
    }
  });
  let signalExpr: Expr | undefined;
  if (spec.segment.signal) {
    try {
      signalExpr = parseExpr(spec.segment.signal);
    } catch (e) {
      issues.push(`segment.signal: ${(e as Error).message}`);
    }
  }

  // ---- 2. smoothing and tracks -------------------------------------------
  const frames = smoothFrames(raw, fps);
  const reference = evidence.reference?.length ? smoothFrames(evidence.reference, fps) : undefined;
  const tracks = new Tracks(frames, fps, evidence.width, evidence.height);
  // landing times are measured on the unsmoothed points: smoothing rounds a sharp stop and shifts it
  const rawTracks = new Tracks(raw, fps, evidence.width, evidence.height);
  const n = tracks.n;

  // ---- 1b. quality: the needed points ------------------------------------
  const allExprs: Expr[] = [...metricExprs.values()].map((m) => m.expr);
  phaseExprs.forEach((e) => allExprs.push(e));
  mistakeExprs.forEach((m) => m && allExprs.push(m.when));
  if (signalExpr) allExprs.push(signalExpr);
  const referenced = new Set<string>();
  for (const e of allExprs) for (const d of dottedNames(e)) if (isKnownPoint(d) && !isDirection(d)) referenced.add(d);
  const needed = [...new Set([...referenced, ...(spec.requires_visible ?? [])])];
  const personSeen = POSE_LANDMARKS.some((p) => tracks.visibleShare(p) >= 0.3) || needed.some((p) => tracks.visibleShare(p) >= 0.3);
  if (!personSeen) return reRecord("movement", ["no body points tracked"], framingInstruction([], true), v);
  const share = new Map(needed.map((p) => [p, tracks.visibleShare(p)]));
  const missing = needed.filter((p) => share.get(p)! < 0.6);
  for (const p of missing) issues.push(`${p} visible in ${Math.round(share.get(p)! * 100)}% of frames`);
  const missingRequired = (spec.requires_visible ?? []).filter((p) => missing.includes(p));
  if (missingRequired.length) return reRecord("movement", issues, framingInstruction(missingRequired), v);
  if (needed.length && missing.length > needed.length / 2) return reRecord("movement", issues, framingInstruction(missing), v);

  // ---- 3. the world: segments, phases, landings ----------------------------
  const defaultKind = spec.segment.by as SegmentKind;
  const segCache = new Map<SegmentKind, Segment[]>();
  const segConf = new Map<SegmentKind, number>();
  const phaseCache = new Map<SegmentKind, Record<string, Uint8Array>>();
  const landingCache = new Map<string, number[]>();
  let bodyV: Float64Array | null = null;
  const getBodySpeed = () => (bodyV ??= bodySpeed(tracks));
  const beats = [...(evidence.beats ?? [])].filter(Number.isFinite).sort((a, b) => a - b);
  const stored = new Map<string, StoredMetric>();

  const world: World = {
    tracks,
    frames,
    reference,
    beats,
    baseline: { ...(evidence.baseline ?? {}), ...(ctx.baseline ?? {}) },
    learner: { ...(ctx.learner ?? {}) },
    capture: { angle: evidence.detectedAngle ?? spec.capture.angle, fps },
    pixelHeight: evidence.height || 1,
    defaultKind,
    phaseNames: [...new Set([...BUILTIN_PHASE_NAMES, ...phaseExprs.keys()])],
    stored,
    beatEvents: new Map(),
    segments: (kind) => {
      if (!segCache.has(kind)) segCache.set(kind, computeSegments(kind));
      return segCache.get(kind)!;
    },
    phaseMask: (name, kind) => {
      if (!phaseCache.has(kind)) phaseCache.set(kind, computePhases(kind));
      return phaseCache.get(kind)![name] ?? null;
    },
    landings: (points) => {
      const key = points.join(",");
      if (!landingCache.has(key)) {
        landingCache.set(
          key,
          mergeEvents(
            points.map((p) => {
              const tr = rawTracks.get(p);
              return tr ? landingTimes(tr.y, tr.conf, rawTracks.t) : [];
            })
          )
        );
      }
      return landingCache.get(key)!;
    }
  };
  const whole: View = { idx: allFrames(n) };

  /** Mean confidence of what an evaluation read, times the recording factors. */
  const confOf = (accessed: Accessed, idx: Int32Array): number => {
    const parts: number[] = [];
    for (const a of accessed) {
      if (a.startsWith("__seg:")) parts.push(segConf.get(a.slice(6) as SegmentKind) ?? 1);
      else if (a.startsWith("__metric:")) parts.push(stored.get(a.slice(9))?.confidence ?? 1);
      else if (!isDirection(a)) parts.push(tracks.meanConf(a, idx));
    }
    // the mean, but one badly seen part pulls it down: never more than 0.25 above the weakest part
    const c = parts.length ? Math.min(meanFinite(parts), Math.min(...parts) + 0.25) : 1;
    return Math.max(0, Math.min(1, c * factor));
  };

  function defaultSignal(): { values: Float64Array; points: string[] } {
    let best: string | null = null;
    let bestRange = 0;
    for (const p of referenced) {
      const tr = tracks.get(p);
      if (!tr) continue;
      const ys = tr.y.filter((_, i) => tr.conf[i] >= VISIBLE);
      const r = quantile(ys, 0.95) - quantile(ys, 0.05);
      if (r > bestRange) {
        bestRange = r;
        best = p;
      }
    }
    const name = best ?? "mid_hip";
    const tr = tracks.get(name);
    return { values: tr ? tr.y : new Float64Array(n).fill(NaN), points: constituents(name) };
  }

  function computeSegments(kind: SegmentKind): Segment[] {
    const minDur = spec.segment.min_duration_s;
    switch (kind) {
      case "reps": {
        let values: Float64Array | null = null;
        let pts: string[] = [];
        if (signalExpr && kind === defaultKind) {
          const acc: Accessed = new Set();
          try {
            const s = evaluate(signalExpr, createEnv(world, whole, acc));
            if (isSeries(s) && s.values.length === n) values = s.values;
            else if (isPoints(s)) values = s.y;
            else issues.push("segment.signal must be a series over the clip, e.g. left_hip.y");
          } catch (e) {
            issues.push(`segment.signal: ${(e as Error).message}`);
          }
          pts = [...acc];
        }
        if (!values) ({ values, points: pts } = defaultSignal());
        segConf.set(kind, meanFinite(pts.filter((p) => !p.startsWith("__")).map((p) => tracks.meanConf(p))) || 1);
        const segs = repSegments(values, tracks.t, minDur ?? 0.3);
        if (!segs.length) hints.push("I couldn't find a full repetition. Record at least two complete ones with the whole movement in view.");
        return segs;
      }
      case "moves": {
        segConf.set(kind, meanFinite(["left_wrist", "right_wrist", "left_ankle", "right_ankle"].map((p) => tracks.meanConf(p))) || 0);
        return moveSegments(extremitySpeed(tracks), tracks.t, minDur ?? 0.2);
      }
      case "holds":
        segConf.set(kind, meanFinite(POSE_LANDMARKS.map((p) => tracks.meanConf(p))) || 0);
        return holdSegments(getBodySpeed(), tracks.t, minDur ?? 0.5);
      case "phrases": {
        segConf.set(kind, 1);
        if (!beats.length) {
          issues.push("no beat information for phrases");
          return [];
        }
        return phraseSegments(beats, spec.segment.beats ?? 8, tracks.t);
      }
      case "whole": {
        segConf.set(kind, 1);
        let sig: Float64Array | undefined;
        if (signalExpr) {
          try {
            const s = evaluate(signalExpr, createEnv(world, whole, new Set()));
            if (isSeries(s) && s.values.length === n) sig = s.values;
          } catch {
            /* reported when segmenting by the signal */
          }
        }
        return wholeSegment(n, sig);
      }
    }
  }

  function computePhases(kind: SegmentKind): Record<string, Uint8Array> {
    const segs = world.segments(kind);
    const bs = getBodySpeed();
    const smooth = movingAverage(fillGaps(bs), Math.max(1, Math.round(0.2 * fps)));
    const thr = holdThreshold(smooth);
    const masks = builtinPhases(segs, n, Array.from(smooth, (x) => x < thr));
    // phases declared in the spec are evaluated inside each segment, so max()/min() are per segment
    for (const [name, e] of phaseExprs) {
      const m = new Uint8Array(n);
      segs.forEach((s, k) => {
        const idx = rangeIdx(s.start, s.end);
        try {
          const out = evaluate(e, createEnv(world, { idx, kind, segIndex: k, segment: s }, new Set()));
          if (isSeries(out) && out.values.length === idx.length) out.values.forEach((x, j) => (m[idx[j]] = x !== 0 && !Number.isNaN(x) ? 1 : 0));
          else if (truthy(out)) idx.forEach((i) => (m[i] = 1));
        } catch (err) {
          issues.push(`phase ${name}: ${(err as Error).message}`);
        }
      });
      masks[name] = m;
    }
    return masks;
  }

  // timing against the beat needs a beat; say so up front rather than as a vague failure
  const beatFns = new Set(["on_beat", "step_offset_ms"]);
  const usesBeats = defaultKind === "phrases" || allExprs.some((e) => [...calledFunctions(e)].some((f) => beatFns.has(f)));
  if (usesBeats && !beats.length) hints.push("Play the music or the metronome out loud while you record, so the beat is in the clip.");
  world.segments(defaultKind);

  // ---- 4. metrics -----------------------------------------------------------
  const metrics: Record<string, MetricValue> = {};
  for (const [name, me] of metricExprs) {
    const accessed: Accessed = new Set();
    const unit = spec.units?.[name] ?? inferUnit(me.expr);
    try {
      if (me.per) {
        const kind = segmentKindOf(me.per, defaultKind);
        const segs = world.segments(kind);
        if (!segs.length) throw new ExprRuntimeError(`no ${kind} found in the clip`);
        const vals: number[] = [];
        const confs: number[] = [];
        segs.forEach((s, k) => {
          let idx = rangeIdx(s.start, s.end);
          if (me.at) {
            const mk = world.phaseMask(me.at, kind);
            if (!mk) throw new ExprRuntimeError(`unknown phase "${me.at}"`);
            idx = maskIdx(mk, idx);
          }
          if (!idx.length) {
            vals.push(NaN);
            confs.push(0);
            return;
          }
          const acc: Accessed = new Set();
          const out = evaluate(me.expr, createEnv(world, { idx, kind, segIndex: k, segment: s }, acc));
          vals.push(toNumber(out));
          confs.push(confOf(acc, idx));
          acc.forEach((a) => accessed.add(a));
        });
        accessed.add(`__seg:${kind}`);
        const conf = Math.min(meanFinite(confs), confOf(new Set([`__seg:${kind}`]), whole.idx));
        const keyTimes = segs.map((s) => tracks.t[s.key]);
        stored.set(name, { kind: "per", perKind: kind, value: meanFinite(vals), confidence: conf, per: vals, series: series(vals, confs, keyTimes) });
      } else {
        let view = whole;
        if (me.at) {
          const mk = world.phaseMask(me.at, defaultKind);
          if (!mk) throw new ExprRuntimeError(`unknown phase "${me.at}"`);
          const idx = maskIdx(mk);
          if (!idx.length) throw new ExprRuntimeError(`no "${me.at}" phase found in the clip`);
          view = { idx };
        }
        const out = evaluate(me.expr, createEnv(world, view, accessed));
        const conf = confOf(accessed, view.idx);
        stored.set(name, storeValue(out, view, conf, !!me.at));
      }
    } catch (e) {
      issues.push(`${name}: ${(e as Error).message}`);
      stored.set(name, { kind: "scalar", value: NaN, confidence: 0 });
      continue;
    }
    const s = stored.get(name)!;
    if (!Number.isFinite(s.value)) {
      issues.push(`${name}: could not be measured`);
      continue;
    }
    const per = s.kind === "per" || s.kind === "items" ? (s.per ?? toArray(s.series!)) : undefined;
    metrics[name] = metric(s.value, unit, s.confidence, per && per.every(Number.isFinite) ? per : undefined);
  }

  function storeValue(out: Value, view: View, conf: number, atPhase: boolean): StoredMetric {
    if (typeof out === "number" || typeof out === "boolean") return { kind: "scalar", value: toNumber(out), confidence: conf };
    if (isSeries(out)) {
      if (out.values.length === view.idx.length && view.idx.length === n && !atPhase) return { kind: "frame", value: meanFinite(out.values), confidence: conf, series: out };
      if (out.values.length === view.idx.length) return { kind: "scalar", value: meanFinite(out.values), confidence: conf };
      return { kind: "items", value: meanFinite(out.values), confidence: conf, series: out, per: Array.from(out.values) };
    }
    if (Array.isArray(out)) {
      const vals = toArray(out);
      return { kind: "items", value: meanFinite(vals), confidence: conf, series: series(vals), per: vals };
    }
    throw new ExprRuntimeError("the expression doesn't give a number");
  }

  // ---- 5. mistakes ----------------------------------------------------------
  const timeOf = (s: Series, i: number) => (s.t ? s.t[i] : tracks.t[Math.min(n - 1, i)]);
  const timesWhere = (s: Series, pred: (x: number) => boolean): number[] => {
    const out: number[] = [];
    const isFrameSeries = s.values.length === n;
    for (let i = 0; i < s.values.length; i++) {
      if (!pred(s.values[i])) continue;
      // for a per-frame series keep the start of each stretch, not every frame
      if (isFrameSeries && i > 0 && pred(s.values[i - 1])) continue;
      out.push(timeOf(s, i));
    }
    return out;
  };
  const cmp = (op: string, a: number, b: number) => (op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : op === "==" ? a === b : a !== b);

  /** Which items made a mistake true: `share(not ok) >= 0.3` points at the items where `not ok` holds. */
  function witness(e: Expr, env: ReturnType<typeof createEnv>): { times: number[]; share?: number } | null {
    if (e.kind === "binary" && (e.op === "&&" || e.op === "||")) {
      const a = witness(e.left, env);
      const b = witness(e.right, env);
      if (!a && !b) return null;
      return { times: [...new Set([...(a?.times ?? []), ...(b?.times ?? [])])].sort((x, y) => x - y), share: a?.share ?? b?.share };
    }
    if (e.kind !== "binary" || !COMPARISONS.has(e.op)) return null;
    const left = e.left;
    try {
      const rhs = toNumber(evaluate(e.right, env));
      if (left.kind === "call" && SHARES.has(left.fn) && left.args[0]) {
        const s = evaluate(left.args[0], env);
        if (!isSeries(s)) return null;
        const on = (x: number) => x !== 0 && !Number.isNaN(x);
        const finite = s.values.filter((x) => !Number.isNaN(x)).length;
        return { times: timesWhere(s, on), share: finite ? s.values.filter(on).length / finite : undefined };
      }
      const inner = left.kind === "call" && REDUCERS.has(left.fn) && left.args[0] ? left.args[0] : left;
      const s = evaluate(inner, env);
      if (!isSeries(s)) return null;
      const on = (x: number) => Number.isFinite(x) && cmp(e.op, x, rhs);
      const finite = s.values.filter(Number.isFinite).length;
      const times = timesWhere(s, on);
      return { times: times.length ? times : timesWhere(s, Number.isFinite), share: finite ? s.values.filter(on).length / finite : undefined };
    } catch {
      return null;
    }
  }

  const candidates: NonNullable<AnalysisInput["mistakes"]> = [];
  const mistakeMetrics = new Map<string, string[]>();
  for (const me of mistakeExprs) {
    if (!me) continue;
    const accessed: Accessed = new Set();
    const env = createEnv(world, whole, accessed);
    let out: Value;
    try {
      out = evaluate(me.when, env);
    } catch (e) {
      issues.push(`mistake ${me.m.id}: ${(e as Error).message}`);
      continue;
    }
    let present: boolean;
    let shareV: number | undefined;
    let at: number[] = [];
    if (isSeries(out)) {
      const on = (x: number) => x !== 0 && !Number.isNaN(x);
      const finite = out.values.filter((x) => !Number.isNaN(x)).length;
      shareV = finite ? out.values.filter(on).length / finite : 0;
      at = timesWhere(out, on);
      present = shareV > 0 && shareV >= (me.m.min_share ?? 0);
    } else {
      present = truthy(out);
      if (present) {
        const w = witness(me.when, createEnv(world, whole, new Set()));
        if (w) {
          at = w.times;
          shareV = w.share;
        }
        if (me.m.min_share !== undefined && shareV !== undefined) present = shareV >= me.m.min_share;
      }
    }
    const used = [...rootNames(me.when)].filter((r) => stored.has(r));
    mistakeMetrics.set(me.m.id, used);
    if (!present) continue;
    const confidence = confOf(accessed, whole.idx);
    if (confidence < me.m.min_confidence) {
      issues.push(`mistake ${me.m.id} not shown: confidence ${confidence.toFixed(2)} below ${me.m.min_confidence}`);
      continue;
    }
    at = at.slice(0, 20);
    candidates.push({
      id: me.m.id,
      severity: me.m.severity,
      confidence,
      at,
      evidence: { kind: "time", t: at[0] ?? tracks.t[0] },
      ...(shareV !== undefined ? { share: Math.max(0, Math.min(1, shareV)) } : {})
    });
  }
  const mistakes = applyConfidenceFloor(candidates);

  // ---- 6. criteria ------------------------------------------------------------
  const criteria: Record<string, boolean> = {};
  for (const [id, src] of Object.entries(ctx.criteria ?? {})) {
    try {
      criteria[id] = truthy(evaluate(parseExpr(src), createEnv(world, whole, new Set())));
    } catch (e) {
      criteria[id] = false;
      issues.push(`criterion ${id}: ${(e as Error).message}`);
    }
  }

  // nothing trustworthy: ask for a better recording, naming the problem
  const names = Object.keys(metrics);
  if (Object.keys(spec.metrics).length && !names.some((k) => metrics[k].confidence >= CONFIDENCE_FLOOR)) {
    let instruction: string;
    if (af < 1) instruction = angleInstruction(spec.capture.angle);
    else if (hints.length) instruction = hints[0];
    else if (missing.length) instruction = framingInstruction(missing);
    else if (!names.length && issues.some((i) => /reference/.test(i))) instruction = "Add the reference clip for this drill, then record again.";
    else instruction = "I couldn't see you clearly enough. Record in brighter light with your whole body inside the frame.";
    return reRecord("movement", issues, instruction, v);
  }

  // ---- 7. praise, markers, segments, overlay -----------------------------------
  const praise = findPraise();
  function findPraise(): { metric: string; label: string } | undefined {
    const shown = new Set(mistakes.flatMap((m) => mistakeMetrics.get(m.id) ?? []));
    const margins = new Map<string, number>();
    const metricNames = new Set(stored.keys());
    const consider = (e: Expr, goodWhenTrue: boolean, owner?: string) => {
      walk(e, (node) => {
        if (node.kind !== "binary" || !COMPARISONS.has(node.op)) return;
        const lm = [...rootNames(node.left)].filter((r) => metricNames.has(r));
        const rm = [...rootNames(node.right)].filter((r) => metricNames.has(r));
        if ((lm.length === 0) === (rm.length === 0)) return;
        const metricSide = lm.length ? node.left : node.right;
        const env = createEnv(world, whole, new Set());
        try {
          const l = toNumber(evaluate(node.left, env));
          const r = toNumber(evaluate(node.right, env));
          const k = lm.length ? r : l;
          const val = lm.length ? l : r;
          if (!Number.isFinite(l) || !Number.isFinite(r)) return;
          const good = cmp(node.op, l, r) === goodWhenTrue;
          const margin = ((good ? 1 : -1) * Math.abs(val - k)) / Math.max(Math.abs(k), 1e-6);
          for (const m of owner ? [owner] : [...rootNames(metricSide)].filter((x) => metricNames.has(x))) margins.set(m, Math.min(margins.get(m) ?? Infinity, margin));
        } catch {
          /* not measurable */
        }
      });
    };
    for (const [name, me] of metricExprs) consider(me.expr, true, name);
    mistakeExprs.forEach((me) => me && consider(me.when, false));
    for (const src of Object.values(ctx.criteria ?? {})) {
      try {
        consider(parseExpr(src), true);
      } catch {
        /* reported above */
      }
    }
    let best: string | undefined;
    for (const [m, margin] of margins) {
      if (!metrics[m] || metrics[m].confidence < CONFIDENCE_FLOOR || shown.has(m) || !(margin > 0)) continue;
      if (!best || margin > margins.get(best)!) best = m;
    }
    if (!best) return undefined;
    return { metric: best, label: `${prettyName(best)}: ${formatValue(metrics[best].value, metrics[best].unit)}`.slice(0, 60) };
  }

  const segs = world.segments(defaultKind);
  const markers: NonNullable<AnalysisInput["markers"]> = [];
  segs.slice(0, 50).forEach((s, k) => markers.push({ t: tracks.t[s.start], label: `${singular(defaultKind)} ${k + 1}`, role: "neutral" }));
  for (const m of mistakes) for (const t of (m.at ?? []).slice(0, 10)) markers.push({ t, label: m.id, role: "attention" });
  markers.sort((a, b) => a.t - b.t);

  const keyFrames: { t: number; ref: string; label?: string }[] = [];
  const sortedMistakes = [...mistakes].sort((a, b) => b.severity - a.severity || b.confidence - a.confidence);
  for (const m of sortedMistakes) {
    if (keyFrames.length >= 3) break;
    const t = m.at?.[0];
    if (t === undefined) continue;
    const i = nearestIndex(tracks.t, t);
    keyFrames.push({ t: tracks.t[i], ref: `frame:${i}`, label: m.id.slice(0, 60) });
  }
  if (!keyFrames.length && praise && segs.length) keyFrames.push({ t: tracks.t[segs[0].key], ref: `frame:${segs[0].key}`, label: praise.label });

  const overlay = buildOverlay(world, segs, mistakes, mistakeExprs.filter((m): m is NonNullable<typeof m> => !!m));

  return finish({
    engine: "movement",
    quality: { ok: true, issues },
    metrics,
    markers,
    mistakes,
    criteria,
    ...(praise ? { praise } : {}),
    keyFrames,
    overlay,
    version: v,
    segments: segs.map((s) => [tracks.t[s.start], tracks.t[s.end]] as [number, number]),
    precision: "full"
  });
}

function skeletonAt(frame: PoseFrame): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  for (const [k, p] of Object.entries(frame.pose ?? {})) if (p[3] >= 0.3) out[k] = [p[0], p[1], p[3]];
  return out;
}

interface Mark {
  mistake: string;
  t: number;
  draw: string;
  points: string[];
  coords: [number, number][];
  value?: number;
  ghost?: Record<string, [number, number, number]>;
}

/** The studio's drawing instructions: skeletons at key frames and marks for each mistake, in normalized frame coordinates. */
function buildOverlay(world: World, segs: Segment[], mistakes: { id: string; at?: number[] }[], exprs: { m: { id: string }; show?: Expr }[]) {
  const { tracks } = world;
  const keyIdx = new Set<number>(segs.slice(0, 20).map((s) => s.key));
  for (const m of mistakes) for (const t of (m.at ?? []).slice(0, 5)) keyIdx.add(nearestIndex(tracks.t, t));
  const frames = [...keyIdx].sort((a, b) => a - b).map((i) => ({ t: tracks.t[i], points: skeletonAt(world.frames[i]) }));

  const showFns: Record<string, ExprFn> = {
    angle_arc: (args) => ({ kind: "overlay", draw: "arc", points: args.map((a) => nameOfValue(a)) }),
    line: (args) => ({ kind: "overlay", draw: "line", points: args.map((a) => nameOfValue(a)) }),
    ghost: () => ({ kind: "overlay", draw: "ghost", points: [] })
  };
  let comparison = world.lastComparison;
  const ghostAt = (i: number) => {
    if (!world.reference?.length) return undefined;
    comparison ??= compareToReference(world.frames, world.reference, undefined, { aspect: tracks.aspect });
    const pair = comparison.path.find(([a]) => a === i);
    return pair ? skeletonAt(world.reference[pair[1]]) : undefined;
  };
  const marks: Mark[] = [];
  for (const m of mistakes) {
    const ex = exprs.find((e) => e.m.id === m.id);
    let draw = "skeleton";
    let points: string[] = [];
    if (ex?.show) {
      try {
        const d = evaluate(ex.show, createEnv(world, { idx: allFrames(tracks.n) }, new Set(), showFns));
        if (typeof d === "string") draw = d;
        else if (d && typeof d === "object" && !Array.isArray(d) && (d as Record<string, Value>).kind === "overlay") {
          draw = String((d as Record<string, Value>).draw);
          points = ((d as Record<string, Value>).points as Value[]).map(String);
        }
      } catch {
        /* nothing to draw beyond the skeleton */
      }
    }
    for (const t of (m.at ?? []).slice(0, 5)) {
      const i = nearestIndex(tracks.t, t);
      const coords: [number, number][] = points.filter((p) => !isDirection(p)).map((p) => {
        const tr = tracks.get(p);
        return tr ? [tr.x[i], tr.y[i]] : [NaN, NaN];
      });
      const mark: Mark = { mistake: m.id, t: tracks.t[i], draw, points, coords: coords.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)) };
      if (draw === "arc" && points.length === 3) mark.value = angleAt(tracks, points, i);
      if (draw === "ghost") mark.ghost = ghostAt(i);
      marks.push(mark);
    }
  }
  const events = [...world.beatEvents.entries()].sort((a, b) => a[0] - b[0]).map(([t, offsetMs]) => ({ t, offsetMs }));
  return {
    kind: "pose",
    space: "normalized",
    edges: POSE_EDGES,
    frames,
    marks,
    segments: segs.map((s) => [tracks.t[s.start], tracks.t[s.end]]),
    ...(world.beats.length ? { beats: world.beats } : {}),
    ...(events.length ? { events } : {})
  };
}

function nameOfValue(v: Value): string {
  if (typeof v === "string") return v;
  if (isPoints(v)) return (v as { name?: string }).name ?? "point";
  if (v && typeof v === "object" && !Array.isArray(v) && (v as Record<string, Value>).kind === "direction") return String((v as Record<string, Value>).name);
  return "value";
}

function angleAt(tracks: Tracks, names: string[], i: number): number | undefined {
  const dir: Record<string, [number, number]> = { vertical: [0, -1], horizontal: [1, 0] };
  const b = tracks.get(names[1]);
  if (!b) return undefined;
  const vec = (nm: string): [number, number] | null => {
    if (dir[nm]) return dir[nm];
    const p = tracks.get(nm);
    return p ? [(p.x[i] - b.x[i]) * tracks.aspect, p.y[i] - b.y[i]] : null;
  };
  const u = vec(names[0]);
  const w = vec(names[2]);
  if (!u || !w) return undefined;
  const c = (u[0] * w[0] + u[1] * w[1]) / (Math.hypot(...u) * Math.hypot(...w));
  const deg = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
  return Number.isFinite(deg) ? deg : undefined;
}
