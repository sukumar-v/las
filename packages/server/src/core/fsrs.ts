/**
 * Spaced repetition with ts-fsrs (MIT). A card's FSRS state is stored as JSON with its due date.
 * Review grades 1–4 map to Again / Hard / Good / Easy.
 */
import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs";
import { DAY_MS } from "./common.js";

const scheduler = fsrs();

export type StoredCard = Omit<Card, "due" | "last_review"> & { due: string; last_review?: string };

function toStored(c: Card): StoredCard {
  return { ...c, due: new Date(c.due).toISOString(), last_review: c.last_review ? new Date(c.last_review).toISOString() : undefined };
}
function fromStored(s: StoredCard): Card {
  return { ...s, due: new Date(s.due), last_review: s.last_review ? new Date(s.last_review) : undefined } as Card;
}

/** A fresh card. Cards for nodes the learner already has (placement) are first due a day later. */
export function newCard(now: Date, firstDueInMs = DAY_MS): { state: StoredCard; dueAt: string } {
  const c = createEmptyCard(now);
  c.due = new Date(now.getTime() + firstDueInMs);
  return { state: toStored(c), dueAt: c.due.toISOString() };
}

export const GRADE_TO_RATING: Record<1 | 2 | 3 | 4, Grade> = { 1: Rating.Again, 2: Rating.Hard, 3: Rating.Good, 4: Rating.Easy };

/** Schedule the next review after a grade. */
export function gradeCard(state: StoredCard | Record<string, unknown>, grade: 1 | 2 | 3 | 4, now: Date): { state: StoredCard; dueAt: string } {
  const card = state && (state as StoredCard).due ? fromStored(state as StoredCard) : createEmptyCard(now);
  const next = scheduler.next(card, now, GRADE_TO_RATING[grade]).card;
  const stored = toStored(next);
  return { state: stored, dueAt: stored.due };
}
