/**
 * The learning loop's reaction to every studio event (mcp-and-data §5): mastery (BKT), in-session difficulty,
 * mistake states, reviews (FSRS), the time log and practice mix, analyses and proof checks, pain, check-in
 * answers. The server is the source of truth; the agent reads the results back through tools.
 */
import { evalWith, parseExpr, type Analysis, type EngineId, type SessionPlan, type StudioEvent } from "@las/schema";
import type { AttemptRow, MistakeState } from "@las/store";
import type { LasContext } from "../context.js";
import { addDaysYmd, atLocal, categoryOfNode, drillMap, findByDrill, loadSk, LoopError, mean, nodeMap, pathNodes, weekdayOfYmd, zoned, type SkState } from "./common.js";
import { bktUpdate } from "./bkt.js";
import { gradeCard } from "./fsrs.js";
import { drillEngine, planSession, UNRESOLVED } from "./planner.js";
import { analysisVars, attemptPasses, milestoneProof, recordProofResult } from "./proof.js";
import { buildFeedback, floorFor } from "./feedback.js";
import { answerCheckin, ensureCheckins, reportPainState, scheduleCheckins } from "./checkins.js";
import { adjustPlacement } from "./intake.js";
import { planMix } from "./route.js";
import { RECOVERY_CATEGORY } from "./rules.js";
import { loopSettings } from "./settings.js";
import { sessionSummary } from "./progress.js";

/** In-session difficulty (§2 rules): up one level after 3 successes in a row, down one after 2 misses. */
export const UP_AFTER = 3;
export const DOWN_AFTER = 2;

interface SessionState {
  difficulty: Record<string, number>;
  run: Record<string, { succ: number; miss: number }>;
  quiz: Record<string, { itemId: string; correct: boolean }[]>;
  blocks: Record<string, number>;
}

export function sessionState(summary: any): SessionState {
  const s = summary?.state ?? {};
  return { difficulty: s.difficulty ?? {}, run: s.run ?? {}, quiz: s.quiz ?? {}, blocks: s.blocks ?? {} };
}

export function saveSessionState(ctx: LasContext, sessionId: string, state: SessionState): void {
  const s = ctx.store.getSession(sessionId);
  if (s) ctx.store.updateSession(sessionId, { summary: { ...(s.summary ?? {}), state } });
}

/** Difficulty for drills done outside a session lives in a per-drill setting. */
const drillStateKey = (sk: string, drillId: string) => `drillstate.${sk}.${drillId}`;

/** Pure step of the in-session difficulty rule. */
export function nextDifficulty(level: number, levels: number, run: { succ: number; miss: number }, success: boolean): { level: number; run: { succ: number; miss: number }; changed?: "up" | "down" } {
  const r = success ? { succ: run.succ + 1, miss: 0 } : { succ: 0, miss: run.miss + 1 };
  if (r.succ >= UP_AFTER) {
    const up = Math.min(levels - 1, level + 1);
    return { level: up, run: { succ: 0, miss: 0 }, changed: up !== level ? "up" : undefined };
  }
  if (r.miss >= DOWN_AFTER) {
    const down = Math.max(0, level - 1);
    return { level: down, run: { succ: 0, miss: 0 }, changed: down !== level ? "down" : undefined };
  }
  return { level, run: r };
}

/**
 * Mistake progression (§6): detected → coached (feedback shown) → improving (a clean attempt) → resolved after
 * the model's `resolved_after` clean attempts in a row; a resolved mistake that comes back is resurfaced.
 * Only attempts that could show the mistake count as clean: same engine, and a drill on one of its nodes.
 */
export function updateMistakes(ctx: LasContext, st: SkState, engine: EngineId, seen: string[], nodes: string[], now: Date): void {
  const states = ctx.store.getMistakeStates(st.enrollment.id);
  const known = new Map(st.model.mistakes.map((m) => [m.id, m]));
  const at = now.toISOString();
  for (const id of new Set(seen)) {
    if (!known.has(id)) continue;
    const s = states.get(id);
    const state: MistakeState["state"] = !s || s.state === "muted" ? "detected" : s.state === "resolved" ? "resurfaced" : s.state === "improving" ? "coached" : s.state;
    ctx.store.setMistakeState({ enrollmentId: st.enrollment.id, mistakeId: id, state, lastSeenAt: at, disputedCount: s?.disputedCount ?? 0, cleanStreak: 0, seenCount: (s?.seenCount ?? 0) + 1 });
  }
  for (const [id, s] of states) {
    if (seen.includes(id) || !UNRESOLVED.has(s.state)) continue;
    const mk = known.get(id);
    if (!mk || mk.engine !== engine) continue;
    if (nodes.length && !mk.nodes.some((n) => nodes.includes(n))) continue;
    const clean = s.cleanStreak + 1;
    ctx.store.setMistakeState({ ...s, cleanStreak: clean, state: clean >= mk.resolved_after ? "resolved" : "improving" });
  }
}

