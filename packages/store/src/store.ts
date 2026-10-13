import type { Analysis, SkillModel, Theme } from "@las/schema";
import { Db, json, newId, now, type Row } from "./db.js";

export interface Learner {
  id: string;
  name: string;
  timezone: string;
  quietHours: { start: number; end: number };
  nudgeLimits: { perDay: number; perWeek: number };
  createdAt: string;
}
export interface SkillModelRow {
  id: string;
  skill: string;
  source: string;
  basedOnPack?: string;
  packVersion?: string;
  version: number;
  model: SkillModel;
  validatedAt?: string;
  createdAt: string;
}
export interface Enrollment {
  id: string;
  learnerId: string;
  skillModelId: string;
  status: "active" | "paused" | "done";
  createdAt: string;
}
export interface ThemeRow {
  id: string;
  learnerId: string;
  name: string;
  sourceKind: string;
  theme: Theme;
  validatedAt?: string;
  createdAt: string;
}
export interface Intake {
  id: string;
  learnerId: string;
  skillModelId: string;
  answers: Record<string, any>;
  step: string;
  placement?: { step: number; evidence: string[]; raw: number; adjusted: number };
  enrollmentId?: string;
  createdAt: string;
  completedAt?: string;
}
export interface Intent {
  enrollmentId: string;
  why: string[];
  afterwards: string;
  revisitedAt?: string;
}
export interface Constraints {
  enrollmentId: string;
  minutesPerWeek: number;
  deadline?: string;
  access: string[];
  injuries: string[];
  schedule: { sessionsPerWeek: number; minutesEach: number; days: number[]; window?: { start: number; end: number } };
  location?: string;
}
export interface Milestone {
  id: string;
  enrollmentId: string;
  title: string;
  ladderStep: number;
  proof: any;
  targetDate?: string;
  status: "active" | "done" | "replaced";
  achievedAt?: string;
  selfReported: boolean;
  kind?: string;
  estimateWeeks?: number;
  feasibility?: string;
  createdAt: string;
}
export interface NodeMastery {
  enrollmentId: string;
  nodeId: string;
  pKnown: number;
  attempts: number;
  started: boolean;
  updatedAt: string;
}
export interface ReviewCard {
  id: string;
  enrollmentId: string;
  nodeId: string;
  fsrs: any;
  dueAt: string;
}
export interface SessionRow {
  id: string;
  enrollmentId: string;
  plannedAt?: string;
  startedAt?: string;
  endedAt?: string;
  plan: any;
  location?: string;
  minutes?: number;
  summary?: any;
  status: "planned" | "active" | "done" | "skipped";
}
export interface AttemptRow {
  id: string;
  sessionId?: string;
  enrollmentId: string;
  drillId?: string;
  milestoneId?: string;
  kind: string;
  engine: string;
  specId?: string;
  attemptNo: number;
  mediaRef?: string;
  analysis?: Analysis;
  spec?: any;
  prompt?: string;
  createdAt: string;
  analyzedAt?: string;
}
export interface MistakeState {
  enrollmentId: string;
  mistakeId: string;
  state: "detected" | "coached" | "improving" | "resolved" | "resurfaced" | "muted";
  lastSeenAt?: string;
  disputedCount: number;
  cleanStreak: number;
  seenCount: number;
}
export interface Checkin {
  id: string;
  enrollmentId: string;
  kind: string;
  dueAt: string;
  sentAt?: string;
  answeredAt?: string;
  answer?: string;
  payload: any;
}

export interface LiveSessionRow {
  /** = the session's id */
  id: string;
  enrollmentId: string;
  state: "idle" | "live" | "coach-away" | "paused" | "ended";
  /** the client's conversation id the watcher resumes */
  coachSessionId?: string;
  /** client id from the setup CLI's table (claude-code, codex, ...) */
  client?: string;
  /** the LAS server process that holds the coach */
  coachPid?: number;
  /** a token the holder's process keeps, so a second coach's calls can be told apart */
  coachToken?: string;
  lastWaitAt?: string;
  /** a coach_wait call is open right now */
  waitOpen: boolean;
  leftOnPurpose: boolean;
  studioSeenAt?: string;
  wakes: number;
  lastWakeAt?: string;
  /** the director's own state (current screen, step, overrides...) */
  data: Record<string, any>;
  startedAt: string;
  endedAt?: string;
}
export interface CoachEventRow {
  id: number;
  liveSessionId: string;
  type: string;
  payload: any;
  createdAt: string;
  deliveredAt?: string;
}
export interface CoachScreenRow {
  id: string;
  liveSessionId: string;
  kind: string;
  source: "coach" | "fallback";
  screen: any;
  queuedAt: string;
  shownAt?: string;
  answeredAt?: string;
}

const bool = (v: any) => v === 1 || v === true;

/** The one source of truth: everything the agent reads back comes from here. */
export class Store {
  readonly db: Db;
  constructor(path: string) {
    this.db = new Db(path);
  }
  close(): void {
    this.db.close();
  }

