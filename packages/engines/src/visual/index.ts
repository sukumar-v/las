/**
 * Visual engine: photos, scans and screenshots checked against a rubric.
 *
 * How grading works (LAS never grades an image itself):
 *   1. The studio sends the image, the points the learner tapped and any pixel data.
 *   2. The agent looks at the image with its own vision and grades each rubric criterion
 *      (`rubricPrompt` is the text it sees with the image), then submits the grades as
 *      `evidence.grades` with `grader: "agent"`. When the agent's model is text-only, a local open
 *      vision model can do the same with `grader: "local-model"`.
 *   3. This engine applies the grades (`applyRubricGrades`), adds the measurements that need no
 *      grader (taps, symmetry, exposure and so on), and returns one Analysis.
 *   4. When there are no grades yet, the result carries measurements only, `precision: "reduced"`
 *      and a quality issue saying grading is pending. A criterion with a `level_from` expression
 *      still gets a level from its measurements, but any submitted grade wins over it.
 *
 * A grade must cite where in the image it looked (`must_cite: region`). A grade with no region is
 * kept but its confidence is halved and a quality issue says so. Only region citing can be checked
 * here, because grades carry regions; `timestamp` and `line` rubrics are not enforced for images.
 */
import { CONFIDENCE_FLOOR, parseExpr, evalWith, toNumber, type Analysis, type MetricValue, type RubricSpec, type Value } from "@las/schema";
import type { AnalyzeContext, VisualEvidence } from "../types.js";
import { evalCondition, evalCriteria, finish, metric, metricVars, version } from "../common/analysis.js";
import { measureVisual, type MeasureRegion } from "./measure.js";

export { measureVisual, parseVisualMeasure } from "./measure.js";
export type { MeasureRegion, MeasureResult, ParsedMeasure } from "./measure.js";

type Grade = NonNullable<VisualEvidence["grades"]>[number];
type Criterion = RubricSpec["criteria"][number];

/** One criterion's result after grades are applied. */
export interface AppliedGrade {
  criterion: string;
  level: number;
  confidence: number;
  region?: MeasureRegion;
  note?: string;
  /** false when must_cite wanted a region and the grade had none */
  cited: boolean;
}

/** Confidence for a level worked out from measurements alone: deterministic, but only a proxy for the rubric. */
const MEASURED_CONFIDENCE = 0.8;

function levelKeys(c: Criterion): number[] {
  return Object.keys(c.levels).map(Number).sort((a, b) => a - b);
}

/** The nearest level the criterion actually defines. */
function snapLevel(c: Criterion, level: number): number {
  const keys = levelKeys(c);
  let best = keys[0];
  for (const k of keys) if (Math.abs(k - level) < Math.abs(best - level)) best = k;
  return best;
}

/** 0..1 position of a level between the criterion's lowest and highest level. */
function normalized(c: Criterion, level: number): number {
  const keys = levelKeys(c);
  const lo = keys[0];
  const hi = keys[keys.length - 1];
  return hi === lo ? 1 : (level - lo) / (hi - lo);
}

function cleanRegion(r: Grade["region"]): MeasureRegion | undefined {
  if (!r || ![r.x, r.y, r.w, r.h].every(Number.isFinite)) return undefined;
  const x = Math.max(0, Math.min(1, r.x));
  const y = Math.max(0, Math.min(1, r.y));
  return { x, y, w: Math.max(0, Math.min(1 - x, r.w)), h: Math.max(0, Math.min(1 - y, r.h)) };
}

/**
 * Check submitted grades against the rubric: unknown criteria are dropped, levels snap to a defined
 * level, and (for must_cite = region) a grade without a region has its confidence halved.
 * When a criterion is graded twice the more confident grade is kept.
 */
export function applyRubricGrades(spec: RubricSpec, grades: Grade[] | undefined): { applied: Record<string, AppliedGrade>; issues: string[] } {
  const applied: Record<string, AppliedGrade> = {};
  const issues: string[] = [];
  const byId = new Map(spec.criteria.map((c) => [c.id, c]));
  for (const g of grades ?? []) {
    const c = byId.get(g.criterion);
    if (!c) {
      issues.push(`grade for unknown criterion "${g.criterion}" ignored`);
      continue;
    }
    if (!Number.isFinite(g.level)) {
      issues.push(`grade for "${g.criterion}" has no level and was ignored`);
      continue;
    }
    const region = cleanRegion(g.region);
    let confidence = Math.max(0, Math.min(1, Number.isFinite(g.confidence) ? g.confidence : 0));
    const cited = spec.must_cite !== "region" || !!region;
    if (!cited) {
      confidence /= 2;
      issues.push(`grade for "${g.criterion}" does not point at a region of the image; confidence halved`);
    }
    const next: AppliedGrade = { criterion: c.id, level: snapLevel(c, g.level), confidence, ...(region ? { region } : {}), ...(g.note ? { note: g.note } : {}), cited };
    const prev = applied[c.id];
    if (!prev || next.confidence > prev.confidence) applied[c.id] = next;
  }
  return { applied, issues };
}

