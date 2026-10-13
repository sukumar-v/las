/**
 * The session director (docs/design/live-coach.md §8–§10, §12, §14). One live session per enrollment; its
 * state lives in the store (`live_session`, `coach_event`, `coach_screen`), never only in memory, because the
 * process that serves the studio may not be the one the coach talks to. The director queues events for the
 * coach (at-least-once), shows the coach's screens (one queued screen, messages at once), applies the presence
 * rule, serves fallback screens from the planner's plan and the model's pre-written content, and lets the
 * planner advise. It never decides what to teach while a coach is present.
 */
import { randomUUID } from "node:crypto";
import {
  COACH_DEFAULTS,
  CoachEventSchema,
  type Analysis,
  type BlockKind,
  type CoachEvent,
  type CoachEventInput,
  type CoachMessageView,
  type CoachScreen,
  type CoachSettings,
  type CoachShowResult,
  type CoachStartResult,
  type CoachSuggestion,
  type CoachWaitResult,
  type CoachEndResult,
  type Drill,
  type KnowledgeItem,
  type LiveAdvanceResult,
  type LiveSessionState,
  type LiveState,
  type LiveView,
  type PlanOption,
  type ScreenKind,
  type ScreenSource,
  type SessionItem,
  type SessionPlan,
  type StudioEvent,
  type SummaryView
} from "@las/schema";
import type { AttemptRow, CoachScreenRow, LiveSessionRow } from "@las/store";
import type { LasContext } from "../context.js";
import { loadSk, LoopError, nodeMap, tzOf, zoned, type SkState } from "./common.js";
import { buildFeedback, disputedFor, pickTopMistake } from "./feedback.js";
import { intensityCap, planSession } from "./planner.js";
import { drillItems } from "./practice.js";
import { handleEvent, sessionState } from "./sessions.js";
import { sessionSummary } from "./progress.js";
import { answerCheckin } from "./checkins.js";
import { replan } from "./replan.js";
import { checkScreen, describeItem, KNOWLEDGE_DRILL_TYPES, resolveScreen, wrapupSummary, type ScreenContext, type ScreenIssue } from "./coach-screens.js";
import { UNRESOLVED } from "./planner.js";

// ------------------------------------------------------------------ clock, settings, wake-ups

/** Time for the director. Tests inject a fake one so a 60 s presence window takes milliseconds. */
export interface DirectorClock {
  now(): Date;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: DirectorClock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise((res) => {
      if (signal?.aborted) return res();
      const t = setTimeout(res, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        res();
      }, { once: true });
    })
};

const clocks = new WeakMap<LasContext, DirectorClock>();
export function setDirectorClock(ctx: LasContext, clock?: DirectorClock): void {
  if (clock) clocks.set(ctx, clock);
  else clocks.delete(ctx);
}
export const clockOf = (ctx: LasContext): DirectorClock => clocks.get(ctx) ?? realClock;
const nowOf = (ctx: LasContext) => clockOf(ctx).now();

const settingsCache = new WeakMap<LasContext, { at: number; s: CoachSettings }>();

/** `coach.<name>` settings over COACH_DEFAULTS (§12), read at most once a second (the poller asks often). */
export function coachSettings(ctx: LasContext): CoachSettings {
  const c = settingsCache.get(ctx);
  if (c && Date.now() - c.at < 1000) return c.s;
  const out = { ...COACH_DEFAULTS } as CoachSettings;
  const rows = ctx.store.db.all("SELECT key, value FROM setting WHERE key LIKE 'coach.%'");
  for (const r of rows) {
    const k = String(r.key).slice("coach.".length) as keyof CoachSettings;
    if (!Object.hasOwn(COACH_DEFAULTS, k)) continue;
    let v: number;
    try {
      v = Number(JSON.parse(String(r.value)));
    } catch {
      continue;
    }
    if (Number.isFinite(v) && v >= 0) out[k] = v;
  }
  settingsCache.set(ctx, { at: Date.now(), s: out });
  return out;
}

/** Waits in this process wake at once when something changes here; other processes poll the store. */
const wakers = new WeakMap<LasContext, Set<() => void>>();
function wake(ctx: LasContext): void {
  for (const w of wakers.get(ctx) ?? []) w();
}
function sleepOrWake(ctx: LasContext, ms: number, signal?: AbortSignal): Promise<void> {
  let set = wakers.get(ctx);
  if (!set) wakers.set(ctx, (set = new Set()));
  const s = set;
  return new Promise<void>((res) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      s.delete(finish);
      res();
    };
    s.add(finish);
    void clockOf(ctx).sleep(ms, signal).then(finish);
  });
}

/** The coach token each MCP server (one LasContext) holds per live session. */
const tokens = new WeakMap<LasContext, Map<string, string>>();
function tokensOf(ctx: LasContext): Map<string, string> {
  let m = tokens.get(ctx);
  if (!m) tokens.set(ctx, (m = new Map()));
  return m;
}

// ------------------------------------------------------------------ stored state

/** The director's own state in `live_session.json`. Ids and timestamps only; screens live in `coach_screen`. */
export interface LiveData {
  sk: string;
  minutes: number;
  location?: string;
  /** director clock */
  startedAt: string;
  block: BlockKind;
  /** screen index inside the block */
  step: number;
  /** plan items served (by index in the flattened plan) */
  done: number[];
  /** which plan item each screen served */
  planIndex: Record<string, number>;
  currentId?: string;
  queuedId?: string;
  messageId?: string;
  /** the learner finished the current screen and is waiting for the next one */
  waitingSince?: string;
  deadlineAt?: string;
  waitNotified?: string;
  lastAnsweredId?: string;
  pausedAt?: string;
  pausedBy?: "learner" | "pain" | "closed" | "studio-offline";
  pausedTotalS: number;
  resumeId?: string;
  /** knowledge drills with the coach's own items, by drill id (start_drill serves them) */
  coachDrills: Record<string, { drill: Drill; items: KnowledgeItem[] }>;
  /** mastery when the session started */
  before: Record<string, number>;
  /** nodes the coach's screens worked on */
  nodes: string[];
  hesitated: string[];
  feedbackFor: string[];
  /** event ids returned by the last coach_wait, acknowledged by the next one */
  lastBatch: number[];
  wrapupShown?: boolean;
  /** pain at level 4+: the fallback goes to the wrap-up */
  stop?: boolean;
  summary?: SummaryView;
  takeovers: { at: string; from?: string; to?: string }[];
  /** the studioSeenAt value a studio-offline session.left was sent for */
  offlineFor?: string;
}

export function liveData(row: LiveSessionRow): LiveData {
  const d = row.data ?? {};
  return { done: [], planIndex: {}, pausedTotalS: 0, coachDrills: {}, before: {}, nodes: [], hesitated: [], feedbackFor: [], lastBatch: [], takeovers: [], step: 0, block: "warmup", minutes: 0, sk: row.enrollmentId, startedAt: row.startedAt, ...d } as LiveData;
}

/** Transactions that may already be open on a store (a mutate inside a mutate runs inline). */
const inTx = new WeakSet<object>();

/** Read, change and write a live session under one write lock, so two processes never lose each other's changes. */
function mutate<T>(ctx: LasContext, id: string, fn: (row: LiveSessionRow, data: LiveData) => { patch?: Partial<LiveSessionRow>; out?: T } | void): { row: LiveSessionRow; out?: T } {
  const db = ctx.store.db;
  const run = () => {
    const row = ctx.store.getLiveSession(id);
    if (!row) throw new LoopError(`Unknown live session "${id}".`);
    const data = liveData(row);
    const r = fn(row, data) ?? {};
    const next = ctx.store.updateLiveSession(id, { ...(r.patch ?? {}), data: data as unknown as Record<string, unknown> });
    return { row: next, out: r.out };
  };
  if (inTx.has(db)) return run();
  db.sqlite.exec("BEGIN IMMEDIATE");
  inTx.add(db);
  try {
    const out = run();
    db.sqlite.exec("COMMIT");
    return out;
  } catch (e) {
    db.sqlite.exec("ROLLBACK");
    throw e;
  } finally {
    inTx.delete(db);
  }
}

