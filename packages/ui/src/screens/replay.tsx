import type { ComponentChildren } from "preact";
import type { Analysis, FeedbackView } from "@las/schema";
import { Feedback } from "../components/feedback.js";
import { PoseOverlay, type OverlayMark } from "../figures/overlay.js";
import { Button, Card, Eyebrow } from "../components/primitives.js";
import { AnalysisSummary } from "./session.js";
import type { Voice } from "../copy.js";

/** The replay screen: the learner's clip with overlays and mistake markers, compare toggles, then one fix and one praise. */
export function Replay({ analysis, feedback, media, landmarks, reference, marks, t, onScrub, onMarker, compare, onCompare, onTry, onDispute, onReRecord, voice, aspect }: { analysis: Analysis; feedback: FeedbackView; media?: ComponentChildren; landmarks?: Record<string, [number, number, number?]>; reference?: Record<string, [number, number, number?]>; marks?: OverlayMark[]; t?: number; onScrub?: (t: number) => void; onMarker?: (t: number) => void; compare?: "none" | "reference" | "previous"; onCompare?: (c: "none" | "reference" | "previous") => void; onTry?: () => void; onDispute?: () => void; onReRecord?: () => void; voice?: Voice; /** width / height of the clip (videoWidth / videoHeight); the media box and overlay take this shape. Default 3/4. */ aspect?: number }) {
  const duration = analysis.segments?.length ? Math.max(...analysis.segments.map((s) => s[1])) : Math.max(1, ...analysis.markers.map((m) => m.t), ...analysis.mistakes.flatMap((m) => m.at));
  const visual = analysis.engine === "movement" || analysis.engine === "visual";
  return (
    <div class="las-stack" data-engine={analysis.engine}>
      {visual ? (
        <div class="las-media" aria-label="Replay" style={aspect && aspect > 0 ? { "--las-media-aspect": String(aspect) } : undefined}>
          {media}
          <PoseOverlay landmarks={landmarks} reference={compare === "reference" ? reference : undefined} marks={marks ?? []} label="Replay overlay" />
        </div>
      ) : null}
      {visual || analysis.engine === "audio" || analysis.engine === "speech" ? (
        <div class="las-scrub">
          {analysis.mistakes.flatMap((m) => m.at.map((at, i) => <button key={`${m.id}${i}`} type="button" class="mark" style={{ left: `${(at / duration) * 100}%` }} aria-label={`Mistake ${m.id} at ${at.toFixed(1)}s`} onClick={() => onMarker?.(at)} />))}
          {analysis.markers.filter((m) => m.role === "good").map((m, i) => <span key={`g${i}`} class="mark good" style={{ left: `${(m.t / duration) * 100}%` }} aria-hidden="true" />)}
          <input type="range" min={0} max={duration} step={0.05} value={t ?? 0} aria-label="Scrub" onInput={(e) => onScrub?.(Number((e.currentTarget as HTMLInputElement).value))} />
        </div>
      ) : null}
      {visual ? (
        <div class="las-inline" role="group" aria-label="Compare">
          <Button onClick={() => onCompare?.(compare === "reference" ? "none" : "reference")} aria-pressed={compare === "reference" ? "true" : "false"} disabled={!reference}>
            Reference ghost
          </Button>
          <Button onClick={() => onCompare?.(compare === "previous" ? "none" : "previous")} aria-pressed={compare === "previous" ? "true" : "false"} disabled={!feedback.compare?.previousAttemptId}>
            Your last try
          </Button>
        </div>
      ) : null}
      <Feedback view={feedback} onTry={onTry} onDispute={onDispute} onReRecord={onReRecord} voice={voice} />
      <AnalysisSummary analysis={analysis} />
      {analysis.keyFrames.length ? (
        <Card label="Key frames">
          <Eyebrow>Key frames</Eyebrow>
          <div class="las-pair">
            {analysis.keyFrames.map((k, i) => (
              <div key={i}>
                <img src={k.ref} alt={k.label ?? `Frame at ${k.t.toFixed(1)}s`} class="las-fig" />
                <small>{k.label ?? `${k.t.toFixed(1)}s`}</small>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
