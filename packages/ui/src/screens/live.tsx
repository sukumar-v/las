/**
 * One live coach screen (live-coach §7): the coach's screens and the fallback screens look the same because both
 * draw the shared session items. Feedback, plan proposals, the pause screen and the wrap-up summary are added
 * here; a coach message sits over whatever is showing.
 */
import type { ComponentChildren } from "preact";
import type { BlockKind, CoachMessageView, FeedbackView, PlanProposalView, ScreenKind, SessionItem, SummaryView } from "@las/schema";
import { Feedback } from "../components/feedback.js";
import { LiveFrame, PauseScreen, PlanProposal, Thinking, type PresenceStatus } from "../components/coach.js";
import { itemBody, type SessionHandlers } from "./session.js";
import { Summary } from "./progress.js";
import { Hint } from "../components/primitives.js";
import { copy, type Voice } from "../copy.js";

/** Everything `CoachScreen.item` can be: a session item, feedback, a pause, a message, a plan or a summary. */
export type LiveItem = SessionItem | { type: "feedback"; view: FeedbackView } | { type: "pause"; pausedAt: string } | CoachMessageView | PlanProposalView | SummaryView;

/** The part of a `CoachScreen` the screen needs (the widget and the snapshots pass plain objects). */
export interface LiveScreenModel {
  id: string;
  kind: ScreenKind;
  block: BlockKind;
  item: LiveItem | unknown;
  source?: "coach" | "fallback";
}

export function isSummaryView(x: unknown): x is SummaryView {
  return !!x && typeof x === "object" && "changed" in x && "next" in x && "sessionId" in x;
}

export function liveItem(screen: LiveScreenModel): LiveItem {
  return screen.item as LiveItem;
}

const BLOCK_TITLES: Record<BlockKind, string> = { warmup: "Warm-up", recall: "Recall", learn: "Learn", practice: "Practice", perform: "Perform", wrapup: "Wrap-up" };

export interface LiveHandlers extends SessionHandlers {
  onChoose?: (optionId: string) => void;
  onResume?: () => void;
  onPause?: () => void;
  onTry?: () => void;
  onReRecord?: () => void;
  onDismissMessage?: () => void;
  onReply?: () => void;
  onAsk?: (text: string) => void;
}

export interface LiveScreenProps {
  screen?: LiveScreenModel;
  /** capture sub-steps: capture, analyze */
  phase?: string;
  state?: Record<string, any>;
  presence: PresenceStatus;
  message?: CoachMessageView;
  /** the learner finished and the coach is writing the next screen */
  waiting?: boolean;
  /** seconds in the session so far (the pause screen shows it) */
  seconds?: number;
  /** the session ended: its summary */
  summary?: SummaryView;
  /** the plan option the learner picked on this screen */
  chosen?: string;
  askSent?: boolean;
  fill?: number;
  h?: LiveHandlers;
  voice?: Voice;
  /** the studio's own drawing for this screen (recorder, replay, drill capture) */
  children?: ComponentChildren;
  /** read-only (the chat widget): no ask box, no pause */
  readOnly?: boolean;
  /** the runner is talking to the server: the main button waits */
  busy?: boolean;
}

