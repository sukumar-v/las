/**
 * Progress, the session summary and Today (learning loop §1, §8). Measured against the learner's own past
 * only: no leaderboards, weekly dots instead of streaks, copy that ties back to their why.
 */
import type { ProgressView, SessionPlan, SummaryView, TodayView } from "@las/schema";
import type { LasContext } from "../context.js";
import { addDaysYmd, clamp, daysBetween, lc1, loadSk, LoopError, nodeMap, weekdayOfYmd, zoned, DAY_MS, DAY_NAMES } from "./common.js";
import { routeView, planMix, pictureOf } from "./route.js";
import { readiness } from "./proof.js";
import { buildFeedback } from "./feedback.js";
import { ensureCheckins, describe, missedDays, pendingCheckin } from "./checkins.js";
import { velocity } from "./replan.js";
import { CARD_SECONDS, planSession } from "./planner.js";

export function getProgress(ctx: LasContext, sk: string, now = new Date()): ProgressView {
  const st = loadSk(ctx, sk);
  const e = st.enrollment.id;
  const mastery = ctx.store.getMastery(e);
  const keyMetrics = st.model.key_metrics.map((k) => {
    const history = ctx.store.metricHistory(e, k.id, 100).map((h) => ({ value: h.value, at: h.at }));
    return { id: k.id, label: k.label, unit: k.unit, better: k.better, format: k.format, history, first: history[0]?.value, latest: history[history.length - 1]?.value };
  });
  // before and after: the first saved attempt beside the latest at the most practiced drill
  const analyzed = ctx.store.listAttempts(e, { analyzed: true, limit: 500 }).filter((a) => a.drillId && a.analysis?.quality.ok);
  const counts = new Map<string, number>();
  for (const a of analyzed) counts.set(a.drillId!, (counts.get(a.drillId!) ?? 0) + 1);
  const most = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  let beforeAfter: ProgressView["beforeAfter"];
  if (most) {
    const list = analyzed.filter((a) => a.drillId === most).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const first = list[0];
    const latest = list[list.length - 1];
    const km = st.model.key_metrics.find((k) => k.metric in first.analysis!.metrics);
    beforeAfter = {
      drillId: most,
      label: st.model.drills.find((d) => d.id === most)?.title ?? most,
      first: { attemptId: first.id, value: km ? first.analysis!.metrics[km.metric].value : undefined, at: first.createdAt },
      latest: latest.id !== first.id ? { attemptId: latest.id, value: km ? latest.analysis!.metrics[km.metric]?.value : undefined, at: latest.createdAt } : undefined,
      unit: km?.unit
    };
  }
  // time: actual minutes against the plan since the skill started (up to the last 4 weeks), and the mix
  const days = clamp(daysBetween(st.enrollment.createdAt, now), 1, 28);
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  const t = ctx.store.timeSince(e, since);
  const plannedMinutes = Math.round((st.constraints.minutesPerWeek * days) / 7);
  const catTotal = Object.values(t.byCategory).reduce((s, v) => s + v, 0);
  const mix = planMix(st).mix.map((x) => ({ category: x.category, planned: x.share, actual: catTotal ? Math.round(((t.byCategory[x.category] ?? 0) / catTotal) * 100) : 0 }));
  const r = readiness(ctx, st);
  const byId = nodeMap(st.model);
  return {
    sk: e,
    skill: st.model.name,
    route: routeView(ctx, st),
    nodes: st.model.nodes.map((n) => ({ id: n.id, name: n.name, mastery: Math.round((mastery.get(n.id)?.pKnown ?? byId.get(n.id)!.bkt.p_init) * 1000) / 1000 })),
    keyMetrics,
    beforeAfter,
    time: { actualMinutes: Math.round(t.minutes), plannedMinutes, mix },
    history: {
      sessions: ctx.store.listSessions(e, 50).map((s) => ({ id: s.id, at: s.endedAt ?? s.startedAt ?? s.plannedAt, minutes: s.minutes, focus: (s.plan as SessionPlan)?.focus?.name, status: s.status })),
      attempts: ctx.store.listAttempts(e, { limit: 50 }).map((a) => ({ id: a.id, at: a.createdAt, kind: a.kind, drillId: a.drillId, engine: a.engine }))
    },
    proof: { title: st.milestone?.title ?? "", ready: r.ready, percent: r.percent, criteria: r.criteria }
  };
}

