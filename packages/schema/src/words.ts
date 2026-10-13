/** Word count used for every learner-facing budget. */
export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export const CARD_WORD_BUDGET = 25;
export const FEEDBACK_HEADLINE_BUDGET = 8;