/** What one live screen draws, and its main button. Pure: the studio runner and the widget both use it. */
export function liveBody({ screen, phase, state = {}, h = {}, voice, children, chosen, seconds = 0, summary, waiting }: LiveScreenProps): { body: ComponentChildren; cta: { label: string; enabled: boolean; hidden?: boolean } } {
  if (summary) return { body: <Summary view={summary} voice={voice} />, cta: { label: copy(voice, "backToToday"), enabled: true } };
  if (waiting) return { body: <Thinking voice={voice} />, cta: { label: copy(voice, "continue"), enabled: false } };
  if (!screen) return { body: <Hint>{copy(voice, "Loading the session…")}</Hint>, cta: { label: copy(voice, "continue"), enabled: false } };
  const item = liveItem(screen);
  const block = { title: BLOCK_TITLES[screen.block] ?? "", reason: undefined as string | undefined };
  if (isSummaryView(item)) return { body: <Summary view={item} voice={voice} />, cta: { label: copy(voice, "done"), enabled: true } };
  switch (item.type) {
    case "feedback": {
      const looped = !!state.looped?.[item.view.attemptId];
      const canFix = !!item.view.fixDrillId && !looped && !item.view.reRecord;
      return {
        body: children ?? <Feedback view={item.view} voice={voice} onTry={h.onTry} onReRecord={h.onReRecord} />,
        cta: { label: canFix ? copy(voice, "tryFix") : copy(voice, "continue"), enabled: true }
      };
    }
    case "pause":
      return { body: <PauseScreen seconds={seconds} voice={voice} />, cta: { label: copy(voice, "resume"), enabled: true } };
    case "plan":
      return { body: <PlanProposal view={item} voice={voice} chosen={chosen} onChoose={h.onChoose} />, cta: { label: copy(voice, "continue"), enabled: !!chosen } };
    case "message":
      // a message is drawn over the screen, never as one; one sent as a screen waits for the next
      return { body: <Thinking voice={voice} />, cta: { label: copy(voice, "continue"), enabled: true } };
    case "wrapup":
      // a live wrap-up carries the coach's praise and one fix over the server's summary
      if (!children && (item as { summary?: SummaryView }).summary) return { body: <Summary view={(item as { summary: SummaryView }).summary} voice={voice} />, cta: { label: copy(voice, "done"), enabled: true } };
      return itemBody({ item, block, state, h, voice, children });
    default: {
      const r = itemBody({ item, block, phase: phase ?? (item.type === "capture" ? "capture" : undefined), state, h, voice, children });
      return { body: r.body, cta: r.cta };
    }
  }
}

/** A live session screen inside the live frame. */
export function LiveScreen(props: LiveScreenProps) {
  const { screen, presence, message, h = {}, voice, readOnly, summary, askSent, fill, busy } = props;
  const { body, cta } = liveBody(props);
  const item = screen ? liveItem(screen) : undefined;
  const paused = !!item && !isSummaryView(item) && (item as { type?: string }).type === "pause";
  const kind = summary ? "ended" : props.waiting ? "waiting" : (screen?.kind ?? "loading");
  const onCta = paused ? h.onResume : h.onNext;
  return (
    <LiveFrame
      kind={kind}
      screenId={summary ? "ended" : screen?.id}
      block={summary ? "wrapup" : screen?.block}
      fill={fill}
      presence={presence}
      message={message}
      onDismissMessage={h.onDismissMessage}
      onReply={readOnly ? undefined : h.onReply}
      ask={readOnly || summary ? undefined : { away: presence === "away" || presence === "left", sent: askSent, onAsk: (t) => h.onAsk?.(t) }}
      onPause={readOnly || summary || paused ? undefined : h.onPause}
      onExit={readOnly ? undefined : h.onExit}
      cta={readOnly ? undefined : { ...cta, enabled: cta.enabled && !busy, onClick: onCta }}
      voice={voice}
    >
      {body}
    </LiveFrame>
  );
}

/** The coach view a tool result carries (coach_start, coach_show, coach_wait): a LiveView, `{screen, state, message}`, or a bare screen. */
export interface CoachWidgetModel {
  screen?: LiveScreenModel;
  message?: CoachMessageView;
  presence: PresenceStatus;
  summary?: SummaryView;
}

export function coachWidgetModel(d: any): CoachWidgetModel {
  const data = d ?? {};
  const bare = data.item && data.kind ? data : undefined;
  const screen: LiveScreenModel | undefined = bare ?? data.screen ?? data.view?.screen ?? data.current;
  const message: CoachMessageView | undefined = data.message ?? data.view?.message ?? (screen && (screen.item as any)?.type === "message" ? (screen.item as CoachMessageView) : undefined);
  const stateObj = data.view ?? data;
  const state: string | undefined = typeof stateObj.state === "string" ? stateObj.state : stateObj.state?.state;
  const present: boolean = stateObj.coachPresent ?? state === "live";
  const presence: PresenceStatus = present ? "here" : stateObj.leftOnPurpose ? "left" : "away";
  const summary: SummaryView | undefined = stateObj.summary ?? (screen && isSummaryView(screen.item) ? screen.item : undefined);
  return { screen: screen && (screen.item as any)?.type === "message" ? undefined : screen, message, presence, summary: state === "ended" ? summary : undefined };
}
