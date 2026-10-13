import { z } from "zod";
import { countWords } from "../words.js";

/** Measurements the visual engine can compute from points the learner taps or from the image. */
export const VISUAL_MEASURES = ["tapped_points", "proportion", "symmetry", "exposure", "color_balance", "edge_density", "text", "line_count", "angle"] as const;

export const RubricCriterionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/),
  label: z.string().max(60).optional(),
  /** level number -> description; levels are ordered, higher is better */
  levels: z.record(z.string().regex(/^\d+$/), z.string().min(1)),
  /** optional measurement backing the score, e.g. `tapped_points(head_top, chin, feet)` or `symmetry(vertical)` */
  measure: z.string().optional(),
  /** optional expression over measurements that maps to a level, e.g. `if(ratio_error < 0.1, 3, if(ratio_error < 0.25, 2, 1))` */
  level_from: z.string().optional(),
  weight: z.number().min(0).max(10).default(1)
});

export const RubricSpecSchema = z.object({
  kind: z.literal("rubric").default("rubric"),
  criteria: z.array(RubricCriterionSchema).min(1).max(8),
  must_cite: z.enum(["region", "timestamp", "line", "none"]).default("region"),
  /** points the learner is asked to tap before grading, with a prompt for each */
  taps: z.array(z.object({ id: z.string(), prompt: z.string().max(60) })).max(8).optional(),
  reference_image: z.string().optional(),
  /** expression over criterion levels for pass/fail, e.g. `proportions >= 2 && line_confidence >= 2` */
  pass: z.string().optional(),
  /** safety-critical rubrics are never proofs */
  safety_critical: z.boolean().default(false)
});
export type RubricSpec = z.infer<typeof RubricSpecSchema>;
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

export function checkRubricSpec(spec: RubricSpec): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  spec.criteria.forEach((c, i) => {
    const levels = Object.keys(c.levels).map(Number).sort((a, b) => a - b);
    if (levels.length < 2) issues.push({ path: `criteria[${i}].levels`, message: "a criterion needs at least 2 levels" });
    for (const [k, v] of Object.entries(c.levels)) {
      if (countWords(v) > 25) issues.push({ path: `criteria[${i}].levels.${k}`, message: "level descriptions are 25 words or fewer" });
    }
    if (c.measure) {
      const fn = /^([a-z_]+)\s*\(/.exec(c.measure)?.[1];
      if (!fn || !(VISUAL_MEASURES as readonly string[]).includes(fn)) issues.push({ path: `criteria[${i}].measure`, message: `unknown measure; use one of ${VISUAL_MEASURES.join(", ")}` });
    }
  });
  if (spec.safety_critical) issues.push({ path: "safety_critical", message: "rubric grading is never the proof for anything safety-critical" });
  return issues;
}
