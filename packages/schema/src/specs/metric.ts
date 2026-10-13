import { z } from "zod";
import { calledFunctions, dottedNames, rootNames, type Expr } from "../expr/ast.js";
import { parseExpr, parseMetricExpr } from "../expr/parser.js";
import { STANDARD_FUNCTION_NAMES } from "../expr/evaluate.js";
import { isKnownPoint, trackerFor, POSE_GROUPS } from "../bodypoints.js";

/** Functions the movement engine adds on top of the standard library. */
export const MOVEMENT_FUNCTIONS = [
  "angle",
  "distance",
  "velocity",
  "speed",
  "height",
  "between",
  "phase_duration",
  "pose_similarity",
  "on_beat",
  "step_offset_ms",
  "symmetry",
  "jerk",
  "visible",
  "reps",
  "duration",
  "hold_time",
  "x",
  "y",
  "z",
  "overlay",
  "midpoint",
  "projection",
  "smooth",
  "angle_arc",
  "line",
  "ghost",
  "beat_timeline"
] as const;

export const KNOWN_METRIC_FUNCTIONS = new Set<string>([...STANDARD_FUNCTION_NAMES, ...MOVEMENT_FUNCTIONS]);

/** Names a metric spec may reference besides body points and other metrics. */
export const METRIC_CONTEXT_NAMES = new Set(["baseline", "learner", "beat", "reference", "rep", "segment", "t", "fps", "capture", "phase"]);
/** Built-in phase names for repetition-based segments. */
export const BUILTIN_PHASES = new Set(["down", "up", "hold", "bottom", "top", "start", "end", "peak"]);
/** Keywords used as options or as what to draw. */
export const METRIC_KEYWORDS = new Set(["dtw", "linear", "none", "beat_timeline", "ghost", "skeleton", "line", "arc", "all", ...Object.keys(POSE_GROUPS)]);

export const CAMERA_ANGLES = ["front", "side", "side-45", "back", "top", "over-shoulder", "any"] as const;
export const SEGMENT_KINDS = ["reps", "moves", "phrases", "holds", "whole"] as const;

export const CaptureSpecSchema = z.object({
  angle: z.enum(CAMERA_ANGLES).default("any"),
  fps: z.number().int().min(10).max(240).default(30),
  duration_s: z.number().min(1).max(600).optional(),
  distance_m: z.number().min(0.5).max(20).optional(),
  /** which trackers to run; derived from the points used when omitted */
  track: z.array(z.enum(["pose", "hands", "face", "objects"])).optional(),
  guide: z.string().max(120).optional()
});

export const SegmentSpecSchema = z.object({
  by: z.enum(SEGMENT_KINDS).default("whole"),
  /** a series expression whose minima split repetitions, e.g. `left_hip.y` */
  signal: z.string().optional(),
  beats: z.number().int().min(1).max(64).optional(),
  beat_source: z.enum(["audio_track", "metronome", "tap"]).optional(),
  min_duration_s: z.number().min(0.1).optional()
});

export const MistakeDetectorSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-_.]*$/),
  /** expression over metrics; true means the mistake is present */
  when: z.string().min(1),
  min_share: z.number().min(0).max(1).optional(),
  min_confidence: z.number().min(0).max(1).default(0.7),
  severity: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  /** what to draw: overlay(expr), beat_timeline, angle_arc(point,point,point), line(point,point), ghost */
  show: z.string().optional(),
  fix_drill: z.string().optional()
});

export const MetricSpecSchema = z.object({
  kind: z.literal("metric").default("metric"),
  capture: CaptureSpecSchema.prefault({}),
  segment: SegmentSpecSchema.prefault({}),
  reference: z.string().optional(),
  /** named phases, each an expression that marks the frames in the phase (e.g. bottom: `left_hip.y == max(left_hip.y)`) */
  phases: z.record(z.string(), z.string()).optional(),
  /** metric name -> expression, evaluated in order; later metrics can use earlier ones */
  metrics: z.record(z.string().regex(/^[a-z_][a-z0-9_]*$/), z.string().min(1)),
  /** optional unit per metric for display */
  units: z.record(z.string(), z.string()).optional(),
  mistakes: z.array(MistakeDetectorSchema).default([]),
  /** points that must be visible for the result to count */
  requires_visible: z.array(z.string()).optional()
});
export type MetricSpec = z.infer<typeof MetricSpecSchema>;
export type MetricSpecInput = z.input<typeof MetricSpecSchema>;
export type CaptureSpec = z.infer<typeof CaptureSpecSchema>;
export type MistakeDetector = z.infer<typeof MistakeDetectorSchema>;

