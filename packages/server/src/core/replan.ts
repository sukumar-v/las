/**
 * Re-planning (learning loop §7): velocity against the plan, and the options the learner chooses from.
 * The plan never changes silently: every option is the learner's choice and is logged in plan_change.
 */
import type { PlanView, RouteView } from "@las/schema";
import type { LasContext } from "../context.js";
import { addWeeks, clamp, DAY_NAMES, isoDay, loadSk, LoopError, mean, meanHours, scheduleFor, weeksTo, WEEK_MS, type SkState } from "./common.js";
import { feasibility } from "./rules.js";
import { planView, routeView } from "./route.js";
import { loopSettings } from "./settings.js";
import { PROOF_MASTERY, planSession } from "./planner.js";
import { nextPracticeTime } from "./sessions.js";
import { refreshSchedule } from "./checkins.js";

export type VelocityStatus = "behind" | "ahead" | "on-track" | "too-early" | "no-milestone";

export interface Velocity {
  status: VelocityStatus;
  gainedHours: number;
  totalHours: number;
  weeksElapsed: number;
  perWeek: number;
  plannedPerWeek: number;
  projectedDate?: string;
  targetDate?: string;
}

/**
 * Velocity = ladder hours gained per week, from mastery (§7). A step's progress is the mean over its nodes
 * of how far each has come from its starting p_init to 80%; hours gained = Σ step hours × progress.
 * Behind: the projected date is more than 20% of the plan's span past the target. Ahead: more than 30% early.
 * Decision: no verdict in the first week, there isn't enough to go on.
 */
export function velocity(ctx: LasContext, st: SkState, now = new Date()): Velocity {
  const m = st.milestone;
  const plannedPerWeek = st.constraints.minutesPerWeek / 60;
  if (!m) return { status: "no-milestone", gainedHours: 0, totalHours: 0, weeksElapsed: 0, perWeek: 0, plannedPerWeek };
  const mastery = ctx.store.getMastery(st.enrollment.id);
  const nodes = new Map(st.model.nodes.map((n) => [n.id, n]));
  let total = 0;
  let gained = 0;
  for (let i = st.placement + 1; i <= m.ladderStep; i++) {
    const s = st.model.ladder[i];
    const h = meanHours(s);
    const progress = s.nodes.length
      ? mean(
          s.nodes.map((id) => {
            const p0 = nodes.get(id)?.bkt.p_init ?? 0.1;
            return clamp(((mastery.get(id)?.pKnown ?? p0) - p0) / Math.max(0.05, PROOF_MASTERY - p0), 0, 1);
          })
        )
      : 0;
    total += h;
    gained += h * progress;
  }
  const start = new Date(m.createdAt);
  const weeksElapsed = Math.max(1 / 7, (now.getTime() - start.getTime()) / WEEK_MS);
  const perWeek = gained / weeksElapsed;
  const target = m.targetDate ? new Date(`${m.targetDate}T23:59:59Z`) : addWeeks(start, m.estimateWeeks ?? 4);
  const projected = perWeek > 0 ? new Date(now.getTime() + ((total - gained) / perWeek) * WEEK_MS) : undefined;
  const span = Math.max(WEEK_MS, target.getTime() - start.getTime());
  let status: VelocityStatus = "on-track";
  if (total === 0 || gained >= total) status = "on-track";
  else if (now.getTime() - start.getTime() < WEEK_MS) status = "too-early";
  else if (!projected || projected.getTime() > target.getTime() + 0.2 * span) status = "behind";
  else if (projected.getTime() < target.getTime() - 0.3 * span) status = "ahead";
  return { status, gainedHours: Math.round(gained * 10) / 10, totalHours: Math.round(total * 10) / 10, weeksElapsed: Math.round(weeksElapsed * 10) / 10, perWeek: Math.round(perWeek * 100) / 100, plannedPerWeek, projectedDate: projected ? isoDay(projected) : undefined, targetDate: m.targetDate };
}

export const REPLAN_OPTIONS: Record<string, { id: string; label: string }[]> = {
  behind: [
    { id: "stone", label: "A closer stepping stone" },
    { id: "more-time", label: "More time per week" },
    { id: "later-date", label: "Move the date" }
  ],
  ahead: [
    { id: "stretch", label: "Stretch the goal" },
    { id: "keep", label: "Keep it" }
  ],
  "plan-check": [
    { id: "change-days", label: "Change days" },
    { id: "change-minutes", label: "Change minutes" },
    { id: "keep", label: "Keep as is" }
  ]
};