const iso = (d: Date) => d.toISOString();
const ageS = (from: string | undefined, now: Date) => (from ? (now.getTime() - Date.parse(from)) / 1000 : Infinity);
const newScreenId = () => `scr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

/** The presence rule (§8): a coach_wait is open, or one returned less than presenceWindowS ago. */
export function isPresent(row: LiveSessionRow, s: CoachSettings, now: Date): boolean {
  if (!row.coachToken || row.leftOnPurpose || row.state === "ended") return false;
  // an open wait refreshes nothing until it returns, so a stale open flag (a process that died mid-wait) runs out too
  return ageS(row.lastWaitAt, now) < (row.waitOpen ? s.presenceWindowS + s.waitMaxS : s.presenceWindowS);
}

export function minutesUsed(data: LiveData, now: Date): number {
  const paused = data.pausedAt ? ageS(data.pausedAt, now) : 0;
  return Math.max(0, Math.round(((ageS(data.startedAt, now) - data.pausedTotalS - paused) / 60) * 10) / 10);
}

// ------------------------------------------------------------------ screens

export function screenOf(r: CoachScreenRow): CoachScreen {
  return { ...(r.screen as CoachScreen), id: r.id, liveSessionId: r.liveSessionId, kind: r.kind as ScreenKind, source: r.source, queuedAt: r.queuedAt, shownAt: r.shownAt, answeredAt: r.answeredAt };
}
const screenById = (ctx: LasContext, id?: string) => (id ? ctx.store.getCoachScreen(id) : undefined);

function addScreen(ctx: LasContext, liveId: string, s: { id?: string; kind: ScreenKind; source: ScreenSource; block: BlockKind; item: CoachScreen["item"]; input?: CoachScreen["input"]; reason?: string; replyTo?: string }, now: Date): CoachScreenRow {
  const id = s.id ?? newScreenId();
  const screen: Omit<CoachScreen, "id" | "liveSessionId" | "queuedAt"> = { kind: s.kind, source: s.source, block: s.block, item: s.item, input: s.input, reason: s.reason, replyTo: s.replyTo };
  return ctx.store.addCoachScreen({ id, liveSessionId: liveId, kind: s.kind, source: s.source, screen: { ...screen, queuedAt: iso(now) } });
}

/** Makes a screen the one the studio draws now. */
function makeCurrent(ctx: LasContext, data: LiveData, screen: CoachScreenRow, now: Date): void {
  const sc = screen.screen as CoachScreen;
  if (data.queuedId === screen.id) data.queuedId = undefined;
  data.currentId = screen.id;
  data.waitingSince = data.deadlineAt = data.waitNotified = undefined;
  data.messageId = undefined;
  if (screen.kind !== "pause") {
    if (sc.block !== data.block) {
      data.block = sc.block;
      data.step = 0;
    } else data.step++;
  }
  const idx = data.planIndex[screen.id];
  if (idx !== undefined && !data.done.includes(idx)) data.done.push(idx);
  if (screen.kind === "wrapup") data.wrapupShown = true;
  if (screen.kind === "feedback") {
    const a = (sc.item as { view?: { attemptId?: string } }).view?.attemptId;
    if (a && !data.feedbackFor.includes(a)) data.feedbackFor.push(a);
  }
  ctx.store.updateCoachScreen(screen.id, { shownAt: iso(now) });
}

// ------------------------------------------------------------------ the plan as advice (§10) and fallback content (§9)

export interface PlanEntry {
  index: number;
  block: BlockKind;
  item: SessionItem;
  reason: string;
  /** the model has the content to show it with no coach */
  buildable: boolean;
}

const planOf = (ctx: LasContext, id: string): SessionPlan | undefined => ctx.store.getSession(id)?.plan as SessionPlan | undefined;

/** The plan flattened into items, always ending with a wrap-up. A learn block without cards becomes a lesson suggestion with none. */
export function planEntries(st: SkState, plan: SessionPlan | undefined): PlanEntry[] {
  const out: PlanEntry[] = [];
  for (const b of plan?.blocks ?? []) {
    const items = b.items.length ? b.items : b.lesson ? [{ type: "lesson" as const, lessonId: b.lesson.lessonId, title: b.lesson.title, cards: [], nodes: b.lesson.nodes }] : [];
    for (const it of items) out.push({ index: out.length, block: b.kind, item: it, reason: b.reason, buildable: buildable(st, it) });
  }
  if (!out.some((e) => e.item.type === "wrapup")) out.push({ index: out.length, block: "wrapup", item: { type: "wrapup" }, reason: "What changed, and what's next.", buildable: true });
  return out;
}

function buildable(st: SkState, it: SessionItem): boolean {
  switch (it.type) {
    case "warmup":
      return it.steps.length > 0;
    case "review":
      return it.cardIds.length > 0;
    case "lesson":
      return it.cards.length > 0;
    case "drill":
      return !KNOWLEDGE_DRILL_TYPES.has(it.drill.type) || !!drillItems(st.model, it.drill)?.items.length;
    default:
      return true;
  }
}

const DIRECTOR_OWNED = new Set(["warmup", "review"]);

/** The planner's next item for the coach: the first one not served yet, past the warm-up and recall the director shows itself. */
function suggestionEntry(entries: PlanEntry[], data: LiveData): PlanEntry | undefined {
  return entries.find((e) => !data.done.includes(e.index) && !DIRECTOR_OWNED.has(e.item.type));
}

function suggestionOf(entries: PlanEntry[], data: LiveData): CoachSuggestion | undefined {
  const e = suggestionEntry(entries, data);
  if (!e) return undefined;
  const reason = e.item.type === "lesson" && !e.item.cards.length ? `${e.reason} No pre-written cards: write them.` : e.reason;
  return { item: e.item, block: e.block, reason };
}

const kindOfItem = (it: SessionItem): ScreenKind => (it.type === "review" ? "recall" : (it.type as ScreenKind));

/** A screen from a plan item and the model's pre-written content. */
function entryScreen(ctx: LasContext, st: SkState, liveId: string, data: LiveData, e: PlanEntry, source: ScreenSource, now: Date): CoachScreenRow {
  let item: CoachScreen["item"] = e.item;
  if (e.item.type === "drill") {
    // the session's own difficulty for this drill, which may have moved since the plan was made
    const state = sessionState(ctx.store.getSession(liveId)?.summary);
    const d = e.item.drill;
    const difficulty = state.difficulty[d.id] ?? e.item.difficulty;
    const lv = d.difficulty?.levels[difficulty];
    item = { ...e.item, difficulty, label: lv !== undefined ? `${d.difficulty!.param}: ${lv}` : d.title };
  }
  if (e.item.type === "wrapup") item = { type: "wrapup", summary: liveSummary(ctx, liveId, data) };
  const row = addScreen(ctx, liveId, { kind: kindOfItem(e.item), source, block: e.block, item, input: source === "coach" ? { kind: "suggested" } : undefined }, now);
  data.planIndex[row.id] = e.index;
  const nodes = e.item.type === "lesson" ? e.item.nodes : e.item.type === "drill" ? e.item.drill.nodes : [];
  for (const n of nodes) if (!data.nodes.includes(n)) data.nodes.push(n);
  return row;
}

/** The fallback's next screen (§9): feedback on a fresh analysis, else the next plan item with content, else the wrap-up. */
function fallbackScreen(ctx: LasContext, st: SkState, liveId: string, data: LiveData, now: Date): CoachScreenRow {
  const entries = planEntries(st, planOf(ctx, liveId));
  const wrap = () => entries.find((e) => e.item.type === "wrapup")!;
  const timeUp = minutesUsed(data, now) >= data.minutes && data.minutes > 0;
  if (data.stop || timeUp) return entryScreen(ctx, st, liveId, data, wrap(), "fallback", now);
  // a recording analyzed in this session that hasn't had its feedback yet
  const fresh = ctx.store
    .listAttempts(st.enrollment.id, { analyzed: true, limit: 20 })
    .filter((a) => a.sessionId === liveId && !data.feedbackFor.includes(a.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (fresh) {
    const view = buildFeedback(ctx, fresh.id, { markCoached: true });
    return addScreen(ctx, liveId, { kind: "feedback", source: "fallback", block: data.block, item: { type: "feedback", view } }, now);
  }
  for (const e of entries) {
    if (data.done.includes(e.index)) continue;
    if (!e.buildable) {
      // no pre-written content: skip it, never invent text
      data.done.push(e.index);
      continue;
    }
    return entryScreen(ctx, st, liveId, data, e, "fallback", now);
  }
  return entryScreen(ctx, st, liveId, data, wrap(), "fallback", now);
}

/**
 * What the learner sees next (§8): the warm-up and recall first (the director shows them), then the coach's
 * queued screen; with a present coach and nothing queued, wait until the screen deadline; else the fallback.
 * Runs inside mutate.
 */
function serveNext(ctx: LasContext, st: SkState, row: LiveSessionRow, data: LiveData, now: Date, opts: { force?: boolean } = {}): { screen?: CoachScreenRow; waiting?: { until: string } } {
  if (row.state === "ended" || row.state === "paused") return {};
  const s = coachSettings(ctx);
  const entries = planEntries(st, planOf(ctx, row.id));
  const first = entries.find((e) => !data.done.includes(e.index));
  if (first && DIRECTOR_OWNED.has(first.item.type) && first.buildable) {
    const scr = entryScreen(ctx, st, row.id, data, first, "fallback", now);
    makeCurrent(ctx, data, scr, now);
    return { screen: scr };
  }
  const queued = screenById(ctx, data.queuedId);
  if (queued) {
    makeCurrent(ctx, data, queued, now);
    return { screen: queued };
  }
  if (!opts.force && isPresent(row, s, now)) {
    if (!data.waitingSince) {
      data.waitingSince = iso(now);
      data.deadlineAt = iso(new Date(now.getTime() + s.screenDeadlineS * 1000));
    }
    if (now.getTime() < Date.parse(data.deadlineAt!)) return { waiting: { until: data.deadlineAt! } };
  }
  const scr = fallbackScreen(ctx, st, row.id, data, now);
  makeCurrent(ctx, data, scr, now);
  return { screen: scr };
}

// ------------------------------------------------------------------ the stream (what the studio hears)

interface Seen {
  state: LiveState;
  present: boolean;
  queued?: string;
  left: boolean;
  current?: string;
  shownAt?: string;
  message?: string;
  ended: boolean;
}
const seen = new WeakMap<LasContext, Map<string, Seen>>();

/**
 * Emits what changed since this process last told its studio: coach.state, coach.screen, coach.message,
 * coach.ended. Changes made here call it at once; changes made by another process reach it through the poller.
 */
export function publish(ctx: LasContext, rowOrId: LiveSessionRow | string | undefined): void {
  const row = typeof rowOrId === "string" ? ctx.store.getLiveSession(rowOrId) : rowOrId;
  if (!row) return;
  wake(ctx);
  let m = seen.get(ctx);
  if (!m) seen.set(ctx, (m = new Map()));
  const data = liveData(row);
  const now = nowOf(ctx);
  const present = isPresent(row, coachSettings(ctx), now);
  const cur = screenById(ctx, data.currentId);
  const queued = screenById(ctx, data.queuedId);
  const next: Seen = { state: row.state, present, queued: data.queuedId, left: row.leftOnPurpose, current: data.currentId, shownAt: cur?.shownAt, message: data.messageId, ended: row.state === "ended" };
  const prev = m.get(row.id);
  m.set(row.id, next);
  const liveSessionId = row.id;
  if (!prev || prev.state !== next.state || prev.present !== next.present || prev.queued !== next.queued || prev.left !== next.left)
    ctx.emit("coach.state", { liveSessionId, state: row.state, coachPresent: present, queued: queued ? { id: queued.id, kind: queued.kind, source: queued.source } : undefined, leftOnPurpose: row.leftOnPurpose });
  if (cur && (!prev || prev.current !== next.current || prev.shownAt !== next.shownAt) && !next.ended) ctx.emit("coach.screen", { liveSessionId, screen: screenOf(cur) });
  if (next.message && (!prev || prev.message !== next.message)) {
    const msg = screenById(ctx, next.message);
    if (msg) ctx.emit("coach.message", { liveSessionId, message: (msg.screen as CoachScreen).item as CoachMessageView });
  }
  if (next.ended && (!prev || !prev.ended)) ctx.emit("coach.ended", { liveSessionId, summary: data.summary ?? sessionSummary(ctx, row.id) });
}

/**
 * The studio-serving process re-reads open live sessions every pollMs while a studio listens, so changes another
 * process made (a coach's screen, an event) reach the stream, and deadlines and presence are applied on time.
 */
export function startLivePoller(ctx: LasContext): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy || ctx.listeners.size === 0) return;
    busy = true;
    void (async () => {
      try {
        const open = ctx.store.listLiveSessions({ states: ["live", "coach-away", "paused"], limit: 20 });
        for (const r of open) await tick(ctx, r.id);
        // sessions this process knew as open that another process ended
        const known = seen.get(ctx);
        for (const [id, s] of known ?? []) {
          if (s.ended || open.some((r) => r.id === id)) continue;
          if (ctx.store.getLiveSession(id)) publish(ctx, id);
          else known!.delete(id);
        }
      } catch {
        /* the next round tries again */
      } finally {
        busy = false;
      }
    })();
  }, coachSettings(ctx).pollMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ------------------------------------------------------------------ the coach's view of the session

function liveSummary(ctx: LasContext, liveId: string, data: LiveData): SummaryView {
  const s = sessionSummary(ctx, liveId);
  const st = loadSk(ctx, s.sk);
  const byId = nodeMap(st.model);
  const mastery = ctx.store.getMastery(st.enrollment.id);
  const have = new Set(s.changed.map((c) => c.nodeId));
  for (const n of data.nodes) if (!have.has(n) && byId.has(n)) s.changed.push({ nodeId: n, name: byId.get(n)!.name, before: data.before[n] ?? mastery.get(n)?.pKnown ?? 0, after: mastery.get(n)?.pKnown ?? 0 });
  // the coach's own wrap-up words, if it showed one
  const coachWrap = ctx.store.listCoachScreens(liveId).filter((r) => r.kind === "wrapup" && r.source === "coach" && r.shownAt).pop();
  const input = (coachWrap?.screen as CoachScreen | undefined)?.input;
  return input && input.kind === "wrapup" ? wrapupSummary(s, input) : s;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** The small state every wait returns (§3.2): deltas only, about 2 KB. */
export function liveState(ctx: LasContext, row: LiveSessionRow, st: SkState, now: Date): LiveSessionState {
  const data = liveData(row);
  const s = coachSettings(ctx);
  const nodes = nodeMap(st.model);
  const mastery = ctx.store.getMastery(st.enrollment.id);
  const changed = [...mastery].filter(([id, m]) => Math.abs(m.pKnown - (data.before[id] ?? m.pKnown)) >= 0.005).slice(0, 12);
  const mistakes = [...ctx.store.getMistakeStates(st.enrollment.id).values()].filter((m) => UNRESOLVED.has(m.state) || (m.lastSeenAt ?? "") >= data.startedAt).slice(0, 10);
  const cur = screenById(ctx, data.currentId);
  const q = screenById(ctx, data.queuedId);
  const session = ctx.store.getSession(row.id);
  return {
    state: row.state,
    block: data.block,
    step: Math.max(0, data.step),
    minutesUsed: minutesUsed(data, now),
    minutesPlanned: data.minutes,
    screen: cur ? { id: cur.id, kind: cur.kind as ScreenKind, source: cur.source, shownAt: cur.shownAt ?? cur.queuedAt } : undefined,
    queued: q ? { id: q.id, kind: q.kind as ScreenKind } : undefined,
    mastery: changed.map(([id, m]) => ({ nodeId: id, name: nodes.get(id)?.name ?? id, before: r2(data.before[id] ?? 0), now: r2(m.pKnown) })),
    mistakes: mistakes.map((m) => ({ id: m.mistakeId, state: m.state })),
    difficulty: sessionState(session?.summary).difficulty,
    intensityCap: intensityCap(ctx, st, now),
    injuries: st.constraints.injuries,
    location: data.location,
    studio: { connected: ageS(row.studioSeenAt, now) < 75, lastSeenAt: row.studioSeenAt },
    holder: { client: row.client, present: isPresent(row, s, now) },
    waiting: data.waitingSince && data.deadlineAt ? { since: data.waitingSince, until: data.deadlineAt } : undefined
  };
}

export function liveView(ctx: LasContext, row: LiveSessionRow, now = nowOf(ctx)): LiveView {
  const data = liveData(row);
  const cur = screenById(ctx, data.currentId);
  const msg = screenById(ctx, data.messageId);
  const q = screenById(ctx, data.queuedId);
  return {
    liveSessionId: row.id,
    sk: row.enrollmentId,
    state: row.state,
    coachPresent: isPresent(row, coachSettings(ctx), now),
    screen: cur ? screenOf(cur) : undefined,
    message: msg ? ((msg.screen as CoachScreen).item as CoachMessageView) : undefined,
    queued: q ? { id: q.id, kind: q.kind as ScreenKind, source: q.source } : undefined,
    minutesUsed: minutesUsed(data, now),
    minutesPlanned: data.minutes,
    leftOnPurpose: row.leftOnPurpose,
    summary: row.state === "ended" ? (data.summary ?? sessionSummary(ctx, row.id)) : undefined
  };
}

// ------------------------------------------------------------------ the event queue (§3.2, §6)

/** A coach event as the server makes it: no id yet, `at` optional. */
export type NewCoachEvent = CoachEventInput extends infer E ? (E extends unknown ? Omit<E, "id" | "at"> & { at?: string } : never) : never;

/** Queues one event for the coach (ids rise in order) and wakes waits in this process. */
export function queueEvent(ctx: LasContext, liveId: string, ev: NewCoachEvent): number {
  const at = ev.at ?? iso(nowOf(ctx));
  const parsed = CoachEventSchema.parse({ ...ev, id: "0", at }) as Record<string, unknown>;
  delete parsed.id;
  const id = ctx.store.queueCoachEvent(liveId, parsed.type as string, parsed);
  wake(ctx);
  return id;
}

const eventOf = (r: { id: number; payload: unknown }): CoachEvent => ({ ...(r.payload as CoachEvent), id: String(r.id) });

/** The live session an event about this session id belongs to, while it's open. */
function openLive(ctx: LasContext, sessionId: string | undefined): LiveSessionRow | undefined {
  if (!sessionId) return undefined;
  const r = ctx.store.getLiveSession(sessionId);
  return r && r.state !== "ended" ? r : undefined;
}

// ------------------------------------------------------------------ periodic checks

/** Presence, the screen deadline, a studio gone quiet, the end of a paused day. Cheap when nothing changed. */
export async function tick(ctx: LasContext, liveId: string, now = nowOf(ctx)): Promise<LiveSessionRow | undefined> {
  let row = ctx.store.getLiveSession(liveId);
  if (!row || row.state === "ended") return row;
  const s = coachSettings(ctx);
  const data = liveData(row);
  const present = isPresent(row, s, now);
  // a paused session ends at the end of the learner's day, keeping what was done
  if (row.state === "paused" && data.pausedAt) {
    const tz = tzOf(ctx.store.getOrCreateLearner());
    if (zoned(now, tz).ymd !== zoned(new Date(data.pausedAt), tz).ymd) {
      await endLive(ctx, liveId);
      return ctx.store.getLiveSession(liveId);
    }
  }
  const seenAt = row.studioSeenAt ?? data.startedAt;
  const offline = (row.state === "live" || row.state === "coach-away") && ageS(seenAt, now) > s.studioOfflineS && data.offlineFor !== seenAt;
  const lapse = (row.state === "live" && !present) || (row.state === "coach-away" && present);
  const due = row.state !== "paused" && !!data.waitingSince && (!present || now.getTime() >= Date.parse(data.deadlineAt ?? "")) && !data.queuedId;
  const queuedWhileWaiting = row.state !== "paused" && !!data.waitingSince && !!data.queuedId;
  if (!offline && !lapse && !due && !queuedWhileWaiting) {
    publish(ctx, row);
    return row;
  }
  if (offline) {
    queueEvent(ctx, liveId, { type: "session.left", reason: "studio-offline", at: iso(now) });
    row = pause(ctx, liveId, "studio-offline", now, seenAt);
  }
  row = mutate(ctx, liveId, (r, d) => {
    const p = isPresent(r, s, now);
    const patch: Partial<LiveSessionRow> = {};
    if (r.state === "live" && !p) patch.state = "coach-away";
    if (r.state === "coach-away" && p) patch.state = "live";
    if (r.state !== "paused" && r.state !== "ended" && d.waitingSince && (d.queuedId || !p || now.getTime() >= Date.parse(d.deadlineAt ?? ""))) {
      serveNext(ctx, loadSk(ctx, r.enrollmentId), { ...r, ...patch } as LiveSessionRow, d, now, { force: true });
    }
    return { patch };
  }).row;
  publish(ctx, row);
  return row;
}

function pause(ctx: LasContext, liveId: string, by: NonNullable<LiveData["pausedBy"]>, now: Date, offlineFor?: string): LiveSessionRow {
  const row = mutate(ctx, liveId, (r, d) => {
    if (offlineFor) d.offlineFor = offlineFor;
    if (r.state === "paused" || r.state === "ended") return;
    d.pausedAt = iso(now);
    d.pausedBy = by;
    d.resumeId = d.currentId;
    d.waitingSince = d.deadlineAt = undefined;
    const scr = addScreen(ctx, liveId, { kind: "pause", source: "fallback", block: d.block, item: { type: "pause", pausedAt: iso(now) } }, now);
    makeCurrent(ctx, d, scr, now);
    return { patch: { state: "paused" } };
  }).row;
  publish(ctx, row);
  return row;
}

function resume(ctx: LasContext, liveId: string, now: Date): { row: LiveSessionRow; pausedSeconds: number } {
  const s = coachSettings(ctx);
  const res = mutate<number>(ctx, liveId, (r, d) => {
    if (r.state !== "paused") return { out: 0 };
    const secs = d.pausedAt ? Math.max(0, ageS(d.pausedAt, now)) : 0;
    d.pausedTotalS += secs;
    d.pausedAt = d.pausedBy = undefined;
    const back = screenById(ctx, d.resumeId);
    d.resumeId = undefined;
    if (back) {
      const block = d.block;
      const step = d.step;
      makeCurrent(ctx, d, back, now);
      d.block = block;
      d.step = step;
    } else d.currentId = undefined;
    return { patch: { state: isPresent(r, s, now) ? "live" : "coach-away" }, out: secs };
  });
  publish(ctx, res.row);
  return { row: res.row, pausedSeconds: Math.round(res.out ?? 0) };
}

// ------------------------------------------------------------------ starting a session

/** Marks the session row active like session.started, and returns the mastery it started from. */
function startSessionRow(ctx: LasContext, sessionId: string, now: Date): Record<string, number> {
  const s = ctx.store.getSession(sessionId)!;
  const before = Object.fromEntries([...ctx.store.getMastery(s.enrollmentId)].map(([k, v]) => [k, v.pKnown]));
  ctx.store.updateSession(s.id, { status: "active", startedAt: s.startedAt ?? iso(now), summary: { ...(s.summary ?? {}), before: s.summary?.before ?? before } });
  ctx.store.logEvent(s.enrollmentId, "session.started", { type: "session.started", sessionId, live: true });
  return before;
}

/** A session left open from an earlier day (a crash, a closed laptop) ends before a new one starts. */
async function closeStale(ctx: LasContext, st: SkState, now: Date): Promise<LiveSessionRow | undefined> {
  const open = ctx.store.openLiveSession(st.enrollment.id);
  if (!open) return undefined;
  const d = liveData(open);
  if (zoned(now, st.tz).ymd !== zoned(new Date(d.startedAt), st.tz).ymd && !isPresent(open, coachSettings(ctx), now)) {
    await endLive(ctx, open.id);
    return undefined;
  }
  return open;
}

function createLive(ctx: LasContext, st: SkState, opts: { minutes?: number; location?: string; state: LiveState; coach?: { token: string; client?: string; coachSessionId?: string } }, now: Date): LiveSessionRow {
  const plan = planSession(ctx, st.enrollment.id, { minutes: opts.minutes, location: opts.location, now });
  const before = startSessionRow(ctx, plan.sessionId, now);
  const entries = planEntries(st, plan);
  const data: LiveData = { sk: st.enrollment.id, minutes: plan.minutes, location: opts.location, startedAt: iso(now), block: entries[0]?.block ?? "practice", step: -1, done: [], planIndex: {}, pausedTotalS: 0, coachDrills: {}, before, nodes: [], hesitated: [], feedbackFor: [], lastBatch: [], takeovers: [] };
  ctx.store.createLiveSession({ id: plan.sessionId, enrollmentId: st.enrollment.id, state: opts.state, client: opts.coach?.client, coachPid: opts.coach ? process.pid : undefined, coachToken: opts.coach?.token, coachSessionId: opts.coach?.coachSessionId, data: data as unknown as Record<string, unknown> });
  const row = mutate(ctx, plan.sessionId, (r, d) => {
    // the warm-up and recall are the director's: they show at once
    const first = entries[0];
    if (first && DIRECTOR_OWNED.has(first.item.type) && first.buildable) makeCurrent(ctx, d, entryScreen(ctx, st, r.id, d, first, "fallback", now), now);
    return { patch: opts.coach ? { lastWaitAt: iso(now) } : {} };
  }).row;
  publish(ctx, row);
  return row;
}

/** POST /api/live/start: the learner starts from the studio with no coach (state coach-away). */
export async function startFromStudio(ctx: LasContext, sk: string, opts: { minutes?: number; location?: string } = {}): Promise<LiveView> {
  const now = nowOf(ctx);
  const st = loadSk(ctx, sk);
  const open = await closeStale(ctx, st, now);
  if (open) return studioArrived(ctx, open.id);
  const row = createLive(ctx, st, { ...opts, state: "coach-away" }, now);
  return studioArrived(ctx, row.id);
}

/** The studio opened or reopened the session: presence for the studio, and a first screen if there is none. */
export function studioArrived(ctx: LasContext, liveId: string): LiveView {
  const now = nowOf(ctx);
  const row = mutate(ctx, liveId, (r, d) => {
    const patch: Partial<LiveSessionRow> = { studioSeenAt: iso(now) };
    if (r.state !== "ended" && r.state !== "paused" && !d.currentId) serveNext(ctx, loadSk(ctx, r.enrollmentId), r, d, now);
    return { patch };
  }).row;
  publish(ctx, row);
  return liveView(ctx, row, now);
}

export function studioPing(ctx: LasContext, liveId: string): { ok: true; coachPresent: boolean; state: LiveState } {
  const now = nowOf(ctx);
  const row = mutate(ctx, liveId, () => ({ patch: { studioSeenAt: iso(now) } })).row;
  publish(ctx, row);
  return { ok: true, coachPresent: isPresent(row, coachSettings(ctx), now), state: row.state };
}

export function openLiveFor(ctx: LasContext, sk: string): LiveView | null {
  const e = ctx.store.resolveEnrollment(sk);
  const row = e ? ctx.store.openLiveSession(e.id) : undefined;
  return row ? liveView(ctx, row) : null;
}

export async function getLive(ctx: LasContext, liveId: string): Promise<LiveView> {
  const row = await tick(ctx, liveId);
  if (!row) throw new LoopError(`Unknown live session "${liveId}".`);
  return row.state === "ended" ? liveView(ctx, row) : studioArrived(ctx, liveId);
}

/** POST /api/live/:id/advance: the learner finished `screenId`. */
export async function advance(ctx: LasContext, liveId: string, screenId: string | undefined, seconds?: number): Promise<LiveAdvanceResult> {
  const now = nowOf(ctx);
  await tick(ctx, liveId, now);
  const res = mutate<{ end?: boolean; screen?: CoachScreenRow; waiting?: { until: string } }>(ctx, liveId, (r, d) => {
    const patch: Partial<LiveSessionRow> = { studioSeenAt: iso(now) };
    if (r.state === "ended" || r.state === "paused") return { patch, out: {} };
    const cur = screenById(ctx, d.currentId);
    if (cur && screenId && screenId !== cur.id) return { patch, out: {} };
    if (cur?.kind === "pause") return { patch, out: {} };
    if (cur && !cur.answeredAt) {
      ctx.store.updateCoachScreen(cur.id, { answeredAt: iso(now), screen: { ...(cur.screen as object), seconds } });
      d.lastAnsweredId = cur.id;
    }
    if (cur?.kind === "wrapup") return { patch, out: { end: true } };
    return { patch, out: serveNext(ctx, loadSk(ctx, r.enrollmentId), r, d, now) };
  });
  publish(ctx, res.row);
  if (res.out?.end) {
    await endLive(ctx, liveId);
    return { view: liveView(ctx, ctx.store.getLiveSession(liveId)!) };
  }
  const view = liveView(ctx, res.row, now);
  if (res.out?.waiting) return { waiting: true, until: res.out.waiting.until, view };
  return { screen: view.screen, view };
}

// ------------------------------------------------------------------ ending (§3.1 coach_end, the wrap-up done)

/** Ends the session with the existing completeSession semantics (time log, mastery after, the next session). */
export async function endLive(ctx: LasContext, liveId: string): Promise<SummaryView> {
  const row = ctx.store.getLiveSession(liveId);
  if (!row) throw new LoopError(`Unknown live session "${liveId}".`);
  if (row.state === "ended") return liveData(row).summary ?? sessionSummary(ctx, liveId);
  const now = nowOf(ctx);
  const minutes = Math.max(1, Math.round(minutesUsed(liveData(row), now)));
  // session.completed calls markEnded back through liveCompleted
  await handleEvent(ctx, { type: "session.completed", sessionId: liveId, minutes, at: iso(now) });
  const after = ctx.store.getLiveSession(liveId)!;
  if (after.state !== "ended") markEnded(ctx, liveId);
  return liveData(ctx.store.getLiveSession(liveId)!).summary ?? sessionSummary(ctx, liveId);
}

function markEnded(ctx: LasContext, liveId: string): void {
  const now = nowOf(ctx);
  const row = mutate(ctx, liveId, (r, d) => {
    if (r.state === "ended") return;
    d.summary = liveSummary(ctx, liveId, d);
    if (d.queuedId) ctx.store.deleteCoachScreen(d.queuedId);
    d.queuedId = d.waitingSince = d.deadlineAt = undefined;
    if (d.pausedAt) {
      d.pausedTotalS += ageS(d.pausedAt, now);
      d.pausedAt = undefined;
    }
    return { patch: { state: "ended", endedAt: iso(now), waitOpen: false } };
  }).row;
  publish(ctx, row);
}

// ------------------------------------------------------------------ studio events (§6) and the server's own

/** The live coach's studio events (POST /api/events): the director reacts and queues coach events. */
export async function onStudioEvent(ctx: LasContext, event: Extract<StudioEvent, { sessionId: string }>): Promise<Record<string, unknown>> {
  const now = nowOf(ctx);
  const at = iso(now);
  const live = openLive(ctx, event.sessionId);
  if (!live) return { sessionId: event.sessionId, live: false };
  mutate(ctx, live.id, () => ({ patch: { studioSeenAt: at } }));
  switch (event.type) {
    case "screen.viewed": {
      const scr = screenById(ctx, event.screenId);
      if (!scr || scr.liveSessionId !== live.id) return { unknownScreen: event.screenId };
      const prev = event.previous ? screenById(ctx, event.previous.screenId) : undefined;
      if (!scr.shownAt) ctx.store.updateCoachScreen(scr.id, { shownAt: at });
      const id = queueEvent(ctx, live.id, { type: "screen.viewed", screenId: event.screenId, kind: scr.kind as ScreenKind, source: scr.source, previous: event.previous && prev ? { screenId: prev.id, kind: prev.kind as ScreenKind, seconds: event.previous.seconds } : undefined, at });
      return { eventId: id };
    }
    case "card.answered":
      return { eventId: queueEvent(ctx, live.id, { type: "card.answered", screenId: event.screenId, card: event.card, cardType: event.cardType, answer: event.answer, correct: event.correct, seconds: event.seconds, at }) };
    case "learner.asked":
      return { eventId: queueEvent(ctx, live.id, { type: "learner.asked", screenId: event.screenId, text: event.text, at }) };
    case "learner.hesitated": {
      // once per screen
      const d = liveData(live);
      if (d.hesitated.includes(event.screenId)) return { duplicate: true };
      mutate(ctx, live.id, (_r, dd) => void dd.hesitated.push(event.screenId));
      return { eventId: queueEvent(ctx, live.id, { type: "learner.hesitated", screenId: event.screenId, seconds: event.seconds, at }) };
    }
    case "session.paused": {
      const id = queueEvent(ctx, live.id, { type: "session.paused", reason: event.reason, at });
      pause(ctx, live.id, event.reason, now);
      return { eventId: id, state: "paused" };
    }
    case "session.resumed": {
      const r = resume(ctx, live.id, now);
      const id = queueEvent(ctx, live.id, { type: "session.resumed", pausedSeconds: event.pausedSeconds || r.pausedSeconds, at });
      return { eventId: id, state: r.row.state };
    }
    case "session.left": {
      const id = queueEvent(ctx, live.id, { type: "session.left", reason: event.reason, at });
      pause(ctx, live.id, event.reason === "studio-offline" ? "studio-offline" : "closed", now);
      return { eventId: id, state: "paused" };
    }
    case "plan.chosen":
      return applyPlanChoice(ctx, live, event.screenId, event.optionId, now);
    default:
      return {};
  }
}

/** The learner tapped an option on a plan screen (§10): the server applies it and logs it as a plan change. */
function applyPlanChoice(ctx: LasContext, live: LiveSessionRow, screenId: string, optionId: string, now: Date): Record<string, unknown> {
  const scr = screenById(ctx, screenId);
  const input = (scr?.screen as CoachScreen | undefined)?.input;
  if (!scr || scr.liveSessionId !== live.id || !input || input.kind !== "plan") throw new LoopError(`"${screenId}" isn't a plan screen of this session.`);
  if ((scr.screen as { chosen?: string }).chosen) return { duplicate: true, optionId: (scr.screen as { chosen?: string }).chosen };
  const opt: PlanOption | undefined = input.options.find((o) => o.id === optionId);
  if (!opt) throw new LoopError(`"${optionId}" isn't an option on this screen: ${input.options.map((o) => o.id).join(", ")}.`);
  const sk = live.enrollmentId;
  const a = opt.action;
  const changes: string[] = [];
  const split = (v: string) => {
    const [o, ...rest] = v.split(":");
    return { o, value: rest.length ? rest.join(":") : undefined };
  };
  if (a.kind === "replan") {
    const { o, value } = split(a.option);
    changes.push(replan(ctx, sk, o, value, now).change);
  } else if (a.kind === "reschedule") {
    if (a.days) changes.push(replan(ctx, sk, "change-days", a.days, now).change);
    if (a.minutesPerWeek !== undefined) changes.push(replan(ctx, sk, "change-minutes", a.minutesPerWeek, now).change);
    if (a.targetDate) changes.push(replan(ctx, sk, "later-date", a.targetDate, now).change);
  } else if (a.kind === "checkin") {
    changes.push(answerCheckin(ctx, input.checkinId!, a.option, now).message);
  }
  ctx.store.logPlanChange(sk, `coach-plan:${screenId}`, `${optionId}${a.kind === "none" ? "" : `:${a.kind}`}`);
  ctx.store.updateCoachScreen(scr.id, { screen: { ...(scr.screen as object), chosen: optionId } });
  const change = changes.filter(Boolean).join(" ") || "Nothing changes.";
  const eventId = queueEvent(ctx, live.id, { type: "plan.chosen", screenId, optionId, label: opt.label, change });
  return { optionId, change, eventId };
}

