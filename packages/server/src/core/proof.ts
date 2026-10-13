/**
 * Proof checks (learning loop §9, evaluation §6). The milestone's proof standard is a list of criteria,
 * each an expression over the evaluator's metrics. Readiness: every milestone skill at 80% mastery or more
 * and 2 recent attempts passing. A pass marks the milestone done and asks why again.
 */
import { evalWith, parseExpr, rootNames, type Analysis, type ProofResultView, type ProofSpec, type Value } from "@las/schema";
import type { AttemptRow, Milestone } from "@las/store";
import type { LasContext } from "../context.js";
import { loadSk, LoopError, mean, nodeMap, pathNodes, type SkState } from "./common.js";
import { PROOF_MASTERY } from "./planner.js";

/** Metric values as expression variables: per-segment metrics become lists (so share(), count() work), others numbers. */
export function analysisVars(analysis: Analysis): Record<string, Value> {
  const vars: Record<string, Value> = {};
  for (const [k, m] of Object.entries(analysis.metrics)) vars[k] = m.per && m.per.length ? m.per : m.value;
  for (const [k, v] of Object.entries(analysis.criteria)) if (!(k in vars)) vars[k] = v;
  return vars;
}

function evalCheck(check: string, vars: Record<string, Value>): boolean | undefined {
  try {
    const v = evalWith(parseExpr(check), vars);
    return v === true || (typeof v === "number" && v !== 0 && !Number.isNaN(v)) ? true : v === false || v === 0 ? false : undefined;
  } catch {
    return undefined;
  }
}

export interface CriterionResult {
  id: string;
  label: string;
  passed: boolean;
  evidence?: string;
}

/** Each criterion: the engine's own verdict when it gave one, else the check evaluated over the metrics. */
export function gradeCriteria(proof: ProofSpec, analysis: Analysis): CriterionResult[] {
  const vars = analysisVars(analysis);
  return proof.criteria.map((c) => {
    const engine = analysis.criteria[c.id];
    const passed = typeof engine === "boolean" ? engine : (evalCheck(c.check, vars) ?? false);
    let names: string[] = [];
    try {
      names = [...rootNames(parseExpr(c.check))].filter((n) => n in analysis.metrics);
    } catch {
      names = [];
    }
    const evidence = names.map((n) => `${n} ${Math.round(analysis.metrics[n].value * 100) / 100}${analysis.metrics[n].unit ? " " + analysis.metrics[n].unit : ""}`).join(", ");
    return { id: c.id, label: c.label, passed, evidence: evidence || undefined };
  });
}

export const attemptPasses = (proof: ProofSpec, analysis: Analysis): boolean => analysis.quality.ok && gradeCriteria(proof, analysis).every((c) => c.passed);

export function milestoneProof(st: SkState, m: Milestone): ProofSpec | undefined {
  const stored = m.proof as ProofSpec | undefined;
  if (stored?.criteria?.length) return stored;
  return st.model.ladder[m.ladderStep]?.proof;
}

export interface Readiness {
  ready: boolean;
  nodesReady: boolean;
  percent: number;
  nodes: { id: string; name: string; mastery: number }[];
  missing: { id: string; name: string; mastery: number }[];
  passing: number;
  needPassing: number;
  criteria: { id: string; label: string; passed?: boolean }[];
  message: string;
}

/**
 * Proof readiness (§7 "Proof ready"): every milestone skill at 80% or more, and 2 recent attempts (of the
 * last 5 analyzed with the proof's engine) passing every criterion. Decision: a self-reported proof needs
 * only the mastery part, since there's no measured attempt to rehearse.
 */
