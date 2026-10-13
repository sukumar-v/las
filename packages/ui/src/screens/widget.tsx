import type { Theme } from "@las/schema";
import { Onboarding } from "./onboarding.js";
import { Today } from "./today.js";
import { ProgressScreen, Summary, ProofResult } from "./progress.js";
import { Feedback } from "../components/feedback.js";
import { Lesson } from "../components/lesson.js";
import { Sim } from "../components/sim.js";
import { Figure } from "../figures/figure.js";
import { Card, Eyebrow, Hint, KeyValues, Note, H2 } from "../components/primitives.js";
import { Route } from "../components/route.js";
import { DrillView, AnalysisSummary } from "./session.js";
import { ThemePreview } from "./theme-preview.js";
import type { Voice } from "../copy.js";
import { LiveScreen, coachWidgetModel } from "./live.js";

export interface WidgetPayload {
  view: string;
  title: string;
  data: any;
  theme?: Theme;
  studioLink?: string;
  sk?: string | null;
}

/** Renders any tool result's view. Interactions that need devices open the studio. */
export function Widget({ payload, handlers = {} }: { payload: WidgetPayload; handlers?: Record<string, (...a: any[]) => void> }) {
  const d = payload.data ?? {};
  const voice = payload.theme?.voice as Voice | undefined;
  const link = payload.studioLink ? (
    <Hint>
      <a href={payload.studioLink} target="_blank" rel="noopener">
        Open in the studio
      </a>
    </Hint>
  ) : null;
  switch (payload.view) {
    case "onboarding":
      return <Onboarding view={d} voice={voice} h={handlers} />;
    case "today":
      return (
        <div class="las-app">
          <main class="las-main">
            <Today view={d} voice={voice} onStart={handlers.onStart} onReview={handlers.onReview} onCheckin={handlers.onCheckin} onProgress={handlers.onProgress} />
            {link}
          </main>
        </div>
      );
    case "progress":
      return (
        <div class="las-app">
          <main class="las-main">
            <ProgressScreen view={d} voice={voice} onProof={handlers.onProof} />
            {link}
          </main>
        </div>
      );
    case "summary":
      return (
        <div class="las-app">
          <main class="las-main">
            <Summary view={d} voice={voice} />
          </main>
        </div>
      );
    case "proof":
      return (
        <div class="las-app">
          <main class="las-main">
            <ProofResult view={d} voice={voice} onNext={handlers.onNext} onRetry={handlers.onRetry} />
            {link}
          </main>
        </div>
      );
    case "lesson":
      return (
        <div class="las-app">
          <main class="las-main">
            <H2>{d.title ?? payload.title}</H2>
            <Lesson cards={d.cards ?? []} voice={voice} title={d.title} />
          </main>
        </div>
      );
    case "sim":
      return (
        <div class="las-app">
          <main class="las-main">
            <Card label={d.title}>
              <Eyebrow>sim</Eyebrow>
              <Sim spec={d} />
            </Card>
          </main>
        </div>
      );
    case "diagram":
    case "mechanism":
      return (
        <div class="las-app">
          <main class="las-main">
            <Card label={payload.title}>
              <Eyebrow>{payload.view}</Eyebrow>
              {d.text ? <div class="las-prompt">{d.text}</div> : null}
              <Figure figure={d.figure} />
            </Card>
          </main>
        </div>
      );
    case "feedback":
    case "mistake":
      return (
        <div class="las-app">
          <main class="las-main">
            <Feedback view={d} voice={voice} onTry={handlers.onTry} onDispute={handlers.onDispute} onReRecord={handlers.onReRecord} />
            {link}
          </main>
        </div>
      );
    case "analysis":
      return (
        <div class="las-app">
          <main class="las-main">
            <AnalysisSummary analysis={d.analysis ?? d} />
            {link}
          </main>
        </div>
      );
    case "drill":
      return (
        <div class="las-app">
          <main class="las-main">
            <DrillView drill={d.drill} difficulty={d.difficulty ?? 0} label={d.label ?? ""} state={d.state} voice={voice} onPick={handlers.onPick} />
            {link}
          </main>
        </div>
      );
    case "review":
      return (
        <div class="las-app">
          <main class="las-main">
            <Card label="Reviews">
              <Eyebrow>{d.cards?.length ?? 0} cards due</Eyebrow>
              {(d.cards ?? []).slice(0, 1).map((c: any) => (
                <div key={c.id} class="las-prompt">{c.prompt}</div>
              ))}
            </Card>
            {link}
          </main>
        </div>
      );
    case "capture":
      return (
        <div class="las-app">
          <main class="las-main">
            <Card label="Record">
              <Eyebrow>{d.engine}</Eyebrow>
              <div class="las-prompt">{d.prompt}</div>
              {d.how ? <Hint>{d.how}</Hint> : null}
              <Note icon="cam">Recording needs the camera or microphone: open the studio{d.phone ? " on your phone" : ""}.</Note>
            </Card>
            {link}
          </main>
        </div>
      );
    case "coach": {
      // the live coach's screen inside the chat: cards and plan options work here; anything that needs a device or
      // the session's own state opens the studio (the host relays actions as for every other view)
      const m = coachWidgetModel(d);
      return (
        <div class="las-widget-coach">
          <LiveScreen screen={m.screen} presence={m.presence} message={m.message} summary={m.summary} voice={voice} readOnly h={{ onChoose: handlers.onChoose, onTry: handlers.onTry, onReRecord: handlers.onReRecord, onReview: handlers.onReview, onCapture: handlers.onCapture }} />
          {link ? <div class="las-app">{link}</div> : null}
        </div>
      );
    }
    case "theme-preview":
      return <ThemePreview sample={d.sample} screen={d.screen} voice={voice} />;
    case "capabilities":
      return (
        <div class="las-app">
          <main class="las-main">
            <Card label="Capabilities">
              <Eyebrow>Engines</Eyebrow>
              <KeyValues items={(d.engines ?? []).map((e: any) => [e.id, e.available ? `available (${e.backend})` : `missing: ${e.reason ?? ""}`])} />
              <Eyebrow>Code runners</Eyebrow>
              <KeyValues items={[["browser", (d.runners?.browser ?? []).join(", ")], ["local", (d.runners?.local ?? []).map((l: any) => l.language).join(", ") || "none"], ["container", d.runners?.container?.available ? d.runners.container.runtime : "none"]]} />
            </Card>
          </main>
        </div>
      );
    case "route":
    case "plan":
      return (
        <div class="las-app">
          <main class="las-main">
            <Route route={d.route ?? d} />
            {link}
          </main>
        </div>
      );
    default:
      return (
        <div class="las-app">
          <main class="las-main">
            <Card label={payload.title}>
              <Eyebrow>{payload.view}</Eyebrow>
              <pre class="las-code">{JSON.stringify(d, null, 1).slice(0, 2000)}</pre>
            </Card>
            {link}
          </main>
        </div>
      );
  }
}