function parseDays(value: unknown): number[] {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[,\s]+/).filter(Boolean);
  const out = list.map((v) => {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0 && n <= 6) return n;
    const i = DAY_NAMES.findIndex((d) => d.toLowerCase().startsWith(String(v).toLowerCase().slice(0, 3)));
    if (i < 0) throw new LoopError(`"${String(v)}" isn't a day. Use 0–6 (Monday = 0) or day names.`);
    return i;
  });
  return [...new Set(out)].sort((a, b) => a - b);
}

export interface ReplanResult {
  option: string;
  change: string;
  plan: PlanView;
  route: RouteView;
}

/**
 * Applies one re-plan option the learner chose: stone / smaller, more-time, later-date, stretch, keep,
 * change-days (value: days), change-minutes (value: minutes per week), pause, resume.
 */
export function replan(ctx: LasContext, sk: string, option: string, value?: unknown, now = new Date()): ReplanResult {
  const st = loadSk(ctx, sk);
  const e = st.enrollment.id;
  const m = st.milestone;
  const model = st.model;
  const top = model.ladder.length - 1;
  let change = "";
  const c = st.constraints;
  const needMilestone = () => {
    if (!m) throw new LoopError("There's no active milestone to change. revisit_why sets the next one.");
    return m;
  };
  const feasFor = (step: number, minutesPerWeek: number) => feasibility({ model, placement: st.placement, minutesPerWeek, deadlineWeeks: c.deadline ? Math.max(1, Math.round((new Date(c.deadline).getTime() - now.getTime()) / WEEK_MS)) : null, why: st.intent?.why ?? [] }, step).label;
  switch (option) {
    case "stone":
    case "smaller": {
      const ms = needMilestone();
      const weeksLeft = Math.max(1, Math.round((new Date(`${ms.targetDate ?? isoDay(now)}T00:00:00Z`).getTime() - now.getTime()) / WEEK_MS));
      let stone: number | undefined = value !== undefined ? Number(value) : undefined;
      if (stone === undefined || !Number.isInteger(stone)) {
        stone = undefined;
        for (let r = st.placement + 1; r < ms.ladderStep; r++) if (weeksTo(model, st.placement, r, c.minutesPerWeek) <= weeksLeft) stone = r;
        stone ??= st.placement + 1 < ms.ladderStep ? st.placement + 1 : undefined;
      }
      if (stone === undefined || stone >= ms.ladderStep || stone <= st.placement) throw new LoopError("Your milestone is already the next step on the ladder. Try more time per week or a later date.");
      const w = weeksTo(model, st.placement, stone, c.minutesPerWeek);
      loopSettings.setNextGoal(ctx, e, { step: ms.ladderStep, title: ms.title });
      ctx.store.addMilestone({ enrollmentId: e, title: model.ladder[stone].label, ladderStep: stone, proof: model.ladder[stone].proof ?? { engine: "self-report", label: model.ladder[stone].label, criteria: [] }, targetDate: isoDay(addWeeks(now, w)), kind: "stone", estimateWeeks: w, feasibility: feasFor(stone, c.minutesPerWeek) });
      change = `Stepping stone "${model.ladder[stone].label}" in about ${w} weeks; "${ms.title}" stays the next goal.`;
      break;
    }
    case "more-time":
    case "change-minutes": {
      const ms = m;
      const minutes = clamp(Math.round(value !== undefined ? Number(value) : c.minutesPerWeek + 60), 30, 600);
      if (!Number.isFinite(minutes)) throw new LoopError("Give minutes per week as a number.");
      const sched = scheduleFor(minutes);
      const days = option === "change-minutes" && c.schedule.days.length === sched.sessionsPerWeek ? c.schedule.days : sched.days;
      ctx.store.setConstraints({ ...c, minutesPerWeek: minutes, schedule: { ...sched, days, window: c.schedule.window } });
      if (ms) ctx.store.updateMilestone(ms.id, { estimateWeeks: weeksTo(model, st.placement, ms.ladderStep, minutes), feasibility: feasFor(ms.ladderStep, minutes) });
      change = `${Math.round((minutes / 60) * 10) / 10} hours a week: ${sched.sessionsPerWeek} sessions of about ${sched.minutesEach} min.`;
      break;
    }
    case "later-date": {
      const ms = needMilestone();
      let date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
      if (!date) {
        const projected = velocity(ctx, st, now).projectedDate;
        date = projected && projected > (ms.targetDate ?? "") ? projected : isoDay(addWeeks(new Date(`${ms.targetDate ?? isoDay(now)}T00:00:00Z`), Math.max(1, Math.ceil((ms.estimateWeeks ?? 4) * 0.3))));
      }
      ctx.store.updateMilestone(ms.id, { targetDate: date });
      change = `Target moved to ${date}.`;
      break;
    }
    case "stretch": {
      const ms = needMilestone();
      const step = Math.min(top, ms.ladderStep + 1);
      if (step === ms.ladderStep) throw new LoopError("This milestone is already the top of the ladder.");
      const w = weeksTo(model, st.placement, step, c.minutesPerWeek);
      ctx.store.addMilestone({ enrollmentId: e, title: model.ladder[step].label, ladderStep: step, proof: model.ladder[step].proof ?? { engine: "self-report", label: model.ladder[step].label, criteria: [] }, targetDate: ms.targetDate && w <= (ms.estimateWeeks ?? w) ? ms.targetDate : isoDay(addWeeks(now, w)), kind: "stretch", estimateWeeks: w, feasibility: feasFor(step, c.minutesPerWeek) });
      change = `Stretch goal: "${model.ladder[step].label}".`;
      break;
    }
    case "change-days": {
      if (value === undefined) throw new LoopError("Which days? Pass value as day names or 0–6 (Monday = 0).");
      const days = parseDays(value);
      if (!days.length) throw new LoopError("Pick at least one day.");
      const minutesEach = clamp(Math.round(c.minutesPerWeek / days.length / 5) * 5, 10, 60);
      ctx.store.setConstraints({ ...c, schedule: { sessionsPerWeek: days.length, minutesEach, days, window: c.schedule.window } });
      change = `Practice on ${days.map((d) => DAY_NAMES[d]).join(", ")}, about ${minutesEach} min each.`;
      break;
    }
    case "keep":
      change = "Plan kept as it is.";
      break;
    case "pause":
      ctx.store.setEnrollmentStatus(e, "paused");
      change = "Paused. Nothing is scheduled until you resume.";
      break;
    case "resume":
      ctx.store.setEnrollmentStatus(e, "active");
      change = "Resumed.";
      break;
    default:
      throw new LoopError(`Unknown option "${option}". Options: stone, more-time, later-date, stretch, keep, change-days, change-minutes, pause, resume.`);
  }
  ctx.store.logPlanChange(e, "replan", value !== undefined ? `${option}:${typeof value === "string" ? value : JSON.stringify(value)}` : option);
  afterPlanChange(ctx, e, now);
  const fresh = loadSk(ctx, e);
  return { option, change, plan: planView(ctx, e), route: routeView(ctx, fresh) };
}