function observe(ctx: LasContext, st: SkState, nodes: string[], success: boolean): Record<string, number> {
  const mastery = ctx.store.getMastery(st.enrollment.id);
  const byId = nodeMap(st.model);
  const out: Record<string, number> = {};
  for (const id of new Set(nodes)) {
    const n = byId.get(id);
    if (!n) continue;
    const cur = mastery.get(id);
    const p = bktUpdate(cur?.pKnown ?? n.bkt.p_init, success, n.bkt);
    ctx.store.setMastery(st.enrollment.id, id, p, (cur?.attempts ?? 0) + 1, true);
    out[id] = Math.round(p * 1000) / 1000;
  }
  return out;
}

const snapshot = (ctx: LasContext, sk: string) => Object.fromEntries([...ctx.store.getMastery(sk)].map(([k, v]) => [k, v.pKnown]));

/** The success of an analyzed attempt: the engine's pass, the drill's success expression, the proof standard, else "no mistake above the floor". */
function attemptSuccess(st: SkState, attempt: AttemptRow, analysis: Analysis, seen: string[]): boolean {
  if (typeof analysis.criteria.pass === "boolean") return analysis.criteria.pass;
  const drill = st.model.drills.find((d) => d.id === attempt.drillId);
  if (drill?.success) {
    try {
      const v = evalWith(parseExpr(drill.success), analysisVars(analysis));
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v !== 0;
    } catch {
      /* fall through */
    }
  }
  if ((attempt.kind === "rehearsal" || attempt.kind === "proof") && st.milestone) {
    const proof = milestoneProof(st, st.milestone);
    if (proof) return attemptPasses(proof, analysis);
  }
  return seen.length === 0;
}

/** Key metric flat over its last 4 values (within 5% of its mean): a plateau check-in, at most every 14 days. */
function checkPlateau(ctx: LasContext, st: SkState, now: Date): void {
  for (const km of st.model.key_metrics) {
    const h = ctx.store.metricHistory(st.enrollment.id, km.id, 4).map((x) => x.value);
    if (h.length < 4) continue;
    const m = Math.abs(mean(h));
    if (Math.max(...h) - Math.min(...h) > Math.max(0.05 * m, 1e-9)) continue;
    const recent = ctx.store.listCheckins(st.enrollment.id).some((c) => c.kind === "plateau" && now.getTime() - new Date(c.dueAt).getTime() < 14 * 864e5);
    if (!recent) ctx.store.addCheckin({ enrollmentId: st.enrollment.id, kind: "plateau", dueAt: now.toISOString(), payload: { metricId: km.id, label: km.label } });
    return;
  }
}

