/**
 * The studio events a live session sends (live-coach §6). Pure builders, so the payloads are tested: the server
 * turns each into the coach event the coach reads from `coach_wait`.
 */
import { ASK_MAX_CHARS, type Card, type StudioEvent } from "@las/schema";

/** Whole seconds between two times, never negative. */
export function secondsBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.round((toMs - fromMs) / 1000));
}

/** `screen.viewed`, with the time spent on the screen before it. */
export function screenViewed(sessionId: string, screenId: string, previous: { screenId: string; shownAt: number } | undefined, now: number): StudioEvent {
  return {
    type: "screen.viewed",
    sessionId,
    screenId,
    previous: previous ? { screenId: previous.screenId, seconds: secondsBetween(previous.shownAt, now) } : undefined,
    at: new Date(now).toISOString()
  };
}

/** What the learner did on a card, in the shape the lesson component reports it. */
export interface CardAction {
  picked?: number;
  revealed?: boolean;
  interacted?: boolean;
  side?: "left" | "right";
}

/**
 * `card.answered` for the cards that take an answer (predict, compare, try-it). Other card types, and a card with
 * no answer yet, send nothing.
 */
export function cardAnswered(sessionId: string, screenId: string, index: number, card: Card, a: CardAction, seconds: number): StudioEvent | undefined {
  const base = { type: "card.answered" as const, sessionId, screenId, card: index, cardType: card.type, seconds: Math.max(0, Math.round(seconds)) };
  switch (card.type) {
    case "predict":
      return a.picked === undefined ? undefined : { ...base, answer: a.picked, correct: a.picked === card.answer };
    case "compare":
      return a.side ? { ...base, answer: a.side, correct: card.answer ? a.side === card.answer : undefined } : undefined;
    case "try-it":
      return a.interacted ? { ...base, answer: card.action } : undefined;
    default:
      return undefined;
  }
}

/** `learner.asked`: the learner's own words, trimmed to 280 characters; nothing for an empty box. */
export function learnerAsked(sessionId: string, screenId: string | undefined, text: string): StudioEvent | undefined {
  const t = text.trim().slice(0, ASK_MAX_CHARS);
  return t ? { type: "learner.asked", sessionId, screenId, text: t } : undefined;
}

export function learnerHesitated(sessionId: string, screenId: string, seconds: number): StudioEvent {
  return { type: "learner.hesitated", sessionId, screenId, seconds: Math.max(0, Math.round(seconds)) };
}

export function sessionPaused(sessionId: string, reason: "learner" | "pain" = "learner"): StudioEvent {
  return { type: "session.paused", sessionId, reason };
}

export function sessionResumed(sessionId: string, pausedSeconds: number): StudioEvent {
  return { type: "session.resumed", sessionId, pausedSeconds: Math.max(0, Math.round(pausedSeconds)) };
}

export function sessionLeft(sessionId: string, reason: "closed" | "studio-offline" = "closed"): StudioEvent {
  return { type: "session.left", sessionId, reason };
}

export function planChosen(sessionId: string, screenId: string, optionId: string): StudioEvent {
  return { type: "plan.chosen", sessionId, screenId, optionId };
}
