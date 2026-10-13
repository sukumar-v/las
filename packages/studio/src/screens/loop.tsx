/**
 * The learning-loop screens around a session: home, Today with its check-in, reviews, a standalone drill,
 * capture and replay pages, progress, the session summary, the proof check, and a theme preview.
 * Each one renders the shared screen from @las/ui; the studio only fetches, navigates and posts events.
 */
import { useEffect, useState } from "preact/hooks";
import { Today, ProgressScreen, Summary, ProofResult, ThemePreview, Tiles, Tile, Card, Eyebrow, Button, Choice, Hint, Note, DrillView, Feedback, Figure, type CardAnswer } from "@las/ui";
import type { ProgressView, ProofResultView, SummaryView, TodayView } from "@las/schema";
import { api, type AttemptInfo, type DrillStepView, type ReviewCard, type StateView } from "../api.js";
import { navigate, buildPath } from "../router.js";
import { loadTheme, setActiveTheme, useT, useVoice } from "../theme.js";
import { onStream } from "../stream.js";
import { startSession } from "../live/director.js";
import { Page, Loading, Failed } from "./common.js";
import { CaptureView } from "./capture.js";
import { ReplayView } from "./replay.js";
import { processCapture, PIPELINE_STEPS, type Captured, type ProcessResult } from "../capture/pipeline.js";
import { Steps } from "@las/ui";

/** "/": Today for the active skill, a picker when there are several, onboarding on the first run. */
export function Home() {
  const t = useT();
  const [state, setState] = useState<StateView | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    void loadTheme();
    api.state().then(
      (s) => {
        const active = s.enrollments.filter((e) => e.status !== "done");
        if (!s.enrollments.length) navigate("/app/onboard/new", { replace: true });
        else if (active.length === 1) navigate(buildPath("/app/today", {}, { sk: active[0].sk }), { replace: true });
        else setState(s);
      },
      (e) => setError((e as Error).message)
    );
  }, []);
  if (error) return <Failed error={error} />;
  if (!state) return <Loading />;
  return (
    <Page nav>
      <h1 class="las-h1" tabIndex={-1}>
        {t("Your skills")}
      </h1>
      <Tiles list>
        {state.enrollments.map((e) => (
          <Tile key={e.sk} title={e.skill} detail={e.milestone?.title ?? e.status} icon="target" onClick={() => navigate(buildPath("/app/today", {}, { sk: e.sk }))} />
        ))}
        <Tile title={t("Learn something new")} icon="spark" onClick={() => navigate("/app/onboard/new")} />
      </Tiles>
    </Page>
  );
}

