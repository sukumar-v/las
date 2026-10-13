/**
 * The live session runner (live-coach §8): draws the director's current screen, one at a time, and sends what the
 * learner does as events. The coach's screens and the fallback screens use the same session items, so a session
 * with no coach looks the same as one with a coach; only the presence pill says which.
 *
 * - each screen shown: `screen.viewed` with the time on the one before; 20 s with no action: `learner.hesitated`
 * - a card answered: `card.answered`; a plan option: `plan.chosen`; the ask box: `learner.asked`
 * - Pause / Resume: `session.paused` / `session.resumed`; the tab closing: `session.left` by beacon
 * - a screen finished: `POST /api/live/:id/advance`, waiting for a present coach until the screen deadline
 * - the stream: `coach.screen`, `coach.message`, `coach.state`, `coach.ended`; `hello` resyncs from the server
 * - events wait in an ordered outbox while offline and go out in order on reconnect
 */
import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import { LiveScreen, Summary, Button, Note, isSummaryView, type CardAnswer, type LiveItem, type LiveScreenModel } from "@las/ui";
import type { CoachScreen, FeedbackView, LiveView, ScreenKind, SessionItem, StudioEvent, SummaryView } from "@las/schema";
import { api, type AttemptInfo } from "../api.js";
import { navigate, buildPath } from "../router.js";
import { loadTheme, useT, useVoice } from "../theme.js";
import { onStream } from "../stream.js";
import { Loading } from "./common.js";
import { CaptureView } from "./capture.js";
import { ReplayView } from "./replay.js";
import { SessionRunner, type DrillState } from "./session.js";
import { processCapture, PIPELINE_STEPS, type Captured, type ProcessResult } from "../capture/pipeline.js";
import { advanceToNext, chooseRunner, fillOf, initialModel, presenceOf, reduceLive, visibleMessage, type RunnerKind } from "../live/director.js";
import { cardAnswered, learnerAsked, learnerHesitated, planChosen, screenViewed, secondsBetween, sessionLeft, sessionPaused, sessionResumed } from "../live/events.js";
import { createEventQueue, sessionQueueStore, type EventQueue } from "../live/queue.js";
import { createHesitationTimer, recordingInDocument } from "../live/hesitation.js";

/** `/app/session/:id`: the live runner when the director has a live session for this id, else the planned runner. */
export function SessionRoute({ id, query }: { id: string; query: URLSearchParams }) {
  const [choice, setChoice] = useState<{ kind: RunnerKind; view?: LiveView } | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void chooseRunner(api, id).then((c) => alive && setChoice(c));
    return () => {
      alive = false;
    };
  }, [id]);
  if (!choice) return <Loading />;
  return choice.kind === "live" && choice.view ? <LiveRunner id={id} initial={choice.view} /> : <SessionRunner id={id} query={query} />;
}

type CaptureItem = Extract<SessionItem, { type: "capture" }>;
interface LocalItem {
  id: string;
  item: LiveItem;
}

/** Per-session conveniences that survive a reload (reviews done, the plan option picked, the last screen reported). */
interface Kept {
  viewed?: { screenId: string; shownAt: number };
  reviewed: Record<string, boolean>;
  chosen: Record<string, string>;
}
const keptKey = (id: string) => `las.live.${id}`;
function loadKept(id: string): Kept {
  try {
    const s = sessionStorage.getItem(keptKey(id));
    return s ? { reviewed: {}, chosen: {}, ...JSON.parse(s) } : { reviewed: {}, chosen: {} };
  } catch {
    return { reviewed: {}, chosen: {} };
  }
}
function saveKept(id: string, k: Kept): void {
  try {
    sessionStorage.setItem(keptKey(id), JSON.stringify(k));
  } catch {
    /* a convenience */
  }
}

/** A capture item rebuilt from an attempt, for a second attempt after a fix drill or a re-record. */
export function captureItemFrom(info: AttemptInfo, attemptId: string): CaptureItem {
  const a = info.attempt;
  return { type: "capture", attemptSpecId: attemptId, engine: a.engine as CaptureItem["engine"], specId: a.specId ?? "", prompt: info.prompt ?? a.prompt ?? "", how: info.how, drillId: a.drillId, kind: a.kind === "proof" || a.kind === "rehearsal" ? a.kind : "perform" };
}

