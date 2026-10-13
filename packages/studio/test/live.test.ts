import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COACH_DEFAULTS, StudioEventSchema, type Card, type CoachScreen, type LiveView, type StudioEvent } from "@las/schema";
import { cardAnswered, learnerAsked, learnerHesitated, planChosen, screenViewed, secondsBetween, sessionLeft, sessionPaused, sessionResumed } from "../src/live/events.js";
import { createHesitationTimer } from "../src/live/hesitation.js";
import { createEventQueue, isRetryable, memoryQueueStore } from "../src/live/queue.js";
import { advanceToNext, chooseRunner, fillOf, initialModel, presenceOf, reduceLive, runnerFor, startSession, visibleMessage } from "../src/live/director.js";
import { ApiError, type AdvanceResult } from "../src/api.js";

const T0 = Date.parse("2026-10-13T10:00:00Z");

function screen(id: string, kind: CoachScreen["kind"] = "lesson", item: unknown = { type: "lesson", lessonId: "l", title: "L", cards: [], nodes: [] }): CoachScreen {
  return { id, liveSessionId: "ses_1", kind, source: "fallback", block: "learn", item: item as CoachScreen["item"], queuedAt: new Date(T0).toISOString() };
}

function view(over: Partial<LiveView> = {}): LiveView {
  return { liveSessionId: "ses_1", sk: "sk_1", state: "coach-away", coachPresent: false, minutesUsed: 3, minutesPlanned: 30, leftOnPurpose: false, ...over };
}

describe("live events", () => {
  it("screen.viewed carries the seconds on the previous screen", () => {
    const ev = screenViewed("ses_1", "scr_2", { screenId: "scr_1", shownAt: T0 }, T0 + 42_400);
    expect(ev).toMatchObject({ type: "screen.viewed", sessionId: "ses_1", screenId: "scr_2", previous: { screenId: "scr_1", seconds: 42 } });
    expect(screenViewed("ses_1", "scr_1", undefined, T0)).toMatchObject({ previous: undefined });
    expect(secondsBetween(T0, T0 - 5000)).toBe(0);
  });

  it("card.answered for predict, compare and try-it, with correct when the card knows the answer", () => {
    const predict: Card = { type: "predict", text: "Which?", options: ["a", "b"], answer: 1 };
    const compare: Card = { type: "compare", text: "Which?", left: { kind: "figure", points: {}, segments: [] } as any, right: { kind: "figure", points: {}, segments: [] } as any, answer: "left" };
    const tryIt: Card = { type: "try-it", text: "Clap it", action: "tap-rhythm" };
    expect(cardAnswered("ses_1", "scr_1", 0, predict, { picked: 1, revealed: true }, 7.6)).toMatchObject({ card: 0, cardType: "predict", answer: 1, correct: true, seconds: 8 });
    expect(cardAnswered("ses_1", "scr_1", 0, predict, { picked: 0 }, 1)).toMatchObject({ correct: false });
    expect(cardAnswered("ses_1", "scr_1", 1, compare, { side: "right" }, 3)).toMatchObject({ card: 1, answer: "right", correct: false });
    expect(cardAnswered("ses_1", "scr_1", 1, { ...compare, answer: undefined } as Card, { side: "right" }, 3)).toMatchObject({ correct: undefined });
    expect(cardAnswered("ses_1", "scr_1", 2, tryIt, { interacted: true }, 3)).toMatchObject({ cardType: "try-it", answer: "tap-rhythm" });
    // no answer yet, or a card that takes none
    expect(cardAnswered("ses_1", "scr_1", 0, predict, {}, 1)).toBeUndefined();
    expect(cardAnswered("ses_1", "scr_1", 0, { type: "diagram", text: "x", figure: { kind: "figure", points: {}, segments: [] } } as any, { interacted: true }, 1)).toBeUndefined();
  });

  it("learner.asked trims to 280 characters and sends nothing for an empty box", () => {
    expect(learnerAsked("ses_1", "scr_1", "   ")).toBeUndefined();
    const ev = learnerAsked("ses_1", "scr_1", `  ${"x".repeat(400)}  `) as Extract<StudioEvent, { type: "learner.asked" }>;
    expect(ev.text.length).toBe(280);
    expect(learnerAsked("ses_1", undefined, " why? ")).toMatchObject({ type: "learner.asked", text: "why?" });
  });

  it("every event the runner sends is a valid studio event", () => {
    const all: (StudioEvent | undefined)[] = [
      screenViewed("ses_1", "scr_2", { screenId: "scr_1", shownAt: T0 }, T0 + 1000),
      cardAnswered("ses_1", "scr_1", 0, { type: "predict", text: "?", options: ["a", "b"], answer: 0 }, { picked: 0 }, 2),
      learnerAsked("ses_1", "scr_1", "Why the knee?"),
      learnerHesitated("ses_1", "scr_1", 20),
      sessionPaused("ses_1"),
      sessionResumed("ses_1", 61.4),
      sessionLeft("ses_1"),
      planChosen("ses_1", "scr_plan", "keep")
    ];
    for (const ev of all) expect(StudioEventSchema.safeParse(ev).success, JSON.stringify(ev)).toBe(true);
    expect(sessionResumed("ses_1", 61.4)).toMatchObject({ pausedSeconds: 61 });
    expect(sessionLeft("ses_1")).toMatchObject({ reason: "closed" });
  });
});

