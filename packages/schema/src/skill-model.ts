import { z } from "zod";
import { EngineIdSchema } from "./engines.js";
import { EngineSpecSchema } from "./specs/index.js";
import { CaptureSpecSchema } from "./specs/metric.js";
import { CardSchema, LessonSpecSchema } from "./lesson.js";
import { DrillSchema } from "./drill.js";
import { FigureSchema } from "./lesson.js";

const id = z.string().regex(/^[a-z0-9][a-z0-9-_.]*$/, "ids are lowercase with - _ .");
const short = (n: number) => z.string().min(1).max(n);

export const WhyOptionSchema = z.object({ id, label: short(40), icon: z.string().max(20).optional() });

export const PictureSchema = z.object({
  id,
  label: short(60),
  /** why ids this picture fits */
  why: z.array(z.string()).default([]),
  /** the ladder step this picture needs */
  ladderStep: z.number().int().min(1),
  /** the picture's own milestone wording and proof label */
  milestone: short(80),
  proof: short(120),
  /** practice mix for this picture, category -> share (sums to ~100) */
  focus: z.record(z.string(), z.number().min(0).max(100)),
  access: z.array(z.string().max(40)).optional()
});
export type Picture = z.infer<typeof PictureSchema>;

/** Standard answer types for level checks. */
export const PROBE_TYPES = ["single", "multi", "scale", "visual-multi", "quiz", "tap", "record", "code"] as const;

export const ProbeOptionSchema = z.object({
  value: z.union([z.string(), z.number()]),
  label: short(60),
  detail: z.string().max(80).optional(),
  figure: FigureSchema.optional()
});

export const ProbeSchema = z.object({
  id,
  type: z.enum(PROBE_TYPES),
  question: short(120),
  sub: z.string().max(120).optional(),
  options: z.array(ProbeOptionSchema).max(12).optional(),
  /** for `quiz`, `tap`, `record`, `code`: a spec id in model.specs */
  spec: z.string().optional(),
  /** up to how many picks for `multi`/`visual-multi` */
  max: z.number().int().min(1).max(12).optional(),
  optional: z.boolean().default(false)
});
export type Probe = z.infer<typeof ProbeSchema>;

/** Evidence -> ladder step, as data. Rules run in order; the first match wins; no match means step 0. */
export const PlacementRuleSchema = z.object({ when: short(200), step: z.number().int().min(0), evidence: z.string().max(80).optional() });
export type PlacementRule = z.infer<typeof PlacementRuleSchema>;

export const ProofCriterionSchema = z.object({ id, label: short(80), check: short(200) });

export const ProofSpecSchema = z.object({
  engine: EngineIdSchema,
  /** spec id in model.specs; required unless engine is self-report */
  spec: z.string().optional(),
  label: short(120),
  criteria: z.array(ProofCriterionSchema).min(1).max(6),
  capture: CaptureSpecSchema.optional(),
  single_take: z.literal(true).default(true),
  /** the fallback engine when the primary one isn't available, recorded by the agent */
  fallback: EngineIdSchema.optional(),
  fallback_spec: z.string().optional()
});
export type ProofSpec = z.infer<typeof ProofSpecSchema>;

export const LadderStepSchema = z.object({
  id,
  label: short(60),
  /** hours to reach this step from the previous one, as a range */
  hours: z.tuple([z.number().min(0), z.number().min(0)]),
  /** nodes that must be mastered for this step */
  nodes: z.array(z.string()).default([]),
  /** step 0 has no proof */
  proof: ProofSpecSchema.optional(),
  sources: z.array(z.string().max(200)).optional()
});
export type LadderStep = z.infer<typeof LadderStepSchema>;

export const BktSchema = z.object({
  p_init: z.number().min(0).max(1).default(0.1),
  p_learn: z.number().min(0).max(1).default(0.2),
  p_slip: z.number().min(0).max(0.5).default(0.1),
  p_guess: z.number().min(0).max(0.5).default(0.15)
});

export const ReviewCardSchema = z.object({
  prompt: short(160),
  kind: z.enum(["choice", "hotspot", "fill", "say", "play", "recall"]).default("choice"),
  options: z.array(z.string().max(60)).max(6).optional(),
  answer: z.union([z.number().int(), z.string()]).optional(),
  figure: FigureSchema.optional()
});

export const NodeSchema = z.object({
  id,
  name: short(50),
  requires: z.array(z.string()).default([]),
  lesson: z.string(),
  drills: z.array(z.string()).min(1),
  mistakes: z.array(z.string()).default([]),
  bkt: BktSchema.prefault({}),
  review: ReviewCardSchema,
  /** practice-mix category */
  focus: z.string().max(40).optional()
});
export type SkillNode = z.infer<typeof NodeSchema>;

