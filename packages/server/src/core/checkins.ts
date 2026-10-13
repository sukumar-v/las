/**
 * Follow-ups and check-ins (learning loop §7, DESIGN §9). An MCP server can't start a conversation, so LAS
 * keeps a schedule of check-ins in the store; `runCheckins` is what the client's scheduler, `las checkin`,
 * Web Push or a cron job calls. Limits: quiet hours, at most 1 nudge a day and 4 a week (the learner's own
 * limits), one-tap pause. Wording ties back to the learner's own why; no guilt, no streaks.
 */
import type { CheckinView, SessionPlan } from "@las/schema";
import type { Checkin } from "@las/store";
import type { LasContext } from "../context.js";
import { addDaysYmd, atLocal, DAY_MS, DAY_NAMES, daysBetween, fmtDate, lc1, loadSk, LoopError, weekdayOfYmd, zoned, type SkState } from "./common.js";
import { planSession } from "./planner.js";
import { readiness } from "./proof.js";
import { REPLAN_OPTIONS, replan, velocity } from "./replan.js";
import { loopSettings } from "./settings.js";
import { pictureOf } from "./route.js";

export type CheckinKind =
  | "session-reminder"
  | "missed-session"
  | "plan-check"
  | "weekly-review"
  | "proof-ready"
  | "plateau"
  | "pain-followup"
  | "gone-quiet"
  | "session-feel"
  | "behind"
  | "ahead"
  | "revisit-why";

/** Which check-in Today shows first when several are waiting. */
export const PRIORITY: CheckinKind[] = ["pain-followup", "revisit-why", "proof-ready", "missed-session", "plan-check", "behind", "ahead", "session-feel", "session-reminder", "weekly-review", "plateau", "gone-quiet"];
/** Shown on Today only; never pushed, so they don't count against the nudge limits. */
export const IN_APP = new Set<string>(["session-feel", "revisit-why"]);
/** Decision: the weekly review is on Sunday at 10:00 local time; "next morning" means the end of quiet hours. */
export const WEEKLY_REVIEW_DAY = 6;
export const WEEKLY_REVIEW_HOUR = 10;
const DEFAULT_WINDOW = { start: 18, end: 21 };

type Opt = { id: string; label: string; detail?: string };

/** The question and one-tap answers for each check-in (§7 table). */
export function describe(st: SkState, c: Pick<Checkin, "kind" | "payload">): { question: string; options: Opt[] } {
  const p = (c.payload ?? {}) as Record<string, any>;
  const pic = st.intent?.afterwards || pictureOf(st).picture?.label || pictureOf(st).text || "";
  const pause: Opt = { id: "pause", label: "Pause reminders" };
  switch (c.kind as CheckinKind) {
    case "session-reminder":
      return { question: `Time for ${st.model.name}? ${p.minutes ?? st.constraints.schedule.minutesEach} min${p.focus ? `: ${lc1(p.focus)}` : ""}.`, options: [{ id: "start", label: "Start" }, { id: "snooze", label: "Snooze an hour" }, { id: "quick", label: "Quick 5-min" }, pause] };
    case "missed-session":
      return { question: `Missed ${DAY_NAMES[weekdayOfYmd(p.date ?? "2000-01-03")]}. Move it to today?`, options: [{ id: "move", label: "Move it to today" }, { id: "quick", label: "Quick session" }, { id: "skip", label: "Skip it" }, pause] };
    case "plan-check":
      return { question: "Two sessions slipped this week. Does the plan still fit your week?", options: [...REPLAN_OPTIONS["plan-check"], pause] };
    case "weekly-review":
      return { question: "Weekly review: 5 minutes on progress, the mix and next week.", options: [{ id: "open", label: "Start the review" }, { id: "later", label: "Later" }, pause] };
    case "proof-ready":
      return { question: `Your skills for "${st.milestone?.title ?? p.title ?? "your milestone"}" are ready. Take the proof check?`, options: [{ id: "proof", label: "Take the proof check" }, { id: "later", label: "Not yet" }, pause] };
    case "plateau":
      return { question: `${p.label ?? "Your key metric"} has been flat for 4 sessions. Try something different?`, options: [{ id: "variation", label: "Try a variation" }, { id: "lighter", label: "A lighter week" }, { id: "talk", label: "What's getting in the way?" }, pause] };
    case "pain-followup":
      return { question: `How is your ${lc1(p.area ?? "pain")} now?`, options: [{ id: "better", label: "Better" }, { id: "same", label: "About the same" }, { id: "worse", label: "Worse" }] };
    case "gone-quiet":
      return { question: pic ? `It's been a while. Still up for ${lc1(pic)}?` : `It's been a while. Still up for ${st.model.noun}?`, options: [{ id: "why", label: "Ask my why again" }, { id: "smaller", label: "A smaller goal" }, { id: "pause", label: "Pause for now" }] };
    case "session-feel":
      return p.injury
        ? { question: `How does your ${lc1(p.injury)} feel after session ${p.n ?? 1}?`, options: [{ id: "fine", label: "Fine" }, { id: "sore", label: "A bit sore" }, { id: "painful", label: "Painful" }] }
        : { question: `How did session ${p.n ?? 1} feel?`, options: [{ id: "too-easy", label: "Too easy" }, { id: "about-right", label: "About right" }, { id: "too-hard", label: "Too hard" }] };
    case "behind":
      return { question: `At this pace, "${st.milestone?.title ?? ""}" lands around ${p.projected ? fmtDate(p.projected, st.tz) : "later than planned"}. Want to adjust?`, options: [...REPLAN_OPTIONS.behind, pause] };
    case "ahead":
      return { question: `You're ahead of plan on "${st.milestone?.title ?? ""}". Stretch the goal?`, options: [...REPLAN_OPTIONS.ahead, pause] };
    case "revisit-why":
      return { question: `You did it: ${p.title ?? "milestone done"}. What's pulling you toward ${st.model.noun} now?`, options: [{ id: "why", label: "Answer again" }, { id: "later", label: "Later" }] };
    default:
      return { question: c.kind, options: [{ id: "ok", label: "OK" }] };
  }
}

