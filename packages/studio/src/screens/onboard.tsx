/**
 * Onboarding in the studio: the shared Onboarding screen, one step at a time from the server (record_answer's
 * rules), with multi-answer picks held on the device until the step's main button sends them.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { Onboarding, Button } from "@las/ui";
import type { IntakeView } from "@las/schema";
import { api } from "../api.js";
import { navigate, buildPath } from "../router.js";
import { loadTheme, useT, useVoice } from "../theme.js";
import { adaptIntake, submission, suggestionValue, toggle, type IntakeDraft } from "../intake.js";
import { playClicks } from "../capture/audio.js";
import { Failed, Loading } from "./common.js";

const SECTIONS = ["Look", "Skill", "Why", "Picture it", "Level", "Time", "Milestone", "Plan"];

/** The first screen: pick one of the skill models the agent has written, or ask the agent for a new one. */
export function OnboardNew() {
  const t = useT();
  const voice = useVoice();
  const [models, setModels] = useState<{ id: string; name: string; engines: string[] }[] | undefined>(undefined);
  const [asked, setAsked] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    void loadTheme();
    api.skillModels().then((r) => setModels(r.models), (e) => setError((e as Error).message));
  }, []);
  if (error) return <Failed error={error} />;
  if (!models) return <Loading />;
  const view: IntakeView = {
    intakeId: "new",
    step: "skill",
    stepIndex: 0,
    sections: SECTIONS,
    sectionIndex: 1,
    ribbon: [],
    question: t("What do you want to learn?"),
    sub: asked ? t(`Ask your agent: "I want to learn ${asked}". It writes the skill model, and it shows up here.`) : models.length ? undefined : t("Nothing set up yet. Tell your agent what you want to learn; it appears here once its skill model passes validation."),
    answerType: "single",
    options: models.map((m) => ({ value: m.id, label: m.name, detail: m.engines.filter((e) => e !== "self-report").join(" · "), icon: "spark" })),
    cta: { label: t("Check again"), enabled: true }
  };
  return (
    <Onboarding
      view={view}
      voice={voice}
      h={{
        onAnswer: async (_f, v) => {
          try {
            const r = await api.startIntake(String(v));
            navigate(buildPath("/app/onboard/:intakeId", { intakeId: r.intakeId }));
          } catch (e) {
            setError((e as Error).message);
          }
        },
        onText: (_f, text) => setAsked(text.trim() || undefined),
        onNext: () => api.skillModels().then((r) => setModels(r.models), () => undefined)
      }}
    />
  );
}

