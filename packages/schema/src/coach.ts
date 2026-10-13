/**
 * The live coach (docs/design/live-coach.md): the events the coach receives from `coach_wait`, the screens
 * `coach_show` accepts, the small state every wait returns, and the two new views (a coach message and a plan
 * proposal). Shared by the server (director), the studio and the CLI watcher so all three agree.
 */
import { z } from "zod";
import { AnalysisSchema } from "./analysis.js";
import { CardSchema, FigureSchema } from "./lesson.js";
import { KnowledgeItemSchema } from "./specs/others.js";
import type { Analysis } from "./analysis.js";
import type { BlockKind, SessionItem, SummaryView } from "./views.js";

// ------------------------------------------------------------------ budgets and settings (§7, §12)

export const MESSAGE_WORD_BUDGET = 25;
export const DRILL_PROMPT_WORD_BUDGET = 25;
export const KNOWLEDGE_ITEM_WORD_BUDGET = 40;
export const PLAN_QUESTION_WORD_BUDGET = 25;
export const ASK_MAX_CHARS = 280;

/** Starting values; each is a setting (`coach.<name>`) the learner or the CLI can change. */
export const COACH_DEFAULTS = {
  /** a coach counts as present while a coach_wait is open or returned less than this many seconds ago */
  presenceWindowS: 60,
  /** a present coach that hasn't queued the next screen by then is skipped for the fallback */
  screenDeadlineS: 8,
  waitDefaultS: 45,
  waitMaxS: 55,
  /** after the first event, wait this long for more so a burst arrives together */
  batchWindowMs: 300,
  /** cross-process: how often a coach_wait polls the store when it isn't the process that serves the studio */
  pollMs: 250,
  /** no word from the studio for this long: session.left (studio-offline) */
  studioOfflineS: 300,
  /** seconds on a screen with no action before learner.hesitated */
  hesitationS: 20,
  /** the watcher: one wake per live session this often at most, and this many per session */
  wakeMinIntervalS: 120,
  wakeMaxPerSession: 5,
  /** MCP progress notifications while waiting */
  progressEveryS: 10
} as const;
export type CoachSettings = { -readonly [K in keyof typeof COACH_DEFAULTS]: number };

// ------------------------------------------------------------------ live session state (§8)

export const LIVE_STATES = ["idle", "live", "coach-away", "paused", "ended"] as const;
export type LiveState = (typeof LIVE_STATES)[number];

export const SCREEN_KINDS = ["lesson", "drill", "capture", "feedback", "message", "plan", "wrapup", "warmup", "recall", "pause"] as const;
export type ScreenKind = (typeof SCREEN_KINDS)[number];
export type ScreenSource = "coach" | "fallback";

// ------------------------------------------------------------------ events (§6)

const base = { id: z.string(), at: z.string(), screenId: z.string().optional() };

/** Events the coach receives, in id order. The studio posts most of them; the server makes the rest. */
export const CoachEventSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("screen.viewed"), kind: z.enum(SCREEN_KINDS), source: z.enum(["coach", "fallback"]), previous: z.object({ screenId: z.string(), kind: z.enum(SCREEN_KINDS), seconds: z.number().min(0) }).optional() }),
  z.object({ ...base, type: z.literal("card.answered"), card: z.number().int().min(0), cardType: z.string(), answer: z.unknown(), correct: z.boolean().optional(), seconds: z.number().min(0).optional() }),
  z.object({
    ...base,
    type: z.literal("drill.answered"),
    drillId: z.string(),
    itemId: z.string().optional(),
    correct: z.boolean().optional(),
    success: z.boolean().optional(),
    score: z.number().min(0).max(1).optional(),
    difficulty: z.number().int().min(0),
    changed: z.enum(["up", "down", "none"]).default("none"),
    mastery: z.array(z.object({ nodeId: z.string(), before: z.number(), after: z.number() })).default([]),
    done: z.boolean().default(false),
    outcome: z.record(z.string(), z.unknown()).optional()
  }),
  z.object({
    ...base,
    type: z.literal("attempt.analyzed"),
    attemptId: z.string(),
    drillId: z.string().optional(),
    analysis: AnalysisSchema,
    /** up to 3 annotated key frames, by reference (never media) */
    keyFrames: z.array(z.object({ t: z.number(), ref: z.string(), label: z.string().max(40).optional() })).max(3).default([]),
    proof: z.record(z.string(), z.unknown()).optional(),
    /** the server's top-mistake pick, as advice */
    top: z.object({ mistakeId: z.string(), name: z.string(), confidence: z.number(), severity: z.number().optional(), fixDrillId: z.string().optional() }).optional()
  }),
  z.object({ ...base, type: z.literal("learner.asked"), text: z.string().max(ASK_MAX_CHARS) }),
  z.object({ ...base, type: z.literal("learner.hesitated"), seconds: z.number().min(0) }),
  z.object({ ...base, type: z.literal("pain.reported"), area: z.string(), level: z.number().int().min(1).max(5), intensityCap: z.number().int().min(1).max(5) }),
  z.object({ ...base, type: z.literal("session.paused"), reason: z.enum(["learner", "pain"]) }),
  z.object({ ...base, type: z.literal("session.resumed"), pausedSeconds: z.number().min(0) }),
  z.object({ ...base, type: z.literal("session.left"), reason: z.enum(["closed", "studio-offline"]) })
]);
export type CoachEvent = z.infer<typeof CoachEventSchema>;
export type CoachEventType = CoachEvent["type"];
export type CoachEventInput = z.input<typeof CoachEventSchema>;