/** drill.answered (§6): each knowledge item, and each drill's outcome with `done` and the full outcome. */
export function liveDrillAnswered(ctx: LasContext, sessionId: string | undefined, ev: { drillId: string; itemId?: string; correct?: boolean; success?: boolean; score?: number; difficulty: number; changed?: "up" | "down" | null; mastery?: { nodeId: string; before: number; after: number }[]; done: boolean; outcome?: Record<string, unknown> }): void {
  const live = openLive(ctx, sessionId);
  if (!live) return;
  queueEvent(ctx, live.id, { type: "drill.answered", drillId: ev.drillId, itemId: ev.itemId, correct: ev.correct, success: ev.success, score: ev.score, difficulty: ev.difficulty, changed: ev.changed ?? "none", mastery: ev.mastery ?? [], done: ev.done, outcome: ev.outcome });
}

/** pain.reported (§6): the server already lowered intensity (reportPainState); the event carries the cap. */
export function livePain(ctx: LasContext, enrollmentId: string, area: string, level: number, cap: number, stopToday: boolean): void {
  const live = ctx.store.openLiveSession(enrollmentId);
  if (!live) return;
  queueEvent(ctx, live.id, { type: "pain.reported", area, level, intensityCap: cap });
  const row = mutate(ctx, live.id, (_r, d) => {
    if (stopToday) d.stop = true;
    // a queued drill above the new cap never shows
    const q = screenById(ctx, d.queuedId);
    const qi = (q?.screen as CoachScreen | undefined)?.item as { type?: string; drill?: Drill } | undefined;
    if (q && qi?.type === "drill" && qi.drill && qi.drill.intensity > cap) {
      ctx.store.deleteCoachScreen(q.id);
      d.queuedId = undefined;
    }
  }).row;
  publish(ctx, row);
}