describe("hesitation timer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once per screen after the hesitation time with no action", () => {
    const fired: [string, number][] = [];
    const h = createHesitationTimer({ onHesitate: (id, s) => fired.push([id, s]) });
    h.start("scr_1");
    vi.advanceTimersByTime(COACH_DEFAULTS.hesitationS * 1000 - 1);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([["scr_1", COACH_DEFAULTS.hesitationS]]);
    // once per screen: more idle time, activity, or coming back to it does nothing
    vi.advanceTimersByTime(60_000);
    h.activity();
    h.start("scr_1");
    vi.advanceTimersByTime(60_000);
    expect(fired.length).toBe(1);
    // a new screen counts again
    h.start("scr_2");
    vi.advanceTimersByTime(20_000);
    expect(fired.map((f) => f[0])).toEqual(["scr_1", "scr_2"]);
  });

  it("starts the count again on any action", () => {
    const fired: string[] = [];
    const h = createHesitationTimer({ seconds: 20, onHesitate: (id) => fired.push(id) });
    h.start("scr_1");
    vi.advanceTimersByTime(15_000);
    h.activity();
    vi.advanceTimersByTime(15_000);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(5_000);
    expect(fired).toEqual(["scr_1"]);
  });

  it("never fires while recording, and fires after the recording when the learner is idle again", () => {
    let recording = true;
    const fired: string[] = [];
    const h = createHesitationTimer({ seconds: 20, onHesitate: (id) => fired.push(id), isRecording: () => recording });
    h.start("scr_cap");
    vi.advanceTimersByTime(65_000);
    expect(fired).toEqual([]);
    recording = false;
    vi.advanceTimersByTime(20_000);
    expect(fired).toEqual(["scr_cap"]);
  });

  it("stop cancels the count (pause, waiting for the coach, the end)", () => {
    const fired: string[] = [];
    const h = createHesitationTimer({ seconds: 20, onHesitate: (id) => fired.push(id) });
    h.start("scr_1");
    vi.advanceTimersByTime(10_000);
    h.stop();
    h.activity();
    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
    expect(h.fired("scr_1")).toBe(false);
  });
});

describe("offline event queue", () => {
  const ev = (n: number): StudioEvent => ({ type: "learner.hesitated", sessionId: "ses_1", screenId: `scr_${n}`, seconds: n });

  it("sends in order, holds everything behind a network failure, and sends the rest in order on reconnect", async () => {
    const sent: number[] = [];
    let online = true;
    const states: boolean[] = [];
    const store = memoryQueueStore();
    const q = createEventQueue({
      store,
      send: async (e) => {
        if (!online) throw new ApiError("Can't reach the LAS server", 0);
        sent.push((e as any).seconds);
      },
      onChange: (s) => states.push(s.online)
    });
    await q.push(ev(1));
    online = false;
    await q.push(ev(2));
    await q.push(ev(3));
    await q.push(ev(4));
    expect(sent).toEqual([1]);
    expect(q.online()).toBe(false);
    expect(q.pending().map((e: any) => e.seconds)).toEqual([2, 3, 4]);
    // kept for a reload, too
    expect(store.load().map((e: any) => e.seconds)).toEqual([2, 3, 4]);
    online = true;
    await q.flush();
    expect(sent).toEqual([1, 2, 3, 4]);
    expect(q.pending()).toEqual([]);
    expect(q.online()).toBe(true);
    expect(states).toContain(false);
  });

  it("drops an event the server refuses so it never blocks the ones behind it", async () => {
    const sent: number[] = [];
    const refused: number[] = [];
    const q = createEventQueue({
      send: async (e) => {
        if ((e as any).seconds === 2) throw new ApiError("invalid event", 400);
        sent.push((e as any).seconds);
      },
      onRefused: (e) => refused.push((e as any).seconds)
    });
    await Promise.all([q.push(ev(1)), q.push(ev(2)), q.push(ev(3))]);
    await q.flush();
    expect(sent).toEqual([1, 3]);
    expect(refused).toEqual([2]);
    expect(isRetryable(new ApiError("x", 503))).toBe(true);
    expect(isRetryable(new ApiError("x", 422))).toBe(false);
  });

  it("picks up what an earlier page left in its store, first", async () => {
    const store = memoryQueueStore();
    store.save([ev(1), ev(2)]);
    const sent: number[] = [];
    const q = createEventQueue({ store, send: async (e) => void sent.push((e as any).seconds) });
    await q.push(ev(3));
    await q.flush();
    expect(sent).toEqual([1, 2, 3]);
  });

  it("an event pushed while one is in flight goes out after it", async () => {
    const sent: number[] = [];
    let release: () => void = () => undefined;
    const q = createEventQueue({
      send: (e) =>
        (e as any).seconds === 1
          ? new Promise<void>((r) => {
              release = () => {
                sent.push(1);
                r();
              };
            })
          : Promise.resolve(void sent.push((e as any).seconds))
    });
    const first = q.push(ev(1));
    const second = q.push(ev(2));
    release();
    await Promise.all([first, second]);
    await q.flush();
    expect(sent).toEqual([1, 2]);
  });
});