/** Events the watcher wakes a coach for (§4). */
export const WAKE_EVENT_TYPES: readonly CoachEventType[] = ["screen.viewed", "card.answered", "drill.answered", "attempt.analyzed", "learner.asked", "pain.reported", "session.resumed"];

// ------------------------------------------------------------------ screens (§7)

const id = z.string().regex(/^[a-z0-9][a-z0-9-_.]*$/);
const reason = z.string().max(200).optional();

/** Plan options: the replan tool's options, or a reschedule value, each with a label. */
export const PlanOptionSchema = z.object({
  id: z.string().max(40),
  label: z.string().max(60),
  detail: z.string().max(120).optional(),
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("replan"), option: z.string().max(60) }),
    z.object({ kind: z.literal("reschedule"), days: z.array(z.number().int().min(0).max(6)).optional(), minutesPerWeek: z.number().int().min(10).max(2000).optional(), targetDate: z.string().optional() }),
    z.object({ kind: z.literal("checkin"), option: z.string().max(60) }),
    z.object({ kind: z.literal("none") })
  ])
});
export type PlanOption = z.infer<typeof PlanOptionSchema>;

/** What the coach writes. `reason` is required when the screen differs from the planner's suggestion (§10). */
export const CoachScreenInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("lesson"), title: z.string().max(60), nodes: z.array(z.string()).min(1), cards: z.array(CardSchema).min(1).max(5), reason }),
  z.object({
    kind: z.literal("drill"),
    /** a scaffold drill; required for performance drills, optional for a knowledge drill with its own items */
    drillId: id.optional(),
    /** a knowledge drill type when the coach brings its own items */
    type: z.enum(["choice", "match", "order", "hotspot", "predict-output", "fill"]).optional(),
    title: z.string().max(60).optional(),
    nodes: z.array(z.string()).optional(),
    items: z.array(KnowledgeItemSchema).max(12).optional(),
    prompt: z.string().max(200).optional(),
    difficulty: z.number().int().min(0).max(7).optional(),
    reason
  }),
  z.object({ kind: z.literal("capture"), drillId: id.optional(), milestoneId: z.string().optional(), prompt: z.string().max(200).optional(), how: z.string().max(200).optional(), reason }),
  z.object({
    kind: z.literal("feedback"),
    attemptId: z.string(),
    headline: z.string().max(120),
    /** the mistake or marker in that analysis the headline is about */
    evidence: z.discriminatedUnion("kind", [z.object({ kind: z.literal("mistake"), mistakeId: z.string() }), z.object({ kind: z.literal("marker"), index: z.number().int().min(0) }), z.object({ kind: z.literal("metric"), metricId: z.string() })]),
    fixDrillId: id.optional(),
    why: z.object({ figure: FigureSchema.optional(), card: CardSchema.optional() }).optional(),
    praise: z.string().max(80).optional(),
    reason
  }),
  z.object({ kind: z.literal("message"), text: z.string().max(240), figure: FigureSchema.optional(), replyTo: z.string().optional(), leaving: z.boolean().default(false) }),
  z.object({ kind: z.literal("plan"), question: z.string().max(200), options: z.array(PlanOptionSchema).min(2).max(4), reason: z.string().max(200), checkinId: z.string().optional() }),
  z.object({ kind: z.literal("wrapup"), praise: z.string().max(80).optional(), oneFix: z.string().max(80).optional(), nextNote: z.string().max(200).optional(), reason })
]);
export type CoachScreenInput = z.infer<typeof CoachScreenInputSchema>;
export type CoachScreenInputRaw = z.input<typeof CoachScreenInputSchema>;

