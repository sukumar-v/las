import type { TodayView } from "@las/schema";
import { Card, Eyebrow, Button, Chips, Chip, Meter, WeekDots, Hint, Note } from "../components/primitives.js";
import { Icon } from "../icons.js";
import { Route } from "../components/route.js";
import { copy, type Voice } from "../copy.js";

export function Today({ view, onStart, onReview, onCheckin, onProgress, voice }: { view: TodayView; onStart?: () => void; onReview?: () => void; onCheckin?: (id: string, option: string) => void; onProgress?: () => void; voice?: Voice }) {
  const stateNote: Record<TodayView["state"], string | undefined> = {
    "first-day": copy(voice, "firstDay"),
    normal: undefined,
    missed: copy(voice, "missed"),
    behind: copy(voice, "behind"),
    "proof-ready": copy(voice, "proofReady"),
    "milestone-done": copy(voice, "milestoneDone"),
    paused: copy(voice, "paused")
  };
  return (
    <div class="las-stack" data-state={view.state}>
      <h1 class="las-h1" tabIndex={-1}>
        {copy(voice, "today")}
      </h1>
      {stateNote[view.state] ? <Note icon={view.state === "proof-ready" ? "flag" : view.state === "paused" ? "pause" : "spark"}>{stateNote[view.state]}</Note> : null}
      {view.message ? <Hint>{view.message}</Hint> : null}
      {view.checkin ? (
        <Card label="Check-in">
          <Eyebrow>Check-in</Eyebrow>
          <b>{view.checkin.question}</b>
          <Chips>
            {view.checkin.options.map((o) => (
              <Chip key={o.id} label={o.label} onClick={() => onCheckin?.(view.checkin!.id, o.id)} />
            ))}
          </Chips>
        </Card>
      ) : null}
      {view.nextSession && view.state !== "paused" ? (
        <Card label="Next session">
          <Eyebrow>
            Next session · {view.nextSession.minutes} min
          </Eyebrow>
          <b>{view.nextSession.title}</b>
          <Hint>{view.nextSession.reason}</Hint>
          <Button primary icon="play" onClick={onStart}>
            {view.state === "proof-ready" ? copy(voice, "proofReady") : copy(voice, "startSession")}
          </Button>
        </Card>
      ) : null}
      <button type="button" class="las-card las-cardbtn" onClick={onReview} disabled={!view.reviewsDue.count}>
        <Icon name="repeat" />
        <span>
          <b>{view.reviewsDue.count ? `${view.reviewsDue.count} reviews due` : "No reviews due"}</b>
          <small>{view.reviewsDue.count ? `About ${Math.max(1, view.reviewsDue.minutes)} min` : "Come back after the session"}</small>
        </span>
      </button>
      {view.milestone ? (
        <button type="button" class="las-card las-cardbtn" onClick={onProgress}>
          <span style={{ flex: 1 }}>
            <Eyebrow>Milestone</Eyebrow>
            <b>{view.milestone.title}</b>
            <Meter value={view.milestone.percent / 100} label="Skills for this milestone" size={40} />
            <div class="las-row">
              <span class="las-mono">{view.milestone.percent}% of the skills</span>
              {view.milestone.proofDate ? <span class="las-mono">proof ~{view.milestone.proofDate}</span> : null}
            </div>
          </span>
        </button>
      ) : null}
      <Card label="This week">
        <Eyebrow>This week</Eyebrow>
        <WeekDots week={view.week} />
        {view.weeklyReview ? <Hint>{view.weeklyReview}</Hint> : null}
      </Card>
      <details>
        <summary>Your route</summary>
        <Route route={view.route} />
      </details>
    </div>
  );
}
