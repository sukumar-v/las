/**
 * The session runner (learning loop §2): walks the plan's blocks with the shared SessionScreen. A correction
 * from Perform closes the loop in the same session: the fix drill, then a second attempt. The studio sends the
 * events the server learns from: session.started, block.completed, drill.outcome (the drill route reports
 * knowledge drills), attempt.disputed and session.completed.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { SessionScreen, sessionSteps, Summary, Hint, Note, Feedback, Button, type CardAnswer, type SessionStep } from "@las/ui";
import type { FeedbackView, SessionItem, SessionPlan, SummaryView } from "@las/schema";
import { api, type AttemptInfo, type DrillStepView } from "../api.js";
import { navigate, buildPath } from "../router.js";
import { loadTheme, useT, useVoice } from "../theme.js";
import { CaptureView } from "./capture.js";
import { ReplayView } from "./replay.js";
import { processCapture, PIPELINE_STEPS, type Captured, type ProcessResult } from "../capture/pipeline.js";

type CaptureItem = Extract<SessionItem, { type: "capture" }>;

export interface DrillState {
  item?: DrillStepView["item"];
  picked?: number;
  revealed?: boolean;
  success?: boolean;
  done?: boolean;
  label?: string;
  capture?: boolean;
  attemptId?: string;
  result?: ProcessResult;
}

export interface RunnerState {
  warmup: number[];
  cards: Record<string, CardAnswer[]>;
  drills: Record<string, DrillState>;
  captured: Record<string, boolean>;
  pipeline: Record<string, number>;
  pipelineSteps: Record<string, string[]>;
  reviewed?: boolean;
  /** attempts whose fix drill and second attempt are already in the plan */
  looped: Record<string, boolean>;
}

const emptyState = (): RunnerState => ({ warmup: [], cards: {}, drills: {}, captured: {}, pipeline: {}, pipelineSteps: {}, looped: {} });

/**
 * Closing the loop (§2, §6): after the attempt at `at`, add the fix drill and a second attempt to the same
 * block. Pure, so the order is tested.
 */
export function withFixLoop(plan: SessionPlan, at: { blockIndex: number; itemIndex: number }, fix: SessionItem | undefined, again: SessionItem | undefined): SessionPlan {
  const blocks = plan.blocks.map((b, i) => {
    if (i !== at.blockIndex) return b;
    const items = [...b.items];
    const add = [fix, again].filter((x): x is SessionItem => !!x);
    items.splice(at.itemIndex + 1, 0, ...add);
    return { ...b, items };
  });
  return { ...plan, blocks };
}

export function stepIndexOf(steps: SessionStep[], s: SessionStep): number {
  return steps.findIndex((x) => x.blockIndex === s.blockIndex && x.itemIndex === s.itemIndex && x.phase === s.phase);
}

const storeKey = (id: string) => `las.session.${id}`;

function saveLocal(id: string, v: { plan: SessionPlan; idx: number; state: RunnerState }): void {
  try {
    sessionStorage.setItem(storeKey(id), JSON.stringify(v));
  } catch {
    /* resume within the day is a convenience */
  }
}