export function checkinView(ctx: LasContext, c: Checkin, st?: SkState): CheckinView {
  const s = st ?? loadSk(ctx, c.enrollmentId);
  const d = describe(s, c);
  return { id: c.id, kind: c.kind, question: d.question, options: d.options, dueAt: c.dueAt };
}

const rank = (k: string) => {
  const i = PRIORITY.indexOf(k as CheckinKind);
  return i < 0 ? PRIORITY.length : i;
};

// ---------------------------------------------------------------------------
// Scheduling

function lastActivity(ctx: LasContext, st: SkState): Date {
  const done = ctx.store.listSessions(st.enrollment.id, 50).filter((s) => s.status === "done").map((s) => s.endedAt ?? s.startedAt ?? s.plannedAt ?? "");
  const ext = ctx.store.db.get("SELECT MAX(created_at) AS t FROM time_log WHERE enrollment_id = ?", st.enrollment.id)?.t as string | undefined;
  const all = [...done, ext ?? "", st.enrollment.createdAt].filter(Boolean).sort();
  return new Date(all[all.length - 1]);
}

/**
 * The standing schedule: a reminder at the start of the learner's window on each practice day of the next
 * week, the weekly review on a fixed day, and "gone quiet" 14 days after the last activity.
 */
export function scheduleCheckins(ctx: LasContext, sk: string, now = new Date()): void {
  const st = loadSk(ctx, sk);
  const e = st.enrollment.id;
  if (st.enrollment.status !== "active") return;
  const tz = st.tz;
  const win = st.constraints.schedule.window ?? DEFAULT_WINDOW;
  const pending = ctx.store.listCheckins(e, { pending: true });
  const today = zoned(now, tz).ymd;
  const planned = ctx.store.listSessions(e, 20).find((s) => s.status === "planned");
  const plan = planned?.plan as SessionPlan | undefined;
  for (let i = 0; i < 7; i++) {
    const ymd = addDaysYmd(today, i);
    if (!st.constraints.schedule.days.includes(weekdayOfYmd(ymd))) continue;
    const due = atLocal(ymd, win.start, tz);
    if (due <= now) continue;
    if (pending.some((c) => c.kind === "session-reminder" && c.payload?.date === ymd)) continue;
    ctx.store.addCheckin({ enrollmentId: e, kind: "session-reminder", dueAt: due.toISOString(), payload: { date: ymd, minutes: st.constraints.schedule.minutesEach, focus: plan?.focus?.name } });
  }
  if (!pending.some((c) => c.kind === "weekly-review")) {
    let ymd = today;
    for (let i = 0; i < 8; i++) {
      ymd = addDaysYmd(today, i);
      if (weekdayOfYmd(ymd) === WEEKLY_REVIEW_DAY && atLocal(ymd, WEEKLY_REVIEW_HOUR, tz) > now) break;
    }
    ctx.store.addCheckin({ enrollmentId: e, kind: "weekly-review", dueAt: atLocal(ymd, WEEKLY_REVIEW_HOUR, tz).toISOString(), payload: { date: ymd } });
  }
  ctx.store.deletePendingCheckins(e, "gone-quiet");
  const quietFrom = zoned(lastActivity(ctx, st), tz).ymd;
  ctx.store.addCheckin({ enrollmentId: e, kind: "gone-quiet", dueAt: atLocal(addDaysYmd(quietFrom, 14), WEEKLY_REVIEW_HOUR, tz).toISOString(), payload: { since: quietFrom } });
}