/** attempt.analyzed (§6): the analysis, up to 3 key frames by reference (never media), the proof result and the top-mistake pick. */
export function liveAnalyzed(ctx: LasContext, attempt: AttemptRow, analysis: Analysis, proof?: unknown): void {
  const live = openLive(ctx, attempt.sessionId) ?? ctx.store.openLiveSession(attempt.enrollmentId);
  if (!live) return;
  let st: SkState;
  try {
    st = loadSk(ctx, attempt.enrollmentId);
  } catch {
    return;
  }
  const ref = (r: string, i: number) => (/^data:/i.test(r) ? `attempt:${attempt.id}/frame/${i}` : r);
  const frames = analysis.keyFrames.length ? analysis.keyFrames.slice(0, 3).map((f, i) => ({ t: f.t, ref: ref(f.ref, i), label: f.label?.slice(0, 40) })) : analysis.markers.slice(0, 3).map((m) => ({ t: m.t, ref: `attempt:${attempt.id}@${m.t}`, label: m.label.slice(0, 40) }));
  // the analysis without media or bulky overlay data
  const lean: Analysis = { ...analysis, overlay: undefined, keyFrames: analysis.keyFrames.slice(0, 3).map((f, i) => ({ ...f, ref: ref(f.ref, i) })) };
  const top = pickTopMistake(st.model, analysis, ctx.store.getMistakeStates(st.enrollment.id), disputedFor(ctx, st.enrollment.id, attempt.id));
  const mk = top ? st.model.mistakes.find((x) => x.id === top.mistake.id) : undefined;
  queueEvent(ctx, live.id, {
    type: "attempt.analyzed",
    attemptId: attempt.id,
    drillId: attempt.drillId,
    analysis: lean,
    keyFrames: frames,
    proof: proof && typeof proof === "object" ? (proof as Record<string, unknown>) : undefined,
    top: top ? { mistakeId: top.mistake.id, name: mk?.name ?? top.mistake.id, confidence: top.mistake.confidence, severity: top.mistake.severity, fixDrillId: mk?.fix_drill } : undefined
  });
}

