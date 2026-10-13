/**
 * Shared helpers for onboarding and the learning loop: loading an enrollment with its skill model,
 * ladder arithmetic, the skill graph, dates in the learner's time zone.
 * Nothing here knows any particular skill: every decision reads the skill model (data).
 */
import type { LadderStep, SkillModel, SkillNode, Drill, Mistake } from "@las/schema";
import type { Constraints, Enrollment, Intake, Intent, Learner, Milestone } from "@las/store";
import type { LasContext } from "../context.js";

/** A learner-facing error: tools turn it into an isError result, routes into a 400. */
export class LoopError extends Error {
  constructor(
    message: string,
    readonly data?: Record<string, unknown>
  ) {
    super(message);
    this.name = "LoopError";
  }
}

export const DAY_MS = 864e5;
export const WEEK_MS = 7 * DAY_MS;

export function must<T>(v: T | undefined | null, message: string): T {
  if (v === undefined || v === null) throw new LoopError(message);
  return v;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
export const round2 = (v: number): number => Math.round(v * 100) / 100;
/** Lower-case the first letter so a label can sit inside a sentence. */
export const lc1 = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s);
export const mean = (xs: number[]): number => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : 0);

// ---------------------------------------------------------------------------
// Ladder arithmetic (DESIGN §5.3, the prototype's hoursTo/weeksTo)

/** Mean of a step's hour range: the planner uses the middle of the estimate. */
export const meanHours = (s: LadderStep): number => (s.hours[0] + s.hours[1]) / 2;

/** Hours from the starting step to `to`: the mean hours of steps start+1..to. */
export function hoursTo(model: SkillModel, start: number, to: number): number {
  let h = 0;
  for (let i = start + 1; i <= to && i < model.ladder.length; i++) h += meanHours(model.ladder[i]);
  return h;
}

/** Weeks to reach `to` at the learner's pace: ceil(hours / hours per week), at least 1; 0 when already there. */
export function weeksTo(model: SkillModel, start: number, to: number, minutesPerWeek: number): number {
  if (to <= start) return 0;
  const perWeek = Math.max(0.25, minutesPerWeek / 60);
  return Math.max(1, Math.ceil(hoursTo(model, start, to) / perWeek));
}

// ---------------------------------------------------------------------------
// Skill graph

export function nodeMap(model: SkillModel): Map<string, SkillNode> {
  return new Map(model.nodes.map((n) => [n.id, n]));
}
export function drillMap(model: SkillModel): Map<string, Drill> {
  return new Map(model.drills.map((d) => [d.id, d]));
}
export function mistakeMap(model: SkillModel): Map<string, Mistake> {
  return new Map(model.mistakes.map((m) => [m.id, m]));
}

/** The ids plus every prerequisite they need, prerequisites first, in a stable order. */
export function prereqClosure(model: SkillModel, ids: Iterable<string>): string[] {
  const byId = nodeMap(model);
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id) || !byId.has(id)) return;
    seen.add(id);
    for (const r of byId.get(id)!.requires) visit(r);
    out.push(id);
  };
  for (const id of ids) visit(id);
  return out;
}

/** Nodes the learner already has at a ladder step: every node of steps 0..step and their prerequisites. */
export function nodesUpTo(model: SkillModel, step: number): string[] {
  return prereqClosure(model, model.ladder.slice(0, step + 1).flatMap((s) => s.nodes));
}

/**
 * The route to a milestone (learning loop §3): the nodes of ladder steps placement+1..target and their
 * prerequisite closure, minus what the placement already covers.
 */
export function pathNodes(model: SkillModel, placement: number, target: number): string[] {
  const have = new Set(nodesUpTo(model, placement));
  const wanted = prereqClosure(model, model.ladder.slice(placement + 1, target + 1).flatMap((s) => s.nodes));
  const out = wanted.filter((n) => !have.has(n));
  // a milestone at a step whose nodes were all covered still needs its own nodes checked
  return out.length ? out : prereqClosure(model, model.ladder[target]?.nodes ?? []);
}

/**
 * The practice-mix category a node counts toward: its own focus, else its first drill's, else the mix's
 * first category (decision: a model that doesn't tag nodes still gets its time counted somewhere).
 */
export function categoryOfNode(model: SkillModel, nodeId: string, fallback = ""): string {
  const n = model.nodes.find((x) => x.id === nodeId);
  if (!n) return fallback;
  return n.focus ?? n.drills.map((d) => model.drills.find((x) => x.id === d)?.focus).find((f): f is string => !!f) ?? fallback;
}

/** Drill types that are a real attempt (learning loop §3 step 5: Perform uses one of these and captures it). */
export const PERFORMANCE_DRILLS = new Set(["move", "play-along", "say-it", "build", "make", "timed-reps"]);

// ---------------------------------------------------------------------------
// Enrollment state

export interface SkState {
  enrollment: Enrollment;
  model: SkillModel;
  modelId: string;
  constraints: Constraints;
  intent?: Intent;
  milestone?: Milestone;
  /** the ladder step the learner stands on now */
  placement: number;
  intake?: Intake;
  learner: Learner;
  tz: string;
}

