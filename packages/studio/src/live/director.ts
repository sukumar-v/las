/**
 * The studio's side of the session director (live-coach §8): what the live runner holds, how each stream message
 * and each resync changes it, what the presence pill says, and the advance loop that waits for a slow coach
 * until the screen deadline. Pure or dependency-injected, so each rule is tested without a browser.
 */
import { COACH_DEFAULTS, type CoachMessageView, type CoachScreen, type LiveState, type LiveView, type SummaryView } from "@las/schema";
import type { PresenceStatus } from "@las/ui";
import type { AdvanceResult, Api } from "../api.js";

export interface LiveModel {
  sessionId: string;
  state: LiveState;
  coachPresent: boolean;
  leftOnPurpose: boolean;
  screen?: CoachScreen;
  message?: CoachMessageView;
  /** messages the learner closed, by screen id */
  dismissed: string[];
  /** the learner finished a screen and the coach is writing the next one */
  waiting?: { until: string; after: string };
  summary?: SummaryView;
  minutesUsed: number;
  minutesPlanned: number;
}

export type LiveAction =
  | { type: "sync"; view: LiveView }
  | { type: "coach.screen"; liveSessionId: string; screen: CoachScreen }
  | { type: "coach.message"; liveSessionId: string; message: CoachMessageView }
  | { type: "coach.state"; liveSessionId: string; state: LiveState; coachPresent: boolean; leftOnPurpose?: boolean }
  | { type: "coach.ended"; liveSessionId: string; summary?: SummaryView }
  | { type: "ping"; state: LiveState; coachPresent: boolean }
  | { type: "waiting"; until: string; after: string }
  | { type: "waited" }
  | { type: "dismiss"; screenId: string };

export function initialModel(sessionId: string): LiveModel {
  return { sessionId, state: "idle", coachPresent: false, leftOnPurpose: false, dismissed: [], minutesUsed: 0, minutesPlanned: 0 };
}

function isMessageScreen(s: CoachScreen | undefined): boolean {
  return !!s && (s.kind === "message" || (s.item as { type?: string } | undefined)?.type === "message");
}

function withMessage(m: LiveModel, msg: CoachMessageView | undefined): LiveModel {
  if (!msg) return m;
  return { ...m, message: msg, leftOnPurpose: msg.leaving ? true : m.leftOnPurpose };
}

/** A new screen ends any wait; the same screen keeps it (we're still waiting for the coach's next one). */
function withScreen(m: LiveModel, s: CoachScreen | undefined): LiveModel {
  if (!s) return m;
  if (isMessageScreen(s)) return withMessage(m, s.item as CoachMessageView);
  const waiting = m.waiting && s.id === m.waiting.after ? m.waiting : undefined;
  return { ...m, screen: s, waiting };
}

export function reduceLive(m: LiveModel, a: LiveAction): LiveModel {
  switch (a.type) {
    case "sync": {
      const v = a.view;
      if (v.liveSessionId !== m.sessionId) return m;
      let next: LiveModel = { ...m, state: v.state, coachPresent: v.coachPresent, leftOnPurpose: v.leftOnPurpose, minutesUsed: v.minutesUsed, minutesPlanned: v.minutesPlanned };
      next = withScreen(next, v.screen);
      next = withMessage(next, v.message);
      if (v.state === "ended") next = { ...next, waiting: undefined, summary: v.summary ?? next.summary };
      return next;
    }
    case "coach.screen":
      return a.liveSessionId === m.sessionId ? withScreen(m, a.screen) : m;
    case "coach.message":
      return a.liveSessionId === m.sessionId ? withMessage(m, a.message) : m;
    case "coach.state":
      if (a.liveSessionId !== m.sessionId) return m;
      return { ...m, state: a.state, coachPresent: a.coachPresent, leftOnPurpose: a.leftOnPurpose ?? m.leftOnPurpose };
    case "coach.ended":
      return a.liveSessionId === m.sessionId ? { ...m, state: "ended", waiting: undefined, summary: a.summary ?? m.summary } : m;
    case "ping":
      return { ...m, state: a.state, coachPresent: a.coachPresent };
    case "waiting":
      return { ...m, waiting: { until: a.until, after: a.after } };
    case "waited":
      return { ...m, waiting: undefined };
    case "dismiss":
      return m.dismissed.includes(a.screenId) ? m : { ...m, dismissed: [...m.dismissed, a.screenId] };
  }
}