export function TodayPage({ sk }: { sk: string }) {
  const voice = useVoice();
  const t = useT();
  const [view, setView] = useState<TodayView | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const load = () => api.today(sk).then(setView, (e) => setError((e as Error).message));
  useEffect(() => {
    void loadTheme(sk);
    void load();
    return onStream("checkin.due", () => void load());
  }, [sk]);
  if (error) return <Failed error={error} sk={sk} />;
  if (!view) return <Loading />;
  const start = async () => {
    try {
      // a live session: the coach's screens when a coach is here, the fallback screens when not
      const { id } = await startSession(api, sk, view.nextSession?.id);
      navigate(buildPath("/app/session/:id", { id }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Page nav sk={sk} current="today">
      {note ? <Note icon="check">{note}</Note> : null}
      <Today
        view={view}
        voice={voice}
        onStart={() => void start()}
        onReview={() => navigate(buildPath("/app/review", {}, { sk }))}
        onProgress={() => navigate(buildPath("/app/progress", {}, { sk }))}
        onCheckin={async (checkinId, option) => {
          try {
            const r = await api.event({ type: "checkin.answered", checkinId, option });
            const out = r.result ?? {};
            if (out.action === "session" && out.sessionId) return navigate(buildPath("/app/session/:id", { id: out.sessionId }));
            if (out.action === "run_proof_check" && out.milestoneId) return navigate(buildPath("/app/proof/:milestoneId", { milestoneId: out.milestoneId }, { sk }));
            setNote(out.message || out.error || t("Noted."));
            await load();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
    </Page>
  );
}

/** Reviews due (FSRS): one card at a time, revealed, then graded 1–4. */
export function ReviewPage({ sk, back }: { sk: string; back?: string | null }) {
  const t = useT();
  const voice = useVoice();
  const [cards, setCards] = useState<ReviewCard[] | undefined>(undefined);
  const [i, setI] = useState(0);
  const [answer, setAnswer] = useState<CardAnswer>({});
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    void loadTheme(sk);
    api.reviews(sk, 20).then((r) => setCards(r.cards), (e) => setError((e as Error).message));
  }, [sk]);
  const leave = () => navigate(back ?? buildPath("/app/today", {}, { sk }));
  if (error) return <Failed error={error} sk={sk} />;
  if (!cards) return <Loading />;
  const card = cards[i];
  if (!card)
    return (
      <Page nav sk={sk}>
        <h1 class="las-h1" tabIndex={-1}>
          {t("review")}
        </h1>
        <Note icon="check">{cards.length ? t("All caught up.") : t("No reviews due.")}</Note>
        <Button primary onClick={leave}>
          {t("continue")}
        </Button>
      </Page>
    );
  const grade = async (g: 1 | 2 | 3 | 4) => {
    try {
      await api.event({ type: "review.graded", cardId: card.cardId, grade: g });
      setAnswer({});
      setI(i + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const revealed = !!answer.revealed;
  return (
    <Page sk={sk}>
      <div class="las-row">
        <Eyebrow>
          {t("review")} · {i + 1}/{cards.length}
        </Eyebrow>
        <Button link onClick={leave}>
          {t("done")}
        </Button>
      </div>
      <Card label={card.name}>
        <Eyebrow>{card.name}</Eyebrow>
        {card.figure ? <Figure figure={card.figure} /> : null}
        {card.options?.length ? (
          <Choice prompt={card.prompt} options={card.options} answer={typeof card.answer === "number" ? card.answer : undefined} state={{ picked: answer.picked, revealed }} onPick={(p) => setAnswer({ picked: p, revealed: true })} />
        ) : (
          <>
            <div class="las-prompt">{card.prompt}</div>
            {revealed ? (card.answer !== undefined ? <p class="las-sub">{String(card.answer)}</p> : null) : <Button onClick={() => setAnswer({ revealed: true })}>{t("Show the answer")}</Button>}
          </>
        )}
      </Card>
      {revealed ? (
        <div class="las-grades" role="group" aria-label={t("How well did you know it?")}>
          {([["Again", 1], ["Hard", 2], ["Good", 3], ["Easy", 4]] as const).map(([label, g]) => (
            <Button key={g} primary={g === 3} onClick={() => void grade(g)}>
              {t(label)}
            </Button>
          ))}
        </div>
      ) : (
        <Hint>{voice === "terse" ? "" : t("Answer first, then say how well you knew it.")}</Hint>
      )}
    </Page>
  );
}

/** A drill on its own (outside a session): knowledge items one at a time, or a capture for performance drills. */
export function DrillPage({ drillId, sk }: { drillId: string; sk?: string | null }) {
  const t = useT();
  const voice = useVoice();
  const [step, setStep] = useState<DrillStepView | undefined>(undefined);
  const [state, setState] = useState<{ picked?: number; success?: boolean }>({});
  const [info, setInfo] = useState<AttemptInfo | undefined>(undefined);
  const [result, setResult] = useState<ProcessResult | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    void loadTheme(sk);
    api.drillNext(drillId, { sk: sk ?? undefined }).then(async (s) => {
      setStep(s);
      if (s.kind === "capture" && s.attemptId) setInfo(await api.attempt(s.attemptId));
    }, (e) => setError((e as Error).message));
  }, [drillId]);
  if (error) return <Failed error={error} sk={sk} />;
  if (!step) return <Loading />;
  const pick = async (i: number) => {
    if (!step.item) return;
    setState({ picked: i });
    try {
      const r = await api.drillNext(drillId, { sk: step.sk, answer: { itemId: step.item.id, answer: i } });
      setStep(r);
      setState({ success: r.last?.correct });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const [captured, setCaptured] = useState<Captured | undefined>(undefined);
  const check = async () => {
    if (!info || !captured || busy) return;
    setBusy(true);
    try {
      setResult(await processCapture(api, info, captured, () => undefined));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page nav sk={step.sk}>
      <h1 class="las-h1" tabIndex={-1}>
        {step.drill.title}
      </h1>
      <DrillView drill={step.drill} difficulty={step.difficulty} label={step.label} state={step.item ? { item: step.item, picked: state.picked, success: state.success } : { success: state.success }} onPick={(i) => void pick(i)} voice={voice}>
        {step.kind === "capture" && info ? result?.feedback ? <Feedback view={result.feedback} voice={voice} /> : <CaptureView info={info} onCaptured={setCaptured} captured={!!captured} /> : undefined}
      </DrillView>
      {step.kind === "capture" && !result ? (
        <Button primary big disabled={!captured || busy} onClick={() => void check()}>
          {busy ? t("checking") : captured ? t("checkIt") : step.drill.type === "build" ? t("runFirst") : t("recordFirst")}
        </Button>
      ) : null}
      {step.done || result ? (
        <>
          <Note icon="check">{step.progress ? t(`${step.progress.correct} of ${step.progress.answered} right.`) : t("Drill done.")}</Note>
          <Button primary onClick={() => navigate(buildPath("/app/today", {}, { sk: step.sk }))}>
            {t("done")}
          </Button>
        </>
      ) : null}
    </Page>
  );
}

/** A capture on its own: from a studio link, a paired phone, an onboarding level check, or a proof check. */
export function CapturePage({ attemptId, query }: { attemptId: string; query: URLSearchParams }) {
  const t = useT();
  const [info, setInfo] = useState<AttemptInfo | undefined>(undefined);
  const [captured, setCaptured] = useState<Captured | undefined>(undefined);
  const [done, setDone] = useState(-1);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    api.attempt(attemptId).then(async (i) => {
      await loadTheme(i.attempt.enrollmentId);
      setInfo(i);
    }, (e) => setError((e as Error).message));
  }, [attemptId]);
  if (error && !info) return <Failed error={error} />;
  if (!info) return <Loading />;
  const check = async () => {
    if (!captured) return;
    setDone(0);
    try {
      const r = await processCapture(api, info, captured, setDone);
      const intake = query.get("intake");
      const field = query.get("field");
      if (intake && field) await api.answer(intake, field, { attemptId }).catch(() => undefined);
      const ret = query.get("return");
      if (ret) return navigate(ret);
      if (info.attempt.kind === "proof" && info.attempt.milestoneId) return navigate(buildPath("/app/proof/:milestoneId", { milestoneId: info.attempt.milestoneId }, { attempt: attemptId }));
      void r;
      navigate(buildPath("/app/replay/:attemptId", { attemptId }));
    } catch (e) {
      setDone(-1);
      setError((e as Error).message);
    }
  };
  return (
    <Page>
      {info.checklist?.length ? (
        <Card label={t("Proof standard")}>
          <Eyebrow>{info.singleTake ? t("One continuous take") : t("What counts")}</Eyebrow>
          <ul class="las-checks">
            {info.checklist.map((c) => (
              <li key={c.id}>{c.label}</li>
            ))}
          </ul>
        </Card>
      ) : null}
      {done >= 0 ? (
        <Card label={t("Analysis")}>
          <Eyebrow>{t("On this device. Nothing is uploaded.")}</Eyebrow>
          <Steps steps={PIPELINE_STEPS} done={done} />
        </Card>
      ) : (
        <CaptureView info={info} onCaptured={setCaptured} captured={!!captured} />
      )}
      {error ? <Note kind="warn" icon="warn">{error}</Note> : null}
      {done < 0 ? (
        <Button primary big disabled={!captured} onClick={() => void check()}>
          {captured ? t("checkIt") : info.attempt.engine === "code" ? t("runFirst") : t("recordFirst")}
        </Button>
      ) : null}
    </Page>
  );
}

export function ReplayPage({ attemptId }: { attemptId: string }) {
  const [sk, setSk] = useState<string | undefined>(undefined);
  useEffect(() => {
    api.attempt(attemptId).then((i) => {
      setSk(i.attempt.enrollmentId);
      void loadTheme(i.attempt.enrollmentId);
    }, () => undefined);
  }, [attemptId]);
  return (
    <Page nav sk={sk}>
      <ReplayView
        attemptId={attemptId}
        onTry={(fb) => fb.fixDrillId && navigate(buildPath("/app/drill/:id", { id: fb.fixDrillId }, { sk: fb.sk }))}
        onReRecord={async () => {
          const r = await api.attemptAgain(attemptId);
          navigate(buildPath("/app/capture/:attemptId", { attemptId: r.attemptId }));
        }}
      />
    </Page>
  );
}

export function ProgressPage({ sk }: { sk: string }) {
  const voice = useVoice();
  const [view, setView] = useState<ProgressView | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    void loadTheme(sk);
    api.progress(sk).then(setView, (e) => setError((e as Error).message));
  }, [sk]);
  if (error) return <Failed error={error} sk={sk} />;
  if (!view) return <Loading />;
  return (
    <Page nav sk={sk} current="progress">
      <ProgressScreen view={view} voice={voice} onProof={() => navigate(buildPath("/app/proof/:milestoneId", { milestoneId: "current" }, { sk }))} />
    </Page>
  );
}

export function SummaryPage({ sessionId }: { sessionId: string }) {
  const voice = useVoice();
  const [view, setView] = useState<SummaryView | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    api.summary(sessionId).then((v) => {
      setView(v);
      void loadTheme(v.sk);
    }, (e) => setError((e as Error).message));
  }, [sessionId]);
  if (error) return <Failed error={error} />;
  if (!view) return <Loading />;
  return (
    <Page nav sk={view.sk}>
      <Summary view={view} voice={voice} />
    </Page>
  );
}

/** The proof check: readiness, then one continuous take, then the result per criterion. */
export function ProofPage({ milestoneId, query }: { milestoneId: string; query: URLSearchParams }) {
  const t = useT();
  const voice = useVoice();
  const sk = query.get("sk");
  const attempt = query.get("attempt");
  const [result, setResult] = useState<ProofResultView | undefined>(undefined);
  const [ready, setReady] = useState<{ message: string; checklist: { id: string; label: string }[]; ready: boolean } | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    void loadTheme(sk);
    if (attempt) {
      api.feedback(attempt).then((r) => (r.proof ? setResult(r.proof) : setError(t("The result isn't in yet."))), (e) => setError((e as Error).message));
      return;
    }
    api.proofStart({ milestoneId: milestoneId === "current" ? undefined : milestoneId, sk: sk ?? undefined }).then((r) => {
      if (r.attempt) return navigate(buildPath("/app/capture/:attemptId", { attemptId: r.attempt.id }), { replace: true });
      setReady(r);
    }, (e) => setError((e as Error).message));
  }, [milestoneId, attempt]);
  if (error) return <Failed error={error} sk={sk} />;
  if (result)
    return (
      <Page nav sk={sk}>
        <ProofResult view={result} voice={voice} onNext={() => navigate(sk ? buildPath("/app/today", {}, { sk }) : "/")} onRetry={() => navigate(sk ? buildPath("/app/today", {}, { sk }) : "/")} />
      </Page>
    );
  if (!ready) return <Loading />;
  return (
    <Page nav sk={sk}>
      <h1 class="las-h1" tabIndex={-1}>
        {t("Proof check")}
      </h1>
      <Note icon="flag">{ready.message}</Note>
      <ul class="las-checks">
        {ready.checklist.map((c) => (
          <li key={c.id}>{c.label}</li>
        ))}
      </ul>
      <Button
        primary
        icon="flag"
        onClick={() =>
          api.proofStart({ milestoneId: milestoneId === "current" ? undefined : milestoneId, sk: sk ?? undefined, proceed: true }).then(
            (r) => r.attempt && navigate(buildPath("/app/capture/:attemptId", { attemptId: r.attempt.id })),
            (e) => setError((e as Error).message)
          )
        }
      >
        {t("Take it anyway")}
      </Button>
    </Page>
  );
}

