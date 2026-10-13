import { z } from "zod";
import { EngineIdSchema } from "./engines.js";

/** Where a piece of evidence points: a frame, a time range, a line, an image region. */
export const EvidenceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time"), t: z.number(), end: z.number().optional(), frame: z.string().optional() }),
  z.object({ kind: z.literal("line"), file: z.string(), line: z.number().int(), end: z.number().int().optional() }),
  z.object({ kind: z.literal("region"), x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1), frame: z.string().optional() }),
  z.object({ kind: z.literal("item"), id: z.string() }),
  z.object({ kind: z.literal("move"), ply: z.number().int() }),
  z.object({ kind: z.literal("none") })
]);
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const MetricValueSchema = z.object({
  value: z.number(),
  unit: z.string().default(""),
  confidence: z.number().min(0).max(1).default(1),
  /** per-segment values when the metric is computed per rep/move/phrase */
  per: z.array(z.number()).optional()
});
export type MetricValue = z.infer<typeof MetricValueSchema>;

/** The one result shape every evaluator returns. */
export const AnalysisSchema = z.object({
  engine: EngineIdSchema,
  quality: z.object({ ok: z.boolean(), issues: z.array(z.string()).default([]), reRecord: z.string().optional() }),
  metrics: z.record(z.string(), MetricValueSchema).prefault({}),
  markers: z.array(z.object({ t: z.number(), label: z.string(), role: z.enum(["good", "attention", "reference", "neutral"]).default("neutral") })).default([]),
  mistakes: z
    .array(
      z.object({
        id: z.string(),
        severity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        confidence: z.number().min(0).max(1),
        at: z.array(z.number()).default([]),
        evidence: EvidenceRefSchema,
        share: z.number().min(0).max(1).optional()
      })
    )
    .default([]),
  criteria: z.record(z.string(), z.boolean()).prefault({}),
  /** something done well, as a metric id, for the "one thing done well" card */
  praise: z.object({ metric: z.string(), label: z.string().max(60) }).optional(),
  /** up to 3 annotated key frames (data URLs or media refs) */
  keyFrames: z.array(z.object({ t: z.number(), ref: z.string(), label: z.string().max(60).optional() })).max(3).default([]),
  /** engine-specific overlay data drawn by the studio: skeleton, pitch track, test table... */
  overlay: z.unknown().optional(),
  /** engine + spec + skill model version, so results are reproducible */
  version: z.string(),
  /** segments found (reps, moves, phrases) as [start, end] seconds */
  segments: z.array(z.tuple([z.number(), z.number()])).optional(),
  /** which engine this came from when a fallback was used */
  fallbackFor: EngineIdSchema.optional(),
  /** when a weaker check was used, what the learner should know */
  precision: z.enum(["full", "reduced", "self-report"]).default("full")
});
export type Analysis = z.infer<typeof AnalysisSchema>;
export type AnalysisInput = z.input<typeof AnalysisSchema>;

export const CONFIDENCE_FLOOR = 0.7;

/** The capture request an evaluator needs before it can analyze. */
export const AttemptSpecSchema = z.object({
  sk: z.string(),
  engine: EngineIdSchema,
  spec: z.string(),
  drillId: z.string().optional(),
  milestoneId: z.string().optional(),
  prompt: z.string().max(200),
  how: z.string().max(200).optional(),
  kind: z.enum(["drill", "perform", "proof", "probe", "rehearsal"]).default("perform"),
  attempt: z.number().int().min(1).default(1),
  singleTake: z.boolean().default(false)
});
export type AttemptSpec = z.infer<typeof AttemptSpecSchema>;