/** After a plan change: new reminders for the new days, and the next session re-planned for the new plan. */
export function refreshSchedule(ctx: LasContext, sk: string, now = new Date()): void {
  const st = loadSk(ctx, sk);
  ctx.store.deletePendingCheckins(st.enrollment.id, "session-reminder");
  scheduleCheckins(ctx, sk, now);
  const planned = ctx.store.listSessions(st.enrollment.id, 20).find((s) => s.status === "planned" && !s.startedAt);
  if (planned && st.milestone) planSession(ctx, sk, { now, sessionId: planned.id });
}

/** Practice days that passed with no session done since the practice day before them. */
export function missedDays(ctx: LasContext, st: SkState, now = new Date(), lookbackDays = 7): string[] {
  const tz = st.tz;
  const today = zoned(now, tz).ymd;
  const created = zoned(new Date(st.enrollment.createdAt), tz).ymd;
  const doneDays = ctx.store
    .listSessions(st.enrollment.id, 200)
    .filter((s) => s.status === "done")
    .map((s) => zoned(new Date(s.endedAt ?? s.startedAt ?? s.plannedAt ?? now), tz).ymd);
  const extDays = ctx.store.db.all("SELECT created_at FROM time_log WHERE enrollment_id = ? AND source = 'external'", st.enrollment.id).map((r) => zoned(new Date(r.created_at as string), tz).ymd);
  const active = [...doneDays, ...extDays];
  const days = st.constraints.schedule.days;
  const out: string[] = [];
  let prev: string | undefined;
  for (let i = lookbackDays + 7; i >= 1; i--) {
    const ymd = addDaysYmd(today, -i);
    if (!days.includes(weekdayOfYmd(ymd))) continue;
    const from = prev;
    prev = ymd;
    if (ymd <= created || i > lookbackDays) continue;
    const covered = active.some((d) => d <= ymd && (!from || d > from));
    if (!covered) out.push(ymd);
  }
  return out;
}

/**
 * Event-driven check-ins, created when their trigger holds (idempotent): missed session (next morning),
 * plan check (2 misses in a week), proof ready, behind or ahead of plan.
 */
