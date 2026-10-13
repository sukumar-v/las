import type { SessionPlan, SessionItem, SessionBlock, Analysis, Drill } from "@las/schema";
import { Frame } from "../components/frame.js";
import { Card, Eyebrow, Button, Hint, Steps, Note, Chips, Chip, Question } from "../components/primitives.js";
import { Lesson, type CardAnswer } from "../components/lesson.js";
import { Choice } from "../components/answers.js";
import { Icon } from "../icons.js";
import { copy, type Voice } from "../copy.js";

export const BLOCK_LABELS: Record<SessionBlock["kind"], string> = { warmup: "Warm-up", recall: "Recall", learn: "Learn", practice: "Practice", perform: "Perform", wrapup: "Wrap-up" };

export interface SessionStep {
  blockIndex: number;
  itemIndex: number;
  /** sub-step inside an item: a card index, a drill round, capture/analyze/feedback/fix phases */
  phase?: string;
}

/** Flatten a plan into steps the runner walks through. */
export function sessionSteps(plan: SessionPlan): SessionStep[] {
  const out: SessionStep[] = [];
  plan.blocks.forEach((b, bi) => {
    b.items.forEach((it, ii) => {
      if (it.type === "capture") out.push({ blockIndex: bi, itemIndex: ii, phase: "capture" }, { blockIndex: bi, itemIndex: ii, phase: "analyze" }, { blockIndex: bi, itemIndex: ii, phase: "feedback" });
      else out.push({ blockIndex: bi, itemIndex: ii });
    });
  });
  return out;
}

export interface SessionHandlers {
  onNext?: () => void;
  onBack?: () => void;
  onExit?: () => void;
  onCardAnswer?: (lessonId: string, i: number, a: CardAnswer) => void;
  onDrillPick?: (drillId: string, i: number) => void;
  onWarmupTick?: (i: number) => void;
  onCapture?: (item: Extract<SessionItem, { type: "capture" }>) => void;
  onReview?: () => void;
}

export function SessionScreen({ plan, step, state, h = {}, voice, children }: { plan: SessionPlan; step: SessionStep; state: Record<string, any>; h?: SessionHandlers; voice?: Voice; children?: preact.ComponentChildren }) {
  const block = plan.blocks[step.blockIndex];
  const item = block.items[step.itemIndex];
  const steps = sessionSteps(plan);
  const idx = steps.findIndex((s) => s.blockIndex === step.blockIndex && s.itemIndex === step.itemIndex && s.phase === step.phase);
  const sections = plan.blocks.map((b) => BLOCK_LABELS[b.kind]);
  const inBlock = steps.filter((s) => s.blockIndex === step.blockIndex);
  const pos = inBlock.findIndex((s) => s === steps[idx]);
  let cta = { label: copy(voice, "continue"), enabled: true };
  let body: preact.ComponentChildren = null;
  switch (item.type) {
    case "warmup": {
      const ticks = (state.warmup as number[]) ?? [];
      const all = ticks.length >= item.steps.length;
      cta = { label: all ? "Warm-up done" : "Tick each one off", enabled: all };
      body = (
        <>
          <Question q={block.title} sub={block.reason} />
          <Card label="Warm-up">
            <ul class="las-steps">
              {item.steps.map((s, i) => (
                <li key={i} class={ticks.includes(i) ? "done" : ""}>
                  <Chip label={s} on={ticks.includes(i)} onClick={() => h.onWarmupTick?.(i)} />
                </li>
              ))}
            </ul>
          </Card>
        </>
      );
      break;
    }
    case "review":
      cta = { label: state.reviewed ? copy(voice, "continue") : copy(voice, "review"), enabled: true };
      body = (
        <>
          <Question q={block.title} sub={block.reason} />
          <button type="button" class="las-card las-cardbtn" onClick={h.onReview}>
            <Icon name="repeat" />
            <span>
              <b>{item.count} cards due</b>
              <small>Spaced repetition keeps it</small>
            </span>
          </button>
        </>
      );
      break;
    case "lesson": {
      const answers = (state.cards?.[item.lessonId] as CardAnswer[]) ?? [];
      const first = item.cards[0];
      const needs = first?.type === "predict" ? answers[0]?.revealed : true;
      cta = { label: copy(voice, "continue"), enabled: !!needs };
      body = (
        <>
          <Question q={item.title} sub={block.reason} />
          <Lesson title={item.title} cards={item.cards} answers={answers} onAnswer={(i, a) => h.onCardAnswer?.(item.lessonId, i, a)} voice={voice} />
        </>
      );
      break;
    }
    case "drill": {
      const d = item.drill;
      const done = !!state.drills?.[d.id];
      cta = { label: copy(voice, "continue"), enabled: done || d.type === "make" };
      body = (
        <>
          <Question q={d.title} sub={block.reason} />
          <DrillView drill={d} difficulty={item.difficulty} label={item.label} state={state.drills?.[d.id]} onPick={(i) => h.onDrillPick?.(d.id, i)} voice={voice}>
            {children}
          </DrillView>
        </>
      );
      break;
    }
    case "capture": {
      if (step.phase === "capture") {
        const captured = !!state.captured?.[item.attemptSpecId];
        cta = { label: captured ? copy(voice, "checkIt") : item.engine === "code" ? copy(voice, "runFirst") : copy(voice, "recordFirst"), enabled: captured };
        body = (
          <>
            <Question q={item.prompt} sub={item.how} />
            {children ?? (
              <Button primary icon={item.engine === "code" ? "code" : item.engine === "audio" || item.engine === "speech" ? "mic" : "cam"} onClick={() => h.onCapture?.(item)}>
                {item.engine === "code" ? copy(voice, "runTests") : item.engine === "visual" ? "Add a photo" : "Record"}
              </Button>
            )}
          </>
        );
      } else if (step.phase === "analyze") {
        const done = (state.pipeline?.[item.attemptSpecId] as number) ?? 0;
        const stepsList = (state.pipelineSteps?.[item.attemptSpecId] as string[]) ?? ["Recording is usable", "Features extracted", "Metrics", "Mistake check"];
        cta = { label: copy(voice, "checking"), enabled: false };
        body = (
          <>
            <Question q="Checking your attempt" sub="On this device. Nothing is uploaded." />
            <Card label="Analysis">
              <Steps steps={stepsList} done={done} />
            </Card>
          </>
        );
      } else {
        cta = { label: copy(voice, "tryFix"), enabled: true };
        body = children ?? <Note>Feedback appears here.</Note>;
      }
      break;
    }
    case "wrapup":
      cta = { label: copy(voice, "done"), enabled: true };
      body = children ?? (
        <>
          <Question q="Wrap-up" sub="What changed, and what's next." />
        </>
      );
      break;
  }
  return (
    <Frame sections={sections} sectionIndex={step.blockIndex} sectionFill={(pos + 1) / Math.max(inBlock.length, 1)} onBack={h.onBack} canBack={idx > 0} exit="Exit" onExit={h.onExit} cta={{ ...cta, onClick: h.onNext }}>
      {body}
    </Frame>
  );
}