/** The text the agent sees together with the image: criteria, levels, how to cite, and the JSON to submit. */
export function rubricPrompt(spec: RubricSpec, taps?: Record<string, [number, number]>): string {
  const lines: string[] = [];
  lines.push("Grade the attached image against this rubric. Look at the image itself; do not guess from the learner's description.");
  lines.push("");
  lines.push("Criteria (higher levels are better):");
  for (const c of spec.criteria) {
    lines.push(`- ${c.id}${c.label ? ` (${c.label})` : ""}:`);
    for (const k of levelKeys(c)) lines.push(`    ${k} = ${c.levels[String(k)]}`);
  }
  if (spec.reference_image) lines.push("", `A reference image is also provided (${spec.reference_image}). Compare against it where a level mentions it.`);
  if (taps && Object.keys(taps).length) {
    lines.push("", "The learner marked these points (x, y from the top-left, 0 to 1):");
    for (const [id, p] of Object.entries(taps)) {
      const ask = spec.taps?.find((t) => t.id === id)?.prompt;
      lines.push(`- ${id}${ask ? ` (${ask})` : ""}: ${p[0].toFixed(3)}, ${p[1].toFixed(3)}`);
    }
  }
  lines.push("");
  if (spec.must_cite === "region") lines.push("For every grade, give the region of the image you judged as x, y, w, h (0 to 1, from the top-left). A grade without a region counts for half.");
  lines.push("Give a confidence from 0 to 1 for each grade. Use a low confidence when the image is unclear; do not inflate it.");
  lines.push("Add a short note (a few words) naming what you saw.");
  lines.push("");
  lines.push("Reply with only this JSON, one entry per criterion:");
  const first = spec.criteria[0];
  const mid = levelKeys(first)[Math.floor((levelKeys(first).length - 1) / 2)];
  lines.push(
    JSON.stringify(
      { grades: [{ criterion: first.id, level: mid, confidence: 0.8, ...(spec.must_cite === "region" ? { region: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 } } : {}), note: "what you saw" }] },
      null,
      2
    )
  );
  return lines.join("\n");
}

/** Evaluate a criterion's `level_from` over its measurements. Returns undefined when it can't be worked out. */
function levelFromMeasures(c: Criterion, values: Record<string, number>, extra: Record<string, Value>): number | undefined {
  if (!c.level_from) return undefined;
  try {
    const v = toNumber(evalWith(parseExpr(c.level_from), { ...extra, ...values }));
    return Number.isFinite(v) ? snapLevel(c, v) : undefined;
  } catch {
    return undefined;
  }
}

function put(metrics: Record<string, MetricValue>, name: string, value: number, unit = "", confidence = 1) {
  if (Number.isFinite(value)) metrics[name] = metric(value, unit, confidence);
}

