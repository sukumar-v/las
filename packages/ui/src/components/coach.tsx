/**
 * The live coach's pieces (live-coach §7, §8): the presence pill, the "coach is thinking" indicator, a coach
 * message shown over the current screen, a plan proposal, the ask-the-coach box and the pause screen. Every look
 * comes from the theme's tokens and variants; every word from the voice's copy set or the coach.
 */
import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { BlockKind, CoachMessageView, PlanProposalView } from "@las/schema";
import { Button, Eyebrow, Hint, Question, Stat, Tile, Tiles, Note } from "./primitives.js";
import { Frame } from "./frame.js";
import { Figure } from "../figures/figure.js";
import { Icon } from "../icons.js";
import { copy, type Voice } from "../copy.js";

export type PresenceStatus = "here" | "away" | "thinking" | "left";

/** The most a learner can type into the ask box (live-coach §6, `learner.asked`). */
export const ASK_LIMIT = 280;
/** A coach message's word budget (live-coach §7); longer text is cut at the budget. */
export const MESSAGE_WORDS = 25;

export function clampWords(text: string, max = MESSAGE_WORDS): string {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? text.trim() : `${words.slice(0, max).join(" ")}…`;
}

const PRESENCE_KEY: Record<PresenceStatus, string> = { here: "coachHere", away: "coachAway", left: "coachAway", thinking: "coachThinking" };

/** "Coach here", "coach away" or "coach is thinking": a small pill in the session frame. */
export function Presence({ status, voice }: { status: PresenceStatus; voice?: Voice }) {
  return (
    <span class="las-presence" data-presence={status} role="status" aria-live="polite">
      <i class="las-presence-dot" aria-hidden="true" />
      {copy(voice, PRESENCE_KEY[status])}
    </span>
  );
}

/** Three dots and a few words while the coach writes the next screen. */
export function Thinking({ voice }: { voice?: Voice }) {
  return (
    <div class="las-thinking" role="status" aria-live="polite">
      <span class="las-thinking-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{copy(voice, "coachThinking")}</span>
    </div>
  );
}

/** A coach message over the current screen: a few words, an optional figure, reply and dismiss. */
export function CoachMessage({ view, voice, onDismiss, onReply }: { view: CoachMessageView; voice?: Voice; onDismiss?: () => void; onReply?: () => void }) {
  return (
    <section class="las-card las-coachmsg" aria-label={copy(voice, "coachMessage")} aria-live="polite" data-leaving={view.leaving ? "true" : undefined}>
      <div class="las-coachmsg-head">
        <Eyebrow>
          <Icon name="speech" size="sm" /> {copy(voice, "coachMessage")}
        </Eyebrow>
        {onDismiss ? (
          <button type="button" class="las-iconbtn" aria-label={copy(voice, "dismiss")} onClick={onDismiss}>
            <Icon name="x" />
          </button>
        ) : null}
      </div>
      <p class="las-coachmsg-text">{clampWords(view.text)}</p>
      {view.figure ? (
        <div class="las-coachmsg-fig">
          <Figure figure={view.figure} />
        </div>
      ) : null}
      {view.leaving ? (
        <Note icon="flag">{copy(voice, "coachLeft")}</Note>
      ) : onReply ? (
        <Button link icon="speech" onClick={onReply}>
          {copy(voice, "reply")}
        </Button>
      ) : null}
    </section>
  );
}

/** A plan change the coach proposes: the question, its reason, and 2–4 options shaped like a check-in's. */
export function PlanProposal({ view, voice, chosen, onChoose }: { view: PlanProposalView; voice?: Voice; chosen?: string; onChoose?: (optionId: string) => void }) {
  return (
    <div class="las-stack" data-plan={view.screenId}>
      <Eyebrow>{copy(voice, "planChange")}</Eyebrow>
      <Question q={view.question} sub={view.reason} />
      <Tiles list>
        {view.options.slice(0, 4).map((o) => (
          <Tile key={o.id} title={o.label} detail={o.detail} on={chosen === o.id} icon={chosen === o.id ? "check" : "target"} onClick={() => onChoose?.(o.id)} />
        ))}
      </Tiles>
      {chosen ? <Note icon="check">{copy(voice, "planChosen")}</Note> : null}
    </div>
  );
}

