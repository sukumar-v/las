/**
 * Bayesian Knowledge Tracing (DESIGN §9; pyBKT is the reference). Mastery of a node = P(known).
 * Each observation is one piece of evidence on the node: a drill outcome (its `success`), or an analyzed
 * attempt (its pass criterion, the drill's success expression, or "no mistake above the confidence floor").
 * The node's own p_init / p_learn / p_slip / p_guess come from the skill model.
 */
export interface BktParams {
  p_init: number;
  p_learn: number;
  p_slip: number;
  p_guess: number;
}

export const DEFAULT_BKT: BktParams = { p_init: 0.1, p_learn: 0.2, p_slip: 0.1, p_guess: 0.15 };

/**
 * One standard BKT step:
 * 1. condition on the observation: correct → P(L)(1−S) / (P(L)(1−S) + (1−P(L))G),
 *    wrong → P(L)S / (P(L)S + (1−P(L))(1−G));
 * 2. then the chance to learn: P(L') = post + (1 − post)·T.
 */
export function bktUpdate(pKnown: number, correct: boolean, p: BktParams = DEFAULT_BKT): number {
  const L = Math.min(1, Math.max(0, pKnown));
  const post = correct ? (L * (1 - p.p_slip)) / (L * (1 - p.p_slip) + (1 - L) * p.p_guess) : (L * p.p_slip) / (L * p.p_slip + (1 - L) * (1 - p.p_guess));
  const next = post + (1 - post) * p.p_learn;
  return Number.isFinite(next) ? Math.min(0.999, Math.max(0.001, next)) : L;
}

/** P(correct) on the next attempt, used to aim practice at a 70–85% success rate. */
export function pCorrect(pKnown: number, p: BktParams = DEFAULT_BKT): number {
  return pKnown * (1 - p.p_slip) + (1 - pKnown) * p.p_guess;
}