/** After any change: refresh the reminder schedule and re-plan the next session so it reflects the new plan. */
export function afterPlanChange(ctx: LasContext, sk: string, now = new Date()): void {
  refreshSchedule(ctx, sk, now);
}

/**
 * reschedule: move a planned session to another time ("today", "tomorrow" or an ISO date/time), or skip it.
 * Skipping never resets anything; the next session goes on the next practice day.
 */
export function reschedule(ctx: LasContext, sessionId: string, when: string, now = new Date()) {
  const s = ctx.store.getSession(sessionId);
  if (!s) throw new LoopError(`Unknown session "${sessionId}".`);
  if (s.status === "done") throw new LoopError("That session is done already.");
  const st = loadSk(ctx, s.enrollmentId);
  let plannedAt: string | undefined;
  if (when === "skip") {
    ctx.store.updateSession(s.id, { status: "skipped" });
    ctx.store.logPlanChange(st.enrollment.id, "reschedule", `skip:${s.id}`);
    const next = st.milestone ? planSession(ctx, st.enrollment.id, { now, plannedAt: nextPracticeTime(st, now).toISOString(), fresh: true }) : undefined;
    refreshSchedule(ctx, st.enrollment.id, now);
    return { sessionId: s.id, status: "skipped" as const, next: next ? { sessionId: next.sessionId, title: next.title, plannedAt: ctx.store.getSession(next.sessionId)?.plannedAt } : undefined };
  }
  const w = when.trim().toLowerCase();
  if (w === "today" || w === "now") plannedAt = now.toISOString();
  else if (w === "tomorrow") plannedAt = new Date(now.getTime() + 864e5).toISOString();
  else if (!Number.isNaN(Date.parse(when))) plannedAt = new Date(when).toISOString();
  else throw new LoopError(`"${when}" isn't a time. Use "today", "tomorrow", an ISO date or time, or "skip".`);
  ctx.store.updateSession(s.id, { plannedAt, status: "planned" });
  ctx.store.logPlanChange(st.enrollment.id, "reschedule", `move:${s.id}:${plannedAt}`);
  refreshSchedule(ctx, st.enrollment.id, now);
  return { sessionId: s.id, status: "planned" as const, plannedAt };
}