export function ensureCheckins(ctx: LasContext, sk: string, now = new Date()): void {
  const st = loadSk(ctx, sk);
  const e = st.enrollment.id;
  if (st.enrollment.status !== "active" || !st.milestone) return;
  const tz = st.tz;
  const quietEnd = st.learner.quietHours.end;
  const all = ctx.store.listCheckins(e);
  const recent = (kind: string, days: number) => all.some((c) => c.kind === kind && daysBetween(c.dueAt, now) < days);
  for (const ymd of missedDays(ctx, st, now)) {
    if (all.some((c) => c.kind === "missed-session" && c.payload?.date === ymd)) continue;
    ctx.store.addCheckin({ enrollmentId: e, kind: "missed-session", dueAt: atLocal(addDaysYmd(ymd, 1), quietEnd, tz).toISOString(), payload: { date: ymd } });
    all.push({ id: "", enrollmentId: e, kind: "missed-session", dueAt: now.toISOString(), payload: { date: ymd } });
  }
  const weekAgo = addDaysYmd(zoned(now, tz).ymd, -7);
  const missedThisWeek = all.filter((c) => c.kind === "missed-session" && (c.payload?.date ?? "") > weekAgo).length;
  if (missedThisWeek >= 2 && !recent("plan-check", 7)) ctx.store.addCheckin({ enrollmentId: e, kind: "plan-check", dueAt: now.toISOString(), payload: { missed: missedThisWeek } });
  const r = readiness(ctx, st);
  if (r.ready && !all.some((c) => c.kind === "proof-ready" && (!c.answeredAt || daysBetween(c.answeredAt, now) < 3))) ctx.store.addCheckin({ enrollmentId: e, kind: "proof-ready", dueAt: now.toISOString(), payload: { milestoneId: st.milestone.id, title: st.milestone.title } });
  const v = velocity(ctx, st, now);
  if ((v.status === "behind" || v.status === "ahead") && !recent(v.status, 7)) ctx.store.addCheckin({ enrollmentId: e, kind: v.status, dueAt: now.toISOString(), payload: { projected: v.projectedDate, target: v.targetDate } });
}

/** The first check-in waiting for a decision, by priority (Today shows only this one). */
export function pendingCheckin(ctx: LasContext, sk: string, now = new Date()): Checkin | undefined {
  const st = loadSk(ctx, sk);
  return ctx.store
    .listCheckins(st.enrollment.id, { pending: true })
    .filter((c) => c.dueAt <= now.toISOString() && !(c.kind === "session-reminder" && daysBetween(c.dueAt, now) > 0.5))
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.dueAt.localeCompare(b.dueAt))[0];
}

function inQuietHours(now: Date, tz: string, q: { start: number; end: number }): boolean {
  const h = zoned(now, tz).hour;
  return q.start > q.end ? h >= q.start || h < q.end : h >= q.start && h < q.end;
}

export interface RunResult {
  due: CheckinView[];
  delivered: string[];
}

/**
 * What's due now: creates event-driven check-ins, tops up the schedule, then delivers within the limits
 * (quiet hours, nudges per day and week, paused skills get nothing). Delivery is pluggable: listeners on
 * the context get a "checkin.due" event and an optional `deliver` callback is called for each one sent.
 */
export async function runCheckins(ctx: LasContext, now = new Date(), opts: { deliver?: (c: CheckinView) => unknown | Promise<unknown> } = {}): Promise<RunResult> {
  const learner = ctx.store.getOrCreateLearner();
  const due: { c: Checkin; view: CheckinView }[] = [];
  for (const e of ctx.store.listEnrollments(learner.id)) {
    if (e.status !== "active") continue;
    ensureCheckins(ctx, e.id, now);
    scheduleCheckins(ctx, e.id, now);
    const st = loadSk(ctx, e.id);
    for (const c of ctx.store.listCheckins(e.id, { pending: true })) {
      if (c.dueAt > now.toISOString()) continue;
      // a reminder for a slot long gone is no use to anyone
      if (c.kind === "session-reminder" && daysBetween(c.dueAt, now) > 0.5) {
        ctx.store.updateCheckin(c.id, { answeredAt: now.toISOString(), answer: "expired" });
        continue;
      }
      due.push({ c, view: checkinView(ctx, c, st) });
    }
  }
  due.sort((a, b) => rank(a.c.kind) - rank(b.c.kind) || a.c.dueAt.localeCompare(b.c.dueAt));
  const delivered: string[] = [];
  const tz = (() => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: learner.timezone });
      return learner.timezone;
    } catch {
      return "UTC";
    }
  })();
  if (!inQuietHours(now, tz, learner.quietHours)) {
    const since = (ms: number) => (ctx.store.db.get("SELECT COUNT(*) AS n FROM checkin WHERE sent_at IS NOT NULL AND sent_at >= ?", new Date(now.getTime() - ms).toISOString())?.n as number) ?? 0;
    let budget = Math.min(learner.nudgeLimits.perDay - since(DAY_MS), learner.nudgeLimits.perWeek - since(7 * DAY_MS));
    for (const d of due) {
      if (budget <= 0) break;
      if (d.c.sentAt || IN_APP.has(d.c.kind)) continue;
      ctx.store.updateCheckin(d.c.id, { sentAt: now.toISOString() });
      delivered.push(d.c.id);
      budget--;
      ctx.emit("checkin.due", d.view);
      if (opts.deliver) await opts.deliver(d.view);
    }
  }
  return { due: due.map((d) => d.view), delivered };
}