/** The ask-the-coach box: up to 280 characters; the help line says the words go to the coach. */
export function AskCoach({ voice, away, sent, onAsk, id = "las-ask" }: { voice?: Voice; away?: boolean; sent?: boolean; onAsk?: (text: string) => void; id?: string }) {
  const [text, setText] = useState("");
  const left = ASK_LIMIT - text.length;
  return (
    <section class="las-ask" aria-label={copy(voice, "askLabel")}>
      <form
        class="las-field"
        autocomplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          const v = text.trim().slice(0, ASK_LIMIT);
          if (!v) return;
          onAsk?.(v);
          setText("");
        }}
      >
        <input id={id} aria-label={copy(voice, "askLabel")} placeholder={copy(voice, "askPlaceholder")} maxLength={ASK_LIMIT} value={text} enterkeyhint="send" onInput={(e) => setText((e.currentTarget as HTMLInputElement).value.slice(0, ASK_LIMIT))} />
        <Button type="submit" icon="speech" disabled={!text.trim()}>
          {copy(voice, "askSend")}
        </Button>
      </form>
      <div class="las-ask-help">
        <Hint>{sent ? copy(voice, "askSent") : copy(voice, away ? "askHelpAway" : "askHelp")}</Hint>
        {left <= 40 ? <span class="las-mono las-hint">{left}</span> : null}
      </div>
    </section>
  );
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** A paused session: the time so far and Resume. */
export function PauseScreen({ seconds, voice, onResume }: { seconds: number; voice?: Voice; onResume?: () => void }) {
  return (
    <div class="las-stack las-pause" data-paused="true">
      <span class="las-pause-mark" aria-hidden="true">
        <Icon name="pause" />
      </span>
      <h1 class="las-h1" tabIndex={-1}>
        {copy(voice, "pausedTitle")}
      </h1>
      <div class="las-stats">
        <Stat value={formatClock(seconds)} label={copy(voice, "timeSoFar")} />
      </div>
      {onResume ? (
        <Button primary big icon="play" onClick={onResume}>
          {copy(voice, "resume")}
        </Button>
      ) : null}
    </div>
  );
}

export const LIVE_BLOCKS: BlockKind[] = ["warmup", "recall", "learn", "practice", "perform", "wrapup"];
const LIVE_BLOCK_LABELS: Record<BlockKind, string> = { warmup: "Warm-up", recall: "Recall", learn: "Learn", practice: "Practice", perform: "Perform", wrapup: "Wrap-up" };

export interface LiveFrameProps {
  kind: string;
  screenId?: string;
  block?: BlockKind;
  /** minutes used out of planned: fills the current block's segment */
  fill?: number;
  presence: PresenceStatus;
  message?: CoachMessageView;
  onDismissMessage?: () => void;
  onReply?: () => void;
  /** the ask box; left out on the summary */
  ask?: { away: boolean; sent?: boolean; onAsk: (text: string) => void };
  onPause?: () => void;
  onExit?: () => void;
  exit?: string;
  cta?: { label: string; enabled?: boolean; onClick?: () => void; hidden?: boolean; secondary?: ComponentChildren };
  voice?: Voice;
  children?: ComponentChildren;
}

/** The session frame for a live session: progress by block, presence and pause under the bar, a coach message over the screen, the ask box under it. */
export function LiveFrame({ kind, screenId, block, fill, presence, message, onDismissMessage, onReply, ask, onPause, onExit, exit = "Exit", cta, voice, children }: LiveFrameProps) {
  const idx = block ? LIVE_BLOCKS.indexOf(block) : -1;
  const status = (
    <div class="las-live-status">
      <div class="las-live-row">
        <Presence status={presence} voice={voice} />
        {onPause ? (
          <Button icon="pause" onClick={onPause}>
            {copy(voice, "pause")}
          </Button>
        ) : null}
      </div>
      {presence === "left" && !message ? <Hint>{copy(voice, "coachLeft")}</Hint> : null}
      {message ? <CoachMessage view={message} voice={voice} onDismiss={onDismissMessage} onReply={message.leaving ? undefined : onReply} /> : null}
    </div>
  );
  return (
    <Frame
      liveKind={kind}
      liveScreen={screenId}
      sections={LIVE_BLOCKS.map((b) => LIVE_BLOCK_LABELS[b])}
      sectionIndex={idx >= 0 ? idx : undefined}
      sectionFill={fill}
      canBack={false}
      exit={onExit ? exit : undefined}
      onExit={onExit}
      status={status}
      aside={ask ? <AskCoach voice={voice} away={ask.away} sent={ask.sent} onAsk={ask.onAsk} /> : undefined}
      cta={cta}
    >
      {children}
    </Frame>
  );
}
