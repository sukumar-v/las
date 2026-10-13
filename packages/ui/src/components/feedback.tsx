import { useState } from "preact/hooks";
import type { FeedbackView } from "@las/schema";
import { Button, Card, Eyebrow, Pill, Note } from "./primitives.js";
import { Figure } from "../figures/figure.js";
import { LessonCard } from "./lesson.js";
import { copy, type Voice } from "../copy.js";

/** One fix, with evidence, a Try this button and a visual Why. Plus one thing done well. */
export function Feedback({ view, onTry, onDispute, onReRecord, voice }: { view: FeedbackView; onTry?: () => void; onDispute?: () => void; onReRecord?: () => void; voice?: Voice }) {
  const [why, setWhy] = useState(false);
  const [disputed, setDisputed] = useState(false);
  if (view.reRecord) {
    return (
      <Card label="Record again">
        <Eyebrow>{copy(voice, "reRecord")}</Eyebrow>
        <div class="las-prompt">{view.reRecord}</div>
        <Note icon="cam">{view.analysis.quality.issues.join(". ") || "The recording couldn't be analyzed."}</Note>
        <Button primary icon="cam" onClick={onReRecord}>
          {copy(voice, "reRecord")}
        </Button>
      </Card>
    );
  }
  return (
    <div class="las-stack">
      <Card class="las-feedback" label={copy(voice, "oneFix")}>
        <div class="las-row">
          <Eyebrow>{copy(voice, "oneFix")}</Eyebrow>
          {view.precision !== "full" ? <Pill kind="warn" icon="warn">{view.precision === "self-report" ? "self-reported" : "less precise check"}</Pill> : null}
        </div>
        <div class="headline">{view.headline}</div>
        {view.evidence.figure ? <Figure figure={view.evidence.figure} /> : null}
        {view.evidence.frame ? <img src={view.evidence.frame} alt={view.evidence.label ?? "Evidence frame"} class="las-fig" /> : null}
        {view.evidence.label ? <div class="evidence">{view.evidence.label}</div> : null}
        {view.confidence !== undefined ? <div class="evidence las-mono">confidence {Math.round(view.confidence * 100)}%</div> : null}
        <div class="las-inline">
          {view.fixDrillId ? (
            <Button primary icon="repeat" onClick={onTry}>
              Try this{view.fixDrillTitle ? `: ${view.fixDrillTitle}` : ""}
            </Button>
          ) : null}
          {view.why ? (
            <Button onClick={() => setWhy(!why)} aria-expanded={why ? "true" : "false"}>
              {copy(voice, "why")}
            </Button>
          ) : null}
          {view.mistakeId && !disputed ? (
            <Button
              link
              onClick={() => {
                setDisputed(true);
                onDispute?.();
              }}
            >
              {copy(voice, "thatsWrong")}
            </Button>
          ) : null}
          {disputed ? <Pill kind="info">Noted. Muted for this attempt.</Pill> : null}
        </div>
        {why && view.why ? view.why.figure ? <Figure figure={view.why.figure} /> : view.why.card ? <LessonCard card={view.why.card} index={0} voice={voice} /> : null : null}
      </Card>
      {view.praise ? (
        <Card class="las-feedback praise" label={copy(voice, "didWell")}>
          <Eyebrow>{copy(voice, "didWell")}</Eyebrow>
          <div class="headline">{view.praise.headline}</div>
        </Card>
      ) : null}
      {view.compare && view.compare.before !== undefined && view.compare.after !== undefined ? (
        <div class="las-ba" role="group" aria-label="Before and after">
          <div>
            <Eyebrow>Before</Eyebrow>
            <b class="las-mono">{view.compare.before}{view.compare.unit}</b>
          </div>
          <span aria-hidden="true">→</span>
          <div class={view.compare.after !== view.compare.before ? "up" : ""}>
            <Eyebrow>Now</Eyebrow>
            <b class="las-mono">{view.compare.after}{view.compare.unit}</b>
          </div>
        </div>
      ) : null}
    </div>
  );
}