export function analyzeVisual(spec: RubricSpec, evidence: VisualEvidence, ctx?: AnalyzeContext): Analysis {
  const v = version("visual", ctx?.specId, ctx?.modelVersion);
  const issues: string[] = [];
  const metrics: Record<string, MetricValue> = {};
  const expectedText = (ctx as { expectedText?: string } | undefined)?.expectedText;
  const extra: Record<string, Value> = {};
  if (ctx?.baseline) extra.baseline = ctx.baseline;
  if (ctx?.learner) extra.learner = ctx.learner as Record<string, Value>;

  const { applied, issues: gradeIssues } = applyRubricGrades(spec, evidence.grades);
  issues.push(...gradeIssues);

  // measurements, per criterion
  const regions: { criterion: string; x: number; y: number; w: number; h: number; level?: number; note?: string }[] = [];
  const measureRegion: Record<string, MeasureRegion | undefined> = {};
  const levels: Record<string, { level: number; confidence: number; source: "grade" | "measurement" }> = {};

  for (const c of spec.criteria) {
    let values: Record<string, number> = {};
    if (c.measure) {
      const r = measureVisual(c.measure, evidence, { expectedText });
      values = r.values;
      measureRegion[c.id] = r.region;
      for (const msg of r.issues) issues.push(`${c.id}: ${msg}`);
      for (const [k, val] of Object.entries(values)) put(metrics, `${c.id}_${k}`, val);
    }
    const g = applied[c.id];
    if (g) {
      levels[c.id] = { level: g.level, confidence: g.confidence, source: "grade" };
    } else {
      const lv = levelFromMeasures(c, values, extra);
      if (lv !== undefined) levels[c.id] = { level: lv, confidence: MEASURED_CONFIDENCE, source: "measurement" };
    }
  }

  // grading state: everything below is about what a grader has or hasn't said
  const ungraded = spec.criteria.filter((c) => !applied[c.id]).map((c) => c.id);
  let precision: "full" | "reduced" = "full";
  if (Object.keys(applied).length === 0) {
    precision = "reduced";
    issues.push("grading pending: no rubric grades have been submitted yet, so this shows measurements only");
  } else if (ungraded.length) {
    precision = "reduced";
    issues.push(`grading pending for: ${ungraded.join(", ")}`);
  }

  // levels, confidence, score
  let weighted = 0;
  let weights = 0;
  for (const c of spec.criteria) {
    const l = levels[c.id];
    if (!l) continue;
    put(metrics, `${c.id}_level`, l.level, "level", l.confidence);
    put(metrics, `${c.id}_confidence`, l.confidence);
    weighted += c.weight * normalized(c, l.level);
    weights += c.weight;
    const reg = applied[c.id]?.region ?? measureRegion[c.id];
    if (reg) regions.push({ criterion: c.id, ...reg, level: l.level, ...(applied[c.id]?.note ? { note: applied[c.id].note } : {}) });
  }
  if (weights > 0) put(metrics, "score", weighted / weights, "0..1", Math.min(...spec.criteria.filter((c) => levels[c.id]).map((c) => levels[c.id].confidence)));

  // mistake: the weakest criterion below its top level, among those we are confident about
  const mistakes: Analysis["mistakes"] = [];
  const eligible = spec.criteria
    .filter((c) => levels[c.id] && levels[c.id].level < levelKeys(c)[levelKeys(c).length - 1] && levels[c.id].confidence >= CONFIDENCE_FLOOR)
    .sort((a, b) => normalized(a, levels[a.id].level) - normalized(b, levels[b.id].level) || b.weight - a.weight || levels[b.id].confidence - levels[a.id].confidence);
  const weakest = eligible[0];
  if (weakest) {
    const n = normalized(weakest, levels[weakest.id].level);
    const reg = applied[weakest.id]?.region ?? measureRegion[weakest.id] ?? { x: 0, y: 0, w: 1, h: 1 };
    mistakes.push({
      id: weakest.id,
      severity: n <= 1 / 3 ? 3 : n < 2 / 3 ? 2 : 1,
      confidence: levels[weakest.id].confidence,
      at: [],
      evidence: { kind: "region", ...reg }
    });
  }

  // praise: the best criterion, if it isn't the one we are asking them to fix
  const best = spec.criteria
    .filter((c) => levels[c.id] && c.id !== weakest?.id && levels[c.id].confidence >= CONFIDENCE_FLOOR && normalized(c, levels[c.id].level) > 0)
    .sort((a, b) => normalized(b, levels[b.id].level) - normalized(a, levels[a.id].level) || levels[b.id].confidence - levels[a.id].confidence || b.weight - a.weight)[0];
  const praise = best ? { metric: `${best.id}_level`, label: (best.label ?? best.id).slice(0, 60) } : undefined;

  // pass and proof criteria
  const vars = metricVars(metrics, extra);
  for (const c of spec.criteria) if (levels[c.id]) vars[c.id] = levels[c.id].level;
  const criteria: Record<string, boolean> = {};
  const passed = evalCondition(spec.pass, vars);
  if (passed !== null) criteria.pass = passed;
  Object.assign(criteria, evalCriteria((ctx as { criteria?: Record<string, string> } | undefined)?.criteria ?? {}, vars));

  const grader = evidence.grades?.length ? evidence.grader ?? "agent" : "none";
  return finish({
    engine: "visual",
    quality: { ok: true, issues },
    metrics,
    markers: [],
    mistakes,
    criteria,
    ...(praise ? { praise } : {}),
    keyFrames: [],
    overlay: { kind: "regions", regions, taps: evidence.taps ?? {}, grader },
    version: v,
    precision
  });
}