export function readiness(ctx: LasContext, st: SkState, m = st.milestone): Readiness {
  if (!m) return { ready: false, nodesReady: false, percent: 0, nodes: [], missing: [], passing: 0, needPassing: 0, criteria: [], message: "No active milestone." };
  const mastery = ctx.store.getMastery(st.enrollment.id);
  const byId = nodeMap(st.model);
  const ids = pathNodes(st.model, st.placement, m.ladderStep);
  const nodes = ids.map((id) => ({ id, name: byId.get(id)?.name ?? id, mastery: mastery.get(id)?.pKnown ?? byId.get(id)?.bkt.p_init ?? 0 }));
  const missing = nodes.filter((n) => n.mastery < PROOF_MASTERY);
  const proof = milestoneProof(st, m);
  const needPassing = !proof || proof.engine === "self-report" ? 0 : 2;
  const recent = ctx.store
    .listAttempts(st.enrollment.id, { analyzed: true, limit: 30 })
    .filter((a) => a.kind !== "proof" && a.kind !== "probe" && a.engine === proof?.engine)
    .slice(0, 5);
  const passing = proof ? recent.filter((a) => attemptPasses(proof, a.analysis!)).length : 0;
  const latest = recent[0]?.analysis;
  const criteria = (proof?.criteria ?? []).map((c) => ({ id: c.id, label: c.label, passed: latest && proof ? gradeCriteria(proof, latest).find((x) => x.id === c.id)?.passed : undefined }));
  const nodesReady = nodes.length > 0 && missing.length === 0;
  const ready = nodesReady && passing >= needPassing;
  const percent = Math.round(mean(nodes.map((n) => Math.min(1, n.mastery / PROOF_MASTERY))) * 100);
  const message = ready
    ? "Ready for the proof check."
    : [missing.length ? `Still under 80%: ${missing.map((n) => `${n.name} (${Math.round(n.mastery * 100)}%)`).join(", ")}.` : "", passing < needPassing ? `${passing} of ${needPassing} recent attempts pass the proof standard.` : ""].filter(Boolean).join(" ");
  return { ready, nodesReady, percent, nodes, missing, passing, needPassing, criteria, message };
}

/** Grades a proof attempt's analysis and records the result; a pass completes the milestone. */
export function recordProofResult(ctx: LasContext, attempt: AttemptRow, analysis: Analysis, now = new Date()): ProofResultView {
  const m = ctx.store.getMilestone(attempt.milestoneId ?? "");
  if (!m) throw new LoopError(`Attempt ${attempt.id} isn't tied to a milestone.`);
  const st = loadSk(ctx, m.enrollmentId);
  const proof = milestoneProof(st, m);
  if (!proof) throw new LoopError("This milestone has no proof standard.");
  const criteria = analysis.quality.ok ? gradeCriteria(proof, analysis) : proof.criteria.map((c) => ({ id: c.id, label: c.label, passed: false, evidence: analysis.quality.reRecord ?? analysis.quality.issues.join("; ") }));
  const passed = analysis.quality.ok && criteria.every((c) => c.passed);
  const result: ProofResultView = { milestoneId: m.id, title: m.title, passed, criteria, attemptId: attempt.id, precision: analysis.precision };
  const proofId = ctx.store.addProof(st.enrollment.id, m.id, attempt.id, result);
  result.proofCardId = passed ? proofId : undefined;
  if (passed) completeMilestone(ctx, st, m, false, now);
  return result;
}

/** A milestone is done: mark it, drop its pending proof check-ins, ask why again (§9 step 4). */
export function completeMilestone(ctx: LasContext, st: SkState, m: Milestone, selfReported: boolean, now = new Date()): void {
  ctx.store.updateMilestone(m.id, { status: "done", achievedAt: now.toISOString(), selfReported });
  ctx.store.deletePendingCheckins(st.enrollment.id, "proof-ready");
  ctx.store.addCheckin({ enrollmentId: st.enrollment.id, kind: "revisit-why", dueAt: now.toISOString(), payload: { milestoneId: m.id, title: m.title } });
  ctx.store.logPlanChange(st.enrollment.id, selfReported ? "milestone self-reported" : "proof passed", `done:${m.id}`);
}
