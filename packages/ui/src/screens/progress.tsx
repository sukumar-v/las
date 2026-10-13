import type { ProgressView, SummaryView, ProofResultView } from "@las/schema";
import { Card, Eyebrow, H2, Meter, Mix, Hint, Note, Button, Pill } from "../components/primitives.js";
import { Route } from "../components/route.js";
import { Chart } from "../figures/chart.js";
import { Icon } from "../icons.js";
import { copy, type Voice } from "../copy.js";

const fmtMetric = (v: number | undefined, unit: string, format: string) => (v === undefined ? "–" : format === "percent" ? `${Math.round(v * 100)}%` : format === "ms" ? `${Math.round(v)} ms` : format === "cents" ? `${Math.round(v)} cents` : `${Math.round(v * 100) / 100}${unit ? ` ${unit}` : ""}`);

export function ProgressScreen({ view, voice, onProof }: { view: ProgressView; voice?: Voice; onProof?: () => void }) {
  return (
    <div class="las-stack">
      <h1 class="las-h1" tabIndex={-1}>{copy(voice, "progress")}</h1>
      <H2>Your route</H2>
      <Route route={view.route} />
      <H2>Skills for this milestone</H2>
      <div class="las-nodes">
        {view.nodes.map((n) => (
          <div key={n.id}>
            <Meter value={n.mastery} label={`${n.name} mastery`} size={44} />
            <span>{n.name}</span>
          </div>
        ))}
      </div>
      {view.keyMetrics.map((k) => (
        <Card key={k.id} label={k.label}>
          <div class="las-row">
            <Eyebrow>{k.label}</Eyebrow>
            <span class="las-mono">{k.better === "higher" ? "higher is better" : "lower is better"}</span>
          </div>
          {k.history.length >= 2 ? <Chart type="line" series={[{ label: k.label, values: k.history.map((h) => h.value) }]} label={`${k.label} over ${k.history.length} attempts`} /> : <Hint>Trend appears after two attempts.</Hint>}
          <div class="las-ba">
            <div>
              <Eyebrow>First</Eyebrow>
              <b class="las-mono">{fmtMetric(k.first, k.unit, k.format)}</b>
            </div>
            <span aria-hidden="true">→</span>
            <div class={k.first !== undefined && k.latest !== undefined && (k.better === "higher" ? k.latest > k.first : k.latest < k.first) ? "up" : ""}>
              <Eyebrow>Latest</Eyebrow>
              <b class="las-mono">{fmtMetric(k.latest, k.unit, k.format)}</b>
            </div>
          </div>
        </Card>
      ))}
      {view.beforeAfter ? (
        <Card label="Before and after">
          <Eyebrow>Before and after · {view.beforeAfter.label}</Eyebrow>
          <div class="las-pair">
            <div>
              <small>First attempt</small>
              <b class="las-mono">{view.beforeAfter.first?.value ?? "–"}{view.beforeAfter.unit ?? ""}</b>
            </div>
            <div>
              <small>Latest</small>
              <b class="las-mono">{view.beforeAfter.latest?.value ?? "–"}{view.beforeAfter.unit ?? ""}</b>
            </div>
          </div>
        </Card>
      ) : null}
      <H2 small="actual vs planned">Time</H2>
      <div class="las-row">
        <span class="las-mono">{Math.round(view.time.actualMinutes)} min</span>
        <span class="las-mono">of {Math.round(view.time.plannedMinutes)} planned</span>
      </div>
      <Mix parts={view.time.mix.map((m) => ({ category: m.category, share: m.planned }))} label="Planned mix" />
      {view.time.mix.some((m) => m.actual > 0) ? <Mix parts={view.time.mix.map((m) => ({ category: m.category, share: m.actual }))} label="Actual mix" /> : null}
      <H2>Proof check</H2>
      <Card label="Proof check">
        <div class="las-row">
          <b>{view.proof.title}</b>
          <Pill kind={view.proof.ready ? "good" : "info"} icon="flag">{view.proof.ready ? "ready" : `${view.proof.percent}%`}</Pill>
        </div>
        <ul class="las-checks">
          {view.proof.criteria.map((c) => (
            <li key={c.id}>
              <Icon name={c.passed ? "check" : "flag"} />
              <span>{c.label}</span>
            </li>
          ))}
        </ul>
        {view.proof.ready ? <Button primary icon="flag" onClick={onProof}>{copy(voice, "proofReady")}</Button> : <Hint>Opens when the skills for this step reach 80% and two recent attempts pass.</Hint>}
      </Card>
      <details>
        <summary>History</summary>
        <ul class="las-checks">
          {view.history.sessions.slice(0, 20).map((s) => (
            <li key={s.id}>
              <Icon name="clock" />
              <span>{s.at ? new Date(s.at).toLocaleDateString() : "unscheduled"} · {s.focus ?? "session"} · {s.status}{s.minutes ? ` · ${Math.round(s.minutes)} min` : ""}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export function Summary({ view, voice }: { view: SummaryView; voice?: Voice }) {
  return (
    <div class="las-stack">
      <h1 class="las-h1" tabIndex={-1}>{copy(voice, "done")}</h1>
      <Card label="What changed">
        <Eyebrow>What changed · {Math.round(view.minutes)} min</Eyebrow>
        <div class="las-nodes">
          {view.changed.map((c) => (
            <div key={c.nodeId}>
              <Meter value={c.after} label={`${c.name} ${Math.round(c.before * 100)} to ${Math.round(c.after * 100)}`} size={44} />
              <span>{c.name}</span>
            </div>
          ))}
        </div>
        {view.metric ? (
          <div class="las-ba">
            <div>
              <Eyebrow>{view.metric.label} before</Eyebrow>
              <b class="las-mono">{view.metric.before ?? "–"}{view.metric.unit}</b>
            </div>
            <span aria-hidden="true">→</span>
            <div class={view.metric.after !== undefined && view.metric.before !== undefined && view.metric.after !== view.metric.before ? "up" : ""}>
              <Eyebrow>now</Eyebrow>
              <b class="las-mono">{view.metric.after ?? "–"}{view.metric.unit}</b>
            </div>
          </div>
        ) : null}
      </Card>
      {view.oneFix ? (
        <Card label={copy(voice, "oneFix")}>
          <Eyebrow>{copy(voice, "oneFix")}</Eyebrow>
          <b>{view.oneFix.headline}</b>
          {view.oneFix.fixDrillTitle ? <Hint>Next time: {view.oneFix.fixDrillTitle}</Hint> : null}
        </Card>
      ) : null}
      {view.praise ? <Note icon="spark">{view.praise}</Note> : null}
      <Card label="Next session">
        <Eyebrow>Next session{view.next.when ? ` · ${view.next.when}` : ""}</Eyebrow>
        <b>{view.next.title}</b>
        <Hint>{view.next.focus}</Hint>
      </Card>
    </div>
  );
}

export function ProofResult({ view, voice, onNext, onRetry }: { view: ProofResultView; voice?: Voice; onNext?: () => void; onRetry?: () => void }) {
  return (
    <div class="las-stack">
      <h1 class="las-h1" tabIndex={-1}>{view.passed ? copy(voice, "milestoneDone") : "Not yet"}</h1>
      <Card label="Proof">
        <Eyebrow>{view.title}</Eyebrow>
        {view.precision !== "full" ? <Pill kind="warn" icon="warn">{view.precision === "self-report" ? "self-reported" : "less precise check"}</Pill> : null}
        <ul class="las-checks">
          {view.criteria.map((c) => (
            <li key={c.id}>
              <Icon name={c.passed ? "check" : "x"} />
              <span>
                {c.label}
                {c.evidence ? <small class="las-hint"> · {c.evidence}</small> : null}
              </span>
            </li>
          ))}
        </ul>
        {view.passed ? (
          <Button primary icon="flag" onClick={onNext}>
            Pick the next milestone
          </Button>
        ) : (
          <Button primary icon="repeat" onClick={onRetry}>
            Add targeted work and retry later
          </Button>
        )}
      </Card>
    </div>
  );
}
