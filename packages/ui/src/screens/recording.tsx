import type { ComponentChildren } from "preact";
import { Card, Eyebrow, Button, Hint, Pill, Note } from "../components/primitives.js";
import { Icon } from "../icons.js";
import { PoseOverlay, type OverlayMark } from "../figures/overlay.js";
import { BeatTimeline } from "../figures/chart.js";
import { copy, type Voice } from "../copy.js";

export interface FramingState {
  pointsVisible: number; // 0..1 share of needed points visible
  light: boolean;
  steady: boolean;
  ready: boolean;
  seconds: number;
}

/** The recording screen: a live framing guide, the record button that stays disabled until the guide is satisfied, and live meters. */
export function Recording({ engine, prompt, how, angle, durationS, framing, recording, elapsed, onRecord, onStop, onUpload, meters, landmarks, media, voice, children }: { engine: string; prompt: string; how?: string; angle?: string; durationS?: number; framing?: FramingState; recording?: boolean; elapsed?: number; onRecord?: () => void; onStop?: () => void; onUpload?: () => void; meters?: { pitch?: { cents: number; note?: string }; beats?: { offsetsMs: (number | null)[]; beats: number }; level?: number; tests?: { label: string; pass?: boolean }[] }; landmarks?: Record<string, [number, number, number?]>; media?: ComponentChildren; voice?: Voice; children?: ComponentChildren }) {
  const needsCamera = engine === "movement" || engine === "visual";
  const needsMic = engine === "audio" || engine === "speech";
  const ready = framing?.ready ?? !needsCamera;
  const marks: OverlayMark[] = [];
  return (
    <div class="las-stack" data-engine={engine}>
      <div class="las-q">
        <h1 class="las-h1" tabIndex={-1}>{prompt}</h1>
        {how ? <p class="las-sub">{how}</p> : null}
      </div>
      {needsCamera ? (
        <div class="las-media" aria-label="Camera preview">
          {media ?? <Icon name="cam" />}
          <PoseOverlay landmarks={landmarks} marks={marks} label="Framing guide" />
          {!recording ? (
            <div class="las-overlay las-ev" style={{ padding: "var(--las-space-2)", alignContent: "end" }}>
              <Pill kind={framing && framing.pointsVisible >= 0.6 ? "good" : "warn"} icon={framing && framing.pointsVisible >= 0.6 ? "check" : "warn"}>
                {framing ? `${Math.round(framing.pointsVisible * 100)}% in frame` : "waiting for camera"}
              </Pill>
              {framing ? <Pill kind={framing.light ? "good" : "warn"}>{framing.light ? "light ok" : "more light"}</Pill> : null}
              {framing ? <Pill kind={framing.steady ? "good" : "warn"}>{framing.steady ? "steady" : "hold still"}</Pill> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {needsMic && meters?.level !== undefined ? (
        <Card label="Microphone level">
          <div class="las-meter" role="meter" aria-label="Input level" aria-valuenow={Math.round(meters.level * 100)} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${Math.round(meters.level * 100)}%` }} />
          </div>
        </Card>
      ) : null}
      {meters?.pitch ? (
        <Card label="Pitch">
          <Eyebrow>Pitch</Eyebrow>
          <div class="las-row">
            <b class="las-mono">{meters.pitch.note ?? "–"}</b>
            <span class={`las-pill ${Math.abs(meters.pitch.cents) <= 15 ? "good" : Math.abs(meters.pitch.cents) <= 30 ? "info" : "warn"}`}>{meters.pitch.cents > 0 ? "+" : ""}{Math.round(meters.pitch.cents)} cents</span>
          </div>
        </Card>
      ) : null}
      {meters?.beats ? <BeatTimeline beats={meters.beats.beats} offsetsMs={meters.beats.offsetsMs} /> : null}
      {meters?.tests ? (
        <ul class="las-testlist" aria-label="Tests">
          {meters.tests.map((t, i) => (
            <li key={i} class={t.pass === undefined ? "" : t.pass ? "pass" : "fail"}>
              <span>{t.label}</span>
              <span>{t.pass === undefined ? "…" : t.pass ? "pass" : "fail"}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {children}
      <div class="las-inline">
        {engine === "code" ? null : recording ? (
          <Button primary icon="pause" onClick={onStop}>
            Stop{elapsed !== undefined ? ` · ${Math.round(elapsed)}s` : ""}{durationS ? ` / ${durationS}s` : ""}
          </Button>
        ) : (
          <Button primary icon={needsMic ? "mic" : "cam"} disabled={!ready} onClick={onRecord} aria-describedby="rec-hint">
            Record
          </Button>
        )}
        {engine !== "code" ? (
          <Button icon="book" onClick={onUpload}>
            {engine === "visual" ? "Choose a photo" : "Use a file"}
          </Button>
        ) : null}
      </div>
      <Hint>
        <span id="rec-hint">{angle ? `Camera: ${angle}. ` : ""}{needsCamera && !ready ? "The record button turns on when you're in frame, lit and steady." : needsMic ? "Headphones in: the click stays out of the recording." : "Stays on this device."}</span>
      </Hint>
      {copy(voice, "checking") ? null : <Note>…</Note>}
    </div>
  );
}
