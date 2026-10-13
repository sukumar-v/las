import type { IntakeView, PlacementView, MilestoneSuggestion, PlanView, OptionView } from "@las/schema";
import { Frame } from "../components/frame.js";
import { Question, Hint, Note, Button, Chips, Chip, Card, Eyebrow, H2, Stat, Mix, Tag, Pill } from "../components/primitives.js";
import { Single, Multi, Scale, VisualMulti, Slider, WeekPlan, Choice } from "../components/answers.js";
import { Route } from "../components/route.js";
import { Icon } from "../icons.js";
import { copy, type Voice } from "../copy.js";

export interface OnboardingHandlers {
  onAnswer?: (field: string, value: unknown) => void;
  onNext?: () => void;
  onBack?: () => void;
  onRibbon?: (id: string) => void;
  onAdjust?: (delta: -1 | 1) => void;
  onText?: (field: string, text: string) => void;
}

const DEADLINES: OptionView[] = [
  { value: "none", label: "No deadline" },
  { value: "4w", label: "4 weeks" },
  { value: "3m", label: "3 months" },
  { value: "6m", label: "6 months" }
];

/** Renders one onboarding step from an IntakeView. Same frame for every skill. */
export function Onboarding({ view, h = {}, voice, entering }: { view: IntakeView; h?: OnboardingHandlers; voice?: Voice; entering?: boolean }) {
  const p = view.payload ?? {};
  const body = () => {
    switch (view.step) {
      case "look":
        return (
          <>
            <Question q={view.question} sub={view.sub} />
            <Single
              options={view.options ?? []}
              value={view.value}
              onPick={(v) => h.onAnswer?.("look", v)}
            />
            <Hint>Paste a design prompt, describe it, or add a screenshot in the chat. Everything after this is drawn in your look.</Hint>
          </>
        );
      case "skill":
        return (
          <>
            <Question q={view.question} sub={view.sub} />
            {view.options?.length ? <Single options={view.options} value={view.value} list={false} onPick={(v) => h.onAnswer?.("skill", v)} /> : null}
            <div class="las-or">or anything else</div>
            <form
              class="las-field"
              autocomplete="off"
              onSubmit={(e) => {
                e.preventDefault();
                h.onText?.("skill", ((e.currentTarget as HTMLFormElement).querySelector("input") as HTMLInputElement).value);
              }}
            >
              <input id="skill-input" aria-label="Skill" placeholder="Rock climbing, Japanese, chess…" value={typeof view.value === "string" ? view.value : ""} enterkeyhint="go" />
              <Button primary type="submit">Go</Button>
            </form>
            <Hint>Every skill gets its own ladder of goals.</Hint>
          </>
        );
      case "why":
        return (
          <>
            <Question q={view.question} sub={view.sub ?? "Pick up to two."} />
            <Multi options={view.options ?? []} value={(view.value as any[]) ?? []} max={view.max ?? 2} onToggle={(v) => h.onAnswer?.("why", v)} />
          </>
        );
      case "picture":
        return (
          <>
            <Question q={view.question} sub={view.sub} />
            <Single options={view.options ?? []} value={view.value} onPick={(v) => h.onAnswer?.("picture", v)} />
            <form
              class="las-field"
              autocomplete="off"
              onSubmit={(e) => {
                e.preventDefault();
                h.onText?.("pictureText", ((e.currentTarget as HTMLFormElement).querySelector("input") as HTMLInputElement).value);
              }}
            >
              <input id="picture-input" aria-label="In your own words" placeholder="Or say it your way" value={(p.pictureText as string) ?? ""} enterkeyhint="next" />
            </form>
          </>
        );
      case "probe": {
        const probe = p.probe as { id: string; type: string; spec?: unknown; items?: any[] } | undefined;
        const field = view.field ?? probe?.id ?? "probe";
        return (
          <>
            <Question q={view.question} sub={view.sub} />
            {view.answerType === "single" ? <Single options={view.options ?? []} value={view.value} onPick={(v) => h.onAnswer?.(field, v)} /> : null}
            {view.answerType === "multi" ? <Multi big options={view.options ?? []} value={(view.value as any[]) ?? []} onToggle={(v) => h.onAnswer?.(field, v)} /> : null}
            {view.answerType === "scale" ? <Scale options={view.options ?? []} value={view.value} onPick={(v) => h.onAnswer?.(field, v)} /> : null}
            {view.answerType === "visual-multi" ? <VisualMulti options={view.options ?? []} value={(view.value as any[]) ?? []} onToggle={(v) => h.onAnswer?.(field, v)} /> : null}
            {view.answerType === "quiz" ? <QuizStep payload={p} onPick={(i) => h.onAnswer?.(field, i)} /> : null}
            {view.answerType === "tap" ? <TapStep payload={p} /> : null}
            {view.answerType === "record" ? (
              <label class="las-upload" for="probe-clip">
                <Icon name="cam" />
                <span>{(p.clipName as string) ?? "Add a short clip, or skip"}</span>
                <input type="file" id="probe-clip" accept="video/*,audio/*" hidden />
              </label>
            ) : null}
            {view.answerType === "code" ? <textarea class="las-textarea" aria-label="Code" placeholder={(p.starter as string) ?? ""} /> : null}
            {view.stepIndex <= 1 || (p.first as boolean) ? (
              <Button link onClick={() => h.onAnswer?.("fresh", true)}>
                {copy(voice, "newToThis")}
              </Button>
            ) : null}
          </>
        );
      }
      case "place": {
        const pl = p.placement as PlacementView;
        return (
          <>
            <Question q={view.question} sub={view.sub ?? "Based on what you just showed us."} />
            <div class="las-ev">
              {pl.evidence.map((e) => (
                <span key={e}>
                  <Icon name="check" size="sm" />
                  {e}
                </span>
              ))}
            </div>
            <Route route={{ start: pl.step, steps: pl.rows.map((r) => ({ step: r.step, label: r.label, hours: [0, 0], weeks: r.weeks, state: r.state, target: false, nodes: [] })) }} />
            <div class="las-nudge">
              <Button icon="down" disabled={!pl.canLower} onClick={() => h.onAdjust?.(-1)}>
                {copy(voice, "tooHard")}
              </Button>
              <Button icon="up" disabled={!pl.canRaise} onClick={() => h.onAdjust?.(1)}>
                {copy(voice, "tooEasy")}
              </Button>
            </div>
          </>
        );
      }
      case "time": {
        const minutes = (p.minutes as number) ?? 180;
        const sched = p.schedule as { sessionsPerWeek: number; minutesEach: number; days: number[] };
        return (
          <>
            <Question q={view.question} sub={view.sub ?? "A rough guess is fine. You can change it any week."} />
            <Slider id="minutes" label="Hours per week" min={30} max={600} step={30} value={minutes} format={(v) => `${(v / 60).toFixed(1).replace(/\.0$/, "")} hours a week`} hints={["30 min", "10 h"]} onInput={(v) => h.onAnswer?.("minutes", v)} />
            {sched ? <WeekPlan days={sched.days} minutes={minutes} sessions={sched.sessionsPerWeek} /> : null}
            <H2>Any deadline?</H2>
            <Chips>
              {DEADLINES.map((d) => (
                <Chip key={String(d.value)} label={d.label} on={(p.deadline ?? "none") === d.value} onClick={() => h.onAnswer?.("deadline", d.value)} />
              ))}
            </Chips>
          </>
        );
      }
      case "around": {
        const access = (p.accessOptions as string[]) ?? [];
        const injuries = (p.injuryOptions as string[]) ?? [];
        const picked = (p.access as string[]) ?? [];
        const hurt = (p.injuries as string[]) ?? [];
        return (
          <>
            <Question q={view.question} sub={view.sub ?? "Tap what applies. Skip if nothing does."} />
            <H2>What you have</H2>
            <Chips>
              {access.map((a) => (
                <Chip key={a} label={a} on={picked.includes(a)} onClick={() => h.onAnswer?.("access", a)} />
              ))}
            </Chips>
            {injuries.length ? (
              <>
                <H2>Anything that hurts?</H2>
                <Chips>
                  {injuries.map((a) => (
                    <Chip key={a} label={a} icon="care" on={hurt.includes(a)} onClick={() => h.onAnswer?.("injury", a)} />
                  ))}
                </Chips>
              </>
            ) : null}
          </>
        );
      }
      case "milestone": {
        const sugs = (p.suggestions as MilestoneSuggestion[]) ?? [];
        const picked = p.picked as number | undefined;
        return (
          <>
            <Question q={view.question} sub={view.sub} />
            <div class="las-stack" role="group" aria-label="Milestone suggestions">
              {sugs.map((s, i) => (
                <button key={i} type="button" class="las-tile" aria-pressed={picked === i ? "true" : "false"} onClick={() => h.onAnswer?.("milestone", i)}>
                  <span class="tt">
                    <span class="las-row">
                      <Eyebrow>{s.kindLabel}</Eyebrow>
                      <Pill kind={s.feasibility.kind}>{s.feasibility.label}</Pill>
                    </span>
                    <b>{s.title}</b>
                    <small>
                      {s.proof} · ~{s.weeks} wk
                    </small>
                    {s.feasibility.message ? <small>{s.feasibility.message}</small> : null}
                  </span>
                </button>
              ))}
            </div>
            <form
              class="las-field"
              autocomplete="off"
              onSubmit={(e) => {
                e.preventDefault();
                h.onText?.("customMilestone", ((e.currentTarget as HTMLFormElement).querySelector("input") as HTMLInputElement).value);
              }}
            >
              <input id="custom-milestone" aria-label="Your own milestone" placeholder={(p.placeholder as string) ?? "Your own milestone"} enterkeyhint="done" />
              <Button primary type="submit">Set</Button>
            </form>
            {p.route ? (
              <details>
                <summary>Show the full ladder</summary>
                <Route route={p.route as any} onPick={(step) => h.onAnswer?.("ladderStep", step)} />
              </details>
            ) : null}
          </>
        );
      }
      case "plan": {
        const plan = p.plan as PlanView;
        return (
          <>
            <section class="las-hero">
              <Eyebrow>{plan.skill} · first milestone</Eyebrow>
              <h1 class="las-h1" tabIndex={-1}>{plan.milestone.title}</h1>
              <Note icon={plan.milestone.engine === "code" ? "code" : plan.milestone.engine === "audio" || plan.milestone.engine === "speech" ? "mic" : plan.milestone.engine === "self-report" ? "flag" : "cam"}>
                <b>{plan.milestone.engine}</b>
                <br />
                {plan.milestone.proof}
              </Note>
              <div class="las-stats">
                <Stat value={plan.milestone.targetDate} label="target date" />
                <Stat value={`${plan.milestone.weeks} wk`} label="estimate" />
                <Stat value={`${plan.milestone.hoursPerWeek} h`} label="per week" />
              </div>
            </section>
            <H2>Your route</H2>
            <Route route={plan.route} />
            <H2>Shaped by your answers</H2>
            <div class="las-inline">
              {plan.why.map((w) => (
                <Tag key={w}>{w}</Tag>
              ))}
              <span aria-hidden="true">→</span>
              <b>{plan.picture}</b>
            </div>
            <Mix parts={plan.mix} />
            {plan.mixReasons.length ? <Hint>Adjusted for: {plan.mixReasons.join(" · ")}</Hint> : null}
            <H2>Check-ins</H2>
            <WeekPlan days={plan.schedule.days} minutes={plan.schedule.minutesEach * plan.schedule.sessionsPerWeek} sessions={plan.schedule.sessionsPerWeek} />
            <ul class="las-checks">
              {plan.checkins.map((c) => (
                <li key={c}>
                  <Icon name="clock" />
                  <span>{c}</span>
                </li>
              ))}
              {plan.injuryRules.map((r) => (
                <li key={r.injury} class="care">
                  <Icon name="care" />
                  <span>
                    <b>{r.injury}:</b> {r.rule}
                  </span>
                </li>
              ))}
              {plan.safety?.supervisedOnly.length ? (
                <li class="care">
                  <Icon name="warn" />
                  <span>Theory only, never coached here: {plan.safety.supervisedOnly.join(", ")}.</span>
                </li>
              ) : null}
            </ul>
            <details class="las-profile">
              <summary>Learner profile · what LAS stores</summary>
              <pre class="las-code">{JSON.stringify(plan.profile, null, 2)}</pre>
            </details>
          </>
        );
      }
    }
  };
  return (
    <Frame sections={view.sections} sectionIndex={view.sectionIndex} sectionFill={0.5} ribbon={view.ribbon} onRibbon={h.onRibbon} onBack={h.onBack} canBack={view.stepIndex > 0} cta={{ label: view.cta.label, enabled: view.cta.enabled, onClick: h.onNext, secondary: view.cta.secondary }} entering={entering}>
      {body()}
    </Frame>
  );
}