/** The presence pill: thinking while we wait for the coach, here, away, or left on purpose. */
export function presenceOf(m: Pick<LiveModel, "waiting" | "coachPresent" | "leftOnPurpose">): PresenceStatus {
  if (m.waiting) return "thinking";
  if (m.coachPresent) return "here";
  return m.leftOnPurpose ? "left" : "away";
}

/** The message to draw over the screen, unless the learner closed it. */
export function visibleMessage(m: Pick<LiveModel, "message" | "dismissed">): CoachMessageView | undefined {
  return m.message && !m.dismissed.includes(m.message.screenId) ? m.message : undefined;
}

/** The current block's fill, from minutes used out of planned. */
export function fillOf(m: Pick<LiveModel, "minutesUsed" | "minutesPlanned">): number {
  return m.minutesPlanned > 0 ? Math.max(0.15, Math.min(1, m.minutesUsed / m.minutesPlanned)) : 0.5;
}

export interface AdvanceDeps {
  advance: (body: { screenId: string; seconds?: number }) => Promise<AdvanceResult>;
  /** resolves with the coach's screen from the stream, or undefined once `untilMs` passes */
  waitForScreen: (untilMs: number) => Promise<CoachScreen | undefined>;
  onWaiting?: (until: string) => void;
  now?: () => number;
}

/**
 * The learner finished `screenId`. The director answers with the next screen, or asks us to wait for a present
 * coach until the screen deadline: then the coach's screen arrives on the stream, or we ask again after `until`
 * (the director serves the fallback once the deadline has passed). Gives up after a few rounds.
 */
export async function advanceToNext(deps: AdvanceDeps, body: { screenId: string; seconds?: number }, maxRounds = 4): Promise<{ screen?: CoachScreen; view?: LiveView }> {
  const now = deps.now ?? Date.now;
  let view: LiveView | undefined;
  for (let round = 0; round < maxRounds; round++) {
    const r = await deps.advance(body);
    view = r.view;
    if (r.screen) return { screen: r.screen, view };
    if (!r.waiting) return { screen: r.view?.screen && r.view.screen.id !== body.screenId ? r.view.screen : undefined, view };
    const untilMs = r.until ? Date.parse(r.until) : now() + COACH_DEFAULTS.screenDeadlineS * 1000;
    deps.onWaiting?.(new Date(untilMs).toISOString());
    const s = await deps.waitForScreen(untilMs);
    if (s) return { screen: s, view };
  }
  return { view };
}

export type RunnerKind = "live" | "plan";

/** `/app/session/:id` draws the live runner when the director has a live session for it, else the planned runner. */
export function runnerFor(view: Partial<LiveView> | null | undefined): RunnerKind {
  return view && typeof view.liveSessionId === "string" && view.state && view.state !== "idle" ? "live" : "plan";
}

export async function chooseRunner(api: Pick<Api, "live">, id: string): Promise<{ kind: RunnerKind; view?: LiveView }> {
  try {
    const view = await api.live(id);
    return { kind: runnerFor(view), view };
  } catch {
    // no live session (404), or a server without the live coach: the planned runner
    return { kind: "plan" };
  }
}

/** Today's Start: a live session (coach away until a coach joins); a server without live routes gets the planned session. */
export async function startSession(api: Pick<Api, "liveStart" | "nextSession">, sk: string, nextId?: string): Promise<{ kind: RunnerKind; id: string }> {
  try {
    const v = await api.liveStart({ sk });
    return { kind: "live", id: v.liveSessionId };
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status !== 404 && status !== 405) throw e;
    return { kind: "plan", id: nextId ?? (await api.nextSession(sk)).sessionId };
  }
}
