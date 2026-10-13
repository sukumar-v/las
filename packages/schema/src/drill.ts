import { z } from "zod";
import { CaptureSpecSchema } from "./specs/metric.js";

/** The standard drill types. A skill model chooses among them and can't invent new ones. */
export const DRILL_TYPES = ["choice", "match", "order", "hotspot", "predict-output", "fill", "tap-rhythm", "play-along", "say-it", "move", "timed-reps", "build", "make"] as const;
export type DrillType = (typeof DRILL_TYPES)[number];

/** Which engine scores each drill type. */
export const DRILL_ENGINE: Record<DrillType, "knowledge" | "audio" | "speech" | "movement" | "code" | "visual" | "interaction"> = {
  choice: "knowledge",
  match: "knowledge",
  order: "knowledge",
  hotspot: "knowledge",
  "predict-output": "knowledge",
  fill: "knowledge",
  "tap-rhythm": "interaction",
  "play-along": "audio",
  "say-it": "speech",
  move: "movement",
  "timed-reps": "movement",
  build: "code",
  make: "visual"
};

export const DifficultySchema = z.object({
  /** the parameter that gets harder */
  param: z.string().max(40),
  /** ordered levels, as labels or numbers */
  levels: z.array(z.union([z.string().max(40), z.number()])).min(1).max(8),
  start: z.number().int().min(0).default(0)
});

export const DrillSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-_.]*$/),
  type: z.enum(DRILL_TYPES),
  title: z.string().max(60),
  /** instruction, 25 words or fewer */
  prompt: z.string().max(200).optional(),
  nodes: z.array(z.string()).min(1),
  /** engine spec id in model.specs (required for performance drills) */
  spec: z.string().optional(),
  /** knowledge drills can inline items instead of a spec */
  items: z.array(z.string()).optional(),
  capture: CaptureSpecSchema.optional(),
  needs: z.array(z.string()).default([]),
  /** expression over the result metrics, true means success */
  success: z.string().optional(),
  difficulty: DifficultySchema.optional(),
  minutes: z.number().min(1).max(30).default(5),
  /** physical intensity 1..5 for caps and injury rules */
  intensity: z.number().int().min(1).max(5).default(2),
  /** practice-mix category this drill counts toward */
  focus: z.string().max(40).optional(),
  /** fix drills are targeted at a mistake */
  fixes: z.array(z.string()).default([])
});
export type Drill = z.infer<typeof DrillSchema>;
export type DrillInput = z.input<typeof DrillSchema>;

/** A drill outcome: every drill type reports the same shape. */
export const DrillOutcomeSchema = z.object({
  drillId: z.string(),
  nodes: z.array(z.string()),
  success: z.boolean(),
  score: z.number().min(0).max(1),
  metrics: z.record(z.string(), z.number()).prefault({}),
  mistakes: z.array(z.string()).default([]),
  difficulty: z.number().int().min(0).default(0),
  durationS: z.number().min(0).optional(),
  attemptId: z.string().optional()
});
export type DrillOutcome = z.infer<typeof DrillOutcomeSchema>;
