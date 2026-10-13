/** View models the server returns and the UI renders. Shared so both sides agree. */
import type { Card } from "./lesson.js";
import type { Drill } from "./drill.js";
import type { Analysis, EvidenceRef } from "./analysis.js";
import type { Figure } from "./lesson.js";
import type { EngineId } from "./engines.js";

export interface RibbonItem {
  id: string;
  label: string;
  icon?: string;
}

export interface OptionView {
  value: string | number;
  label: string;
  detail?: string;
  badge?: string;
  icon?: string;
  figure?: Figure;
}

export type IntakeStep = "look" | "skill" | "why" | "picture" | "probe" | "place" | "time" | "around" | "milestone" | "plan";

export interface IntakeView {
  intakeId: string;
  step: IntakeStep;
  stepIndex: number;
  sections: string[];
  sectionIndex: number;
  ribbon: RibbonItem[];
  question: string;
  sub?: string;
  answerType: "single" | "multi" | "scale" | "visual-multi" | "quiz" | "tap" | "record" | "code" | "slider" | "none" | "text";
  options?: OptionView[];
  max?: number;
  field?: string;
  /** current answer(s) */
  value?: unknown;
  cta: { label: string; enabled: boolean; secondary?: string };
  /** step-specific payload (placement rows, plan summary, probe spec...) */
  payload?: Record<string, unknown>;
  done?: boolean;
  sk?: string;
}

export interface PlacementView {
  step: number;
  evidence: string[];
  rows: { step: number; label: string; state: "done" | "here" | "ahead"; weeks?: number }[];
  canLower: boolean;
  canRaise: boolean;
}

export interface MilestoneSuggestion {
  kind: "quick" | "picture" | "stretch" | "stone" | "custom" | "ladder";
  kindLabel: string;
  step: number;
  title: string;
  proof: string;
  engine: EngineId;
  weeks: number;
  feasibility: { kind: "good" | "warn"; label: string; message?: string; stoneStep?: number };
}

export interface PlanView {
  sk: string;
  skill: string;
  milestone: { title: string; proof: string; engine: EngineId; targetDate: string; weeks: number; hoursPerWeek: number; feasibility: string };
  route: RouteView;
  why: string[];
  picture: string;
  mix: { category: string; share: number }[];
  mixReasons: string[];
  schedule: { sessionsPerWeek: number; minutesEach: number; days: number[] };
  checkins: string[];
  injuryRules: { injury: string; rule: string }[];
  safety?: { supervisedOnly: string[]; stop: string[] };
  profile: Record<string, unknown>;
}

export interface RouteView {
  start: number;
  target?: number;
  steps: { step: number; label: string; hours: [number, number]; weeks?: number; state: "done" | "here" | "ahead"; target: boolean; nodes: { id: string; name: string; mastery: number }[] }[];
}

export interface TodayView {
  sk: string;
  skill: string;
  state: "first-day" | "normal" | "missed" | "behind" | "proof-ready" | "milestone-done" | "paused";
  nextSession?: { id?: string; title: string; minutes: number; focus: string; reason: string };
  reviewsDue: { count: number; minutes: number };
  milestone?: { title: string; percent: number; proofDate?: string; step: number };
  checkin?: { id: string; kind: string; question: string; options: { id: string; label: string }[] };
  week: { day: number; state: "done" | "missed" | "plan" | "none"; today: boolean }[];
  weeklyReview?: string;
  message?: string;
  route: RouteView;
}

export type BlockKind = "warmup" | "recall" | "learn" | "practice" | "perform" | "wrapup";

export interface SessionBlock {
  kind: BlockKind;
  minutes: number;
  reason: string;
  title: string;
  /** what the block holds */
  items: SessionItem[];
  /** a learn block whose lesson has no cards yet (fallback content, live coach §9): what a live coach is advised to teach */
  lesson?: { lessonId: string; title: string; nodes: string[] };
}

export type SessionItem =
  | { type: "warmup"; steps: string[] }
  | { type: "review"; cardIds: string[]; count: number }
  | { type: "lesson"; lessonId: string; title: string; cards: Card[]; nodes: string[] }
  | { type: "drill"; drill: Drill; difficulty: number; label: string }
  | { type: "capture"; attemptSpecId: string; engine: EngineId; specId: string; prompt: string; how?: string; drillId?: string; kind: "perform" | "proof" | "rehearsal"; angle?: string; durationS?: number }
  /** `summary` is set on a live wrap-up screen (the coach's praise and one fix over the server's summary) */
  | { type: "wrapup"; summary?: SummaryView }
  /** a live feedback screen (docs/design/live-coach.md §7) */
  | { type: "feedback"; view: FeedbackView }
  /** the learner paused a live session */
  | { type: "pause"; pausedAt: string };

export interface SessionPlan {
  sessionId: string;
  sk: string;
  skill: string;
  title: string;
  minutes: number;
  focus: { nodeId: string; name: string; reason: string };
  blocks: SessionBlock[];
  location?: string;
  short?: boolean;
  startedAt?: string;
  status: "planned" | "active" | "done" | "skipped";
}

export interface FeedbackView {
  attemptId: string;
  sk: string;
  headline: string;
  mistakeId?: string;
  severity?: number;
  confidence?: number;
  evidence: { ref: EvidenceRef; figure?: Figure; frame?: string; label?: string };
  praise?: { headline: string; metric?: string };
  fixDrillId?: string;
  fixDrillTitle?: string;
  why?: { figure?: Figure; card?: Card };
  analysis: Analysis;
  reRecord?: string;
  precision: "full" | "reduced" | "self-report";
  compare?: { previousAttemptId?: string; metric?: string; before?: number; after?: number; unit?: string };
}

export interface ProgressView {
  sk: string;
  skill: string;
  route: RouteView;
  nodes: { id: string; name: string; mastery: number }[];
  keyMetrics: { id: string; label: string; unit: string; better: "higher" | "lower"; format: string; history: { value: number; at: string }[]; first?: number; latest?: number }[];
  beforeAfter?: { drillId: string; label: string; first?: { attemptId: string; value?: number; at: string }; latest?: { attemptId: string; value?: number; at: string }; unit?: string };
  time: { actualMinutes: number; plannedMinutes: number; mix: { category: string; planned: number; actual: number }[] };
  history: { sessions: { id: string; at?: string; minutes?: number; focus?: string; status: string }[]; attempts: { id: string; at: string; kind: string; drillId?: string; engine: string }[] };
  proof: { title: string; ready: boolean; percent: number; criteria: { id: string; label: string; passed?: boolean }[] };
}

export interface SummaryView {
  sessionId: string;
  sk: string;
  skill: string;
  minutes: number;
  changed: { nodeId: string; name: string; before: number; after: number }[];
  oneFix?: { headline: string; mistakeId: string; fixDrillTitle?: string };
  praise?: string;
  next: { title: string; focus: string; when?: string };
  metric?: { label: string; before?: number; after?: number; unit: string };
  /** a live coach's note on the next session */
  nextNote?: string;
}

export interface ProofResultView {
  milestoneId: string;
  title: string;
  passed: boolean;
  criteria: { id: string; label: string; passed: boolean; evidence?: string }[];
  attemptId?: string;
  proofCardId?: string;
  precision: "full" | "reduced" | "self-report";
}

export interface CheckinView {
  id: string;
  kind: string;
  question: string;
  options: { id: string; label: string; detail?: string }[];
  dueAt: string;
}