export const MistakeSchema = z.object({
  id,
  name: short(50),
  nodes: z.array(z.string()).min(1),
  engine: EngineIdSchema,
  detector: z.object({
    /** the metric (from the engine spec) or analysis field the detector reads */
    metric: short(60),
    /** expression over metrics (and learner/baseline), true means present */
    when: short(200),
    min_share: z.number().min(0).max(1).optional(),
    min_confidence: z.number().min(0).max(1).default(0.7)
  }),
  severity: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  /** the visual explanation under "Why?": a lesson card or a figure. Fallback content (live coach §9): without it the Why button is left out */
  explain: z.union([z.object({ lesson: z.string(), card: z.number().int().min(0).default(0) }), z.object({ figure: FigureSchema })]).optional(),
  fix_drill: z.string(),
  resolved_after: z.number().int().min(1).max(10).default(3),
  /**
   * headline of 8 words or fewer. Fallback content (live coach §9): optional; "" when the agent didn't write one,
   * and the fallback feedback uses the mistake's `name`
   */
  headline: z.string().max(60).default("")
});
export type Mistake = z.infer<typeof MistakeSchema>;

/**
 * A lesson in the skill model. Its cards are fallback content (live coach §9): optional, checked whenever present.
 * A lesson without cards is skipped by the fallback; a live coach writes the cards for this learner.
 */
export const ModelLessonSchema = LessonSpecSchema.required({ id: true }).extend({ cards: z.array(CardSchema).max(5).default([]) });
export type ModelLesson = z.infer<typeof ModelLessonSchema>;

export const WarmupSchema = z.object({
  id,
  title: short(50),
  steps: z.array(short(80)).min(1).max(8),
  minutes: z.number().min(1).max(20).default(5),
  for_injuries: z.array(z.string()).optional()
});

export const SafetySchema = z.object({
  warmup: z.string(),
  injury_questions: z.array(short(80)).min(1),
  beginner_caps: z.object({ max_intensity: z.number().int().min(1).max(5).default(3), max_minutes: z.number().int().min(5).max(120).default(45), sessions_per_week: z.number().int().min(1).max(7).default(4) }),
  stop_criteria: z.array(short(100)).min(1),
  see_professional: z.array(short(100)).min(1),
  /** activities LAS teaches the theory of but won't coach or assess */
  supervised_only: z.array(short(80)).default([])
});
export type Safety = z.infer<typeof SafetySchema>;

export const KeyMetricSchema = z.object({
  id,
  label: short(40),
  engine: EngineIdSchema,
  /** metric name from the engine's analysis */
  metric: short(60),
  unit: z.string().max(12).default(""),
  better: z.enum(["higher", "lower"]).default("higher"),
  format: z.enum(["number", "percent", "ms", "count", "cents"]).default("number")
});

export const MediaSchema = z.object({
  id,
  path: z.string(),
  license: z.enum(["CC0", "CC-BY-4.0", "learner"]),
  note: z.string().max(120).optional()
});

export const SkillModelSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().optional(),
  /** what the learner typed */
  skill: short(80),
  name: short(60),
  /** lowercase noun used in questions ("bouldering", "the guitar") */
  noun: short(40),
  source: z.enum(["generated", "curated"]).default("generated"),
  based_on_pack: z.string().optional(),
  pack_version: z.string().optional(),
  version: z.number().int().min(1).default(1),
  physical: z.boolean(),
  engines: z.array(EngineIdSchema).min(1),
  /** engine the agent chose when one it wanted was missing: wanted -> used */
  fallbacks: z.record(z.string(), EngineIdSchema).optional(),
  why: z.array(WhyOptionSchema).min(3).max(8),
  pictures: z.array(PictureSchema).min(2).max(8),
  probes: z.array(ProbeSchema).min(1).max(3),
  placement: z.array(PlacementRuleSchema).default([]),
  ladder: z.array(LadderStepSchema).min(4).max(9),
  nodes: z.array(NodeSchema).min(1),
  lessons: z.array(ModelLessonSchema).min(1),
  drills: z.array(DrillSchema).min(1),
  specs: z.record(z.string(), EngineSpecSchema).prefault({}),
  mistakes: z.array(MistakeSchema).default([]),
  warmups: z.array(WarmupSchema).optional(),
  safety: SafetySchema.optional(),
  access: z.array(short(40)).default([]),
  /** injury -> training rule, as data */
  injuries: z.record(z.string(), short(160)).optional(),
  /** default practice mix, category -> share */
  focus: z.record(z.string(), z.number().min(0).max(100)),
  /** categories lowered when an injury is flagged */
  hard_focus: z.array(z.string()).optional(),
  key_metrics: z.array(KeyMetricSchema).min(1).max(3),
  media: z.array(MediaSchema).optional(),
  copy: z.object({ placeholder: z.string().max(60).optional(), blurb: z.string().max(80).optional() }).optional(),
  /** agent notes: sources and reasoning, not shown to learners */
  notes: z.string().max(2000).optional()
});
export type SkillModel = z.infer<typeof SkillModelSchema>;
export type SkillModelInput = z.input<typeof SkillModelSchema>;