/** session.completed for a live session (the studio's, or endLive's own): the live session ends too. */
export function liveCompleted(ctx: LasContext, sessionId: string): void {
  if (openLive(ctx, sessionId)) markEnded(ctx, sessionId);
}

/** A knowledge drill the coach brought its own items for (start_drill and drill.outcome find it here). */
export function coachDrill(ctx: LasContext, sessionId: string | undefined, drillId: string): { drill: Drill; items: KnowledgeItem[] } | undefined {
  if (!sessionId || !drillId.startsWith("coach.")) return undefined;
  const row = ctx.store.getLiveSession(sessionId);
  return row ? liveData(row).coachDrills[drillId] : undefined;
}

// ------------------------------------------------------------------ the coach's tools (§3.1)

const LOOP = "Loop: coach_wait → read the events → coach_show the next screen (or \"suggested\") → coach_wait, until coach_end. A heartbeat means call coach_wait again.";

/** The process-and-context holder check. Returns the row after attaching, or throws with what to do next. */
function holderCheck(ctx: LasContext, row: LiveSessionRow, now: Date, opts: { attach: boolean; client?: string; coachSessionId?: string }): { row: LiveSessionRow; reattached: boolean; tookOver: boolean } {
  const mine = tokensOf(ctx).get(row.id);
  if (mine && mine === row.coachToken) return { row, reattached: true, tookOver: false };
  const s = coachSettings(ctx);
  if (mine && row.coachToken && mine !== row.coachToken) {
    tokensOf(ctx).delete(row.id);
    throw new LoopError(`Another coach took over this session (${row.client ?? "another client"}). Stop the loop: tell the learner in a few words that the coach continues there.`, { instruction: "Stop calling coach tools for this session." });
  }
  if (row.coachToken && isPresent(row, s, now)) throw new LoopError(`Another coach is coaching this session right now (${row.client ?? "another client"}). Don't start a second one: tell the learner to continue there, or try again after that coach has been away for ${s.presenceWindowS} s.`, { holder: row.client ?? null });
  if (!opts.attach) throw new LoopError("You don't hold this session. Call coach_start first.");
  const token = randomUUID();
  const from = row.client;
  const had = !!row.coachToken;
  const next = mutate(ctx, row.id, (r, d) => {
    if (had) d.takeovers.push({ at: iso(now), from, to: opts.client });
    return { patch: { coachToken: token, coachPid: process.pid, client: opts.client ?? r.client, coachSessionId: opts.coachSessionId ?? r.coachSessionId, lastWaitAt: iso(now), leftOnPurpose: false, waitOpen: false, state: r.state === "coach-away" ? "live" : r.state } };
  }).row;
  if (had) ctx.store.logEvent(row.enrollmentId, "coach.takeover", { liveSessionId: row.id, from: from ?? null, to: opts.client ?? null, at: iso(now) });
  tokensOf(ctx).set(row.id, token);
  publish(ctx, next);
  return { row: next, reattached: false, tookOver: had };
}