/** The non-performance drill types render here; performance drills (move, play-along, say-it, build, make) use the capture flow. */
export function DrillView({ drill, difficulty, label, state, onPick, voice, children }: { drill: Drill; difficulty: number; label: string; state?: any; onPick?: (i: number) => void; voice?: Voice; children?: preact.ComponentChildren }) {
  const item = state?.item as { prompt: string; options?: string[]; answer?: number; code?: string; figures?: any[]; pairs?: [string, string][]; items?: string[] } | undefined;
  return (
    <div class="las-stack" data-drill={drill.type}>
      <div class="las-row">
        <Eyebrow>{drill.type} · level {difficulty + 1}{label ? ` · ${label}` : ""}</Eyebrow>
        {state?.success !== undefined ? <span class={`las-pill ${state.success ? "good" : "warn"}`}>{state.success ? copy(voice, "wellDone") : copy(voice, "tryAgain")}</span> : null}
      </div>
      {drill.prompt ? <p class="las-sub">{drill.prompt}</p> : null}
      {children}
      {!children && item && (drill.type === "choice" || drill.type === "predict-output" || drill.type === "hotspot") ? <Choice prompt={item.prompt} options={item.options ?? []} answer={item.answer} code={item.code} figures={item.figures} state={{ picked: state?.picked, revealed: state?.revealed }} onPick={onPick} /> : null}
      {!children && item && drill.type === "fill" ? (
        <Card>
          <div class="las-prompt">{item.prompt}</div>
          <input class="las-textarea" aria-label="Your answer" />
        </Card>
      ) : null}
      {!children && item && (drill.type === "match" || drill.type === "order") ? (
        <Card>
          <div class="las-prompt">{item.prompt}</div>
          <Chips>
            {(item.items ?? item.pairs?.map((p) => p[0]) ?? []).map((x, i) => (
              <Chip key={i} label={x} onClick={() => onPick?.(i)} />
            ))}
          </Chips>
        </Card>
      ) : null}
      {!children && !item && drill.type === "tap-rhythm" ? (
        <Card label="Tap the rhythm">
          <button type="button" class="las-pad-btn" aria-label="Tap pad">TAP</button>
        </Card>
      ) : null}
      {!children && !item && ["move", "play-along", "say-it", "timed-reps", "build", "make"].includes(drill.type) ? <Note icon={drill.type === "build" ? "code" : drill.type === "make" ? "look" : drill.type === "move" || drill.type === "timed-reps" ? "cam" : "mic"}>{drill.type === "make" ? "Upload your work when it's done." : "Live meters appear while you work."}</Note> : null}
    </div>
  );
}

export function AnalysisSummary({ analysis }: { analysis: Analysis }) {
  const metrics = Object.entries(analysis.metrics).slice(0, 6);
  return (
    <Card label="Measurements">
      <Eyebrow>Measured</Eyebrow>
      <dl class="las-kv">
        {metrics.map(([k, v]) => (
          <>
            <dt key={`k${k}`}>{k.replace(/_/g, " ")}</dt>
            <dd key={`v${k}`}>
              {Number.isFinite(v.value) ? Math.round(v.value * 100) / 100 : "–"} {v.unit}
              {v.confidence < 0.7 ? " (low confidence)" : ""}
            </dd>
          </>
        ))}
      </dl>
      {analysis.quality.issues.length ? <Hint>{analysis.quality.issues.join(". ")}</Hint> : null}
      {analysis.segments?.length ? <Hint>{analysis.segments.length} segments found</Hint> : null}
    </Card>
  );
}