/** A screen as the director stores and streams it: the coach's input resolved into the item the studio draws. */
export interface CoachScreen {
  id: string;
  liveSessionId: string;
  kind: ScreenKind;
  source: ScreenSource;
  block: BlockKind;
  /** the view the studio renders (a SessionItem, a CoachMessageView, a PlanProposalView or a SummaryView) */
  item: SessionItem | CoachMessageView | PlanProposalView | SummaryView;
  /** the coach's own words, kept for the log */
  input?: CoachScreenInput | { kind: "suggested" };
  reason?: string;
  replyTo?: string;
  queuedAt: string;
  shownAt?: string;
  answeredAt?: string;
}

/** `coach_show` result. */
export interface CoachShowResult {
  ok: boolean;
  errors: { path: string; message: string }[];
  screenId?: string;
  status?: "shown" | "queued";
  /** what the studio shows now */
  current?: { id: string; kind: ScreenKind; source: ScreenSource };
}

// ------------------------------------------------------------------ views (§7)

export interface CoachMessageView {
  type: "message";
  screenId: string;
  text: string;
  figure?: z.infer<typeof FigureSchema>;
  replyTo?: string;
  leaving: boolean;
  at: string;
}

export interface PlanProposalView {
  type: "plan";
  screenId: string;
  sk: string;
  question: string;
  reason: string;
  options: { id: string; label: string; detail?: string }[];
  checkinId?: string;
}

// ------------------------------------------------------------------ what coach_wait returns (§3.2)

export interface CoachSuggestion {
  item: SessionItem;
  block: BlockKind;
  reason: string;
  /** the fallback screen the director would show for this suggestion */
  fallbackScreenId?: string;
}

export interface LiveSessionState {
  state: LiveState;
  block: BlockKind;
  step: number;
  minutesUsed: number;
  minutesPlanned: number;
  screen?: { id: string; kind: ScreenKind; source: ScreenSource; shownAt: string };
  queued?: { id: string; kind: ScreenKind };
  mastery: { nodeId: string; name: string; before: number; now: number }[];
  mistakes: { id: string; state: string }[];
  difficulty: Record<string, number>;
  intensityCap?: number;
  injuries: string[];
  location?: string;
  studio: { connected: boolean; lastSeenAt?: string };
  /** which client holds the coach, when two coaches meet (§8) */
  holder?: { client?: string; present: boolean };
}

export interface CoachWaitResult {
  liveSessionId: string;
  sk: string;
  events: CoachEvent[];
  heartbeat?: true;
  state: LiveSessionState;
  suggestion?: CoachSuggestion;
  instruction: string;
}

export interface CoachStartResult {
  liveSessionId: string;
  sk: string;
  skill: string;
  reattached: boolean;
  state: LiveSessionState;
  plan: { title: string; minutes: number; focus: { nodeId: string; name: string; reason: string }; blocks: { kind: BlockKind; minutes: number; reason: string; title: string }[] };
  suggestion?: CoachSuggestion;
  studioPath: string;
  instruction: string;
}

/** What `GET /api/live/:sessionId` returns to the studio, and what `coach.state` carries on the stream. */
export interface LiveView {
  liveSessionId: string;
  sk: string;
  state: LiveState;
  coachPresent: boolean;
  /** the screen to draw now */
  screen?: CoachScreen;
  /** a message over it, if one is live */
  message?: CoachMessageView;
  queued?: { id: string; kind: ScreenKind; source: ScreenSource };
  minutesUsed: number;
  minutesPlanned: number;
  leftOnPurpose: boolean;
  summary?: SummaryView;
}

export type { Analysis };