export interface CoachStartInput {
  sk: string;
  minutes?: number;
  location?: string;
  client?: string;
  clientSessionId?: string;
}

/** coach_start: plans the session (advice), opens or re-attaches the live session, returns the first state and suggestion. */
export async function coachStart(ctx: LasContext, input: CoachStartInput & { discoveredSessionId?: string }): Promise<CoachStartResult> {
  const now = nowOf(ctx);
  const st = loadSk(ctx, input.sk);
  if (st.enrollment.status === "paused") throw new LoopError("This skill is paused. Ask the learner whether to resume (replan with option resume) first.");
  const coachSessionId = input.clientSessionId ?? input.discoveredSessionId;
  let row = await closeStale(ctx, st, now);
  let reattached = false;
  if (row) {
    const h = holderCheck(ctx, row, now, { attach: true, client: input.client, coachSessionId });
    reattached = h.reattached;
    row = mutate(ctx, row.id, (r) => ({ patch: { lastWaitAt: iso(now), leftOnPurpose: false, state: r.state === "coach-away" ? "live" : r.state, client: input.client ?? r.client, coachSessionId: coachSessionId ?? r.coachSessionId } })).row;
    publish(ctx, row);
  } else {
    const token = randomUUID();
    row = createLive(ctx, st, { minutes: input.minutes, location: input.location, state: "live", coach: { token, client: input.client, coachSessionId } }, now);
    tokensOf(ctx).set(row.id, token);
  }
  const plan = planOf(ctx, row.id)!;
  const entries = planEntries(st, plan);
  const data = liveData(row);
  return {
    liveSessionId: row.id,
    sk: st.enrollment.id,
    skill: st.model.name,
    reattached,
    state: liveState(ctx, row, st, now),
    plan: { title: plan.title, minutes: plan.minutes, focus: plan.focus, blocks: plan.blocks.map((b) => ({ kind: b.kind, minutes: b.minutes, reason: b.reason, title: b.title })) },
    suggestion: suggestionOf(entries, data),
    studioPath: `/app/session/${row.id}`,
    instruction: `${reattached ? "Re-attached to the open session. " : ""}Give the learner the studio link once. Show the first screen with coach_show (write it for this learner, or "suggested"), then ${LOOP}`
  };
}