function QuizStep({ payload, onPick }: { payload: Record<string, unknown>; onPick?: (i: number) => void }) {
  const item = payload.item as { prompt: string; options: string[]; answer?: number; code?: string } | undefined;
  const hist = (payload.history as boolean[]) ?? [];
  if (!item) return <Note>Quiz done.</Note>;
  return (
    <div class="las-stack">
      <div class="las-row">
        <Eyebrow>Question {hist.length + 1}</Eyebrow>
        <span class="las-inline" aria-label={`${hist.filter(Boolean).length} right so far`}>
          {hist.map((h, i) => (
            <Pill key={i} kind={h ? "good" : "bad"}>{h ? "✓" : "✗"}</Pill>
          ))}
        </span>
      </div>
      <Choice prompt={item.prompt} options={item.options} code={item.code} onPick={onPick} />
    </div>
  );
}

function TapStep({ payload }: { payload: Record<string, unknown> }) {
  const taps = (payload.taps as number) ?? 0;
  return (
    <Card label="Tap test">
      <Eyebrow>Tap with the click</Eyebrow>
      <button type="button" class="las-pad-btn" data-act="tap" aria-label="Tap pad">
        {taps ? taps : "TAP"}
      </button>
      <Hint>{(payload.hint as string) ?? "Eight beats. We measure how far from the beat you land."}</Hint>
    </Card>
  );
}