/** attempt.analyzed: store it, update metrics, mistakes, mastery and proof readiness, and build the feedback. */
export function processAnalysis(ctx: LasContext, attemptId: string, analysis: Analysis, now = new Date()) {
  const attempt = ctx.store.getAttempt(attemptId);
  if (!attempt) throw new LoopError(`Unknown attempt "${attemptId}".`);
  // decision: an attempt counts once; posting its analysis again (a retry, a re-grade) updates the stored
  // analysis and the feedback but not mastery, mistakes, metrics or the proof result
  const repeat = !!attempt.analysis;
  ctx.store.setAttemptAnalysis(attemptId, analysis);
  // a level-check attempt during onboarding belongs to the intake until the enrollment exists
  if (!ctx.store.getEnrollment(attempt.enrollmentId)) return { stored: true };
  if (repeat) return { feedback: buildFeedback(ctx, attemptId), repeat: true };
  const st = loadSk(ctx, attempt.enrollmentId);
  for (const km of st.model.key_metrics) {
    const m = analysis.metrics[km.metric];
    if (m && (km.engine === analysis.engine || km.engine === attempt.engine) && analysis.quality.ok) ctx.store.recordMetric(st.enrollment.id, km.id, m.value, attemptId);
  }
  const drill = st.model.drills.find((d) => d.id === attempt.drillId);
  const nodes = drill?.nodes ?? (st.milestone && (attempt.kind === "rehearsal" || attempt.kind === "proof") ? pathNodes(st.model, st.placement, st.milestone.ladderStep) : []);
  let mastery: Record<string, number> = {};
  if (analysis.quality.ok && attempt.kind !== "probe") {
    const seen = analysis.mistakes.filter((m) => m.confidence >= floorFor(st.model, m.id)).map((m) => m.id);
    updateMistakes(ctx, st, analysis.engine, seen, nodes, now);
    // evidence for BKT: the drill's nodes (a proof or rehearsal is evidence on the milestone's nodes)
    mastery = observe(ctx, st, drill?.nodes ?? nodes, attemptSuccess(st, attempt, analysis, seen));
  }
  const proof = attempt.kind === "proof" ? recordProofResult(ctx, ctx.store.getAttempt(attemptId)!, analysis, now) : undefined;
  checkPlateau(ctx, st, now);
  ensureCheckins(ctx, st.enrollment.id, now);
  return { feedback: buildFeedback(ctx, attemptId), proof, mastery };
}

function categoryForBlock(st: SkState, plan: SessionPlan, kind: string): string[] {
  const mix = planMix(st).mix.map((x) => x.category);
  const cat = (nodeId: string) => categoryOfNode(st.model, nodeId, mix[0] ?? "");
  const block = plan.blocks.find((b) => b.kind === kind);
  if (!block) return [];
  const out: string[] = [];
  for (const it of block.items) {
    if (it.type === "drill") out.push(it.drill.focus ?? cat(it.drill.nodes[0]));
    if (it.type === "lesson") out.push(cat(it.nodes[0]));
    if (it.type === "capture") {
      const d = st.model.drills.find((x) => x.id === it.drillId);
      out.push(d?.focus ?? (d ? cat(d.nodes[0]) : ""));
    }
    // warm-up time counts as recovery when the plan has that category (an injury is flagged)
    if (it.type === "warmup" && mix.includes(RECOVERY_CATEGORY)) out.push(RECOVERY_CATEGORY);
  }
  return out.filter(Boolean);
}

/**
 * session.completed: the time log by category from the plan's blocks and the actual minutes (measured block
 * durations where the studio sent them, the rest spread by planned share), mastery after, the next session.
 */
function completeSession(ctx: LasContext, sessionId: string, minutes: number, at: string | undefined, now: Date) {
  const s = ctx.store.getSession(sessionId);
  if (!s) throw new LoopError(`Unknown session "${sessionId}".`);
  // a repeated "completed" event never logs the time twice
  if (s.status === "done") return { summary: sessionSummary(ctx, sessionId), repeat: true };
  const st = loadSk(ctx, s.enrollmentId);
  const sk = st.enrollment.id;
  const plan = s.plan as SessionPlan;
  const state = sessionState(s.summary);
  const blocks = plan.blocks ?? [];
  const measured = blocks.filter((b) => state.blocks[b.kind] !== undefined);
  const measuredMin = measured.reduce((t, b) => t + state.blocks[b.kind] / 60, 0);
  const rest = blocks.filter((b) => state.blocks[b.kind] === undefined);
  const restPlanned = rest.reduce((t, b) => t + b.minutes, 0) || 1;
  const left = Math.max(0, minutes - measuredMin);
  for (const b of blocks) {
    const mins = state.blocks[b.kind] !== undefined ? state.blocks[b.kind] / 60 : (left * b.minutes) / restPlanned;
    if (mins <= 0) continue;
    const cats = categoryForBlock(st, plan, b.kind);
    if (!cats.length) ctx.store.logTime(sk, mins, "session", undefined, b.kind);
    else for (const c of cats) ctx.store.logTime(sk, mins / cats.length, "session", c, b.kind);
  }
  const ended = at ?? now.toISOString();
  ctx.store.updateSession(sessionId, { status: "done", endedAt: ended, startedAt: s.startedAt ?? ended, minutes, summary: { ...(s.summary ?? {}), state, before: s.summary?.before ?? snapshot(ctx, sk), after: snapshot(ctx, sk), completedAt: ended } });
  loopSettings.setVariation(ctx, sk, false);
  const doneCount = ctx.store.listSessions(sk, 500).filter((x) => x.status === "done").length;
  if (doneCount === 1) ctx.store.addCheckin({ enrollmentId: sk, kind: "session-feel", dueAt: ended, payload: { n: 1, injury: st.constraints.injuries[0], sessionId } });
  // the next session goes on the next practice day, at the start of the learner's window
  const planned = ctx.store.listSessions(sk, 20).find((x) => x.status === "planned" && x.id !== sessionId);
  let next: SessionPlan | undefined;
  if (st.milestone && st.enrollment.status === "active") next = planned ? planSession(ctx, sk, { now, sessionId: planned.id }) : planSession(ctx, sk, { now, plannedAt: nextPracticeTime(st, now).toISOString(), fresh: true });
  scheduleCheckins(ctx, sk, now);
  ensureCheckins(ctx, sk, now);
  return { summary: sessionSummary(ctx, sessionId), next };
}

