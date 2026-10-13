import type { Card as CardSpec } from "@las/schema";
import { Card, Eyebrow, Button, Chips, Chip, Meter, WeekDots, Progress, Hint } from "../components/primitives.js";
import { Route } from "../components/route.js";
import { LessonCard } from "../components/lesson.js";
import { BeatTimeline, Chart } from "../figures/chart.js";
import { copy, type Voice } from "../copy.js";

export interface PreviewSample {
  skill: string;
  milestone: string;
  nextSession: string;
  ladder: string[];
  lessonCard: CardSpec;
  feedback: { headline: string; praise: string };
}

/** The learner's own screens in a candidate theme: Today, a lesson card, a feedback card. */
export function ThemePreview({ sample, screen = "all", voice }: { sample: PreviewSample; screen?: string; voice?: Voice }) {
  const route = { start: 1, target: 2, steps: sample.ladder.map((label, i) => ({ step: i, label, hours: [0, 0] as [number, number], state: i < 1 ? ("done" as const) : i === 1 ? ("here" as const) : ("ahead" as const), target: i === 2, nodes: [], weeks: i > 1 ? i * 2 : undefined })) };
  const all = screen === "all";
  return (
    <div class="las-app" data-preview={screen}>
      <main class="las-main">
        {all || screen === "onboarding" ? (
          <>
            <Progress segments={[1, 1, 0.5, 0, 0, 0, 0]} />
            <div class="las-q">
              <h1 class="las-h1" tabIndex={-1}>Six months from now, what are you doing?</h1>
              <p class="las-sub">You're here to <b>have fun</b>. These fit that best.</p>
            </div>
            <Chips>
              <Chip label="Fits your why" on />
              <Chip label="Another option" />
              <Chip label="Skip" />
            </Chips>
          </>
        ) : null}
        {all || screen === "today" ? (
          <>
            <h1 class="las-h1" tabIndex={-1}>{copy(voice, "today")}</h1>
            <Card label="Next session">
              <Eyebrow>Next session · 30 min</Eyebrow>
              <b>{sample.nextSession}</b>
              <Hint>Picked because it's the biggest gap between you and your milestone.</Hint>
              <Button primary icon="play">{copy(voice, "startSession")}</Button>
            </Card>
            <Card label="Milestone">
              <Eyebrow>Milestone</Eyebrow>
              <b>{sample.milestone}</b>
              <Meter value={0.42} label="Skills" size={40} />
            </Card>
            <Card label="This week">
              <Eyebrow>This week</Eyebrow>
              <WeekDots week={[0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, state: day === 0 ? "done" : day === 2 || day === 4 ? "plan" : day === 1 ? "missed" : "none", today: day === 2 }))} />
            </Card>
          </>
        ) : null}
        {all || screen === "lesson" ? <LessonCard card={sample.lessonCard} index={0} voice={voice} /> : null}
        {all || screen === "feedback" ? (
          <>
            <Card class="las-feedback" label="One fix">
              <Eyebrow>{copy(voice, "oneFix")}</Eyebrow>
              <div class="headline">{sample.feedback.headline}</div>
              <BeatTimeline beats={8} offsetsMs={[10, -70, 15, -65, 5, -80, 20, -60]} />
              <div class="las-inline">
                <Button primary icon="repeat">Try this</Button>
                <Button>{copy(voice, "why")}</Button>
              </div>
            </Card>
            <Card class="las-feedback praise" label="Done well">
              <Eyebrow>{copy(voice, "didWell")}</Eyebrow>
              <div class="headline">{sample.feedback.praise}</div>
            </Card>
          </>
        ) : null}
        {all || screen === "progress" ? (
          <>
            <Route route={route} />
            <Chart type="line" series={[{ label: "Key metric", values: [52, 58, 61, 70, 78] }]} labels={["1", "2", "3", "4", "5"]} />
          </>
        ) : null}
      </main>
    </div>
  );
}
