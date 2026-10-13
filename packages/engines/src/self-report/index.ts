/**
 * Self-report engine: what the learner says about their own practice. Always available, always
 * labeled `precision: "self-report"`. It copies numbers into metrics and never finds a mistake.
 * A pain report is surfaced as a quality issue; the learning loop decides what to do about it.
 */
import type { Analysis, MetricValue, SelfReportSpec } from "@las/schema";
import type { AnalyzeContext, SelfReportEvidence } from "../types.js";
import { evalCondition, evalCriteria, finish, metric, metricVars, version } from "../common/analysis.js";

const NUMERIC_FIELDS: Record<string, string> = { minutes: "min", effort: "", felt: "", pain: "", count: "" };
/** From this pain level up, a quality issue is raised. */
const PAIN_ISSUE_AT = 3;

function asNumber(x: unknown): number {
  if (typeof x === "number") return x;
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "string" && x.trim() !== "") return Number(x);
  return NaN;
}

export function analyzeSelfReport(spec: SelfReportSpec, evidence: SelfReportEvidence, ctx?: AnalyzeContext): Analysis {
  const v = version("self-report", ctx?.specId, ctx?.modelVersion);
  const issues: string[] = [];
  const metrics: Record<string, MetricValue> = {};

  for (const [field, unit] of Object.entries(NUMERIC_FIELDS)) {
    const n = asNumber(evidence.fields[field]);
    if (Number.isFinite(n)) metrics[field] = metric(n, unit);
  }
  if (evidence.fields.done !== undefined) {
    const raw = evidence.fields.done;
    const done = typeof raw === "string" ? ["true", "yes", "1", "done"].includes(raw.trim().toLowerCase()) : !!raw;
    metrics.done = metric(done ? 1 : 0);
  }

  // asked for but not answered (pain is read even when not asked: it matters more than the spec)
  const missing = spec.fields.filter((f) => f !== "note" && f !== "photo" && !(f in metrics));
  if (missing.length) issues.push(`not answered: ${missing.join(", ")}`);
  if (metrics.pain && metrics.pain.value >= PAIN_ISSUE_AT) issues.push("pain reported");

  const vars = metricVars(metrics);
  const criteria: Record<string, boolean> = {};
  const passed = evalCondition(spec.pass, vars);
  if (passed !== null) criteria.pass = passed;
  Object.assign(criteria, evalCriteria((ctx as { criteria?: Record<string, string> } | undefined)?.criteria ?? {}, vars));

  return finish({
    engine: "self-report",
    quality: { ok: true, issues },
    metrics,
    markers: [],
    mistakes: [],
    criteria,
    keyFrames: [],
    version: v,
    precision: "self-report"
  });
}