export interface SpecIssue {
  path: string;
  message: string;
}

/** Static checks: every expression parses, every point and function is known, metrics reference only earlier metrics or context. */
export function checkMetricSpec(spec: MetricSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const defined = new Set<string>();
  const phases = new Set(Object.keys(spec.phases ?? {}));
  const checkNames = (e: Expr, path: string, allowMetrics: boolean) => {
    const dotted = dottedNames(e);
    for (const name of rootNames(e)) {
      if (isKnownPoint(name) || METRIC_CONTEXT_NAMES.has(name)) continue;
      if (allowMetrics && defined.has(name)) continue;
      if (phases.has(name) || BUILTIN_PHASES.has(name) || METRIC_KEYWORDS.has(name)) continue;
      if ([...dotted].some((d) => d.startsWith(name + ".") && isKnownPoint(d))) continue;
      issues.push({ path, message: `unknown name "${name}": use a standard body point, a context name (baseline, learner, beat, reference) or an earlier metric` });
    }
    for (const fn of calledFunctions(e)) {
      if (!KNOWN_METRIC_FUNCTIONS.has(fn)) issues.push({ path, message: `unknown function "${fn}"` });
    }
  };
  if (spec.segment.signal) {
    try {
      checkNames(parseExpr(spec.segment.signal), "segment.signal", false);
    } catch (e) {
      issues.push({ path: "segment.signal", message: (e as Error).message });
    }
  }
  for (const [name, src] of Object.entries(spec.phases ?? {})) {
    try {
      checkNames(parseExpr(src), `phases.${name}`, false);
    } catch (e) {
      issues.push({ path: `phases.${name}`, message: (e as Error).message });
    }
  }
  for (const [name, src] of Object.entries(spec.metrics)) {
    try {
      const m = parseMetricExpr(src);
      checkNames(m.expr, `metrics.${name}`, true);
      if (m.per && !["rep", "reps", "move", "moves", "phrase", "phrases", "hold", "holds", "segment", "whole"].includes(m.per)) {
        issues.push({ path: `metrics.${name}`, message: `unknown segment kind "${m.per}" after "per"` });
      }
      if (m.at && !phases.has(m.at) && !BUILTIN_PHASES.has(m.at)) {
        issues.push({ path: `metrics.${name}`, message: `unknown phase "${m.at}" after "at": declare it under phases` });
      }
    } catch (e) {
      issues.push({ path: `metrics.${name}`, message: (e as Error).message });
    }
    defined.add(name);
  }
  spec.mistakes.forEach((m, i) => {
    try {
      checkNames(parseExpr(m.when), `mistakes[${i}].when`, true);
    } catch (e) {
      issues.push({ path: `mistakes[${i}].when`, message: (e as Error).message });
    }
    if (m.show) {
      try {
        checkNames(parseExpr(m.show), `mistakes[${i}].show`, true);
      } catch (e) {
        issues.push({ path: `mistakes[${i}].show`, message: (e as Error).message });
      }
    }
  });
  for (const p of spec.requires_visible ?? []) {
    if (!isKnownPoint(p)) issues.push({ path: "requires_visible", message: `unknown point "${p}"` });
  }
  return issues;
}

/** Trackers a metric spec needs, derived from the points it references. */
export function trackersFor(spec: MetricSpec): ("pose" | "hands" | "face" | "objects")[] {
  if (spec.capture.track) return spec.capture.track;
  const out = new Set<"pose" | "hands" | "face" | "objects">();
  const sources = [spec.segment.signal, ...Object.values(spec.phases ?? {}), ...Object.values(spec.metrics), ...spec.mistakes.map((m) => m.when)];
  for (const src of sources) {
    if (!src) continue;
    try {
      for (const n of dottedNames(parseMetricExpr(src).expr)) {
        if (isKnownPoint(n)) {
          const t = trackerFor(n);
          if (t !== "derived") out.add(t);
          else out.add("pose");
        }
      }
    } catch {
      /* reported by checkMetricSpec */
    }
  }
  if (out.size === 0) out.add("pose");
  return [...out];
}