// ---------------------------------------------------------------------------
// Answers

export interface CheckinAnswer {
  ok: true;
  kind: string;
  option: string;
  message: string;
  action?: "session" | "run_proof_check" | "weekly-review" | "revisit_why" | "talk" | "replan";
  sessionId?: string;
  milestoneId?: string;
  plan?: unknown;
}

/**
 * Applies the learner's one-tap answer (checkin.answered). Options may carry a value as `id:value`
 * (e.g. `change-days:0,2,4`). Every answer is logged as a plan change; nothing changes without one.
 */
export function answerCheckin(ctx: LasContext, checkinId: string, optionRaw: string, now = new Date()): CheckinAnswer {
  const c = ctx.store.getCheckin(checkinId);
  if (!c) throw new LoopError(`Unknown check-in "${checkinId}".`);
  const st = loadSk(ctx, c.enrollmentId);
  const sk = st.enrollment.id;
  const [option, ...rest] = optionRaw.split(":");
  const value = rest.length ? rest.join(":") : undefined;
  const allowed = describe(st, c).options.map((o) => o.id);
  if (!allowed.includes(option) && !["resume"].includes(option)) throw new LoopError(`"${option}" isn't an answer to this check-in. Options: ${allowed.join(", ")}.`);
  ctx.store.updateCheckin(c.id, { answeredAt: now.toISOString(), answer: optionRaw });
  ctx.store.logPlanChange(sk, `checkin:${c.kind}`, optionRaw);
  const out: CheckinAnswer = { ok: true, kind: c.kind, option, message: "" };
  const planned = () => ctx.store.listSessions(sk, 20).find((s) => s.status === "planned" && !s.startedAt);
  switch (option) {
    case "start": {
      const s = planned() ? planSession(ctx, sk, { now, sessionId: planned()!.id }) : planSession(ctx, sk, { now });
      Object.assign(out, { action: "session", sessionId: s.sessionId, message: s.title });
      break;
    }
    case "snooze":
      ctx.store.addCheckin({ enrollmentId: sk, kind: c.kind, dueAt: new Date(now.getTime() + 3600e3).toISOString(), payload: c.payload });
      out.message = "I'll check back in an hour.";
      break;
    case "quick": {
      const s = planSession(ctx, sk, { now, short: true, sessionId: planned()?.id, plannedAt: now.toISOString() });
      Object.assign(out, { action: "session", sessionId: s.sessionId, message: "A 5-minute session: recall and one drill." });
      break;
    }
    case "move": {
      const p = planned();
      const s = p ? (ctx.store.updateSession(p.id, { plannedAt: now.toISOString() }), planSession(ctx, sk, { now, sessionId: p.id })) : planSession(ctx, sk, { now, plannedAt: now.toISOString() });
      Object.assign(out, { action: "session", sessionId: s.sessionId, message: "Moved to today." });
      break;
    }
    case "skip":
      out.message = "Skipped. Nothing else changes.";
      break;
    case "open":
      Object.assign(out, { action: "weekly-review", message: "Weekly review: progress vs plan, the mix, the top mistake, next week." });
      break;
    case "later":
      out.message = "Later it is.";
      break;
    case "proof":
      Object.assign(out, { action: "run_proof_check", milestoneId: st.milestone?.id, message: "Proof check: one continuous take." });
      break;
    case "variation":
      loopSettings.setVariation(ctx, sk, true);
      refreshSchedule(ctx, sk, now);
      out.message = "Next session uses different drills for the same skills.";
      break;
    case "lighter":
      loopSettings.setLighter(ctx, sk, new Date(now.getTime() + 7 * DAY_MS).toISOString());
      refreshSchedule(ctx, sk, now);
      out.message = "A lighter week: shorter sessions, a level easier.";
      break;
    case "talk":
      Object.assign(out, { action: "talk", message: "Let's talk about what's getting in the way." });
      break;
    case "better":
      loopSettings.setPain(ctx, sk, null);
      out.message = "Good. Back to the normal plan, easing in.";
      break;
    case "same":
    case "worse": {
      const pain = loopSettings.pain(ctx, sk, now);
      const long = pain ? daysBetween(pain.firstAt, now) >= 7 : false;
      if (pain) loopSettings.setPain(ctx, sk, { ...pain, until: new Date(now.getTime() + 7 * DAY_MS).toISOString(), cap: Math.max(1, pain.cap - (option === "worse" ? 1 : 0)) });
      ctx.store.addCheckin({ enrollmentId: sk, kind: "pain-followup", dueAt: new Date(now.getTime() + 3 * DAY_MS).toISOString(), payload: c.payload });
      out.message = long || option === "worse" ? "Keep it light, and please see a professional: it has lasted a while." : "Keeping it light. If it lasts more than a week, see a professional.";
      break;
    }
    case "why":
      Object.assign(out, { action: "revisit_why", message: "Let's ask why again." });
      break;
    case "too-easy":
    case "too-hard":
      loopSettings.setDifficultyOffset(ctx, sk, loopSettings.difficultyOffset(ctx, sk) + (option === "too-easy" ? 1 : -1));
      refreshSchedule(ctx, sk, now);
      out.message = option === "too-easy" ? "Next session starts one level higher." : "Next session starts one level lower.";
      break;
    case "about-right":
    case "fine":
      out.message = "Next session keeps the same level.";
      break;
    case "sore":
      out.message = "Normal. Next session keeps the same load.";
      break;
    case "painful": {
      const area = (c.payload?.injury as string) ?? st.constraints.injuries[0] ?? "pain";
      reportPainState(ctx, sk, area, 3, now);
      out.message = `Next session is lighter on your ${lc1(area)}. If it still hurts in a week, see a professional.`;
      break;
    }
    case "pause":
    case "resume":
    case "stone":
    case "smaller":
    case "more-time":
    case "later-date":
    case "stretch":
    case "keep":
    case "change-days":
    case "change-minutes": {
      if ((option === "change-days" || option === "change-minutes") && value === undefined) {
        Object.assign(out, { action: "replan", message: option === "change-days" ? "Which days work? Use replan with change-days." : "How many minutes a week? Use replan with change-minutes." });
        break;
      }
      const r = replan(ctx, sk, option, value, now);
      Object.assign(out, { action: "replan", message: r.change, plan: r.plan });
      break;
    }
    default:
      out.message = "Noted.";
  }
  return out;
}