export function sessionSummary(ctx: LasContext, sessionId: string): SummaryView {
  const s = ctx.store.getSession(sessionId);
  if (!s) throw new LoopError(`Unknown session "${sessionId}".`);
  const st = loadSk(ctx, s.enrollmentId);
  const plan = s.plan as SessionPlan;
  const byId = nodeMap(st.model);
  const mastery = ctx.store.getMastery(st.enrollment.id);
  const nodes = new Set<string>();
  for (const b of plan.blocks ?? [])
    for (const it of b.items) {
      if (it.type === "lesson") it.nodes.forEach((n) => nodes.add(n));
      if (it.type === "drill") it.drill.nodes.forEach((n) => nodes.add(n));
      if (it.type === "capture" && it.drillId) st.model.drills.find((d) => d.id === it.drillId)?.nodes.forEach((n) => nodes.add(n));
    }
  const before = (s.summary?.before ?? {}) as Record<string, number>;
  const after = (s.summary?.after ?? {}) as Record<string, number>;
  const changed = [...nodes].filter((n) => byId.has(n)).map((n) => ({ nodeId: n, name: byId.get(n)!.name, before: before[n] ?? mastery.get(n)?.pKnown ?? 0, after: after[n] ?? mastery.get(n)?.pKnown ?? 0 }));
  const attempts = ctx.store
    .listAttempts(st.enrollment.id, { analyzed: true, limit: 200 })
    .filter((a) => a.sessionId === s.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  let oneFix: SummaryView["oneFix"];
  let praise: string | undefined;
  for (const a of attempts) {
    const f = buildFeedback(ctx, a.id);
    if (!oneFix && f.mistakeId) oneFix = { headline: f.headline, mistakeId: f.mistakeId, fixDrillTitle: f.fixDrillTitle };
    praise ??= f.praise?.headline;
  }
  const next = ctx.store.listSessions(st.enrollment.id, 20).find((x) => x.status === "planned" && x.id !== s.id);
  const np = next?.plan as SessionPlan | undefined;
  let metric: SummaryView["metric"];
  const km = st.model.key_metrics[0];
  if (km) {
    const hist = ctx.store.db.all("SELECT value, attempt_id, created_at FROM metric_history WHERE enrollment_id = ? AND metric_id = ? ORDER BY created_at", st.enrollment.id, km.id);
    const inSession = new Set(attempts.map((a) => a.id));
    const start = s.startedAt ?? s.plannedAt ?? "";
    const prior = hist.filter((h) => !inSession.has(h.attempt_id) && h.created_at < start);
    const mine = hist.filter((h) => inSession.has(h.attempt_id));
    if (mine.length || prior.length) metric = { label: km.label, before: prior[prior.length - 1]?.value ?? mine[0]?.value, after: mine[mine.length - 1]?.value, unit: km.unit };
  }
  return {
    sessionId: s.id,
    sk: st.enrollment.id,
    skill: st.model.name,
    minutes: Math.round(s.minutes ?? plan.minutes ?? 0),
    changed,
    oneFix,
    praise,
    next: { title: np?.title ?? "Next session", focus: np?.focus?.name ?? "", when: next?.plannedAt },
    metric
  };
}

/**
 * Today (§1): what should I do now? The state machine, in order: paused, milestone done, proof ready,
 * missed a session, behind schedule, first day, normal. The pending check-in comes as one-tap options.
 */
export function getToday(ctx: LasContext, sk: string, now = new Date()): TodayView {
  let st = loadSk(ctx, sk);
  const e = st.enrollment.id;
  if (st.enrollment.status === "active") ensureCheckins(ctx, e, now);
  st = loadSk(ctx, e);
  const sessions = ctx.store.listSessions(e, 200);
  const done = sessions.filter((s) => s.status === "done");
  const milestones = ctx.store.listMilestones(e);
  const r = readiness(ctx, st);
  const pending = pendingCheckin(ctx, e, now);
  const allPending = ctx.store.listCheckins(e, { pending: true }).filter((c) => c.dueAt <= now.toISOString());
  let state: TodayView["state"] = "normal";
  if (st.enrollment.status === "paused") state = "paused";
  else if (!st.milestone && milestones.some((m) => m.status === "done")) state = "milestone-done";
  else if (r.ready) state = "proof-ready";
  else if (allPending.some((c) => c.kind === "missed-session")) state = "missed";
  else if (velocity(ctx, st, now).status === "behind") state = "behind";
  else if (!done.length) state = "first-day";
  let nextSession: TodayView["nextSession"];
  if (st.enrollment.status === "active" && st.milestone) {
    const planned = sessions.find((s) => s.status === "planned" || s.status === "active");
    const plan = (planned?.plan as SessionPlan | undefined)?.blocks ? (planned!.plan as SessionPlan) : planSession(ctx, e, { now });
    nextSession = { id: plan.sessionId, title: plan.title, minutes: plan.minutes, focus: plan.focus.name, reason: plan.focus.reason };
  }
  const due = ctx.store.dueReviews(e, now.toISOString()).length;
  const tz = st.tz;
  const today = zoned(now, tz).ymd;
  const monday = addDaysYmd(today, -zoned(now, tz).weekday);
  const doneDays = new Set(done.map((s) => zoned(new Date(s.endedAt ?? s.startedAt ?? s.plannedAt ?? now), tz).ymd));
  const missed = new Set(missedDays(ctx, st, now));
  const week = Array.from({ length: 7 }, (_, i) => {
    const ymd = addDaysYmd(monday, i);
    const planned = st.constraints.schedule.days.includes(weekdayOfYmd(ymd));
    const s: "done" | "missed" | "plan" | "none" = doneDays.has(ymd) ? "done" : missed.has(ymd) ? "missed" : planned && ymd >= today ? "plan" : "none";
    return { day: i, state: s, today: ymd === today };
  });
  const pic = st.intent?.afterwards || pictureOf(st).picture?.label || "";
  const messages: Record<TodayView["state"], string> = {
    "first-day": `Session 1 is ready.${pic ? ` A first step toward ${lc1(pic)}.` : ""}`,
    normal: pic ? `One step closer to ${lc1(pic)}.` : "Pick up where you left off.",
    missed: "Missed one. Nothing resets: pick up where you left off.",
    behind: "Running behind the plan. Want to adjust it?",
    "proof-ready": "Your skills are ready. Take the proof check when you are.",
    "milestone-done": "Milestone done. Let's pick the next one.",
    paused: "Paused. Resume whenever you like."
  };
  const pendingView = pending ? describe(st, pending) : undefined;
  return {
    sk: e,
    skill: st.model.name,
    state,
    nextSession,
    reviewsDue: { count: due, minutes: Math.ceil((due * CARD_SECONDS) / 60) },
    milestone: st.milestone ? { title: st.milestone.title, percent: r.percent, proofDate: st.milestone.targetDate, step: st.milestone.ladderStep } : undefined,
    checkin: pending && pendingView ? { id: pending.id, kind: pending.kind, question: pendingView.question, options: pendingView.options.map((o) => ({ id: o.id, label: o.label })) } : undefined,
    week,
    weeklyReview: `Weekly review on ${DAY_NAMES[6]}, 5 minutes with your coach.`,
    message: messages[state],
    route: routeView(ctx, st)
  };
}
