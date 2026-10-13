/**
 * Feedback and correction (learning loop §6, evaluation §7). One fix at a time: the top mistake by
 * severity × confidence × frequency, above the confidence floor and not disputed, shown with its evidence,
 * one thing done well, a fix drill and a visual "why". Below the floor, or on a bad recording, the answer is
 * a re-record request that names the problem, never a guess.
 */
import { CONFIDENCE_FLOOR, FigureSchema, type Analysis, type Card, type FeedbackView, type Figure, type SkillModel } from "@las/schema";
import type { AttemptRow, MistakeState } from "@las/store";
import type { LasContext } from "../context.js";
import { loadSk, LoopError, type SkState } from "./common.js";

type AnalysisMistake = Analysis["mistakes"][number];

/** A readable headline for a mistake the skill model doesn't name (e.g. an engine's own habit check). */
const humanize = (id: string) => {
  const s = id.replace(/[-_.]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : id;
};

/** The headline for a mistake: the model's fallback headline, else its name, else its id made readable. */
export function mistakeHeadline(mk: SkillModel["mistakes"][number] | undefined, id: string): string {
  return mk?.headline?.trim() || mk?.name || humanize(id);
}

/** The confidence a mistake needs before it is shown: the floor, or the model detector's own if higher. */
export function floorFor(model: SkillModel, mistakeId: string): number {
  return Math.max(CONFIDENCE_FLOOR, model.mistakes.find((m) => m.id === mistakeId)?.detector.min_confidence ?? 0);
}

/** severity × confidence × frequency; frequency counts how often it has shown up for this learner (at least once). */
export function pickTopMistake(model: SkillModel, analysis: Analysis, states: Map<string, MistakeState>, disputed: Set<string>): { mistake: AnalysisMistake; score: number } | undefined {
  let best: { mistake: AnalysisMistake; score: number } | undefined;
  for (const m of analysis.mistakes) {
    if (disputed.has(m.id) || m.confidence < floorFor(model, m.id)) continue;
    const score = m.severity * m.confidence * Math.max(1, states.get(m.id)?.seenCount ?? 1);
    if (!best || score > best.score) best = { mistake: m, score };
  }
  return best;
}

/** When to ask for a better recording instead of giving feedback (§6 rule 5). */
export function reRecordReason(analysis: Analysis, model?: SkillModel, drillId?: string): string | undefined {
  if (!analysis.quality.ok) return analysis.quality.reRecord ?? `I couldn't measure this clearly${analysis.quality.issues.length ? `: ${analysis.quality.issues.join(", ")}` : ""}. Please record it again.`;
  const metrics = Object.values(analysis.metrics);
  if (metrics.length && metrics.every((m) => m.confidence < CONFIDENCE_FLOOR)) {
    const guide = model?.drills.find((d) => d.id === drillId)?.capture?.guide;
    return `I couldn't measure this clearly enough to coach it.${guide ? ` ${guide}.` : ""} Please record it again.`;
  }
  return undefined;
}

const chartLabel = (s: string) => s.replace(/_/g, " ").slice(0, 30);

/**
 * The evidence visual, drawn from what the engine measured: a figure the engine drew, per-rep or per-move
 * values of the mistake's metric as bars, a skeleton or linkage, a pitch contour, a series as a line,
 * else the key frame nearest the moment.
 */
export function evidenceVisual(model: SkillModel, analysis: Analysis, m?: AnalysisMistake): { figure?: Figure; frame?: string } {
  const o = (analysis.overlay ?? {}) as Record<string, any>;
  const tryFig = (f: unknown): Figure | undefined => {
    const r = FigureSchema.safeParse(f);
    return r.success ? r.data : undefined;
  };
  let figure = tryFig(o.figure) ?? tryFig(o);
  const metric = m ? model.mistakes.find((x) => x.id === m.id)?.detector.metric : undefined;
  const per = metric ? analysis.metrics[metric]?.per : undefined;
  if (!figure && per && per.length) {
    figure = tryFig({ kind: "chart", type: "bar", series: [{ label: chartLabel(metric!), values: per.slice(0, 64) }], labels: per.slice(0, 64).map((_, i) => String(i + 1)) });
  }
  if (!figure && o.points && o.segments) figure = tryFig({ kind: "figure", points: o.points, segments: o.segments, marks: o.marks ?? [] });
  const contour = Array.isArray(o.contour) ? o.contour : Array.isArray(o.pitch) ? o.pitch : undefined;
  if (!figure && contour && contour.length >= 2) figure = tryFig({ kind: "contour", values: contour.filter((x: unknown) => typeof x === "number").slice(0, 64) });
  if (!figure && Array.isArray(o.series)) figure = tryFig({ kind: "chart", type: "line", series: o.series.slice(0, 5) });
  let frame: string | undefined;
  const ev = m?.evidence;
  if (ev && "frame" in ev && ev.frame) frame = ev.frame;
  if (!frame && analysis.keyFrames.length) {
    const t = ev && "t" in ev ? ev.t : (m?.at[0] ?? 0);
    frame = [...analysis.keyFrames].sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0].ref;
  }
  return { figure, frame };
}