export interface CoachWaitOptions {
  timeoutS?: number;
  /** the id of the last event the coach has handled; by default the last event of the previous batch */
  ack?: string;
  signal?: AbortSignal;
  /** progress while waiting (MCP progress notifications) */
  onProgress?: (waitedS: number, totalS: number) => void | Promise<void>;
}

/** coach_wait (§3.2): blocks until events arrive, the learner waits for a screen, the session ends, or the timeout (a heartbeat). */
export async function coachWait(ctx: LasContext, sk: string, opts: CoachWaitOptions = {}): Promise<CoachWaitResult> {
  const clock = clockOf(ctx);
  const s = coachSettings(ctx);
  const st = loadSk(ctx, sk);
  let now = clock.now();
  let row = ctx.store.openLiveSession(st.enrollment.id);
  if (!row) {
    const last = ctx.store.listLiveSessions({ enrollmentId: st.enrollment.id, limit: 1 })[0];
    if (last && last.state === "ended" && tokensOf(ctx).has(last.id)) return waitResult(ctx, last, st, [], now, "The session ended. Call coach_end for the summary, then say a few words to the learner.");
    throw new LoopError("No live session for this skill. Call coach_start first.");
  }
  row = holderCheck(ctx, row, now, { attach: true }).row;
  const liveId = row.id;
  const timeoutS = Math.max(1, Math.min(opts.timeoutS ?? s.waitDefaultS, s.waitMaxS));
  // acknowledge what the coach has seen: the previous batch, or up to the id it names
  row = mutate(ctx, liveId, (r, d) => {
    const ack = opts.ack !== undefined && /^\d+$/.test(opts.ack) ? Number(opts.ack) : Math.max(0, ...d.lastBatch);
    if (ack > 0) ctx.store.db.run("UPDATE coach_event SET delivered_at = ? WHERE live_session_id = ? AND delivered_at IS NULL AND id <= ?", iso(now), liveId, ack);
    d.lastBatch = [];
    return { patch: { waitOpen: true, lastWaitAt: iso(now), leftOnPurpose: false, state: r.state === "coach-away" ? "live" : r.state } };
  }).row;
  publish(ctx, row);
  const started = now.getTime();
  let lastProgress = started;
  const done = (r: LiveSessionRow, events: CoachEvent[], instruction: string, heartbeat = false) => {
    const fin = mutate(ctx, liveId, (_r, d) => {
      if (events.length && !opts.signal?.aborted) d.lastBatch = events.map((e) => Number(e.id));
      return { patch: { waitOpen: false, lastWaitAt: iso(clock.now()) } };
    }).row;
    publish(ctx, fin);
    return waitResult(ctx, fin.state === "ended" ? fin : r, st, events, clock.now(), instruction, heartbeat);
  };
  try {
    for (;;) {
      now = clock.now();
      row = (await tick(ctx, liveId, now)) ?? row;
      if (row.state === "ended") return done(row, pendingEvents(ctx, liveId), "The session ended. Call coach_end for the summary, then say a few words to the learner.");
      if (row.coachToken !== tokensOf(ctx).get(liveId)) throw new LoopError(`Another coach took over this session (${row.client ?? "another client"}). Stop the loop: tell the learner in a few words.`);
      let events = pendingEvents(ctx, liveId);
      if (events.length) {
        // a burst arrives together (a drill answer and the screen.viewed after it)
        await clock.sleep(s.batchWindowMs, opts.signal);
        events = pendingEvents(ctx, liveId);
        const r = ctx.store.getLiveSession(liveId)!;
        return done(r, events, instructionFor(r, events));
      }
      const d = liveData(row);
      if (row.state !== "paused" && d.waitingSince && !d.queuedId && d.waitNotified !== d.waitingSince) {
        mutate(ctx, liveId, (_r, dd) => void (dd.waitNotified = dd.waitingSince));
        return done(row, [], `The learner finished the screen and is waiting: show the next screen now (coach_show), before ${d.deadlineAt}, then call coach_wait.`);
      }
      if (opts.signal?.aborted) return done(row, [], "Cancelled. Call coach_wait again.");
      const waited = (now.getTime() - started) / 1000;
      if (waited >= timeoutS) return done(row, [], "Nothing happened. Call coach_wait again now; don't reply in the chat.", true);
      if (opts.onProgress && now.getTime() - lastProgress >= s.progressEveryS * 1000) {
        lastProgress = now.getTime();
        try {
          await opts.onProgress(Math.round(waited), timeoutS);
        } catch {
          /* a client that can't take progress still gets its result */
        }
      }
      await sleepOrWake(ctx, Math.min(s.pollMs, Math.max(1, (timeoutS - waited) * 1000)), opts.signal);
    }
  } catch (e) {
    if (ctx.store.getLiveSession(liveId)) mutate(ctx, liveId, () => ({ patch: { waitOpen: false, lastWaitAt: iso(clock.now()) } }));
    throw e;
  }
}