/**
 * Pain lowers intensity now (§7 "Pain reported"): drills above a lower cap are left out for 7 days, a
 * follow-up check-in comes in 2 days, and the learner is told to see a professional if it lasts more than a week.
 */
export function reportPainState(ctx: LasContext, sk: string, area: string, level: number, now = new Date()) {
  const st = loadSk(ctx, sk);
  const prev = loopSettings.pain(ctx, sk, now);
  const max = st.model.safety?.beginner_caps.max_intensity ?? 3;
  const cap = Math.max(1, max - 1 - (level >= 4 ? 1 : 0));
  loopSettings.setPain(ctx, sk, { area, level, firstAt: prev?.firstAt ?? now.toISOString(), at: now.toISOString(), cap, until: new Date(now.getTime() + 7 * DAY_MS).toISOString() });
  ctx.store.deletePendingCheckins(sk, "pain-followup");
  ctx.store.addCheckin({ enrollmentId: sk, kind: "pain-followup", dueAt: new Date(now.getTime() + 2 * DAY_MS).toISOString(), payload: { area, level } });
  const planned = ctx.store.listSessions(sk, 20).find((s) => s.status === "planned" && !s.startedAt);
  if (planned && st.milestone) planSession(ctx, sk, { now, sessionId: planned.id });
  const rule = st.model.injuries?.[area];
  return {
    cap,
    until: new Date(now.getTime() + 7 * DAY_MS).toISOString(),
    stopToday: level >= 4,
    rule,
    stop: st.model.safety?.stop_criteria ?? [],
    seeProfessional: st.model.safety?.see_professional ?? [],
    note: `${level >= 4 ? "Stop for today. " : ""}Intensity is lower for the next 7 days. If it lasts more than a week, see a professional.`
  };
}
