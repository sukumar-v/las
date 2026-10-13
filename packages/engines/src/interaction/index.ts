/**
 * Interaction engine: keystrokes and clicks the studio recorded during a task.
 * The studio marks each event with what was expected and whether it was right; this engine only measures.
 *
 * Event rules:
 *   - an event with `correct` uses it; otherwise one with `expected` is right when `key === expected`;
 *     an event with neither counts as right (the studio had no verdict to give);
 *   - `Backspace` events are corrections, not attempts, so they are left out of every count;
 *   - the first response time runs from the start of the task (t = 0), later ones from the previous event.
 */
import type { Analysis, MetricValue, TaskSpec } from "@las/schema";
import type { AnalyzeContext, InteractionEvidence } from "../types.js";
import { evalCondition, evalCriteria, finish, metric, metricVars, reRecord, version } from "../common/analysis.js";

type Ev = InteractionEvidence["events"][number];

function isCorrect(e: Ev): boolean {
  if (e.correct !== undefined) return e.correct;
  if (e.expected !== undefined) return e.key === e.expected;
  return true;
}

function avg(a: number[]): number {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
}
function sd(a: number[]): number {
  if (a.length < 2) return 0;
  const m = avg(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function med(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Characters the task asks for in total, with a space between the lines. */
function targetLength(spec: TaskSpec): number {
  return spec.content.reduce((s, c) => s + c.length, 0) + Math.max(0, spec.content.length - 1);
}

export function analyzeInteraction(spec: TaskSpec, evidence: InteractionEvidence, ctx?: AnalyzeContext): Analysis {
  const v = version("interaction", ctx?.specId, ctx?.modelVersion);
  const events = [...evidence.events].filter((e) => e.key !== "Backspace").sort((a, b) => a.t - b.t);
  if (!events.length) return reRecord("interaction", ["no input was recorded"], "Do the task again and start when the first prompt appears.", v);

  const right = events.map(isCorrect);
  const errors = right.filter((r) => !r).length;
  const n = events.length;
  const gaps = events.map((e, i) => (e.t - (i ? events[i - 1].t : 0)) * 1000);
  const interKey = gaps.slice(1);
  const elapsed = evidence.durationS > 0 ? evidence.durationS : events[n - 1].t - events[0].t;

  const metrics: Record<string, MetricValue> = {
    accuracy: metric((n - errors) / n, "0..1"),
    errors: metric(errors, "events")
  };

  let completed: boolean;
  if (spec.task === "type-text") {
    if (elapsed > 0) metrics.wpm = metric((n - errors) / 5 / (elapsed / 60), "wpm");
    metrics.mean_ms = metric(avg(interKey), "ms");
    if (interKey.length >= 3 && avg(interKey) > 0) metrics.consistency = metric(Math.max(0, Math.min(1, 1 - sd(interKey) / avg(interKey))), "0..1");
    completed = n >= targetLength(spec);
  } else {
    metrics.mean_ms = metric(avg(gaps), "ms");
    completed = n >= spec.content.length;
  }
  if (spec.duration_s !== undefined && evidence.durationS >= spec.duration_s - 0.5) completed = true;
  metrics.completed = metric(completed ? 1 : 0);
  if (!Number.isFinite(metrics.mean_ms.value)) delete metrics.mean_ms;

  // habits in the timing
  const mistakes: Analysis["mistakes"] = [];
  const goodGaps = gaps.filter((_, i) => right[i] && i > 0);
  const badIdx = events.map((_, i) => i).filter((i) => !right[i] && i > 0);
  if (errors >= 2 && badIdx.length >= 2 && goodGaps.length >= 2) {
    const fast = badIdx.filter((i) => gaps[i] < 0.85 * avg(goodGaps));
    if (fast.length >= 2 && fast.length >= badIdx.length / 2) {
      mistakes.push({
        id: "rushing",
        severity: errors / n >= 0.25 ? 3 : errors / n >= 0.1 ? 2 : 1,
        confidence: Math.min(0.9, 0.6 + 0.05 * fast.length),
        at: fast.map((i) => events[i].t),
        evidence: { kind: "time", t: events[fast[0]].t },
        share: fast.length / n
      });
    }
  }
  const typical = med(interKey);
  if (interKey.length >= 4 && typical > 0) {
    const long = interKey.map((g, i) => ({ g, i: i + 1 })).filter((x) => x.g > 3 * typical && x.g > 1000);
    if (long.length >= 2) {
      mistakes.push({
        id: "hesitating",
        severity: long.length / n >= 0.2 ? 3 : long.length / n >= 0.1 ? 2 : 1,
        confidence: Math.min(0.9, 0.6 + 0.1 * long.length),
        at: long.map((x) => events[x.i].t),
        evidence: { kind: "time", t: events[long[0].i].t },
        share: long.length / n
      });
    }
  }

  const vars = metricVars(metrics);
  const criteria: Record<string, boolean> = {};
  const passed = evalCondition(spec.pass, vars);
  if (passed !== null) criteria.pass = passed;
  Object.assign(criteria, evalCriteria((ctx as { criteria?: Record<string, string> } | undefined)?.criteria ?? {}, vars));

  let praise: Analysis["praise"];
  if (metrics.accuracy.value >= 0.95) praise = { metric: "accuracy", label: "Clean accuracy" };
  else if (metrics.consistency && metrics.consistency.value >= 0.7) praise = { metric: "consistency", label: "Steady rhythm" };

  const markers = events
    .map((e, i) => ({ e, i }))
    .filter((x) => !right[x.i])
    .slice(0, 20)
    .map((x) => ({ t: x.e.t, label: x.e.expected ? `expected ${x.e.expected}` : "miss", role: "attention" as const }));

  return finish({
    engine: "interaction",
    quality: { ok: true, issues: [] },
    metrics,
    markers,
    mistakes,
    criteria,
    ...(praise ? { praise } : {}),
    keyFrames: [],
    version: v,
    precision: "full"
  });
}
