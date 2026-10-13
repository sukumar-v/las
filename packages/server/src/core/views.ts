import type { Enrollment } from "@las/store";
import type { LasContext } from "../context.js";

/** Read-only views used by resources and tools. Filled in by the learning loop (phase 5) where noted. */
export function learnerProfile(ctx: LasContext) {
  const learner = ctx.store.getOrCreateLearner();
  const enrollments = ctx.store.listEnrollments(learner.id).map((e) => {
    const model = ctx.store.getSkillModel(e.skillModelId);
    return {
      sk: e.id,
      skill: model?.model.name ?? e.skillModelId,
      skillModelId: e.skillModelId,
      status: e.status,
      intent: ctx.store.getIntent(e.id),
      constraints: ctx.store.getConstraints(e.id),
      milestone: ctx.store.activeMilestone(e.id),
      theme: ctx.store.activeTheme(learner.id, e.id)?.id ?? "base"
    };
  });
  return { learner: { id: learner.id, name: learner.name, timezone: learner.timezone, quietHours: learner.quietHours, nudgeLimits: learner.nudgeLimits }, theme: ctx.store.activeTheme(learner.id, null)?.id ?? "base", skills: enrollments };
}

export function routeFor(ctx: LasContext, e: Enrollment) {
  const model = ctx.store.getSkillModel(e.skillModelId)?.model;
  const milestone = ctx.store.activeMilestone(e.id);
  const mastery = ctx.store.getMastery(e.id);
  const intake = ctx.store.db.get("SELECT placement FROM intake WHERE enrollment_id = ?", e.id);
  const placement = intake?.placement ? JSON.parse(intake.placement) : undefined;
  return {
    sk: e.id,
    start: placement?.step ?? 0,
    milestone,
    ladder: (model?.ladder ?? []).map((s, i) => ({
      step: i,
      id: s.id,
      label: s.label,
      hours: s.hours,
      nodes: s.nodes.map((n) => ({ id: n, name: model?.nodes.find((x) => x.id === n)?.name ?? n, mastery: mastery.get(n)?.pKnown ?? 0 })),
      done: placement ? i <= placement.step : i === 0,
      target: milestone?.ladderStep === i
    }))
  };
}

export function progressFor(ctx: LasContext, e: Enrollment) {
  const model = ctx.store.getSkillModel(e.skillModelId)?.model;
  const mastery = ctx.store.getMastery(e.id);
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  return {
    sk: e.id,
    route: routeFor(ctx, e),
    nodes: (model?.nodes ?? []).map((n) => ({ id: n.id, name: n.name, mastery: mastery.get(n.id)?.pKnown ?? 0, attempts: mastery.get(n.id)?.attempts ?? 0 })),
    keyMetrics: (model?.key_metrics ?? []).map((k) => ({ ...k, history: ctx.store.metricHistory(e.id, k.id) })),
    time: ctx.store.timeSince(e.id, since),
    sessions: ctx.store.listSessions(e.id, 30).map((s) => ({ id: s.id, status: s.status, plannedAt: s.plannedAt, minutes: s.minutes, focus: s.plan?.focus })),
    attempts: ctx.store.listAttempts(e.id, { limit: 30 }).map((a) => ({ id: a.id, kind: a.kind, drillId: a.drillId, engine: a.engine, at: a.createdAt, analyzed: !!a.analysis })),
    proofs: ctx.store.listProofs(e.id),
    planChanges: ctx.store.listPlanChanges(e.id)
  };
}

export function mistakesFor(ctx: LasContext, e: Enrollment) {
  const model = ctx.store.getSkillModel(e.skillModelId)?.model;
  const states = ctx.store.getMistakeStates(e.id);
  return {
    sk: e.id,
    mistakes: (model?.mistakes ?? []).map((m) => ({ id: m.id, name: m.name, headline: m.headline, severity: m.severity, nodes: m.nodes, fixDrill: m.fix_drill, state: states.get(m.id)?.state ?? "never-seen", seen: states.get(m.id)?.seenCount ?? 0, cleanStreak: states.get(m.id)?.cleanStreak ?? 0, disputed: states.get(m.id)?.disputedCount ?? 0 })),
    disputes: ctx.store.listDisputes(e.id)
  };
}