export function OnboardScreen({ intakeId }: { intakeId: string }) {
  const t = useT();
  const voice = useVoice();
  const [view, setView] = useState<IntakeView | undefined>(undefined);
  const [draft, setDraft] = useState<IntakeDraft>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const history = useRef<string[]>([]);
  const taps = useRef<{ times: number[]; stop?: () => void; ctx?: AudioContext }>({ times: [] });
  const root = useRef<HTMLDivElement | null>(null);

  const show = (v: IntakeView, push = true) => {
    if (push && view && view.step !== v.step) history.current.push(view.step);
    setView(v);
    setDraft({});
    setError(undefined);
    taps.current = { times: [] };
  };

  useEffect(() => {
    void loadTheme();
    api.intake(intakeId).then((v) => show(v, false), (e) => setError((e as Error).message));
  }, [intakeId]);

  const send = async (field: string, value: unknown) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.answer(intakeId, field, value);
      if (field === view?.field && view?.answerType === "quiz" && r.answer && typeof r.answer.correct === "boolean") {
        const prior = draft.quiz?.[field] ?? [];
        if (r.view.step === view.step && r.view.field === field) {
          setView(r.view);
          setDraft({ ...draft, quiz: { ...(draft.quiz ?? {}), [field]: [...prior, r.answer.correct as boolean] } });
          return;
        }
      }
      show(r.view);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // the tap probe: the shared screen draws the pad; taps land against a click the studio plays
  useEffect(() => {
    const el = root.current;
    if (!el || view?.answerType !== "tap") return;
    const bpm = Number((view.payload?.spec as { tempo?: number } | undefined)?.tempo ?? 90);
    const onTap = (e: Event) => {
      if (!(e.target as HTMLElement).closest('[data-act="tap"]')) return;
      const T = taps.current;
      if (!T.ctx) {
        T.ctx = new AudioContext();
        const at = T.ctx.currentTime + 60 / bpm;
        T.stop = playClicks(T.ctx, bpm, at, 9);
        T.times = [];
        (T as any).grid = at;
        setDraft((d) => ({ ...d, taps: 0 }));
        return;
      }
      T.times.push(T.ctx.currentTime);
      setDraft((d) => ({ ...d, taps: T.times.length }));
      if (T.times.length >= 8) {
        const grid: number = (T as any).grid;
        const period = 60 / bpm;
        const offsets = T.times.map((x) => {
          const d = x - grid;
          return Math.round((d - Math.round(d / period) * period) * 1000);
        });
        T.stop?.();
        void T.ctx.close();
        taps.current = { times: [] };
        void send(view.field ?? "tap", offsets);
      }
    };
    el.addEventListener("click", onTap);
    return () => el.removeEventListener("click", onTap);
  }, [view]);

  if (error && !view) return <Failed error={error} />;
  if (!view) return <Loading />;
  const shown = adaptIntake(view, draft);
  if (error) shown.sub = error;
  const p = (view.payload ?? {}) as Record<string, any>;

  const next = async () => {
    if (view.step === "plan") {
      const sk = view.sk ?? (p.plan as { sk?: string } | undefined)?.sk;
      return navigate(sk ? buildPath("/app/today", {}, { sk }) : "/");
    }
    if (view.step === "milestone") {
      const value = draft.milestone ?? (typeof view.value === "string" ? view.value : undefined);
      if (!value) return;
      setBusy(true);
      try {
        const r = await api.setMilestone(intakeId, value);
        await loadTheme(r.sk);
        show(r.view);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    const sub = submission(view, draft);
    if (sub) await send(sub.field, sub.value);
    else api.intake(intakeId).then((v) => show(v), (e) => setError((e as Error).message));
  };

  const back = () => {
    const prev = history.current.pop();
    if (prev) api.intake(intakeId, prev).then((v) => show(v, false), (e) => setError((e as Error).message));
  };

  const field = view.field ?? "";
  const secondary =
    view.step === "probe" && (view.answerType === "record" || view.answerType === "code") && p.attemptId ? (
      <Button link icon={view.answerType === "code" ? "code" : "cam"} onClick={() => navigate(buildPath("/app/capture/:attemptId", { attemptId: String(p.attemptId) }, { intake: intakeId, field, return: buildPath("/app/onboard/:intakeId", { intakeId }) }))}>
        {view.answerType === "code" ? t("Write it in the editor") : t("Record it")}
      </Button>
    ) : view.step === "look" ? (
      <Button link onClick={() => void send("look", "plain")}>
        {t("skip")}
      </Button>
    ) : undefined;

  return (
    <div ref={root}>
      <Onboarding
        view={{ ...shown, cta: { ...shown.cta, enabled: shown.cta.enabled && !busy, secondary } as any }}
        voice={voice}
        entering
        h={{
          onAnswer: (f, v) => {
            switch (f) {
              case "why":
                return setDraft({ ...draft, why: toggle(draft.why ?? ((view.value as string[]) ?? []), String(v), view.max ?? 2) });
              case "minutes":
                return setDraft({ ...draft, minutes: Number(v) });
              case "deadline":
                return setDraft({ ...draft, deadline: String(v) });
              case "access":
                return setDraft({ ...draft, access: toggle(draft.access ?? ((view.value as { access?: string[] })?.access ?? []), String(v)) });
              case "injury":
                return setDraft({ ...draft, injuries: toggle(draft.injuries ?? ((view.value as { injuries?: string[] })?.injuries ?? []), String(v)) });
              case "milestone": {
                const s = (p.suggestions as any[])?.[Number(v)];
                return s ? setDraft({ ...draft, milestone: suggestionValue(s) }) : undefined;
              }
              case "ladderStep":
                return setDraft({ ...draft, milestone: `ladder:${v}` });
              case "fresh":
                return void send("fresh", true);
              default:
                break;
            }
            if (view.step === "probe" && f === field) {
              if (view.answerType === "multi" || view.answerType === "visual-multi") return setDraft({ ...draft, multi: { ...(draft.multi ?? {}), [field]: toggle(draft.multi?.[field] ?? ((view.value as any[]) ?? []), v as string | number, view.max) } });
              if (view.answerType === "quiz") {
                const item = p.item as { id: string } | undefined;
                return item ? void send(field, { itemId: item.id, answer: v }) : undefined;
              }
            }
            return void send(f, v);
          },
          onText: (f, text) => {
            if (f === "customMilestone") return text.trim().length > 2 ? setDraft({ ...draft, milestone: text.trim() }) : undefined;
            if (text.trim().length > 2) void send(f, text.trim());
          },
          onAdjust: (d) => void send("place", d > 0 ? "too-easy" : "too-hard"),
          onNext: () => void next(),
          onBack: back,
          onRibbon: (id) => api.intake(intakeId, id).then((v) => show(v), (e) => setError((e as Error).message))
        }}
      />
    </div>
  );
}