/** A theme previewed on the learner's own screens (theming §7 preview_theme), applied to this page only. */
export function ThemePage({ id }: { id: string }) {
  const voice = useVoice();
  const [ok, setOk] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [sample, setSample] = useState<{ skill: string; milestone: string; nextSession: string; ladder: string[] } | undefined>(undefined);
  useEffect(() => {
    api.themeById(id).then((r) => {
      setActiveTheme(r.theme, r.themeId);
      setOk(true);
    }, (e) => setError((e as Error).message));
    api.state().then(async (s) => {
      const e = s.enrollments[0];
      if (!e) return setSample(undefined);
      const today = await api.today(e.sk).catch(() => undefined);
      setSample({ skill: e.skill, milestone: e.milestone?.title ?? "", nextSession: today?.nextSession?.title ?? "", ladder: today?.route.steps.map((st) => st.label) ?? [] });
    }, () => undefined);
  }, [id]);
  if (error) return <Failed error={error} />;
  if (!ok) return <Loading />;
  const base = { skill: "Your skill", milestone: "Your first milestone", nextSession: "Session 1", ladder: ["Brand new", "First step", "Second step", "Your milestone"] };
  const s = { ...base, ...Object.fromEntries(Object.entries(sample ?? {}).filter(([, v]) => (Array.isArray(v) ? v.length >= 3 : !!v))) } as typeof base;
  return (
    <ThemePreview
      voice={voice}
      sample={{ ...s, lessonCard: { type: "predict", text: "Which helps more at the start?", options: ["Slow and clean", "Fast and messy"], answer: 0 }, feedback: { headline: "One thing to fix", praise: "One thing done well" } }}
    />
  );
}