describe("advance and waiting for the coach", () => {
  it("shows the next screen at once when the director has one", async () => {
    const calls: unknown[] = [];
    const r = await advanceToNext({ advance: async (b) => (calls.push(b), { screen: screen("scr_2"), view: view() }), waitForScreen: async () => undefined }, { screenId: "scr_1", seconds: 30 });
    expect(r.screen?.id).toBe("scr_2");
    expect(calls).toEqual([{ screenId: "scr_1", seconds: 30 }]);
  });

  it("waits for the coach's screen from the stream while the coach writes it", async () => {
    const waits: number[] = [];
    let waiting: string | undefined;
    const until = new Date(T0 + 8000).toISOString();
    const r = await advanceToNext(
      {
        advance: async () => ({ waiting: true, until, view: view({ state: "live", coachPresent: true }) }) as AdvanceResult,
        waitForScreen: async (ms) => (waits.push(ms), screen("scr_coach")),
        onWaiting: (u) => (waiting = u)
      },
      { screenId: "scr_1" }
    );
    expect(r.screen?.id).toBe("scr_coach");
    expect(waits).toEqual([T0 + 8000]);
    expect(waiting).toBe(until);
  });

  it("asks again after the deadline and takes the fallback", async () => {
    let n = 0;
    const r = await advanceToNext(
      {
        advance: async () => (++n === 1 ? ({ waiting: true, until: new Date(T0).toISOString(), view: view() } as AdvanceResult) : { screen: screen("scr_fallback"), view: view() }),
        waitForScreen: async () => undefined
      },
      { screenId: "scr_1", seconds: 4 }
    );
    expect(n).toBe(2);
    expect(r.screen?.id).toBe("scr_fallback");
  });

  it("uses the screen deadline when the director gives no time, and gives up after a few rounds", async () => {
    const waits: number[] = [];
    let n = 0;
    const r = await advanceToNext({ advance: async () => (n++, { waiting: true, view: view() } as AdvanceResult), waitForScreen: async (ms) => (waits.push(ms), undefined), now: () => T0 }, { screenId: "scr_1" }, 3);
    expect(n).toBe(3);
    expect(waits[0]).toBe(T0 + COACH_DEFAULTS.screenDeadlineS * 1000);
    expect(r.screen).toBeUndefined();
  });

  it("ends with the view when nothing is left (the wrap-up done)", async () => {
    const summary = { sessionId: "ses_1", sk: "sk_1", skill: "S", minutes: 20, changed: [], next: { title: "Next", focus: "x" } };
    const r = await advanceToNext({ advance: async () => ({ view: view({ state: "ended", summary }) }), waitForScreen: async () => undefined }, { screenId: "scr_w" });
    expect(r.screen).toBeUndefined();
    expect(r.view?.state).toBe("ended");
    expect(r.view?.summary?.sessionId).toBe("ses_1");
  });
});