function kindOf(item: LiveItem): ScreenKind {
  if (isSummaryView(item)) return "wrapup";
  switch (item.type) {
    case "review":
      return "recall";
    case "message":
    case "plan":
    case "feedback":
    case "pause":
    case "warmup":
    case "lesson":
    case "drill":
    case "capture":
    case "wrapup":
      return item.type;
  }
}

export function isFeedbackFor(screen: CoachScreen | undefined, attemptId: string): boolean {
  const it = screen?.item as { type?: string; view?: FeedbackView } | undefined;
  return it?.type === "feedback" && it.view?.attemptId === attemptId;
}

interface RunState {
  warmup: Record<string, number[]>;
  cards: Record<string, CardAnswer[]>;
  drills: Record<string, DrillState>;
  captured: Record<string, boolean>;
  pipeline: Record<string, number>;
  pipelineSteps: Record<string, string[]>;
  looped: Record<string, boolean>;
  phase: Record<string, "capture" | "analyze">;
}
const emptyRun = (): RunState => ({ warmup: {}, cards: {}, drills: {}, captured: {}, pipeline: {}, pipelineSteps: {}, looped: {}, phase: {} });

export function LiveRunner({ id, initial }: { id: string; initial: LiveView }) {
  const t = useT();
  const voice = useVoice();
  const [model, dispatch] = useReducer(reduceLive, undefined, () => reduceLive(initialModel(id), { type: "sync", view: initial }));
  const [run, setRun] = useState<RunState>(emptyRun);
  const [local, setLocal] = useState<LocalItem[]>([]);
  const [kept, setKept] = useState<Kept>(() => loadKept(id));
  const [error, setError] = useState<string | undefined>(undefined);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [askSent, setAskSent] = useState(false);
  const [pausedAt, setPausedAt] = useState<number | undefined>(undefined);
  const [wrapSummary, setWrapSummary] = useState<SummaryView | undefined>(undefined);
  const sk = useRef(initial.sk);
  const synced = useRef({ at: Date.now(), minutes: initial.minutesUsed });
  const shown = useRef<{ screenId: string; at: number } | undefined>(kept.viewed ? { screenId: kept.viewed.screenId, at: kept.viewed.shownAt } : undefined);
  const infos = useRef<Record<string, AttemptInfo>>({});
  const captures = useRef<Record<string, Captured>>({});
  const results = useRef<Record<string, ProcessResult>>({});
  const answered = useRef(new Set<string>());
  /** the director's next screen, held while the learner finishes local steps (feedback, a fix drill, a re-take) */
  const held = useRef<{ screen?: CoachScreen; view?: LiveView } | undefined>(undefined);
  const waiter = useRef<((s: CoachScreen | undefined) => void) | undefined>(undefined);
  const left = useRef(false);
  const modelRef = useRef(model);
  modelRef.current = model;
  const [, tick] = useState(0);

  const queue = useRef<EventQueue>(undefined as unknown as EventQueue);
  if (!queue.current) queue.current = createEventQueue({ send: (ev) => api.event(ev), store: sessionQueueStore(`las.live.queue.${id}`), onChange: (s) => setOffline(!s.online) });
  const send = (ev: StudioEvent | undefined) => {
    if (ev) void queue.current.push(ev);
  };
  const hesitation = useRef(createHesitationTimer({ onHesitate: (screenId, s) => send(learnerHesitated(id, screenId, s)), isRecording: () => recordingInDocument() }));

  const resync = async () => {
    try {
      const v = await api.live(id);
      synced.current = { at: Date.now(), minutes: v.minutesUsed };
      // past the director's screen already: the newer state becomes what shows after the local steps
      if (held.current) held.current = { screen: v.screen ?? held.current.screen, view: v };
      else dispatch({ type: "sync", view: v });
      return v;
    } catch {
      return undefined;
    }
  };

  // theme, the outbox left from before a reload, the stream, presence pings and the page-hide beacon
  useEffect(() => {
    void loadTheme(initial.sk);
    void queue.current.flush();
    const offs = [
      onStream("hello", () => {
        void queue.current.flush();
        void resync();
      }),
      onStream("coach.screen", (d) => {
        if (d?.liveSessionId !== id || !d.screen) return;
        if (held.current && d.screen.kind !== "message") {
          held.current = { ...held.current, screen: d.screen };
          return;
        }
        dispatch({ type: "coach.screen", liveSessionId: id, screen: d.screen });
        if (waiter.current && d.screen.kind !== "message") waiter.current(d.screen);
      }),
      onStream("coach.message", (d) => d?.liveSessionId === id && d.message && dispatch({ type: "coach.message", liveSessionId: id, message: d.message })),
      onStream("coach.state", (d) => d?.liveSessionId === id && dispatch({ type: "coach.state", liveSessionId: id, state: d.state, coachPresent: !!d.coachPresent, leftOnPurpose: d.leftOnPurpose })),
      onStream("coach.ended", (d) => d?.liveSessionId === id && dispatch({ type: "coach.ended", liveSessionId: id, summary: d.summary }))
    ];
    const ping = () =>
      void api.livePing(id).then(
        (p) => dispatch({ type: "ping", state: p.state, coachPresent: p.coachPresent }),
        () => undefined
      );
    const timer = setInterval(ping, 30_000);
    const onFocus = () => {
      ping();
      void queue.current.flush();
    };
    const onVisible = () => document.visibilityState === "visible" && onFocus();
    const onOnline = () => {
      void queue.current.flush();
      void resync();
    };
    const onHide = () => {
      if (left.current || modelRef.current.state === "ended") return;
      left.current = true;
      const body = new Blob([JSON.stringify(sessionLeft(id, "closed"))], { type: "application/json" });
      try {
        navigator.sendBeacon?.(api.eventsUrl(), body);
      } catch {
        /* nothing more to do while the page goes away */
      }
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        left.current = false;
        void resync();
      }
    };
    ping();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    // any action on the page counts against hesitation
    const act = () => hesitation.current.activity();
    document.addEventListener("pointerdown", act, true);
    document.addEventListener("keydown", act, true);
    document.addEventListener("input", act, true);
    return () => {
      offs.forEach((off) => off());
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("pointerdown", act, true);
      document.removeEventListener("keydown", act, true);
      document.removeEventListener("input", act, true);
      hesitation.current.stop();
    };
  }, [id]);

  useEffect(() => {
    saveKept(id, kept);
  }, [kept]);

  // a new director screen: report it, start the hesitation count, drop local steps
  const screen = model.screen;
  useEffect(() => {
    if (!screen) return;
    const now = Date.now();
    if (shown.current?.screenId !== screen.id) {
      send(screenViewed(id, screen.id, shown.current ? { screenId: shown.current.screenId, shownAt: shown.current.at } : undefined, now));
      shown.current = { screenId: screen.id, at: now };
      setKept((k) => ({ ...k, viewed: { screenId: screen.id, shownAt: now } }));
    }
    hesitation.current.start(screen.id);
    setAskSent(false);
    if (!held.current) setLocal([]);
    // a drill screen starts its drill fresh
    const it = screen.item as LiveItem;
    if (!isSummaryView(it) && it.type === "drill") setRun((r) => ({ ...r, drills: Object.fromEntries(Object.entries(r.drills).filter(([k]) => k !== it.drill.id)) }));
  }, [screen?.id]);

  const pauseItem = screen && (screen.item as { type?: string }).type === "pause" ? (screen.item as { type: "pause"; pausedAt: string }) : undefined;
  const paused = pausedAt !== undefined || !!pauseItem || model.state === "paused";
  const ended = model.state === "ended";

  // no hesitation while paused, waiting for the coach, or done
  useEffect(() => {
    if (paused || model.waiting || ended) hesitation.current.stop();
    else if (screen) hesitation.current.start(screen.id);
  }, [paused, !!model.waiting, ended]);

  // the summary when the session ends without one
  useEffect(() => {
    if (ended && !model.summary && !wrapSummary) api.summary(id).then(setWrapSummary, () => undefined);
  }, [ended]);

  const display: LiveScreenModel | undefined = local[0]
    ? { id: local[0].id, kind: kindOf(local[0].item), block: screen?.block ?? "perform", item: local[0].item }
    : screen
      ? { id: screen.id, kind: screen.kind, block: screen.block, item: screen.item }
      : undefined;
  const item = display ? (display.item as LiveItem) : undefined;

  // what a screen needs before it can be used: a drill's first item, an attempt's capture spec, the summary
  useEffect(() => {
    if (!item || isSummaryView(item)) return;
    if (item.type === "drill" && !run.drills[item.drill.id]) void startDrill(item.drill.id);
    if (item.type === "capture" && !infos.current[item.attemptSpecId])
      api.attempt(item.attemptSpecId).then(
        (i) => {
          infos.current[item.attemptSpecId] = i;
          tick((n) => n + 1);
        },
        (e) => setError((e as Error).message)
      );
    if (item.type === "wrapup" && !(item as { summary?: SummaryView }).summary && !wrapSummary) api.summary(id).then(setWrapSummary, () => undefined);
  }, [display?.id]);

  const setDrill = (drillId: string, d: DrillState) => setRun((r) => ({ ...r, drills: { ...r.drills, [drillId]: d } }));

  async function startDrill(drillId: string) {
    try {
      const r = await api.drillNext(drillId, { sessionId: id });
      if (r.kind === "capture" && r.attemptId) {
        infos.current[r.attemptId] = await api.attempt(r.attemptId);
        setDrill(drillId, { capture: true, attemptId: r.attemptId, label: r.label });
      } else setDrill(drillId, { item: r.item, done: r.done, label: r.label });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function answerDrill(drillId: string, answer: unknown) {
    const cur = run.drills[drillId];
    if (!cur?.item || cur.done) return;
    setDrill(drillId, { ...cur, picked: typeof answer === "number" ? answer : undefined });
    try {
      const r = await api.drillNext(drillId, { sessionId: id, answer: { itemId: cur.item.id, answer } });
      setDrill(drillId, { item: r.done ? undefined : (r.item ?? cur.item), success: r.last?.correct, done: r.done || !r.item, label: r.label, picked: undefined });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** Shows what the director answered: the view first, then the screen (a streamed screen is newer than the view). */
  function apply(r: { screen?: CoachScreen; view?: LiveView }, finished?: ScreenKind) {
    if (r.view) {
      synced.current = { at: Date.now(), minutes: r.view.minutesUsed };
      dispatch({ type: "sync", view: r.view });
    }
    if (r.screen) dispatch({ type: "coach.screen", liveSessionId: id, screen: r.screen });
    else if (finished === "wrapup" && r.view?.state !== "ended") dispatch({ type: "coach.ended", liveSessionId: id, summary: r.view?.summary });
  }

  const waitForScreen = (untilMs: number) =>
    new Promise<CoachScreen | undefined>((resolve) => {
      const timer = setTimeout(() => done(undefined), Math.max(0, untilMs - Date.now()) + 300);
      const done = (s: CoachScreen | undefined) => {
        clearTimeout(timer);
        waiter.current = undefined;
        resolve(s);
      };
      waiter.current = done;
    });

  /** Asks the director for the screen after the current one; waits for a present coach until the deadline. */
  async function ask(): Promise<{ screen?: CoachScreen; view?: LiveView } | undefined> {
    const s = modelRef.current.screen;
    if (!s) return undefined;
    const seconds = shown.current?.screenId === s.id ? secondsBetween(shown.current.at, Date.now()) : undefined;
    try {
      const r = await advanceToNext({ advance: (b) => api.liveAdvance(id, b), waitForScreen, onWaiting: (until) => dispatch({ type: "waiting", until, after: s.id }) }, { screenId: s.id, seconds });
      setError(undefined);
      return r;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      dispatch({ type: "waited" });
    }
  }

  async function advance() {
    if (busy) return;
    const cur = modelRef.current.screen;
    const finished = cur?.kind;
    // the wrap-up already showed the summary: its Done ends the session and goes to Today, as in the planned runner
    const sawSummary = finished === "wrapup" && !!((cur?.item as { summary?: SummaryView } | undefined)?.summary ?? wrapSummary ?? isSummaryView(cur?.item));
    setBusy(true);
    try {
      const r = await ask();
      if (!r) return;
      apply(r, finished);
      if (sawSummary && (!r.screen || r.view?.state === "ended")) navigate(buildPath("/app/today", {}, { sk: sk.current }));
    } finally {
      setBusy(false);
    }
  }

  /** After an attempt is analyzed: the director's feedback for it, or ours first when the director moves on without it. */
  async function afterCapture(attemptId: string, result: ProcessResult, from: string) {
    const ours: LocalItem[] = result.feedback ? [{ id: `local-feedback-${attemptId}`, item: { type: "feedback", view: result.feedback } }] : [];
    if (held.current) {
      // already past the director's screen: show our feedback, then what the director had next
      setLocal(ours);
      if (!ours.length) releaseHeld();
      return;
    }
    if (modelRef.current.screen?.id !== from) {
      setLocal(ours);
      return;
    }
    setBusy(true);
    try {
      const r = await ask();
      if (!r) return setLocal(ours);
      if (r.screen && isFeedbackFor(r.screen, attemptId)) {
        setLocal([]);
        apply(r);
      } else if (ours.length) {
        held.current = r;
        setLocal(ours);
      } else {
        setLocal([]);
        apply(r);
      }
    } finally {
      setBusy(false);
    }
  }

  function releaseHeld() {
    const h = held.current;
    held.current = undefined;
    setLocal([]);
    if (h) apply(h);
    else void advance();
  }

  async function analyzeCapture(displayId: string, attemptId: string) {
    const info = infos.current[attemptId];
    const cap = captures.current[attemptId];
    if (!info || !cap) return;
    const from = modelRef.current.screen?.id ?? "";
    setRun((r) => ({ ...r, phase: { ...r.phase, [displayId]: "analyze" }, pipeline: { ...r.pipeline, [attemptId]: 0 }, pipelineSteps: { ...r.pipelineSteps, [attemptId]: PIPELINE_STEPS } }));
    try {
      const res = await processCapture(api, info, cap, (n) => setRun((r) => ({ ...r, pipeline: { ...r.pipeline, [attemptId]: n } })));
      results.current[attemptId] = res;
      await afterCapture(attemptId, res, from);
    } catch (e) {
      setError(`${t("The analysis didn't finish")}: ${(e as Error).message}`);
      setRun((r) => ({ ...r, phase: { ...r.phase, [displayId]: "capture" } }));
    }
  }

  /** "Try this": the fix drill, then a second attempt, before the director's next screen (as in the planned runner). */
  async function closeLoop(fb: FeedbackView) {
    const attemptId = fb.attemptId;
    if (run.looped[attemptId] || !fb.fixDrillId) return finish();
    setBusy(true);
    try {
      const fix = await api.drillNext(fb.fixDrillId, { sessionId: id });
      const fixItem: SessionItem = { type: "drill", drill: fix.drill, difficulty: fix.difficulty, label: fix.label };
      if (fix.kind === "capture" && fix.attemptId) {
        infos.current[fix.attemptId] = await api.attempt(fix.attemptId);
        setDrill(fix.drill.id, { capture: true, attemptId: fix.attemptId, label: fix.label });
      } else setDrill(fix.drill.id, { item: fix.item, done: fix.done, label: fix.label });
      const again = await api.attemptAgain(attemptId);
      const info = await api.attempt(again.attemptId);
      infos.current[again.attemptId] = info;
      setRun((r) => ({ ...r, looped: { ...r.looped, [attemptId]: true, [again.attemptId]: true } }));
      setLocal([
        { id: `local-fix-${attemptId}`, item: fixItem },
        { id: `local-again-${again.attemptId}`, item: captureItemFrom(info, again.attemptId) }
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** "Record again": a fresh attempt right away. */
  async function reRecord(attemptId: string) {
    try {
      const again = await api.attemptAgain(attemptId);
      const info = await api.attempt(again.attemptId);
      infos.current[again.attemptId] = info;
      setLocal([{ id: `local-again-${again.attemptId}`, item: captureItemFrom(info, again.attemptId) }]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** The learner finished what's showing. */
  function finish() {
    if (local.length) {
      const rest = local.slice(1);
      if (rest.length) return setLocal(rest);
      if (held.current) return releaseHeld();
      setLocal([]);
      return void advance();
    }
    void advance();
  }

  function next() {
    if (!display || !item) return;
    if (ended) return navigate(buildPath("/app/today", {}, { sk: sk.current }));
    if (isSummaryView(item)) return finish();
    switch (item.type) {
      case "capture": {
        if ((run.phase[display.id] ?? "capture") === "capture") return void analyzeCapture(display.id, item.attemptSpecId);
        return;
      }
      case "feedback":
        if (item.view.fixDrillId && !item.view.reRecord && !run.looped[item.view.attemptId]) return void closeLoop(item.view);
        return finish();
      case "drill": {
        if (item.drill.type === "fill") {
          const d = run.drills[item.drill.id];
          const input = document.querySelector<HTMLInputElement>('[data-drill="fill"] input');
          if (d?.item && !d.done && input?.value) return void answerDrill(item.drill.id, input.value);
        }
        return finish();
      }
      case "review":
        setKept((k) => ({ ...k, reviewed: { ...k.reviewed, [display.id]: true } }));
        return finish();
      default:
        return finish();
    }
  }

  async function pause() {
    send(sessionPaused(id, "learner"));
    setPausedAt(Date.now());
  }

  async function resume() {
    const since = pausedAt ?? (pauseItem ? Date.parse(pauseItem.pausedAt) : Date.now());
    send(sessionResumed(id, secondsBetween(Number.isFinite(since) ? since : Date.now(), Date.now())));
    setPausedAt(undefined);
    await queue.current.flush();
    const v = await resync();
    if (v?.screen?.kind === "pause" || (v?.screen?.item as { type?: string } | undefined)?.type === "pause") await advance();
  }

  const exit = () => {
    if (!ended && !left.current) {
      left.current = true;
      send(sessionLeft(id, "closed"));
    }
    navigate(buildPath("/app/today", {}, { sk: sk.current }));
  };

  // what the studio draws itself for this screen (recorder, replay, a drill's capture, the wrap-up summary)
  let children: preact.ComponentChildren = undefined;
  let phase: string | undefined = undefined;
  if (item && !isSummaryView(item)) {
    if (item.type === "capture") {
      phase = run.phase[display!.id] ?? "capture";
      const info = infos.current[item.attemptSpecId];
      const aid = item.attemptSpecId;
      if (phase === "capture")
        children = info ? (
          <CaptureView key={aid} info={info} captured={!!run.captured[aid]} onCaptured={(c) => {
            captures.current[aid] = c;
            setRun((r) => ({ ...r, captured: { ...r.captured, [aid]: true } }));
          }} />
        ) : (
          <Note>{t("Getting the recorder ready…")}</Note>
        );
    }
    if (item.type === "feedback") {
      const fb = item.view;
      const res = results.current[fb.attemptId];
      children = <ReplayView key={`${display!.id}:${fb.attemptId}`} attemptId={fb.attemptId} data={{ analysis: res?.analysis ?? fb.analysis, feedback: fb, evidence: res?.evidence, mediaUrl: res?.mediaUrl }} onTry={() => void closeLoop(fb)} onReRecord={() => void reRecord(fb.attemptId)} />;
    }
    if (item.type === "drill") {
      const d = run.drills[item.drill.id];
      if (d?.capture && d.attemptId && infos.current[d.attemptId]) {
        const aid = d.attemptId;
        const drillId = item.drill.id;
        children = (
          <>
            <CaptureView key={aid} info={infos.current[aid]} captured={!!run.captured[aid]} onCaptured={(c) => {
              captures.current[aid] = c;
              setRun((r) => ({ ...r, captured: { ...r.captured, [aid]: true } }));
            }} />
            <Button primary disabled={!run.captured[aid] || run.pipeline[aid] === 0} onClick={async () => {
              const c = captures.current[aid];
              if (!c) return;
              const from = modelRef.current.screen?.id ?? "";
              setRun((r) => ({ ...r, pipeline: { ...r.pipeline, [aid]: 0 } }));
              try {
                // measured on this device; the director then shows the feedback (as for any capture)
                const res = await processCapture(api, infos.current[aid], c, () => undefined);
                results.current[aid] = res;
                setDrill(drillId, { ...d, result: res, done: true });
                await afterCapture(aid, res, from);
              } catch (e) {
                setError((e as Error).message);
                setRun((r) => ({ ...r, pipeline: { ...r.pipeline, [aid]: 1 } }));
              }
            }}>
              {run.pipeline[aid] === 0 ? t("checking") : t("checkIt")}
            </Button>
          </>
        );
      } else if (d?.done && !d.item) children = <Note icon="check">{t("Drill done.")}</Note>;
    }
    if (item.type === "wrapup") {
      const sum = (item as { summary?: SummaryView }).summary ?? wrapSummary;
      children = sum ? <Summary view={sum} voice={voice} /> : undefined;
    }
  }

  const drillState = item && !isSummaryView(item) && item.type === "drill" ? run.drills[item.drill.id] : undefined;
  const state = {
    ...run,
    warmup: display ? (run.warmup[display.id] ?? []) : [],
    reviewed: display ? !!kept.reviewed[display.id] : false,
    drills: { ...run.drills, ...(item && !isSummaryView(item) && item.type === "drill" && drillState ? { [item.drill.id]: { ...drillState, revealed: false } } : {}) }
  };
  const pauseScreen: LiveScreenModel | undefined = paused && !ended ? { id: screen?.id ?? "pause", kind: "pause", block: screen?.block ?? "practice", item: { type: "pause", pausedAt: new Date(pausedAt ?? Date.now()).toISOString() } } : undefined;
  const secondsSoFar = synced.current.minutes * 60 + (model.state === "paused" ? 0 : secondsBetween(synced.current.at, pausedAt ?? Date.now()));

  if (!display && !ended && !paused) return <Loading what={t("Loading the session…")} />;

  return (
    <>
      {error || offline ? (
        <div class="las-app">
          <Note kind="warn" icon="warn">
            {offline ? t("offline") : error}
          </Note>
        </div>
      ) : null}
      <LiveScreen
        screen={pauseScreen ?? display}
        phase={phase}
        state={state}
        presence={presenceOf(model)}
        message={visibleMessage(model)}
        waiting={!!model.waiting && !paused}
        seconds={secondsSoFar}
        summary={ended ? (model.summary ?? wrapSummary ?? (item && isSummaryView(item) ? item : undefined)) : undefined}
        chosen={display ? kept.chosen[display.id] : undefined}
        askSent={askSent}
        fill={fillOf(model)}
        busy={busy}
        voice={voice}
        h={{
          onNext: next,
          onExit: exit,
          onPause: () => void pause(),
          onResume: () => void resume(),
          onCardAnswer: (lessonId, i, a) => {
            setRun((r) => {
              const list = [...(r.cards[lessonId] ?? [])];
              list[i] = a;
              return { ...r, cards: { ...r.cards, [lessonId]: list } };
            });
            const key = `${display?.id}:${lessonId}:${i}`;
            const lesson = item && !isSummaryView(item) && item.type === "lesson" ? item : undefined;
            if (!lesson || !screen || answered.current.has(key)) return;
            const ev = cardAnswered(id, screen.id, i, lesson.cards[i], a, shown.current ? secondsBetween(shown.current.at, Date.now()) : 0);
            if (ev) {
              answered.current.add(key);
              send(ev);
            }
          },
          onDrillPick: (drillId, i) => void answerDrill(drillId, i),
          onWarmupTick: (i) =>
            display &&
            setRun((r) => {
              const cur = r.warmup[display.id] ?? [];
              return { ...r, warmup: { ...r.warmup, [display.id]: cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i] } };
            }),
          onReview: () => {
            if (!display) return;
            setKept((k) => ({ ...k, reviewed: { ...k.reviewed, [display.id]: true } }));
            saveKept(id, { ...kept, reviewed: { ...kept.reviewed, [display.id]: true } });
            navigate(buildPath("/app/review", {}, { sk: sk.current, return: buildPath("/app/session/:id", { id }) }));
          },
          onChoose: (optionId) => {
            if (!display || !screen) return;
            setKept((k) => ({ ...k, chosen: { ...k.chosen, [display.id]: optionId } }));
            send(planChosen(id, screen.id, optionId));
          },
          onAsk: (text) => {
            const ev = learnerAsked(id, screen?.id, text);
            if (!ev) return;
            send(ev);
            setAskSent(true);
          },
          onReply: () => document.getElementById("las-ask")?.focus(),
          onDismissMessage: () => {
            const m = visibleMessage(model);
            if (m) dispatch({ type: "dismiss", screenId: m.screenId });
          }
        }}
      >
        {children}
      </LiveScreen>
    </>
  );
}