/** The "Why?" visual: the mistake's lesson card or figure from the skill model. */
export function whyVisual(model: SkillModel, mistakeId: string): { figure?: Figure; card?: Card } | undefined {
  const mk = model.mistakes.find((x) => x.id === mistakeId);
  // fallback content (live coach §9): no explanation means no Why button
  if (!mk?.explain) return undefined;
  if ("figure" in mk.explain) return { figure: mk.explain.figure };
  const lesson = model.lessons.find((l) => l.id === (mk.explain as { lesson: string }).lesson);
  const card = lesson?.cards[(mk.explain as { card: number }).card] ?? lesson?.cards[0];
  return card ? { card } : undefined;
}

function evidenceLabel(m: AnalysisMistake): string | undefined {
  if (m.share !== undefined) return `${Math.round(m.share * 100)}% of the time`;
  if (m.evidence.kind === "line") return `Line ${m.evidence.line}`;
  if (m.evidence.kind === "time") return `At ${Math.round(m.evidence.t * 10) / 10} s`;
  if (m.evidence.kind === "item") return `Question ${m.evidence.id}`;
  if (m.evidence.kind === "move") return `Move ${m.evidence.ply}`;
  return undefined;
}

/** Before vs now on the first key metric both attempts measured (always against the learner's own past). */
function compareWithPrevious(ctx: LasContext, st: SkState, attempt: AttemptRow, analysis: Analysis): FeedbackView["compare"] {
  if (!attempt.drillId) return undefined;
  const prev = ctx.store
    .listAttempts(st.enrollment.id, { drillId: attempt.drillId, analyzed: true, limit: 20 })
    .filter((a) => a.id !== attempt.id && a.createdAt <= attempt.createdAt && a.analysis?.quality.ok)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!prev?.analysis) return undefined;
  const km = st.model.key_metrics.find((k) => k.metric in analysis.metrics && k.metric in prev.analysis!.metrics);
  if (!km) return { previousAttemptId: prev.id };
  return { previousAttemptId: prev.id, metric: km.label, before: prev.analysis.metrics[km.metric].value, after: analysis.metrics[km.metric].value, unit: km.unit || analysis.metrics[km.metric].unit };
}

export function disputedFor(ctx: LasContext, enrollmentId: string, attemptId: string): Set<string> {
  return new Set(ctx.store.listDisputes(enrollmentId).filter((d) => d.attemptId === attemptId).map((d) => d.mistakeId));
}

/** Builds the feedback card for an analyzed attempt. `markCoached` moves the shown mistake to "coached". */
export function buildFeedback(ctx: LasContext, attemptId: string, opts: { markCoached?: boolean } = {}): FeedbackView {
  const attempt = ctx.store.getAttempt(attemptId);
  if (!attempt) throw new LoopError(`Unknown attempt "${attemptId}".`);
  if (!attempt.analysis) throw new LoopError(`Attempt ${attemptId} hasn't been analyzed yet.`);
  const st = loadSk(ctx, attempt.enrollmentId);
  const model = st.model;
  const analysis = attempt.analysis;
  const states = ctx.store.getMistakeStates(st.enrollment.id);
  const reRecord = reRecordReason(analysis, model, attempt.drillId);
  const top = reRecord ? undefined : pickTopMistake(model, analysis, states, disputedFor(ctx, st.enrollment.id, attempt.id));
  const mk = top ? model.mistakes.find((x) => x.id === top.mistake.id) : undefined;
  const vis = top ? evidenceVisual(model, analysis, top.mistake) : { figure: undefined, frame: analysis.keyFrames[0]?.ref };
  const fix = mk ? model.drills.find((d) => d.id === mk.fix_drill) : undefined;
  if (top && opts.markCoached) {
    const s = states.get(top.mistake.id);
    if (s && (s.state === "detected" || s.state === "resurfaced")) ctx.store.setMistakeState({ ...s, state: "coached" });
  }
  // a model without a fallback headline uses the mistake's name (live coach §9): never invented text
  const headline = reRecord ? "Let's record that again" : top ? mistakeHeadline(mk, top.mistake.id) : (analysis.praise?.label ?? "Clean attempt");
  return {
    attemptId: attempt.id,
    sk: st.enrollment.id,
    headline,
    mistakeId: top?.mistake.id,
    severity: top?.mistake.severity,
    confidence: top?.mistake.confidence,
    evidence: { ref: top?.mistake.evidence ?? { kind: "none" }, figure: vis.figure, frame: vis.frame, label: top ? evidenceLabel(top.mistake) : undefined },
    praise: analysis.praise ? { headline: analysis.praise.label, metric: analysis.praise.metric } : undefined,
    fixDrillId: fix?.id,
    fixDrillTitle: fix?.title,
    why: top ? whyVisual(model, top.mistake.id) : undefined,
    analysis,
    reRecord,
    precision: analysis.precision,
    compare: reRecord ? undefined : compareWithPrevious(ctx, st, attempt, analysis)
  };
}