describe("live model", () => {
  const start = () => reduceLive(initialModel("ses_1"), { type: "sync", view: view({ screen: screen("scr_1") }) });

  it("syncs from the server and ignores another session's stream", () => {
    const m = start();
    expect(m).toMatchObject({ state: "coach-away", screen: { id: "scr_1" }, minutesUsed: 3 });
    expect(reduceLive(m, { type: "coach.screen", liveSessionId: "ses_other", screen: screen("scr_9") }).screen?.id).toBe("scr_1");
    expect(reduceLive(m, { type: "sync", view: view({ liveSessionId: "ses_other", screen: screen("scr_9") }) }).screen?.id).toBe("scr_1");
  });

  it("a coach.screen replaces the screen and ends the wait; a resync of the finished screen keeps waiting", () => {
    let m = reduceLive(start(), { type: "waiting", until: "x", after: "scr_1" });
    expect(presenceOf(m)).toBe("thinking");
    m = reduceLive(m, { type: "sync", view: view({ state: "live", coachPresent: true, screen: screen("scr_1") }) });
    expect(m.waiting).toBeDefined();
    m = reduceLive(m, { type: "coach.screen", liveSessionId: "ses_1", screen: screen("scr_2", "drill") });
    expect(m.screen?.id).toBe("scr_2");
    expect(m.waiting).toBeUndefined();
    expect(presenceOf(m)).toBe("here");
  });

  it("a message goes over the screen, a leaving one marks the coach as gone on purpose, and dismissing hides it", () => {
    const msg = { type: "message" as const, screenId: "scr_m", text: "Bye for now", leaving: true, at: "t" };
    let m = reduceLive(start(), { type: "coach.screen", liveSessionId: "ses_1", screen: screen("scr_m", "message", msg) });
    expect(m.screen?.id).toBe("scr_1");
    expect(visibleMessage(m)?.text).toBe("Bye for now");
    m = reduceLive(m, { type: "coach.state", liveSessionId: "ses_1", state: "coach-away", coachPresent: false });
    expect(presenceOf(m)).toBe("left");
    m = reduceLive(m, { type: "dismiss", screenId: "scr_m" });
    expect(visibleMessage(m)).toBeUndefined();
  });

  it("presence follows coach.state and pings", () => {
    let m = start();
    expect(presenceOf(m)).toBe("away");
    m = reduceLive(m, { type: "coach.state", liveSessionId: "ses_1", state: "live", coachPresent: true, leftOnPurpose: false });
    expect(presenceOf(m)).toBe("here");
    m = reduceLive(m, { type: "ping", state: "coach-away", coachPresent: false });
    expect(presenceOf(m)).toBe("away");
  });

  it("ends with the summary", () => {
    const summary = { sessionId: "ses_1", sk: "sk_1", skill: "S", minutes: 20, changed: [], next: { title: "Next", focus: "x" } };
    const m = reduceLive(start(), { type: "coach.ended", liveSessionId: "ses_1", summary });
    expect(m.state).toBe("ended");
    expect(m.summary?.minutes).toBe(20);
    expect(fillOf({ minutesUsed: 15, minutesPlanned: 30 })).toBe(0.5);
    expect(fillOf({ minutesUsed: 0, minutesPlanned: 0 })).toBe(0.5);
  });
});

describe("which runner a session uses", () => {
  it("the live runner when the director has a live session, else the planned runner", () => {
    expect(runnerFor(view())).toBe("live");
    expect(runnerFor(view({ state: "ended" }))).toBe("live");
    expect(runnerFor(view({ state: "idle" }))).toBe("plan");
    expect(runnerFor(null)).toBe("plan");
    expect(runnerFor({} as LiveView)).toBe("plan");
  });

  it("asks the server, and falls back to the planned runner on a 404 or a server without live routes", async () => {
    expect((await chooseRunner({ live: async () => view() }, "ses_1")).kind).toBe("live");
    expect((await chooseRunner({ live: async () => Promise.reject(new ApiError("not found", 404)) }, "ses_1")).kind).toBe("plan");
    expect((await chooseRunner({ live: async () => Promise.reject(new ApiError("offline", 0)) }, "ses_1")).kind).toBe("plan");
  });

  it("Today's Start makes a live session, or a planned one on a server without the live coach", async () => {
    const live = await startSession({ liveStart: async () => view({ liveSessionId: "ses_live" }), nextSession: async () => Promise.reject(new Error("not called")) }, "sk_1");
    expect(live).toEqual({ kind: "live", id: "ses_live" });
    const planned = await startSession({ liveStart: async () => Promise.reject(new ApiError("not found", 404)), nextSession: async () => ({ sessionId: "ses_plan" }) as any }, "sk_1");
    expect(planned).toEqual({ kind: "plan", id: "ses_plan" });
    expect(await startSession({ liveStart: async () => Promise.reject(new ApiError("nf", 404)), nextSession: async () => ({ sessionId: "x" }) as any }, "sk_1", "ses_next")).toEqual({ kind: "plan", id: "ses_next" });
    await expect(startSession({ liveStart: async () => Promise.reject(new ApiError("no skill", 400)), nextSession: async () => ({ sessionId: "x" }) as any }, "sk_1")).rejects.toThrow("no skill");
  });
});
