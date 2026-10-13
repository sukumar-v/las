/**
 * The personalization rules of DESIGN §5.3 as general code. They read only skill-model data
 * (why options, pictures and their tags, the ladder with hour ranges, access, injuries, focus)
 * and the learner's answers. The prototype's rankedAfter / accessOptions / suggestions / kindLabel /
 * feas / focusMix show the same behavior for four hard-coded examples.
 */
import type { EngineId, MilestoneSuggestion, Picture, SkillModel } from "@las/schema";
import { lc1, weeksTo } from "./common.js";

export const DEADLINES = [
  { id: "none", label: "No deadline", weeks: null },
  { id: "4w", label: "4 weeks", weeks: 4 },
  { id: "3m", label: "3 months", weeks: 13 },
  { id: "6m", label: "6 months", weeks: 26 }
] as const;
export type DeadlineId = (typeof DEADLINES)[number]["id"];
export const deadlineWeeks = (id?: string): number | null => DEADLINES.find((d) => d.id === id)?.weeks ?? null;

/**
 * Six-month pictures re-ranked by why (§5.3 row 2): the more of the learner's why tags a picture
 * carries, the higher it goes; ties keep the model's order. Matches carry a "Fits your why" badge.
 */
export function rankPictures(model: SkillModel, why: string[]): { picture: Picture; index: number; fit: number }[] {
  return model.pictures
    .map((picture, index) => ({ picture, index, fit: picture.why.filter((w) => why.includes(w)).length }))
    .sort((a, b) => b.fit - a.fit || a.index - b.index);
}

/** Equipment options (§5.3 row 4): the skill's basics plus whatever the picked picture needs. */
export function accessOptions(model: SkillModel, pictureId?: string): string[] {
  const pic = model.pictures.find((p) => p.id === pictureId);
  const out = [...model.access];
  for (const a of pic?.access ?? []) if (!out.includes(a)) out.push(a);
  return out;
}

/**
 * A why reason is "urgent" when its id names something with a date (§5.3 row 5: "a reason like a trip,
 * event or exam puts the quick win first"). Decision: skill models word why options freely, so LAS
 * matches the id against this list; a model that wants a reason treated as urgent uses one of these words in its id.
 */
export const URGENT_WHY = /event|trip|exam|class|deadline|wedding|race|show/i;
export const isUrgentWhy = (id: string): boolean => URGENT_WHY.test(id);

export interface MilestoneContext {
  model: SkillModel;
  placement: number;
  minutesPerWeek: number;
  deadlineWeeks: number | null;
  why: string[];
  picture?: Picture;
  pictureText?: string;
}

const top = (c: MilestoneContext) => c.model.ladder.length - 1;
const wk = (c: MilestoneContext, step: number) => weeksTo(c.model, c.placement, step, c.minutesPerWeek);

/** The highest step strictly between the placement and `step` reachable within `limit` weeks. */
function stoneWithin(c: MilestoneContext, step: number, limit: number): number | undefined {
  let s: number | undefined;
  for (let r = c.placement + 1; r < step; r++) if (wk(c, r) <= limit) s = r;
  return s;
}

/**
 * Feasibility (§5.3 row 6): with a deadline, "Fits your deadline" or "Ambitious" with the highest stepping
 * stone inside the deadline; without one, "Realistic" up to 12 weeks, else "Long road" with a stone
 * reachable within 8 weeks.
 */
export function feasibility(c: MilestoneContext, step: number): MilestoneSuggestion["feasibility"] {
  const L = c.model.ladder;
  const w = wk(c, step);
  if (step <= c.placement) return { kind: "warn", label: "You're already past this", message: "Pick something higher up the ladder." };
  if (c.deadlineWeeks) {
    if (w <= c.deadlineWeeks) return { kind: "good", label: "Fits your deadline" };
    const s = stoneWithin(c, step, c.deadlineWeeks);
    return {
      kind: "warn",
      label: "Ambitious",
      stoneStep: s,
      message: s !== undefined ? `Reach "${L[s].label}" by your deadline, then this by week ${w}.` : `Even the next step needs about ${wk(c, c.placement + 1)} weeks. Add time or move the deadline.`
    };
  }
  if (w <= 12) return { kind: "good", label: "Realistic" };
  const s = stoneWithin(c, step, 8);
  return {
    kind: "warn",
    label: "Long road",
    stoneStep: s,
    message: s !== undefined ? `Start with "${L[s].label}" in about ${wk(c, s)} weeks and keep this as the next goal.` : `About ${w} weeks at this pace. More time per week brings it closer.`
  };
}