/** The next practice day after today, at the start of the learner's window. */
export function nextPracticeTime(st: SkState, now: Date): Date {
  const today = zoned(now, st.tz).ymd;
  const win = st.constraints.schedule.window ?? { start: 18, end: 21 };
  for (let i = 1; i <= 7; i++) {
    const ymd = addDaysYmd(today, i);
    if (st.constraints.schedule.days.includes(weekdayOfYmd(ymd))) return atLocal(ymd, win.start, st.tz);
  }
  return atLocal(addDaysYmd(today, 1), win.start, st.tz);
}

function sessionForEvent(ctx: LasContext, sessionId: string) {
  const s = ctx.store.getSession(sessionId);
  if (!s) throw new LoopError(`Unknown session "${sessionId}".`);
  return s;
}

/** Every studio event goes through here (POST /api/events, and tools that act like the studio). */
export async function handleEvent(ctx: LasContext, event: StudioEvent, now = new Date()): Promise<Record<string, unknown>> {
  switch (event.type) {
    case "session.started": {
      const s = sessionForEvent(ctx, event.sessionId);
      ctx.store.updateSession(s.id, { status: "active", startedAt: event.at ?? now.toISOString(), summary: { ...(s.summary ?? {}), before: snapshot(ctx, s.enrollmentId) } });
      ctx.store.logEvent(s.enrollmentId, event.type, event);
      return { sessionId: s.id, status: "active" };
    }
    case "session.completed": {
      const s = sessionForEvent(ctx, event.sessionId);
      ctx.store.logEvent(s.enrollmentId, event.type, event);
      return completeSession(ctx, s.id, event.minutes, event.at, now);
    }
    case "block.completed": {
      const s = sessionForEvent(ctx, event.sessionId);
      const state = sessionState(s.summary);
      state.blocks[event.block] = (state.blocks[event.block] ?? 0) + event.durationS;
      saveSessionState(ctx, s.id, state);
      ctx.store.logEvent(s.enrollmentId, event.type, event);
      return { block: event.block, seconds: state.blocks[event.block] };
    }
    case "drill.outcome": {
      const o = event.outcome;
      const session = event.sessionId ? ctx.store.getSession(event.sessionId) : undefined;
      const st = session ? loadSk(ctx, session.enrollmentId) : findByDrill(ctx, o.drillId);
      const sk = st.enrollment.id;
      ctx.store.logEvent(sk, event.type, event);
      const drill = drillMap(st.model).get(o.drillId);
      if (!drill) throw new LoopError(`"${st.model.name}" has no drill "${o.drillId}".`);
      const mastery = observe(ctx, st, o.nodes.length ? o.nodes : drill.nodes, o.success);
      const levels = drill.difficulty?.levels.length ?? 1;
      let state: SessionState;
      if (session) state = sessionState(session.summary);
      else state = { difficulty: {}, run: {}, quiz: {}, blocks: {}, ...ctx.store.getSetting<Partial<SessionState>>(drillStateKey(sk, drill.id), {}) } as SessionState;
      const step = nextDifficulty(state.difficulty[drill.id] ?? o.difficulty, levels, state.run[drill.id] ?? { succ: 0, miss: 0 }, o.success);
      state.difficulty[drill.id] = step.level;
      state.run[drill.id] = step.run;
      if (session) saveSessionState(ctx, session.id, state);
      else ctx.store.setSetting(drillStateKey(sk, drill.id), { difficulty: state.difficulty, run: state.run });
      updateMistakes(ctx, st, drillEngine(st.model, drill), o.mistakes, o.nodes.length ? o.nodes : drill.nodes, now);
      ensureCheckins(ctx, sk, now);
      const lv = drill.difficulty?.levels[step.level];
      return { difficulty: step.level, label: lv !== undefined ? `${drill.difficulty!.param}: ${lv}` : undefined, changed: step.changed ?? null, mastery };
    }
    case "review.graded": {
      const card = ctx.store.getReviewCard(event.cardId);
      if (!card) throw new LoopError(`Unknown review card "${event.cardId}".`);
      const next = gradeCard(card.fsrs, event.grade, now);
      ctx.store.upsertReviewCard({ id: card.id, enrollmentId: card.enrollmentId, nodeId: card.nodeId, fsrs: next.state, dueAt: next.dueAt });
      ctx.store.logEvent(card.enrollmentId, event.type, event);
      return { cardId: card.id, dueAt: next.dueAt };
    }
    case "attempt.captured": {
      const a = ctx.store.getAttempt(event.attemptId);
      if (!a) throw new LoopError(`Unknown attempt "${event.attemptId}".`);
      if (event.mediaRef) ctx.store.setAttemptMedia(a.id, event.mediaRef);
      ctx.store.logEvent(a.enrollmentId, event.type, event);
      return { attemptId: a.id };
    }
    case "attempt.analyzed": {
      const a = ctx.store.getAttempt(event.attemptId);
      if (!a) throw new LoopError(`Unknown attempt "${event.attemptId}".`);
      ctx.store.logEvent(a.enrollmentId, event.type, { type: event.type, attemptId: event.attemptId });
      return processAnalysis(ctx, a.id, event.analysis, now);
    }
    case "attempt.disputed": {
      const a = ctx.store.getAttempt(event.attemptId);
      if (!a) throw new LoopError(`Unknown attempt "${event.attemptId}".`);
      ctx.store.logEvent(a.enrollmentId, event.type, event);
      return disputeMistake(ctx, a, event.mistakeId, event.consentToTune);
    }
    case "pain.reported": {
      const st = loadSk(ctx, event.sk);
      ctx.store.logEvent(st.enrollment.id, event.type, event);
      return reportPainState(ctx, st.enrollment.id, event.area, event.level, now);
    }
    case "checkin.answered": {
      const c = ctx.store.getCheckin(event.checkinId);
      if (!c) throw new LoopError(`Unknown check-in "${event.checkinId}".`);
      ctx.store.logEvent(c.enrollmentId, event.type, event);
      return { ...answerCheckin(ctx, event.checkinId, event.option, now) };
    }
    case "placement.adjusted": {
      const r = await adjustPlacement(ctx, event.intakeId, event.delta);
      ctx.store.logEvent(null, event.type, event);
      return { view: r.view };
    }
    case "theme.changed":
      ctx.store.logEvent(null, event.type, event);
      return {};
  }
}

/**
 * attempt.disputed (§6 rule 6, evaluation §7): the mistake is muted for that attempt and the dispute is
 * logged with the metrics and the learner's consent to use it for tuning. This sighting no longer counts.
 */
export function disputeMistake(ctx: LasContext, attempt: AttemptRow, mistakeId: string, consent: boolean) {
  ctx.store.addDispute(attempt.enrollmentId, attempt.id, mistakeId, attempt.analysis?.metrics ?? {}, consent);
  const s = ctx.store.getMistakeStates(attempt.enrollmentId).get(mistakeId);
  if (s) {
    const seenCount = Math.max(0, s.seenCount - 1);
    ctx.store.setMistakeState({ ...s, seenCount, disputedCount: s.disputedCount + 1, state: seenCount === 0 ? "muted" : s.state });
  }
  return { muted: true, mistakeId, feedback: attempt.analysis ? buildFeedback(ctx, attempt.id) : undefined };
}