  // ---- learner ----
  getOrCreateLearner(): Learner {
    const row = this.db.get("SELECT * FROM learner ORDER BY created_at LIMIT 1");
    if (row) return this.learner(row);
    const id = newId("lrn");
    this.db.run("INSERT INTO learner (id, name, timezone, created_at) VALUES (?, ?, ?, ?)", id, "", Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC", now());
    return this.learner(this.db.get("SELECT * FROM learner WHERE id = ?", id)!);
  }
  updateLearner(patch: Partial<Pick<Learner, "name" | "timezone" | "quietHours" | "nudgeLimits">>): Learner {
    const l = this.getOrCreateLearner();
    this.db.run("UPDATE learner SET name = ?, timezone = ?, quiet_hours = ?, nudge_limits = ? WHERE id = ?", patch.name ?? l.name, patch.timezone ?? l.timezone, patch.quietHours ?? l.quietHours, patch.nudgeLimits ?? l.nudgeLimits, l.id);
    return this.getOrCreateLearner();
  }
  private learner(r: Row): Learner {
    return { id: r.id, name: r.name, timezone: r.timezone, quietHours: json(r.quiet_hours, { start: 22, end: 8 }), nudgeLimits: json(r.nudge_limits, { perDay: 1, perWeek: 4 }), createdAt: r.created_at };
  }

  // ---- skill models ----
  saveSkillModel(model: SkillModel, validated: boolean): SkillModelRow {
    const id = model.id ?? newId("skm");
    const existing = this.db.get("SELECT version FROM skill_model WHERE id = ?", id);
    const version = existing ? (existing.version as number) + 1 : model.version ?? 1;
    const stored = { ...model, id, version };
    if (existing) {
      this.db.run("UPDATE skill_model SET skill = ?, source = ?, based_on_pack = ?, pack_version = ?, version = ?, json = ?, validated_at = ? WHERE id = ?", model.skill, model.source, model.based_on_pack, model.pack_version, version, stored, validated ? now() : null, id);
    } else {
      this.db.run("INSERT INTO skill_model (id, skill, source, based_on_pack, pack_version, version, json, validated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, model.skill, model.source, model.based_on_pack, model.pack_version, version, stored, validated ? now() : null, now());
    }
    return this.getSkillModel(id)!;
  }
  getSkillModel(id: string): SkillModelRow | undefined {
    const r = this.db.get("SELECT * FROM skill_model WHERE id = ?", id);
    return r ? this.skillModel(r) : undefined;
  }
  findSkillModel(skill: string): SkillModelRow | undefined {
    const r = this.db.get("SELECT * FROM skill_model WHERE lower(skill) = lower(?) ORDER BY created_at DESC LIMIT 1", skill.trim());
    return r ? this.skillModel(r) : undefined;
  }
  listSkillModels(): SkillModelRow[] {
    return this.db.all("SELECT * FROM skill_model ORDER BY created_at DESC").map((r) => this.skillModel(r));
  }
  private skillModel(r: Row): SkillModelRow {
    return { id: r.id, skill: r.skill, source: r.source, basedOnPack: r.based_on_pack ?? undefined, packVersion: r.pack_version ?? undefined, version: r.version, model: json(r.json, {} as SkillModel), validatedAt: r.validated_at ?? undefined, createdAt: r.created_at };
  }

  // ---- enrollments ----
  createEnrollment(learnerId: string, skillModelId: string): Enrollment {
    const id = newId("sk");
    this.db.run("INSERT INTO enrollment (id, learner_id, skill_model_id, status, created_at) VALUES (?, ?, ?, 'active', ?)", id, learnerId, skillModelId, now());
    return this.getEnrollment(id)!;
  }
  getEnrollment(id: string): Enrollment | undefined {
    const r = this.db.get("SELECT * FROM enrollment WHERE id = ?", id);
    return r ? { id: r.id, learnerId: r.learner_id, skillModelId: r.skill_model_id, status: r.status, createdAt: r.created_at } : undefined;
  }
  listEnrollments(learnerId?: string): Enrollment[] {
    const rows = learnerId ? this.db.all("SELECT * FROM enrollment WHERE learner_id = ? ORDER BY created_at DESC", learnerId) : this.db.all("SELECT * FROM enrollment ORDER BY created_at DESC");
    return rows.map((r) => ({ id: r.id, learnerId: r.learner_id, skillModelId: r.skill_model_id, status: r.status, createdAt: r.created_at }));
  }
  setEnrollmentStatus(id: string, status: Enrollment["status"]): void {
    this.db.run("UPDATE enrollment SET status = ? WHERE id = ?", status, id);
  }
  /** Resolve `sk`: an enrollment id, a skill model id or a skill name. */
  resolveEnrollment(sk: string): Enrollment | undefined {
    const direct = this.getEnrollment(sk);
    if (direct) return direct;
    const byModel = this.db.get("SELECT * FROM enrollment WHERE skill_model_id = ? AND status != 'done' ORDER BY created_at DESC LIMIT 1", sk);
    if (byModel) return this.getEnrollment(byModel.id);
    const byName = this.db.get("SELECT e.* FROM enrollment e JOIN skill_model m ON m.id = e.skill_model_id WHERE lower(m.skill) = lower(?) OR lower(json_extract(m.json, '$.name')) = lower(?) ORDER BY e.created_at DESC LIMIT 1", sk.trim(), sk.trim());
    return byName ? this.getEnrollment(byName.id) : undefined;
  }

  // ---- themes ----
  saveTheme(learnerId: string, theme: Theme, validated: boolean): ThemeRow {
    const id = theme.id && theme.id !== "base" ? theme.id : newId("thm");
    const stored = { ...theme, id };
    const exists = this.db.get("SELECT 1 FROM theme WHERE id = ?", id);
    if (exists) this.db.run("UPDATE theme SET name = ?, source_kind = ?, json = ?, validated_at = ? WHERE id = ?", theme.name, theme.source.kind, stored, validated ? now() : null, id);
    else this.db.run("INSERT INTO theme (id, learner_id, name, source_kind, json, validated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, learnerId, theme.name, theme.source.kind, stored, validated ? now() : null, now());
    return this.getTheme(id)!;
  }
  getTheme(id: string): ThemeRow | undefined {
    const r = this.db.get("SELECT * FROM theme WHERE id = ?", id);
    return r ? { id: r.id, learnerId: r.learner_id, name: r.name, sourceKind: r.source_kind, theme: json(r.json, {} as Theme), validatedAt: r.validated_at ?? undefined, createdAt: r.created_at } : undefined;
  }
  listThemes(learnerId: string): ThemeRow[] {
    return this.db.all("SELECT * FROM theme WHERE learner_id = ? ORDER BY created_at DESC", learnerId).map((r) => this.getTheme(r.id)!);
  }
  setThemeScope(learnerId: string, themeId: string, enrollmentId: string | null): void {
    this.db.run("INSERT INTO theme_scope (learner_id, enrollment_id, theme_id) VALUES (?, ?, ?) ON CONFLICT(learner_id, enrollment_id) DO UPDATE SET theme_id = excluded.theme_id", learnerId, enrollmentId ?? "", themeId);
  }
  clearThemeScope(learnerId: string, enrollmentId: string | null): void {
    this.db.run("DELETE FROM theme_scope WHERE learner_id = ? AND enrollment_id = ?", learnerId, enrollmentId ?? "");
  }
  /** The active theme for a learner, honoring a per-skill scope first. */
  activeTheme(learnerId: string, enrollmentId?: string | null): ThemeRow | undefined {
    if (enrollmentId) {
      const s = this.db.get("SELECT theme_id FROM theme_scope WHERE learner_id = ? AND enrollment_id = ?", learnerId, enrollmentId);
      if (s) return this.getTheme(s.theme_id);
    }
    const all = this.db.get("SELECT theme_id FROM theme_scope WHERE learner_id = ? AND enrollment_id = ''", learnerId);
    return all ? this.getTheme(all.theme_id) : undefined;
  }

  // ---- intake ----
  createIntake(learnerId: string, skillModelId: string): Intake {
    const id = newId("int");
    this.db.run("INSERT INTO intake (id, learner_id, skill_model_id, answers, step, created_at) VALUES (?, ?, ?, '{}', 'why', ?)", id, learnerId, skillModelId, now());
    return this.getIntake(id)!;
  }
  getIntake(id: string): Intake | undefined {
    const r = this.db.get("SELECT * FROM intake WHERE id = ?", id);
    return r ? { id: r.id, learnerId: r.learner_id, skillModelId: r.skill_model_id, answers: json(r.answers, {}), step: r.step, placement: json(r.placement, undefined), enrollmentId: r.enrollment_id ?? undefined, createdAt: r.created_at, completedAt: r.completed_at ?? undefined } : undefined;
  }
  updateIntake(id: string, patch: Partial<Pick<Intake, "answers" | "step" | "placement" | "enrollmentId" | "completedAt">>): Intake {
    const i = this.getIntake(id);
    if (!i) throw new Error(`unknown intake ${id}`);
    this.db.run("UPDATE intake SET answers = ?, step = ?, placement = ?, enrollment_id = ?, completed_at = ? WHERE id = ?", patch.answers ?? i.answers, patch.step ?? i.step, patch.placement ?? i.placement ?? null, patch.enrollmentId ?? i.enrollmentId ?? null, patch.completedAt ?? i.completedAt ?? null, id);
    return this.getIntake(id)!;
  }

  // ---- intent and constraints ----
  setIntent(enrollmentId: string, why: string[], afterwards: string, revisited = false): void {
    this.db.run("INSERT INTO intent (enrollment_id, why, afterwards, revisited_at) VALUES (?, ?, ?, ?) ON CONFLICT(enrollment_id) DO UPDATE SET why = excluded.why, afterwards = excluded.afterwards, revisited_at = excluded.revisited_at", enrollmentId, why, afterwards, revisited ? now() : null);
  }
  getIntent(enrollmentId: string): Intent | undefined {
    const r = this.db.get("SELECT * FROM intent WHERE enrollment_id = ?", enrollmentId);
    return r ? { enrollmentId, why: json(r.why, []), afterwards: r.afterwards, revisitedAt: r.revisited_at ?? undefined } : undefined;
  }
  setConstraints(c: Constraints): void {
    this.db.run("INSERT INTO constraints (enrollment_id, minutes_per_week, deadline, access, injuries, schedule, location) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(enrollment_id) DO UPDATE SET minutes_per_week = excluded.minutes_per_week, deadline = excluded.deadline, access = excluded.access, injuries = excluded.injuries, schedule = excluded.schedule, location = excluded.location", c.enrollmentId, c.minutesPerWeek, c.deadline, c.access, c.injuries, c.schedule, c.location);
  }
  getConstraints(enrollmentId: string): Constraints | undefined {
    const r = this.db.get("SELECT * FROM constraints WHERE enrollment_id = ?", enrollmentId);
    return r ? { enrollmentId, minutesPerWeek: r.minutes_per_week, deadline: r.deadline ?? undefined, access: json(r.access, []), injuries: json(r.injuries, []), schedule: json(r.schedule, { sessionsPerWeek: 3, minutesEach: 30, days: [0, 2, 4] }), location: r.location ?? undefined } : undefined;
  }

  // ---- milestones ----
  addMilestone(m: Omit<Milestone, "id" | "createdAt" | "status" | "selfReported"> & { status?: Milestone["status"] }): Milestone {
    const id = newId("ms");
    this.db.run("UPDATE milestone SET status = 'replaced' WHERE enrollment_id = ? AND status = 'active'", m.enrollmentId);
    this.db.run("INSERT INTO milestone (id, enrollment_id, title, ladder_step, proof, target_date, status, kind, estimate_weeks, feasibility, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, m.enrollmentId, m.title, m.ladderStep, m.proof, m.targetDate, m.status ?? "active", m.kind, m.estimateWeeks, m.feasibility, now());
    return this.getMilestone(id)!;
  }
  getMilestone(id: string): Milestone | undefined {
    const r = this.db.get("SELECT * FROM milestone WHERE id = ?", id);
    return r ? this.milestone(r) : undefined;
  }
  activeMilestone(enrollmentId: string): Milestone | undefined {
    const r = this.db.get("SELECT * FROM milestone WHERE enrollment_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1", enrollmentId);
    return r ? this.milestone(r) : undefined;
  }
  listMilestones(enrollmentId: string): Milestone[] {
    return this.db.all("SELECT * FROM milestone WHERE enrollment_id = ? ORDER BY created_at", enrollmentId).map((r) => this.milestone(r));
  }
  updateMilestone(id: string, patch: Partial<Pick<Milestone, "targetDate" | "status" | "achievedAt" | "selfReported" | "estimateWeeks" | "feasibility">>): void {
    const m = this.getMilestone(id);
    if (!m) throw new Error(`unknown milestone ${id}`);
    this.db.run("UPDATE milestone SET target_date = ?, status = ?, achieved_at = ?, self_reported = ?, estimate_weeks = ?, feasibility = ? WHERE id = ?", patch.targetDate ?? m.targetDate, patch.status ?? m.status, patch.achievedAt ?? m.achievedAt, patch.selfReported ?? m.selfReported, patch.estimateWeeks ?? m.estimateWeeks, patch.feasibility ?? m.feasibility, id);
  }
  private milestone(r: Row): Milestone {
    return { id: r.id, enrollmentId: r.enrollment_id, title: r.title, ladderStep: r.ladder_step, proof: json(r.proof, {}), targetDate: r.target_date ?? undefined, status: r.status, achievedAt: r.achieved_at ?? undefined, selfReported: bool(r.self_reported), kind: r.kind ?? undefined, estimateWeeks: r.estimate_weeks ?? undefined, feasibility: r.feasibility ?? undefined, createdAt: r.created_at };
  }

  // ---- mastery ----
  getMastery(enrollmentId: string): Map<string, NodeMastery> {
    const out = new Map<string, NodeMastery>();
    for (const r of this.db.all("SELECT * FROM node_mastery WHERE enrollment_id = ?", enrollmentId)) out.set(r.node_id, { enrollmentId, nodeId: r.node_id, pKnown: r.p_known, attempts: r.attempts, started: bool(r.started), updatedAt: r.updated_at });
    return out;
  }
  setMastery(enrollmentId: string, nodeId: string, pKnown: number, attempts: number, started: boolean): void {
    this.db.run("INSERT INTO node_mastery (enrollment_id, node_id, p_known, attempts, started, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(enrollment_id, node_id) DO UPDATE SET p_known = excluded.p_known, attempts = excluded.attempts, started = excluded.started, updated_at = excluded.updated_at", enrollmentId, nodeId, pKnown, attempts, started, now());
  }

  // ---- reviews ----
  upsertReviewCard(c: Omit<ReviewCard, "id"> & { id?: string }): ReviewCard {
    const id = c.id ?? `${c.enrollmentId}:${c.nodeId}`;
    this.db.run("INSERT INTO review_card (id, enrollment_id, node_id, fsrs_state, due_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET fsrs_state = excluded.fsrs_state, due_at = excluded.due_at", id, c.enrollmentId, c.nodeId, c.fsrs, c.dueAt);
    return { ...c, id };
  }
  getReviewCard(id: string): ReviewCard | undefined {
    const r = this.db.get("SELECT * FROM review_card WHERE id = ?", id);
    return r ? { id: r.id, enrollmentId: r.enrollment_id, nodeId: r.node_id, fsrs: json(r.fsrs_state, {}), dueAt: r.due_at } : undefined;
  }
  dueReviews(enrollmentId: string, at = now(), limit = 50): ReviewCard[] {
    return this.db.all("SELECT * FROM review_card WHERE enrollment_id = ? AND due_at <= ? ORDER BY due_at LIMIT ?", enrollmentId, at, limit).map((r) => ({ id: r.id, enrollmentId: r.enrollment_id, nodeId: r.node_id, fsrs: json(r.fsrs_state, {}), dueAt: r.due_at }));
  }
  listReviewCards(enrollmentId: string): ReviewCard[] {
    return this.db.all("SELECT * FROM review_card WHERE enrollment_id = ? ORDER BY due_at", enrollmentId).map((r) => ({ id: r.id, enrollmentId: r.enrollment_id, nodeId: r.node_id, fsrs: json(r.fsrs_state, {}), dueAt: r.due_at }));
  }

  // ---- sessions ----
  createSession(s: Omit<SessionRow, "id" | "status"> & { status?: SessionRow["status"] }): SessionRow {
    const id = newId("ses");
    this.db.run("INSERT INTO session (id, enrollment_id, planned_at, started_at, ended_at, plan, location, minutes, summary, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, s.enrollmentId, s.plannedAt, s.startedAt, s.endedAt, s.plan, s.location, s.minutes, s.summary, s.status ?? "planned");
    return this.getSession(id)!;
  }
  getSession(id: string): SessionRow | undefined {
    const r = this.db.get("SELECT * FROM session WHERE id = ?", id);
    return r ? this.session(r) : undefined;
  }
  updateSession(id: string, patch: Partial<SessionRow>): SessionRow {
    const s = this.getSession(id);
    if (!s) throw new Error(`unknown session ${id}`);
    const n = { ...s, ...patch };
    this.db.run("UPDATE session SET planned_at = ?, started_at = ?, ended_at = ?, plan = ?, location = ?, minutes = ?, summary = ?, status = ? WHERE id = ?", n.plannedAt, n.startedAt, n.endedAt, n.plan, n.location, n.minutes, n.summary, n.status, id);
    return this.getSession(id)!;
  }
  listSessions(enrollmentId: string, limit = 100): SessionRow[] {
    return this.db.all("SELECT * FROM session WHERE enrollment_id = ? ORDER BY COALESCE(planned_at, started_at) DESC LIMIT ?", enrollmentId, limit).map((r) => this.session(r));
  }
  private session(r: Row): SessionRow {
    return { id: r.id, enrollmentId: r.enrollment_id, plannedAt: r.planned_at ?? undefined, startedAt: r.started_at ?? undefined, endedAt: r.ended_at ?? undefined, plan: json(r.plan, {}), location: r.location ?? undefined, minutes: r.minutes ?? undefined, summary: json(r.summary, undefined), status: r.status };
  }
  logPlanner(sessionId: string, entry: unknown): void {
    this.db.run("INSERT INTO planner_log (session_id, json, created_at) VALUES (?, ?, ?)", sessionId, entry, now());
  }

  // ---- attempts ----
  createAttempt(a: Omit<AttemptRow, "id" | "createdAt">): AttemptRow {
    const id = newId("att");
    this.db.run("INSERT INTO attempt (id, session_id, enrollment_id, drill_id, milestone_id, kind, engine, spec_id, attempt_no, media_ref, analysis, spec, prompt, created_at, analyzed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, a.sessionId, a.enrollmentId, a.drillId, a.milestoneId, a.kind, a.engine, a.specId, a.attemptNo, a.mediaRef, a.analysis, a.spec, a.prompt, now(), a.analyzedAt);
    return this.getAttempt(id)!;
  }
  getAttempt(id: string): AttemptRow | undefined {
    const r = this.db.get("SELECT * FROM attempt WHERE id = ?", id);
    return r ? this.attempt(r) : undefined;
  }
  setAttemptAnalysis(id: string, analysis: Analysis, mediaRef?: string): void {
    this.db.run("UPDATE attempt SET analysis = ?, analyzed_at = ?, media_ref = COALESCE(?, media_ref) WHERE id = ?", analysis, now(), mediaRef, id);
  }
  setAttemptMedia(id: string, mediaRef: string): void {
    this.db.run("UPDATE attempt SET media_ref = ? WHERE id = ?", mediaRef, id);
  }
  listAttempts(enrollmentId: string, opts: { drillId?: string; kind?: string; limit?: number; analyzed?: boolean } = {}): AttemptRow[] {
    const where = ["enrollment_id = ?"];
    const params: any[] = [enrollmentId];
    if (opts.drillId) {
      where.push("drill_id = ?");
      params.push(opts.drillId);
    }
    if (opts.kind) {
      where.push("kind = ?");
      params.push(opts.kind);
    }
    if (opts.analyzed) where.push("analysis IS NOT NULL");
    params.push(opts.limit ?? 50);
    return this.db.all(`SELECT * FROM attempt WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`, ...params).map((r) => this.attempt(r));
  }
  private attempt(r: Row): AttemptRow {
    return { id: r.id, sessionId: r.session_id ?? undefined, enrollmentId: r.enrollment_id, drillId: r.drill_id ?? undefined, milestoneId: r.milestone_id ?? undefined, kind: r.kind, engine: r.engine, specId: r.spec_id ?? undefined, attemptNo: r.attempt_no, mediaRef: r.media_ref ?? undefined, analysis: json(r.analysis, undefined), spec: json(r.spec, undefined), prompt: r.prompt ?? undefined, createdAt: r.created_at, analyzedAt: r.analyzed_at ?? undefined };
  }
  recordMetric(enrollmentId: string, metricId: string, value: number, attemptId?: string): void {
    this.db.run("INSERT INTO metric_history (enrollment_id, metric_id, value, attempt_id, created_at) VALUES (?, ?, ?, ?, ?)", enrollmentId, metricId, value, attemptId, now());
  }
  metricHistory(enrollmentId: string, metricId: string, limit = 50): { value: number; attemptId?: string; at: string }[] {
    return this.db.all("SELECT value, attempt_id, created_at FROM metric_history WHERE enrollment_id = ? AND metric_id = ? ORDER BY created_at DESC LIMIT ?", enrollmentId, metricId, limit).map((r) => ({ value: r.value, attemptId: r.attempt_id ?? undefined, at: r.created_at })).reverse();
  }

  // ---- mistakes ----
  getMistakeStates(enrollmentId: string): Map<string, MistakeState> {
    const out = new Map<string, MistakeState>();
    for (const r of this.db.all("SELECT * FROM mistake_state WHERE enrollment_id = ?", enrollmentId)) out.set(r.mistake_id, { enrollmentId, mistakeId: r.mistake_id, state: r.state, lastSeenAt: r.last_seen_at ?? undefined, disputedCount: r.disputed_count, cleanStreak: r.clean_streak, seenCount: r.seen_count });
    return out;
  }
  setMistakeState(s: MistakeState): void {
    this.db.run("INSERT INTO mistake_state (enrollment_id, mistake_id, state, last_seen_at, disputed_count, clean_streak, seen_count) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(enrollment_id, mistake_id) DO UPDATE SET state = excluded.state, last_seen_at = excluded.last_seen_at, disputed_count = excluded.disputed_count, clean_streak = excluded.clean_streak, seen_count = excluded.seen_count", s.enrollmentId, s.mistakeId, s.state, s.lastSeenAt, s.disputedCount, s.cleanStreak, s.seenCount);
  }
  addDispute(enrollmentId: string, attemptId: string, mistakeId: string, metrics: unknown, consent: boolean): void {
    this.db.run("INSERT INTO dispute (id, enrollment_id, attempt_id, mistake_id, metrics, consent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", newId("dsp"), enrollmentId, attemptId, mistakeId, metrics, consent, now());
  }
  listDisputes(enrollmentId: string): { attemptId: string; mistakeId: string; metrics: any; consent: boolean; at: string }[] {
    return this.db.all("SELECT * FROM dispute WHERE enrollment_id = ? ORDER BY created_at", enrollmentId).map((r) => ({ attemptId: r.attempt_id, mistakeId: r.mistake_id, metrics: json(r.metrics, {}), consent: bool(r.consent), at: r.created_at }));
  }

  // ---- check-ins and plan changes ----
  addCheckin(c: Omit<Checkin, "id">): Checkin {
    const id = newId("chk");
    this.db.run("INSERT INTO checkin (id, enrollment_id, kind, due_at, sent_at, answered_at, answer, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, c.enrollmentId, c.kind, c.dueAt, c.sentAt, c.answeredAt, c.answer, c.payload ?? {});
    return { ...c, id };
  }
  getCheckin(id: string): Checkin | undefined {
    const r = this.db.get("SELECT * FROM checkin WHERE id = ?", id);
    return r ? this.checkin(r) : undefined;
  }
  listCheckins(enrollmentId: string, opts: { pending?: boolean } = {}): Checkin[] {
    const rows = opts.pending ? this.db.all("SELECT * FROM checkin WHERE enrollment_id = ? AND answered_at IS NULL ORDER BY due_at", enrollmentId) : this.db.all("SELECT * FROM checkin WHERE enrollment_id = ? ORDER BY due_at DESC LIMIT 100", enrollmentId);
    return rows.map((r) => this.checkin(r));
  }
  pendingCheckinsAll(): Checkin[] {
    return this.db.all("SELECT * FROM checkin WHERE answered_at IS NULL ORDER BY due_at").map((r) => this.checkin(r));
  }
  updateCheckin(id: string, patch: Partial<Pick<Checkin, "sentAt" | "answeredAt" | "answer" | "payload" | "dueAt">>): void {
    const c = this.getCheckin(id);
    if (!c) throw new Error(`unknown check-in ${id}`);
    this.db.run("UPDATE checkin SET due_at = ?, sent_at = ?, answered_at = ?, answer = ?, payload = ? WHERE id = ?", patch.dueAt ?? c.dueAt, patch.sentAt ?? c.sentAt, patch.answeredAt ?? c.answeredAt, patch.answer ?? c.answer, patch.payload ?? c.payload, id);
  }
  deletePendingCheckins(enrollmentId: string, kind?: string): void {
    if (kind) this.db.run("DELETE FROM checkin WHERE enrollment_id = ? AND kind = ? AND answered_at IS NULL", enrollmentId, kind);
    else this.db.run("DELETE FROM checkin WHERE enrollment_id = ? AND answered_at IS NULL", enrollmentId);
  }
  private checkin(r: Row): Checkin {
    return { id: r.id, enrollmentId: r.enrollment_id, kind: r.kind, dueAt: r.due_at, sentAt: r.sent_at ?? undefined, answeredAt: r.answered_at ?? undefined, answer: r.answer ?? undefined, payload: json(r.payload, {}) };
  }
  logPlanChange(enrollmentId: string, reason: string, option: string): void {
    this.db.run("INSERT INTO plan_change (id, enrollment_id, reason, option, created_at) VALUES (?, ?, ?, ?, ?)", newId("pc"), enrollmentId, reason, option, now());
  }
  listPlanChanges(enrollmentId: string): { reason: string; option: string; at: string }[] {
    return this.db.all("SELECT * FROM plan_change WHERE enrollment_id = ? ORDER BY created_at", enrollmentId).map((r) => ({ reason: r.reason, option: r.option, at: r.created_at }));
  }

  // ---- events, time, settings ----
  logEvent(enrollmentId: string | null, type: string, payload: unknown): void {
    this.db.run("INSERT INTO event (enrollment_id, type, json, created_at) VALUES (?, ?, ?, ?)", enrollmentId, type, payload, now());
  }
  listEvents(enrollmentId: string, limit = 200): { type: string; payload: any; at: string }[] {
    return this.db.all("SELECT * FROM event WHERE enrollment_id = ? ORDER BY id DESC LIMIT ?", enrollmentId, limit).map((r) => ({ type: r.type, payload: json(r.json, {}), at: r.created_at })).reverse();
  }
  logTime(enrollmentId: string, minutes: number, source: string, category?: string, note?: string): void {
    this.db.run("INSERT INTO time_log (enrollment_id, minutes, category, source, note, created_at) VALUES (?, ?, ?, ?, ?, ?)", enrollmentId, minutes, category, source, note, now());
  }
  timeSince(enrollmentId: string, sinceIso: string): { minutes: number; byCategory: Record<string, number> } {
    const rows = this.db.all("SELECT minutes, category FROM time_log WHERE enrollment_id = ? AND created_at >= ?", enrollmentId, sinceIso);
    const byCategory: Record<string, number> = {};
    let minutes = 0;
    for (const r of rows) {
      minutes += r.minutes;
      if (r.category) byCategory[r.category] = (byCategory[r.category] ?? 0) + r.minutes;
    }
    return { minutes, byCategory };
  }
  getSetting<T = string>(key: string, fallback: T): T {
    const r = this.db.get("SELECT value FROM setting WHERE key = ?", key);
    return r ? json(r.value, fallback) : fallback;
  }
  setSetting(key: string, value: unknown): void {
    this.db.run("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }

  // ---- pairing and push ----
  createPairingToken(ttlMs = 10 * 60 * 1000): string {
    const token = newId("pair");
    this.db.run("INSERT INTO pairing (token, created_at, expires_at) VALUES (?, ?, ?)", token, now(), new Date(Date.now() + ttlMs).toISOString());
    return token;
  }
  consumePairingToken(token: string, device: string): boolean {
    const r = this.db.get("SELECT * FROM pairing WHERE token = ?", token);
    if (!r || r.used_at || r.expires_at < now()) return false;
    this.db.run("UPDATE pairing SET used_at = ?, device = ? WHERE token = ?", now(), device, token);
    return true;
  }
  addPushSubscription(learnerId: string, sub: unknown): string {
    const id = newId("push");
    this.db.run("INSERT INTO push_subscription (id, learner_id, json, created_at) VALUES (?, ?, ?, ?)", id, learnerId, sub, now());
    return id;
  }
  listPushSubscriptions(learnerId: string): { id: string; subscription: any }[] {
    return this.db.all("SELECT * FROM push_subscription WHERE learner_id = ?", learnerId).map((r) => ({ id: r.id, subscription: json(r.json, {}) }));
  }
  removePushSubscription(id: string): void {
    this.db.run("DELETE FROM push_subscription WHERE id = ?", id);
  }

  // ---- proofs ----
  addProof(enrollmentId: string, milestoneId: string, attemptId: string | undefined, result: unknown, clipRef?: string): string {
    const id = newId("prf");
    this.db.run("INSERT INTO proof (id, enrollment_id, milestone_id, attempt_id, result, clip_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, enrollmentId, milestoneId, attemptId, result, clipRef, now());
    return id;
  }
  listProofs(enrollmentId: string): { id: string; milestoneId: string; attemptId?: string; result: any; clipRef?: string; at: string }[] {
    return this.db.all("SELECT * FROM proof WHERE enrollment_id = ? ORDER BY created_at", enrollmentId).map((r) => ({ id: r.id, milestoneId: r.milestone_id, attemptId: r.attempt_id ?? undefined, result: json(r.result, {}), clipRef: r.clip_ref ?? undefined, at: r.created_at }));
  }

  // ---- live coach (docs/design/live-coach.md §8) ----
  createLiveSession(s: { id: string; enrollmentId: string; state?: LiveSessionRow["state"]; coachSessionId?: string; client?: string; coachPid?: number; coachToken?: string; data?: Record<string, any> }): LiveSessionRow {
    this.db.run("INSERT INTO live_session (id, enrollment_id, state, coach_session_id, client, coach_pid, coach_token, json, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", s.id, s.enrollmentId, s.state ?? "idle", s.coachSessionId, s.client, s.coachPid, s.coachToken, s.data ?? {}, now());
    return this.getLiveSession(s.id)!;
  }
  getLiveSession(id: string): LiveSessionRow | undefined {
    const r = this.db.get("SELECT * FROM live_session WHERE id = ?", id);
    return r ? this.liveSession(r) : undefined;
  }
  /** the enrollment's live session that hasn't ended, newest first */
  openLiveSession(enrollmentId: string): LiveSessionRow | undefined {
    const r = this.db.get("SELECT * FROM live_session WHERE enrollment_id = ? AND state != 'ended' ORDER BY started_at DESC LIMIT 1", enrollmentId);
    return r ? this.liveSession(r) : undefined;
  }
  listLiveSessions(opts: { states?: LiveSessionRow["state"][]; enrollmentId?: string; limit?: number } = {}): LiveSessionRow[] {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.states?.length) {
      where.push(`state IN (${opts.states.map(() => "?").join(",")})`);
      params.push(...opts.states);
    }
    if (opts.enrollmentId) {
      where.push("enrollment_id = ?");
      params.push(opts.enrollmentId);
    }
    return this.db.all(`SELECT * FROM live_session ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY started_at DESC LIMIT ?`, ...params, opts.limit ?? 100).map((r) => this.liveSession(r));
  }
  updateLiveSession(id: string, patch: Partial<Omit<LiveSessionRow, "id" | "enrollmentId" | "startedAt">>): LiveSessionRow {
    const s = this.getLiveSession(id);
    if (!s) throw new Error(`unknown live session ${id}`);
    const n = { ...s, ...patch };
    this.db.run(
      "UPDATE live_session SET state = ?, coach_session_id = ?, client = ?, coach_pid = ?, coach_token = ?, last_wait_at = ?, wait_open = ?, left_on_purpose = ?, studio_seen_at = ?, wakes = ?, last_wake_at = ?, json = ?, ended_at = ? WHERE id = ?",
      n.state, n.coachSessionId, n.client, n.coachPid, n.coachToken, n.lastWaitAt, n.waitOpen, n.leftOnPurpose, n.studioSeenAt, n.wakes, n.lastWakeAt, n.data, n.endedAt, id
    );
    return this.getLiveSession(id)!;
  }
  private liveSession(r: Row): LiveSessionRow {
    return { id: r.id, enrollmentId: r.enrollment_id, state: r.state, coachSessionId: r.coach_session_id ?? undefined, client: r.client ?? undefined, coachPid: r.coach_pid ?? undefined, coachToken: r.coach_token ?? undefined, lastWaitAt: r.last_wait_at ?? undefined, waitOpen: bool(r.wait_open), leftOnPurpose: bool(r.left_on_purpose), studioSeenAt: r.studio_seen_at ?? undefined, wakes: r.wakes ?? 0, lastWakeAt: r.last_wake_at ?? undefined, data: json(r.json, {}), startedAt: r.started_at, endedAt: r.ended_at ?? undefined };
  }

  /** queues an event for the coach; returns its id (ids rise in order) */
  queueCoachEvent(liveSessionId: string, type: string, payload: unknown): number {
    this.db.run("INSERT INTO coach_event (live_session_id, type, json, created_at) VALUES (?, ?, ?, ?)", liveSessionId, type, payload, now());
    return (this.db.get("SELECT last_insert_rowid() AS id") as Row).id as number;
  }
  /** undelivered events in id order; `afterId` narrows to newer ones */
  pendingCoachEvents(liveSessionId: string, afterId = 0, limit = 200): CoachEventRow[] {
    return this.db.all("SELECT * FROM coach_event WHERE live_session_id = ? AND delivered_at IS NULL AND id > ? ORDER BY id LIMIT ?", liveSessionId, afterId, limit).map((r) => this.coachEvent(r));
  }
  countPendingCoachEvents(liveSessionId: string, types?: string[]): number {
    const t = types?.length ? ` AND type IN (${types.map(() => "?").join(",")})` : "";
    return (this.db.get(`SELECT COUNT(*) AS n FROM coach_event WHERE live_session_id = ? AND delivered_at IS NULL${t}`, liveSessionId, ...(types ?? [])) as Row).n as number;
  }
  markCoachEventsDelivered(ids: number[], at = now()): void {
    if (!ids.length) return;
    this.db.run(`UPDATE coach_event SET delivered_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`, at, ...ids);
  }
  listCoachEvents(liveSessionId: string, limit = 500): CoachEventRow[] {
    return this.db.all("SELECT * FROM coach_event WHERE live_session_id = ? ORDER BY id LIMIT ?", liveSessionId, limit).map((r) => this.coachEvent(r));
  }
  private coachEvent(r: Row): CoachEventRow {
    return { id: r.id, liveSessionId: r.live_session_id, type: r.type, payload: json(r.json, {}), createdAt: r.created_at, deliveredAt: r.delivered_at ?? undefined };
  }

  addCoachScreen(s: { id?: string; liveSessionId: string; kind: string; source: "coach" | "fallback"; screen: unknown; shownAt?: string }): CoachScreenRow {
    const id = s.id ?? newId("scr");
    this.db.run("INSERT INTO coach_screen (id, live_session_id, kind, source, json, queued_at, shown_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, s.liveSessionId, s.kind, s.source, s.screen, now(), s.shownAt);
    return this.getCoachScreen(id)!;
  }
  getCoachScreen(id: string): CoachScreenRow | undefined {
    const r = this.db.get("SELECT * FROM coach_screen WHERE id = ?", id);
    return r ? this.coachScreen(r) : undefined;
  }
  updateCoachScreen(id: string, patch: Partial<Pick<CoachScreenRow, "screen" | "shownAt" | "answeredAt" | "source">>): void {
    const s = this.getCoachScreen(id);
    if (!s) throw new Error(`unknown coach screen ${id}`);
    const n = { ...s, ...patch };
    this.db.run("UPDATE coach_screen SET json = ?, source = ?, shown_at = ?, answered_at = ? WHERE id = ?", n.screen, n.source, n.shownAt, n.answeredAt, id);
  }
  deleteCoachScreen(id: string): void {
    this.db.run("DELETE FROM coach_screen WHERE id = ?", id);
  }
  listCoachScreens(liveSessionId: string, limit = 500): CoachScreenRow[] {
    return this.db.all("SELECT * FROM coach_screen WHERE live_session_id = ? ORDER BY queued_at, rowid LIMIT ?", liveSessionId, limit).map((r) => this.coachScreen(r));
  }
  private coachScreen(r: Row): CoachScreenRow {
    return { id: r.id, liveSessionId: r.live_session_id, kind: r.kind, source: r.source, screen: json(r.json, {}), queuedAt: r.queued_at, shownAt: r.shown_at ?? undefined, answeredAt: r.answered_at ?? undefined };
  }

  // ---- export and delete ----
  exportAll(scope: { enrollmentId?: string } = {}): Record<string, Row[]> {
    const tables = ["learner", "skill_model", "enrollment", "theme", "theme_scope", "intake", "intent", "constraints", "milestone", "node_mastery", "review_card", "session", "attempt", "mistake_state", "checkin", "plan_change", "event", "time_log", "dispute", "proof", "metric_history", "live_session", "coach_event", "coach_screen", "setting"];
    const out: Record<string, Row[]> = {};
    for (const t of tables) {
      const hasEnrollment = ["intent", "constraints", "milestone", "node_mastery", "review_card", "session", "attempt", "mistake_state", "checkin", "plan_change", "event", "time_log", "dispute", "proof", "metric_history"].includes(t);
      if (scope.enrollmentId && (t === "coach_event" || t === "coach_screen")) out[t] = this.db.all(`SELECT * FROM ${t} WHERE live_session_id IN (SELECT id FROM live_session WHERE enrollment_id = ?)`, scope.enrollmentId);
      else out[t] = scope.enrollmentId && (hasEnrollment || t === "live_session") ? this.db.all(`SELECT * FROM ${t} WHERE enrollment_id = ?`, scope.enrollmentId) : this.db.all(`SELECT * FROM ${t}`);
    }
    return out;
  }
  deleteEnrollment(enrollmentId: string): string[] {
    const media = this.db.all("SELECT media_ref FROM attempt WHERE enrollment_id = ? AND media_ref IS NOT NULL", enrollmentId).map((r) => r.media_ref as string);
    this.db.transaction(() => {
      for (const t of ["coach_event", "coach_screen"]) this.db.run(`DELETE FROM ${t} WHERE live_session_id IN (SELECT id FROM live_session WHERE enrollment_id = ?)`, enrollmentId);
      for (const t of ["intent", "constraints", "milestone", "node_mastery", "review_card", "session", "attempt", "mistake_state", "checkin", "plan_change", "event", "time_log", "dispute", "proof", "metric_history", "live_session"]) this.db.run(`DELETE FROM ${t} WHERE enrollment_id = ?`, enrollmentId);
      this.db.run("DELETE FROM theme_scope WHERE enrollment_id = ?", enrollmentId);
      this.db.run("DELETE FROM intake WHERE enrollment_id = ?", enrollmentId);
      this.db.run("DELETE FROM enrollment WHERE id = ?", enrollmentId);
    });
    return media;
  }
  deleteEverything(): string[] {
    const media = this.db.all("SELECT media_ref FROM attempt WHERE media_ref IS NOT NULL").map((r) => r.media_ref as string);
    this.db.transaction(() => {
      for (const t of ["intent", "constraints", "milestone", "node_mastery", "review_card", "session", "attempt", "mistake_state", "checkin", "plan_change", "event", "time_log", "dispute", "proof", "metric_history", "coach_event", "coach_screen", "live_session", "theme_scope", "intake", "enrollment", "theme", "skill_model", "push_subscription", "pairing", "setting", "planner_log", "learner"]) this.db.run(`DELETE FROM ${t}`);
    });
    return media;
  }
}