/** The badge on each suggestion (prototype kindLabel). */
export function kindLabel(c: MilestoneContext, kind: MilestoneSuggestion["kind"], step: number): string {
  const pictureText = c.picture?.label ?? c.pictureText;
  switch (kind) {
    case "quick":
      return c.deadlineWeeks && wk(c, step) <= c.deadlineWeeks ? "Before your deadline" : "Quick win";
    case "stretch":
      return "Stretch";
    case "picture":
      return pictureText ? `Toward ${lc1(pictureText)}` : "Toward your picture";
    case "stone":
      return "Stepping stone";
    case "custom":
      return "In your words";
    default:
      return "From the ladder";
  }
}

const proofEngine = (model: SkillModel, step: number): EngineId => model.ladder[step]?.proof?.engine ?? "self-report";

export function suggestion(c: MilestoneContext, kind: MilestoneSuggestion["kind"], step: number, title?: string, proof?: string): MilestoneSuggestion {
  const s = c.model.ladder[step];
  return {
    kind,
    kindLabel: kindLabel(c, kind, step),
    step,
    title: title ?? s.label,
    proof: proof ?? s.proof?.label ?? s.label,
    engine: proofEngine(c.model, step),
    weeks: wk(c, step),
    feasibility: feasibility(c, step)
  };
}

/**
 * Suggested milestones (§5.3 row 5):
 * - quick win = the next step;
 * - toward your picture = the picture's own step (at least the next one) with its milestone wording and proof,
 *   or, for a picture in the learner's own words, two steps up;
 * - stretch = the furthest step reachable in about 6 weeks at their pace, else one past the quick win.
 * A deadline or an urgent why puts the quick win first; otherwise the picture leads.
 */
export function suggestMilestones(c: MilestoneContext): MilestoneSuggestion[] {
  const T = top(c);
  const quick = Math.min(c.placement + 1, T);
  let stretch = quick;
  for (let r = quick + 1; r <= T; r++) {
    if (wk(c, r) <= 6) stretch = r;
    else break;
  }
  if (stretch === quick && quick < T) stretch = quick + 1;
  const out: MilestoneSuggestion[] = [suggestion(c, "quick", quick)];
  if (c.picture) {
    const step = Math.min(Math.max(c.picture.ladderStep, c.placement + 1), T);
    out.push(suggestion(c, "picture", step, c.picture.milestone, c.picture.proof));
  } else if (c.pictureText?.trim()) {
    const step = Math.min(c.placement + 2, T);
    out.push(suggestion(c, "picture", step, `First step toward "${c.pictureText.trim()}"`));
  }
  if (stretch !== quick) out.push(suggestion(c, "stretch", stretch));
  const urgent = !!c.deadlineWeeks || c.why.some(isUrgentWhy);
  if (!urgent && out[1]?.kind === "picture") out.unshift(out.splice(1, 1)[0]);
  return out.filter((s, i, arr) => arr.findIndex((x) => x.step === s.step && x.title === s.title) === i);
}

export interface MixResult {
  mix: { category: string; share: number }[];
  reasons: string[];
}

/** The category LAS adds when an injury is flagged. */
export const RECOVERY_CATEGORY = "Recovery & prehab";

/**
 * Practice mix (§5.3 row 7): starts from the picture's mix (else the model's), +10 to the first
 * category for a beginner (placement ≤ 1), an injury lowers each hard-training category by 10
 * (never below 5) and adds recovery and prehab at 10; then normalized to 100.
 */
export function focusMix(model: SkillModel, picture: Picture | undefined, placement: number, injuries: string[]): MixResult {
  const f = Object.entries(picture?.focus ?? model.focus).map(([category, share]) => ({ category, share }));
  const reasons: string[] = [];
  if (!f.length) return { mix: [], reasons };
  if (placement <= 1) {
    f[0].share += 10;
    reasons.push(`New to this: more ${lc1(f[0].category)}`);
  }
  if (injuries.length) {
    const hard = new Set(model.hard_focus ?? []);
    for (const x of f) if (hard.has(x.category)) x.share = Math.max(5, x.share - 10);
    const rec = f.find((x) => x.category === RECOVERY_CATEGORY);
    if (rec) rec.share += 10;
    else f.push({ category: RECOVERY_CATEGORY, share: 10 });
    reasons.push(`${injuries.map(lc1).join(" and ")}: recovery built in`);
  }
  const sum = f.reduce((t, x) => t + x.share, 0) || 1;
  for (const x of f) x.share = Math.round((x.share / sum) * 100);
  f[0].share += 100 - f.reduce((t, x) => t + x.share, 0);
  return { mix: f, reasons };
}
