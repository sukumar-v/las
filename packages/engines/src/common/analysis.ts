/** Helpers every engine shares: building an Analysis, evaluating pass/mistake expressions over metrics. */
import { AnalysisSchema, CONFIDENCE_FLOOR, evalWith, parseExpr, truthy, type Analysis, type AnalysisInput, type EngineId, type MetricValue, type Value } from "@las/schema";

export const ENGINES_VERSION = "0.1.0";

export function version(engine: EngineId, specId?: string, modelVersion?: number): string {
  return `${engine}@${ENGINES_VERSION}${specId ? `/${specId}` : ""}${modelVersion ? `@v${modelVersion}` : ""}`;
}

export function metric(value: number, unit = "", confidence = 1, per?: number[]): MetricValue {
  return { value: Number.isFinite(value) ? value : NaN, unit, confidence: Math.max(0, Math.min(1, confidence)), ...(per ? { per } : {}) };
}

/** Variables for an expression: metric values by name (plus `.per` arrays through `<name>_per`), baseline and learner. */
export function metricVars(metrics: Record<string, MetricValue>, extra: Record<string, Value> = {}): Record<string, Value> {
  const vars: Record<string, Value> = { ...extra };
  for (const [k, m] of Object.entries(metrics)) {
    vars[k] = m.value;
    if (m.per) vars[`${k}_per`] = m.per;
    vars[`${k}_confidence`] = m.confidence;
  }
  return vars;
}

/** Evaluate a boolean expression over metrics. Returns null when it can't be evaluated. */
export function evalCondition(src: string | undefined, vars: Record<string, Value>): boolean | null {
  if (!src) return null;
  try {
    return truthy(evalWith(parseExpr(src), vars));
  } catch {
    return null;
  }
}

/** Evaluate every proof/drill criterion (`id -> expression`) over metrics. Missing or failing evaluations count as false. */
export function evalCriteria(criteria: Record<string, string>, vars: Record<string, Value>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [id, src] of Object.entries(criteria)) out[id] = evalCondition(src, vars) === true;
  return out;
}

/** Validate and normalize an Analysis before it leaves an engine. */
export function finish(a: AnalysisInput): Analysis {
  return AnalysisSchema.parse(a);
}

/** Drop mistakes under the confidence floor; they are never shown. */
export function applyConfidenceFloor<T extends { confidence: number }>(items: T[], floor = CONFIDENCE_FLOOR): T[] {
  return items.filter((m) => m.confidence >= floor);
}

/** A quality failure with a re-record instruction; metrics are empty so nothing is coached from a bad recording. */
export function reRecord(engine: EngineId, issues: string[], instruction: string, v: string): Analysis {
  return finish({ engine, quality: { ok: false, issues, reRecord: instruction }, metrics: {}, markers: [], mistakes: [], criteria: {}, keyFrames: [], version: v, precision: "full" });
}

export function mean(a: ArrayLike<number>): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) {
    s += a[i];
    n++;
  }
  return n ? s / n : NaN;
}
export function std(a: ArrayLike<number>): number {
  const m = mean(a);
  let s = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) {
    s += (a[i] - m) ** 2;
    n++;
  }
  return n > 1 ? Math.sqrt(s / (n - 1)) : 0;
}
export function median(a: ArrayLike<number>): number {
  const s = Array.from(a).filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
