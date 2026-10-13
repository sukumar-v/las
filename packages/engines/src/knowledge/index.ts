/**
 * Knowledge engine: grades answers to items the agent wrote from the skill model.
 * It knows the standard answer types and nothing about any subject.
 *
 * Answer shapes (`evidence.answers[].answer`):
 *   choice, predict-output  the option index (a number, or a numeric string)
 *   match                   an array of [left, right] pairs, in any order
 *   order                   the items in the order the learner placed them
 *   fill                    a string, or { text, hints } with the number of hints used
 *   hotspot                 a point, as { x, y } or [x, y], in the figure's own coordinates
 */
import type { Analysis, ItemsSpec, KnowledgeItem, MetricValue } from "@las/schema";
import type { AnalyzeContext, KnowledgeEvidence } from "../types.js";
import { evalCondition, evalCriteria, finish, metric, metricVars, reRecord, version } from "../common/analysis.js";

export interface ItemGrade {
  correct: boolean;
  /** 0..1; a correct fill answer loses a quarter per hint used */
  score: number;
}

/** Wrong answers faster than this are treated as guesses; correct answers slower than SLOW_MS as struggling. */
const GUESS_MS = 1500;
const SLOW_MS = 20000;
/** Share of the score a hint costs on a fill item, and the least a correct answer is worth. */
const HINT_COST = 0.25;

function norm(s: unknown): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function asIndex(a: unknown): number {
  if (typeof a === "number") return a;
  if (typeof a === "string" && a.trim() !== "") return Number(a);
  return NaN;
}

function asPoint(a: unknown): [number, number] | null {
  if (Array.isArray(a) && a.length >= 2 && typeof a[0] === "number" && typeof a[1] === "number") return [a[0], a[1]];
  if (a && typeof a === "object" && typeof (a as any).x === "number" && typeof (a as any).y === "number") return [(a as any).x, (a as any).y];
  return null;
}

/** Grade one answer against one item. Anything that isn't the right shape is simply wrong. */
export function gradeItem(item: KnowledgeItem, answer: unknown): ItemGrade {
  const no: ItemGrade = { correct: false, score: 0 };
  const yes: ItemGrade = { correct: true, score: 1 };
  switch (item.type) {
    case "choice":
    case "predict-output":
      return asIndex(answer) === item.answer ? yes : no;
    case "match": {
      if (!Array.isArray(answer) || answer.length !== item.pairs.length) return no;
      const key = (p: unknown) => (Array.isArray(p) && p.length === 2 ? `${norm(p[0])}\u0000${norm(p[1])}` : null);
      const got = answer.map(key);
      if (got.includes(null)) return no;
      const want = item.pairs.map((p) => key(p)!).sort();
      return JSON.stringify((got as string[]).sort()) === JSON.stringify(want) ? yes : no;
    }
    case "order": {
      if (!Array.isArray(answer) || answer.length !== item.items.length) return no;
      return answer.every((x, i) => norm(x) === norm(item.items[i])) ? yes : no;
    }
    case "fill": {
      let text: unknown = answer;
      let hints = 0;
      if (answer && typeof answer === "object" && !Array.isArray(answer)) {
        text = (answer as any).text;
        hints = Math.max(0, Math.min(item.hints.length, Number((answer as any).hints) || 0));
      }
      if (!item.answers.some((a) => norm(a) === norm(text))) return no;
      return { correct: true, score: Math.max(HINT_COST, 1 - HINT_COST * hints) };
    }
    case "hotspot": {
      const p = asPoint(answer);
      if (!p) return no;
      return Math.hypot(p[0] - item.region.x, p[1] - item.region.y) <= item.region.r ? yes : no;
    }
  }
}

/** True once the last `stop_after_wrong` answers in a row were all wrong. */
export function shouldStop(spec: ItemsSpec, history: { itemId: string; correct: boolean }[]): boolean {
  let run = 0;
  for (let i = history.length - 1; i >= 0 && !history[i].correct; i--) run++;
  return run >= spec.stop_after_wrong;
}

/**
 * The next item for an adaptive quiz: it gets harder after each correct answer, stays at the same
 * difficulty after a wrong one, and stops (null) after `stop_after_wrong` wrong answers in a row or
 * when the items run out. If nothing exists at the wanted difficulty, the nearest one is used,
 * preferring harder.
 */
export function nextItem(spec: ItemsSpec, history: { itemId: string; correct: boolean }[]): KnowledgeItem | null {
  if (shouldStop(spec, history)) return null;
  const answered = new Set(history.map((h) => h.itemId));
  const left = spec.items.filter((it) => !answered.has(it.id));
  if (!left.length) return null;
  const byId = new Map(spec.items.map((it) => [it.id, it]));
  let target = Math.min(...spec.items.map((it) => it.difficulty));
  for (let i = history.length - 1; i >= 0; i--) {
    const it = byId.get(history[i].itemId);
    if (it) {
      target = history[i].correct ? it.difficulty + 1 : it.difficulty;
      break;
    }
  }
  let best = left[0];
  for (const it of left) {
    const d = Math.abs(it.difficulty - target);
    const bd = Math.abs(best.difficulty - target);
    if (d < bd || (d === bd && it.difficulty > best.difficulty)) best = it;
  }
  return best;
}