function pendingEvents(ctx: LasContext, liveId: string): CoachEvent[] {
  return ctx.store.pendingCoachEvents(liveId).map(eventOf);
}

function instructionFor(row: LiveSessionRow, events: CoachEvent[]): string {
  const types = new Set(events.map((e) => e.type));
  if (row.state === "paused" && !types.has("session.resumed")) return "The learner paused or left. Call coach_wait again; queue the next screen if you like, it shows when they come back.";
  if (types.has("pain.reported")) return "Pain was reported and intensity is already lower. Show a short message, then an easier screen or coach_end; suggest a professional if it continues. Then call coach_wait.";
  if (types.has("learner.asked")) return "Answer the question in a short message (coach_show kind message, replyTo its id), then back to practice. Then call coach_wait.";
  return "Read the events (skip ids you've seen), show the next screen with coach_show (or \"suggested\"), then call coach_wait again.";
}

function waitResult(ctx: LasContext, row: LiveSessionRow, st: SkState, events: CoachEvent[], now: Date, instruction: string, heartbeat = false): CoachWaitResult {
  const entries = planEntries(st, planOf(ctx, row.id));
  return { liveSessionId: row.id, sk: st.enrollment.id, events, heartbeat: heartbeat ? true : undefined, state: liveState(ctx, row, st, now), suggestion: row.state === "ended" ? undefined : suggestionOf(entries, liveData(row)), instruction };
}

/** coach_show (§7): validates one screen and shows it (a message at once; anything else as the next screen). */
export function coachShow(ctx: LasContext, sk: string, screen: unknown): CoachShowResult {
  const now = nowOf(ctx);
  const st = loadSk(ctx, sk);
  const open = ctx.store.openLiveSession(st.enrollment.id);
  if (!open) {
    const last = ctx.store.listLiveSessions({ enrollmentId: st.enrollment.id, limit: 1 })[0];
    if (last?.state === "ended" && tokensOf(ctx).has(last.id)) throw new LoopError("The session has ended. Call coach_end for the summary, then say a few words to the learner.");
    throw new LoopError("No live session for this skill. Call coach_start first.");
  }
  const row = holderCheck(ctx, open, now, { attach: false }).row;
  const data = liveData(row);
  const entries = planEntries(st, planOf(ctx, row.id));
  const sugE = suggestionEntry(entries, data);
  const screenId = newScreenId();
  const sc: ScreenContext = { ctx, st, liveSessionId: row.id, screenId, now, location: data.location, block: data.block, suggestion: sugE ? { item: sugE.item, block: sugE.block, index: sugE.index } : undefined, summary: () => liveSummary(ctx, row.id, data) };
  const cur = screenById(ctx, data.currentId);
  const current = cur ? { id: cur.id, kind: cur.kind as ScreenKind, source: cur.source } : undefined;
  const reject = (errors: ScreenIssue[], instruction: string): CoachShowResult => ({ ok: false, errors, current, instruction });

  // the shortcut: the planner's suggestion with its pre-written content
  if (screen === "suggested" || (screen as { kind?: string } | null)?.kind === "suggested") {
    if (!sugE) return reject([{ path: "screen", message: "nothing left to suggest: show a wrapup, or call coach_end" }], "Show a wrapup screen or call coach_end.");
    if (!sugE.buildable) return reject([{ path: "screen", message: `the suggestion (${describeItem(sugE.item)}) has no pre-written content` }], "Write that screen yourself (for a lesson: kind lesson with its nodes and 1–5 cards), then call coach_wait.");
    const out = mutate<CoachShowResult>(ctx, row.id, (r, d) => ({ out: place(ctx, r, d, entryScreen(ctx, st, r.id, d, sugE, "coach", now), now) }));
    publish(ctx, out.row);
    return out.out!;
  }

  const checked = checkScreen(sc, screen);
  if (!checked.ok || !checked.input) return reject(checked.errors, "Nothing was shown. Fix these and call coach_show again; the learner keeps the current screen (the fallback shows after the screen deadline).");
  const res = resolveScreen(sc, checked.input);
  const out = mutate<CoachShowResult>(ctx, row.id, (r, d) => {
    if (res.coachDrill) d.coachDrills[res.coachDrill.drill.id] = res.coachDrill;
    for (const n of res.nodes) if (!d.nodes.includes(n)) d.nodes.push(n);
    const scr = addScreen(ctx, r.id, { id: screenId, kind: res.kind, source: "coach", block: res.block, item: res.item, input: res.input, reason: res.reason, replyTo: res.replyTo }, now);
    if (res.matchesSuggestion && sugE) d.planIndex[scr.id] = sugE.index;
    else if (sugE && res.reason && ["lesson", "drill", "capture", "wrapup"].includes(res.kind)) {
      // an override is logged so the planner's weights can still be tuned (§10)
      ctx.store.logPlanner(r.id, { at: iso(now), by: "coach", suggested: { block: sugE.block, item: describeItem(sugE.item), type: sugE.item.type }, chosen: { kind: res.kind, screenId: scr.id, item: describeItem(res.item as SessionItem) }, reason: res.reason });
    }
    if (res.kind === "message") {
      ctx.store.updateCoachScreen(scr.id, { shownAt: iso(now) });
      d.messageId = scr.id;
      const leaving = res.input.kind === "message" && res.input.leaving;
      return { patch: leaving ? { leftOnPurpose: true, state: r.state === "live" ? "coach-away" : r.state } : {}, out: { ok: true, errors: [], screenId: scr.id, status: "shown", current, instruction: leaving ? "You left on purpose: the session continues on fallback content. coach_start brings you back." : "Shown over the current screen. Call coach_wait." } };
    }
    return { out: place(ctx, r, d, scr, now) };
  });
  publish(ctx, out.row);
  return out.out!;
}

/** Shows a screen at once when the learner is waiting (or has nothing yet), else queues it in place of any earlier one. */
function place(ctx: LasContext, r: LiveSessionRow, d: LiveData, scr: CoachScreenRow, now: Date): CoachShowResult {
  const waiting = (!!d.waitingSince || !d.currentId) && r.state !== "paused";
  if (waiting) {
    makeCurrent(ctx, d, scr, now);
    return { ok: true, errors: [], screenId: scr.id, status: "shown", current: { id: scr.id, kind: scr.kind as ScreenKind, source: scr.source }, instruction: "Shown now. Call coach_wait." };
  }
  if (d.queuedId && d.queuedId !== scr.id) {
    const old = screenById(ctx, d.queuedId);
    if (old) {
      ctx.store.deleteCoachScreen(old.id);
      delete d.planIndex[old.id];
    }
  }
  d.queuedId = scr.id;
  const cur = screenById(ctx, d.currentId);
  return { ok: true, errors: [], screenId: scr.id, status: "queued", current: cur ? { id: cur.id, kind: cur.kind as ScreenKind, source: cur.source } : undefined, instruction: "Queued: it shows when the learner finishes the current screen (a newer coach_show replaces it). Call coach_wait." };
}

/** coach_end: shows the fallback wrap-up if none was shown, ends the session, returns the summary. */
export async function coachEnd(ctx: LasContext, sk: string): Promise<CoachEndResult> {
  const now = nowOf(ctx);
  const st = loadSk(ctx, sk);
  const open = ctx.store.openLiveSession(st.enrollment.id);
  const instruction = "Say a few words to the learner in the chat: what changed and the one fix. Don't repeat the whole summary.";
  if (!open) {
    const last = ctx.store.listLiveSessions({ enrollmentId: st.enrollment.id, limit: 1 })[0];
    if (last?.state === "ended") return { liveSessionId: last.id, sk: st.enrollment.id, summary: liveData(last).summary ?? sessionSummary(ctx, last.id), instruction };
    throw new LoopError("No live session for this skill.");
  }
  holderCheck(ctx, open, now, { attach: true });
  const row = mutate(ctx, open.id, (r, d) => {
    if (!d.wrapupShown) {
      const entries = planEntries(st, planOf(ctx, r.id));
      makeCurrent(ctx, d, entryScreen(ctx, st, r.id, d, entries.find((e) => e.item.type === "wrapup")!, "fallback", now), now);
    }
  }).row;
  publish(ctx, row);
  const summary = await endLive(ctx, open.id);
  tokensOf(ctx).delete(open.id);
  return { liveSessionId: open.id, sk: st.enrollment.id, summary, instruction };
}