function loadLocal(id: string): { plan: SessionPlan; idx: number; state: RunnerState } | undefined {
  try {
    const s = sessionStorage.getItem(storeKey(id));
    return s ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
}

export function SessionRunner({ id, query }: { id: string; query: URLSearchParams }) {
  const t = useT();
  const voice = useVoice();
  const [plan, setPlan] = useState<SessionPlan | undefined>(undefined);
  const [idx, setIdx] = useState(0);
  const [state, setState] = useState<RunnerState>(emptyState);
  const [error, setError] = useState<string | undefined>(undefined);
  const [summary, setSummary] = useState<SummaryView | undefined>(undefined);
  const infos = useRef<Record<string, AttemptInfo>>({});
  const [, setInfoTick] = useState(0);
  const captures = useRef<Record<string, Captured>>({});
  const results = useRef<Record<string, ProcessResult>>({});
  const blockStart = useRef<{ block: number; at: number }>({ block: -1, at: Date.now() });
  const startedAt = useRef(Date.now());
  const completed = useRef(false);

  // load (or resume) the plan
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const local = loadLocal(id);
        const p = local?.plan ?? (await api.session(id));
        if (!alive) return;
        await loadTheme(p.sk);
        const steps = sessionSteps(p);
        const want = Number(query.get("step"));
        setPlan(p);
        setState(local?.state ?? emptyState());
        setIdx(Number.isFinite(want) && want > 0 ? Math.min(want, steps.length - 1) : (local?.idx ?? 0));
        if (p.status === "planned" || !p.startedAt) await api.event({ type: "session.started", sessionId: id, at: new Date().toISOString() }).catch(() => undefined);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  const steps = plan ? sessionSteps(plan) : [];
  const step = steps[Math.min(idx, Math.max(0, steps.length - 1))];
  const block = plan && step ? plan.blocks[step.blockIndex] : undefined;
  const item = block && step ? block.items[step.itemIndex] : undefined;

  useEffect(() => {
    if (plan) saveLocal(id, { plan, idx, state });
  }, [plan, idx, state]);

  // block.completed when the runner leaves a block
  useEffect(() => {
    if (!plan || !step) return;
    const prev = blockStart.current;
    if (prev.block !== step.blockIndex) {
      if (prev.block >= 0 && prev.block < step.blockIndex) {
        const b = plan.blocks[prev.block];
        void api.event({ type: "block.completed", sessionId: id, block: b.kind, durationS: Math.round((Date.now() - prev.at) / 1000) }).catch(() => undefined);
      }
      blockStart.current = { block: step.blockIndex, at: Date.now() };
    }
  }, [plan, step?.blockIndex]);

  // load attempt info for captures, and the first item of a drill
  useEffect(() => {
    if (!item) return;
    if (item.type === "capture" && !infos.current[item.attemptSpecId]) {
      api.attempt(item.attemptSpecId).then((i) => {
        infos.current[item.attemptSpecId] = i;
        setInfoTick((n) => n + 1);
      }, (e) => setError((e as Error).message));
    }
    if (item.type === "drill" && !state.drills[item.drill.id]) void startDrill(item.drill.id);
    if (item.type === "wrapup" && !completed.current) void complete();
    if (item.type === "capture" && step.phase === "analyze" && !results.current[item.attemptSpecId] && !captures.current[item.attemptSpecId]) setIdx(idx - 1);
  }, [item, step?.phase]);

  const setDrill = (drillId: string, d: DrillState) => setState((s) => ({ ...s, drills: { ...s.drills, [drillId]: d } }));

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
    const cur = state.drills[drillId];
    if (!cur?.item || cur.done) return;
    setDrill(drillId, { ...cur, picked: typeof answer === "number" ? answer : undefined });
    try {
      const r = await api.drillNext(drillId, { sessionId: id, answer: { itemId: cur.item.id, answer } });
      setDrill(drillId, { item: r.done ? undefined : (r.item ?? cur.item), success: r.last?.correct, done: r.done || !r.item, label: r.label, picked: undefined });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function complete() {
    completed.current = true;
    try {
      if (plan && step) {
        const b = plan.blocks[blockStart.current.block];
        if (b && blockStart.current.block !== step.blockIndex) await api.event({ type: "block.completed", sessionId: id, block: b.kind, durationS: Math.round((Date.now() - blockStart.current.at) / 1000) });
      }
      const minutes = Math.max(1, Math.round((Date.now() - startedAt.current) / 60000));
      await api.event({ type: "session.completed", sessionId: id, minutes, at: new Date().toISOString() });
      setSummary(await api.summary(id));
      try {
        sessionStorage.removeItem(storeKey(id));
      } catch {}
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function analyzeCapture(attemptId: string) {
    const info = infos.current[attemptId];
    const cap = captures.current[attemptId];
    if (!info || !cap) return;
    setState((s) => ({ ...s, pipeline: { ...s.pipeline, [attemptId]: 0 }, pipelineSteps: { ...s.pipelineSteps, [attemptId]: PIPELINE_STEPS } }));
    try {
      const r = await processCapture(api, info, cap, (n) => setState((s) => ({ ...s, pipeline: { ...s.pipeline, [attemptId]: n } })));
      results.current[attemptId] = r;
      setIdx((i) => i + 1);
    } catch (e) {
      setError(`${t("The analysis didn't finish")}: ${(e as Error).message}`);
      setIdx((i) => Math.max(0, i - 1));
    }
  }

  /** "Try this": the fix drill and a second attempt go in right after this attempt. */
  async function closeLoop(fb?: FeedbackView) {
    if (!plan || !step || item?.type !== "capture") return next();
    const attemptId = item.attemptSpecId;
    if (state.looped[attemptId] || !fb?.fixDrillId) return next();
    try {
      const fix = await api.drillNext(fb.fixDrillId, { sessionId: id });
      let fixItem: SessionItem;
      if (fix.kind === "capture" && fix.attemptId) {
        infos.current[fix.attemptId] = await api.attempt(fix.attemptId);
        fixItem = { type: "drill", drill: fix.drill, difficulty: fix.difficulty, label: fix.label };
        setDrill(fix.drill.id, { capture: true, attemptId: fix.attemptId, label: fix.label });
      } else {
        fixItem = { type: "drill", drill: fix.drill, difficulty: fix.difficulty, label: fix.label };
        setDrill(fix.drill.id, { item: fix.item, done: fix.done, label: fix.label });
      }
      const again = await api.attemptAgain(attemptId);
      const againItem: CaptureItem = { ...item, attemptSpecId: again.attemptId };
      const p = withFixLoop(plan, step, fixItem, againItem);
      setState((s) => ({ ...s, looped: { ...s.looped, [attemptId]: true, [again.attemptId]: true } }));
      setPlan(p);
      setIdx(stepIndexOf(sessionSteps(p), step) + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** "Record again": a fresh attempt right after this one. */
  async function reRecord() {
    if (!plan || !step || item?.type !== "capture") return;
    try {
      const again = await api.attemptAgain(item.attemptSpecId);
      const p = withFixLoop(plan, step, undefined, { ...item, attemptSpecId: again.attemptId });
      setPlan(p);
      setIdx(stepIndexOf(sessionSteps(p), step) + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function next() {
    if (!plan || !step || !item) return;
    if (item.type === "capture" && step.phase === "capture") {
      setIdx(idx + 1);
      void analyzeCapture(item.attemptSpecId);
      return;
    }
    if (item.type === "capture" && step.phase === "feedback") {
      const r = results.current[item.attemptSpecId];
      if (r?.feedback?.fixDrillId && !state.looped[item.attemptSpecId]) return void closeLoop(r.feedback);
    }
    if (item.type === "drill" && item.drill.type === "fill") {
      const d = state.drills[item.drill.id];
      const input = document.querySelector<HTMLInputElement>('[data-drill="fill"] input');
      if (d?.item && !d.done && input?.value) return void answerDrill(item.drill.id, input.value);
    }
    if (item.type === "review") setState((s) => ({ ...s, reviewed: true }));
    if (item.type === "wrapup") return navigate(buildPath("/app/today", {}, { sk: plan.sk }));
    if (idx < steps.length - 1) setIdx(idx + 1);
  }

  if (error && !plan) return <Page><Note kind="warn" icon="warn">{error}</Note></Page>;
  if (!plan || !step || !item) return <Page><Hint>{t("Loading the session…")}</Hint></Page>;

  let children: preact.ComponentChildren = undefined;
  if (item.type === "capture") {
    const info = infos.current[item.attemptSpecId];
    if (step.phase === "capture") children = info ? <CaptureView key={item.attemptSpecId} info={info} captured={!!state.captured[item.attemptSpecId]} onCaptured={(c) => {
      captures.current[item.attemptSpecId] = c;
      setState((s) => ({ ...s, captured: { ...s.captured, [item.attemptSpecId]: true } }));
    }} /> : <Hint>{t("Getting the recorder ready…")}</Hint>;
    if (step.phase === "feedback") {
      const r = results.current[item.attemptSpecId];
      children = <ReplayView key={item.attemptSpecId} attemptId={item.attemptSpecId} data={r ? { analysis: r.analysis, feedback: r.feedback, evidence: r.evidence, mediaUrl: r.mediaUrl } : undefined} onTry={(fb) => void closeLoop(fb)} onReRecord={() => void reRecord()} />;
    }
  }
  if (item.type === "drill") {
    const d = state.drills[item.drill.id];
    if (d?.capture && d.attemptId && infos.current[d.attemptId]) {
      const aid = d.attemptId;
      children = d.result?.feedback ? (
        <Feedback view={d.result.feedback} voice={voice} />
      ) : (
        <>
          <CaptureView key={aid} info={infos.current[aid]} captured={!!state.captured[aid]} onCaptured={(c) => {
            captures.current[aid] = c;
            setState((s) => ({ ...s, captured: { ...s.captured, [aid]: true } }));
          }} />
          <Button primary disabled={!state.captured[aid] || state.pipeline[aid] === 0} onClick={async () => {
            const c = captures.current[aid];
            if (!c) return;
            setState((s) => ({ ...s, pipeline: { ...s.pipeline, [aid]: 0 } }));
            try {
              const r = await processCapture(api, infos.current[aid], c, () => undefined);
              setDrill(item.drill.id, { ...d, result: r, done: true });
            } catch (e) {
              setError((e as Error).message);
            }
          }}>
            {state.pipeline[aid] === 0 ? t("checking") : t("checkIt")}
          </Button>
        </>
      );
    } else if (d?.done && !d.item) children = <Note icon="check">{t("Drill done.")}</Note>;
  }
  if (item.type === "wrapup") children = summary ? <Summary view={summary} voice={voice} /> : <Hint>{t("Wrapping up…")}</Hint>;

  const drillState = item.type === "drill" ? state.drills[item.drill.id] : undefined;
  const runnerState = { ...state, drills: { ...state.drills, ...(item.type === "drill" && drillState ? { [item.drill.id]: { ...drillState, revealed: false } } : {}) } };
  return (
    <>
      {error ? <div class="las-app"><Note kind="warn" icon="warn">{error}</Note></div> : null}
      <SessionScreen
        plan={plan}
        step={step}
        state={runnerState}
        voice={voice}
        h={{
          onNext: next,
          onBack: () => setIdx(Math.max(0, idx - 1)),
          onExit: () => navigate(buildPath("/app/today", {}, { sk: plan.sk })),
          onCardAnswer: (lessonId, i, a) => setState((s) => {
            const list = [...(s.cards[lessonId] ?? [])];
            list[i] = a;
            return { ...s, cards: { ...s.cards, [lessonId]: list } };
          }),
          onDrillPick: (drillId, i) => void answerDrill(drillId, i),
          onWarmupTick: (i) => setState((s) => ({ ...s, warmup: s.warmup.includes(i) ? s.warmup.filter((x) => x !== i) : [...s.warmup, i] })),
          onReview: () => {
            setState((s) => ({ ...s, reviewed: true }));
            navigate(buildPath("/app/review", {}, { sk: plan.sk, return: buildPath("/app/session/:id", { id }, { step: idx }) }));
          }
        }}
      >
        {children}
      </SessionScreen>
    </>
  );
}

function Page({ children }: { children?: preact.ComponentChildren }) {
  return (
    <div class="las-app">
      <main class="las-main">{children}</main>
    </div>
  );
}