export function analyzeKnowledge(spec: ItemsSpec, evidence: KnowledgeEvidence, ctx?: AnalyzeContext): Analysis {
  const v = version("knowledge", ctx?.specId, ctx?.modelVersion);
  const issues: string[] = [];
  if (!evidence.answers.length) return reRecord("knowledge", ["no answers"], "Answer at least one question first.", v);

  const byId = new Map(spec.items.map((it) => [it.id, it]));
  interface Row { index: number; item: KnowledgeItem; correct: boolean; score: number; ms: number }
  const rows: Row[] = [];
  const seen = new Set<string>();
  let run = 0;
  let stoppedEarly = false;
  let ignored = 0;
  evidence.answers.forEach((a, index) => {
    if (stoppedEarly) {
      ignored++;
      return;
    }
    const item = byId.get(a.itemId);
    if (!item) {
      issues.push(`answer for unknown item "${a.itemId}" ignored`);
      return;
    }
    if (seen.has(item.id)) {
      issues.push(`item "${item.id}" was answered more than once; only the first answer counts`);
      return;
    }
    seen.add(item.id);
    const g = gradeItem(item, a.answer);
    rows.push({ index, item, correct: g.correct, score: g.score, ms: Number.isFinite(a.ms) ? a.ms : NaN });
    run = g.correct ? 0 : run + 1;
    if (run >= spec.stop_after_wrong) stoppedEarly = true;
  });
  if (ignored) issues.push(`${ignored} answer${ignored > 1 ? "s" : ""} after the stop rule were not counted`);
  if (!rows.length) return reRecord("knowledge", [...issues, "no answers matched the items"], "Answer the questions that were asked.", v);

  const total = rows.length;
  const correct = rows.filter((r) => r.correct).length;
  const times = rows.map((r) => r.ms).filter(Number.isFinite);
  const metrics: Record<string, MetricValue> = {
    correct: metric(correct, "items"),
    total: metric(total, "items"),
    accuracy: metric(rows.reduce((s, r) => s + r.score, 0) / total, "0..1"),
    stopped_early: metric(stoppedEarly ? 1 : 0),
    difficulty_reached: metric(Math.max(0, ...rows.filter((r) => r.correct).map((r) => r.item.difficulty)), "level")
  };
  if (times.length) metrics.mean_ms = metric(times.reduce((s, x) => s + x, 0) / times.length, "ms");

  // habits that show up in the timing, never in the grading
  const mistakes: Analysis["mistakes"] = [];
  const habit = (id: string, hits: Row[]) => {
    if (!hits.length) return;
    const share = hits.length / total;
    mistakes.push({
      id,
      severity: share >= 0.5 ? 3 : share >= 0.25 ? 2 : 1,
      confidence: Math.min(0.95, 0.7 + 0.1 * (hits.length - 1)),
      at: hits.map((r) => r.index),
      evidence: { kind: "item", id: hits[0].item.id },
      share
    });
  };
  habit("guessing", rows.filter((r) => !r.correct && r.ms < GUESS_MS));
  habit("slow", rows.filter((r) => r.correct && r.ms > SLOW_MS));

  // per skill-model node: how the learner did on each
  const nodes: Record<string, { correct: number; total: number; accuracy: number }> = {};
  for (const r of rows) {
    for (const n of r.item.nodes) {
      const e = (nodes[n] ??= { correct: 0, total: 0, accuracy: 0 });
      e.total++;
      if (r.correct) e.correct++;
    }
  }
  for (const e of Object.values(nodes)) e.accuracy = e.correct / e.total;

  const vars = metricVars(metrics);
  const criteria: Record<string, boolean> = {};
  const passed = evalCondition(spec.pass, vars);
  if (passed !== null) criteria.pass = passed;
  Object.assign(criteria, evalCriteria((ctx as { criteria?: Record<string, string> } | undefined)?.criteria ?? {}, vars));

  return finish({
    engine: "knowledge",
    quality: { ok: true, issues },
    metrics,
    markers: [],
    mistakes,
    criteria,
    ...(correct / total >= 0.5 ? { praise: { metric: "accuracy", label: "Answers you got right" } } : {}),
    keyFrames: [],
    overlay: { kind: "items", nodes, items: rows.map((r) => ({ id: r.item.id, type: r.item.type, difficulty: r.item.difficulty, correct: r.correct, score: r.score, ms: r.ms })) },
    version: v,
    precision: "full"
  });
}