export function latestIntakeFor(ctx: LasContext, enrollmentId: string): Intake | undefined {
  const r = ctx.store.db.get("SELECT id FROM intake WHERE enrollment_id = ? AND placement IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1", enrollmentId);
  return r ? ctx.store.getIntake(r.id) : undefined;
}

/** Where the learner stands: the placement from onboarding, raised by every milestone they've passed. */
export function placementOf(ctx: LasContext, enrollmentId: string): number {
  const intake = latestIntakeFor(ctx, enrollmentId);
  let step = intake?.placement?.step ?? 0;
  for (const m of ctx.store.listMilestones(enrollmentId)) if (m.status === "done") step = Math.max(step, m.ladderStep);
  return step;
}

export function tzOf(learner: Learner): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: learner.timezone });
    return learner.timezone;
  } catch {
    return "UTC";
  }
}

export function defaultConstraints(enrollmentId: string, minutesPerWeek = 180): Constraints {
  return { enrollmentId, minutesPerWeek, access: [], injuries: [], schedule: { ...scheduleFor(minutesPerWeek), window: { start: 18, end: 21 } } };
}

export function loadSk(ctx: LasContext, sk: string): SkState {
  const enrollment = ctx.store.resolveEnrollment(sk);
  if (!enrollment) throw new LoopError(`Unknown skill "${sk}". Onboarding (start_intake, then set_milestone) creates one.`);
  const row = ctx.store.getSkillModel(enrollment.skillModelId);
  if (!row) throw new LoopError(`The skill model for "${sk}" is missing.`);
  const learner = ctx.store.getOrCreateLearner();
  return {
    enrollment,
    model: row.model,
    modelId: row.id,
    constraints: ctx.store.getConstraints(enrollment.id) ?? defaultConstraints(enrollment.id),
    intent: ctx.store.getIntent(enrollment.id),
    milestone: ctx.store.activeMilestone(enrollment.id),
    placement: placementOf(ctx, enrollment.id),
    intake: latestIntakeFor(ctx, enrollment.id),
    learner,
    tz: tzOf(learner)
  };
}

/** Find which enrollment's model has a drill (drill ids are unique inside one model). */
export function findByDrill(ctx: LasContext, drillId: string, sk?: string): SkState {
  if (sk) {
    const st = loadSk(ctx, sk);
    if (!st.model.drills.some((d) => d.id === drillId)) throw new LoopError(`"${st.model.name}" has no drill "${drillId}".`);
    return st;
  }
  for (const e of ctx.store.listEnrollments()) {
    if (e.status === "done") continue;
    const m = ctx.store.getSkillModel(e.skillModelId)?.model;
    if (m?.drills.some((d) => d.id === drillId)) return loadSk(ctx, e.id);
  }
  throw new LoopError(`No skill has a drill "${drillId}". Pass sk.`);
}

// ---------------------------------------------------------------------------
// Schedule (prototype `sessions()`): sessions per week from minutes per week, fixed days, minutes each rounded to 5

/** Days of the week as indexes, 0 = Monday. */
export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAYS_FOR: Record<number, number[]> = { 2: [1, 5], 3: [0, 2, 5], 4: [0, 1, 3, 5], 5: [0, 1, 3, 4, 6] };

/**
 * ≤60 min a week → 2 sessions, ≤150 → 3, ≤300 → 4, else 5. Minutes each = minutes / sessions rounded to 5.
 * Decision (design silent): a session is 10–60 minutes (learning loop §2), so minutes each are clamped to
 * that range; time above it is the learner's to spend outside the app (log_external counts it).
 */
export function scheduleFor(minutesPerWeek: number): { sessionsPerWeek: number; minutesEach: number; days: number[] } {
  const m = minutesPerWeek;
  const n = m <= 60 ? 2 : m <= 150 ? 3 : m <= 300 ? 4 : 5;
  return { sessionsPerWeek: n, minutesEach: clamp(Math.round(m / n / 5) * 5, 10, 60), days: DAYS_FOR[n] };
}

// ---------------------------------------------------------------------------
// Dates in the learner's time zone

export interface Zoned {
  ymd: string;
  hour: number;
  minute: number;
  /** 0 = Monday */
  weekday: number;
}

const WD: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export function zoned(date: Date, tz: string): Zoned {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { ymd: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24, minute: Number(get("minute")), weekday: WD[get("weekday")] ?? 0 };
}

/** The instant of `hour`:00 on a local calendar day. */
export function atLocal(ymd: string, hour: number, tz: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  const z = zoned(new Date(guess), tz);
  const [zy, zm, zd] = z.ymd.split("-").map(Number);
  const offset = Date.UTC(zy, zm - 1, zd, z.hour, z.minute) - guess;
  return new Date(guess - offset);
}

export function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekdayOfYmd(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export const addWeeks = (d: Date, w: number): Date => new Date(d.getTime() + w * WEEK_MS);
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
export const daysBetween = (a: Date | string, b: Date | string): number => (new Date(b).getTime() - new Date(a).getTime()) / DAY_MS;

/** Short, friendly date: "Nov 16". */
export function fmtDate(d: Date | string, tz = "UTC"): string {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
}
