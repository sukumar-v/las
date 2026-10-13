/**
 * The route to the milestone, the plan screen and the stored profile (DESIGN §5.1 step 7, §5.4).
 * Built from stored data only, so every tool and route shows the same thing.
 */
import type { PlanView, RouteView } from "@las/schema";
import type { LasContext } from "../context.js";
import { addWeeks, fmtDate, lc1, loadSk, type SkState, weeksTo, DAY_NAMES } from "./common.js";
import { focusMix, type MixResult } from "./rules.js";

/** The picture the learner chose, from their latest intake answers. */
export function pictureOf(st: SkState) {
  const a = (st.intake?.answers ?? {}) as { picture?: string; pictureText?: string };
  return { picture: st.model.pictures.find((p) => p.id === a.picture), text: a.pictureText };
}

/** The planned practice mix, recomputed from the stored answers (the same rule as onboarding). */
export function planMix(st: SkState): MixResult {
  const a = (st.intake?.answers ?? {}) as { revisit?: { placement: number } };
  const onboarding = st.intake?.placement?.step ?? a.revisit?.placement ?? st.placement;
  return focusMix(st.model, pictureOf(st).picture, onboarding, st.constraints.injuries);
}

export function routeView(ctx: LasContext, st: SkState): RouteView {
  const mastery = ctx.store.getMastery(st.enrollment.id);
  const b = st.placement;
  const target = st.milestone?.status === "active" ? st.milestone.ladderStep : undefined;
  return {
    start: b,
    target,
    steps: st.model.ladder.map((s, i) => ({
      step: i,
      label: s.label,
      hours: s.hours,
      weeks: i > b ? weeksTo(st.model, b, i, st.constraints.minutesPerWeek) : undefined,
      state: i < b ? "done" : i === b ? "here" : "ahead",
      target: target === i,
      nodes: s.nodes.map((n) => ({ id: n, name: st.model.nodes.find((x) => x.id === n)?.name ?? n, mastery: mastery.get(n)?.pKnown ?? 0 }))
    }))
  };
}

const hrs = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10}`;

/** The plan screen (§5.1 step 7): target, route, why → picture, practice mix with reasons, check-ins, injury rules, stored profile. */
export function planView(ctx: LasContext, sk: string): PlanView {
  const st = loadSk(ctx, sk);
  const m = st.milestone;
  const c = st.constraints;
  const mix = planMix(st);
  const { picture, text } = pictureOf(st);
  const whyLabels = (st.intent?.why ?? []).map((id) => st.model.why.find((w) => w.id === id)?.label ?? id);
  const afterwards = st.intent?.afterwards || picture?.label || text || "";
  const proof = st.model.ladder[m?.ladderStep ?? 0]?.proof;
  const weeks = m ? (m.estimateWeeks ?? weeksTo(st.model, st.placement, m.ladderStep, c.minutesPerWeek)) : 0;
  const targetDate = m?.targetDate ?? addWeeks(new Date(), weeks).toISOString().slice(0, 10);
  const injuryRules = c.injuries.map((i) => ({ injury: i, rule: st.model.injuries?.[i] ?? "Ease off anything that hurts" }));
  const proofLabel = (m?.proof as { label?: string } | undefined)?.label ?? proof?.label ?? "";
  const checkins = [
    `${c.schedule.sessionsPerWeek} sessions a week, about ${c.schedule.minutesEach} min each. We nudge you if you miss one.`,
    `Proof check around ${fmtDate(targetDate, st.tz)}: ${lc1(proofLabel)}.`,
    `Weekly review on ${DAY_NAMES[6]}, 5 minutes with your coach.`,
    ...injuryRules.map((r) => `${r.injury}: ${r.rule}.`),
    "Once you hit it, we ask why again. Goals change."
  ];
  const profile = {
    skill: st.model.name,
    intent: { why: whyLabels, afterwards },
    baseline: { step: st.model.ladder[st.placement]?.label, evidence: st.intake?.placement?.evidence ?? [], adjustedByLearner: st.intake?.placement?.adjusted ?? 0 },
    constraints: { minutesPerWeek: c.minutesPerWeek, deadlineWeeks: c.deadline ? Math.max(0, Math.round((new Date(c.deadline).getTime() - Date.now()) / 6048e5)) : null, access: c.access, injuries: c.injuries },
    milestones: m
      ? [{ goal: m.title, ladderStep: st.model.ladder[m.ladderStep]?.label, proof: { evaluator: proof?.engine ?? "self-report", pass: proofLabel }, estimateWeeks: weeks, targetDate, feasibility: m.feasibility }]
      : [],
    focus: Object.fromEntries(mix.mix.map((x) => [x.category, x.share])),
    checkins: { sessionsPerWeek: c.schedule.sessionsPerWeek, minutesEach: c.schedule.minutesEach, days: c.schedule.days.map((d) => DAY_NAMES[d].slice(0, 3)) }
  };
  return {
    sk: st.enrollment.id,
    skill: st.model.name,
    milestone: { title: m?.title ?? "", proof: proofLabel, engine: proof?.engine ?? "self-report", targetDate, weeks, hoursPerWeek: Number(hrs(c.minutesPerWeek)), feasibility: m?.feasibility ?? "" },
    route: routeView(ctx, st),
    why: whyLabels,
    picture: afterwards,
    mix: mix.mix,
    mixReasons: mix.reasons,
    schedule: { sessionsPerWeek: c.schedule.sessionsPerWeek, minutesEach: c.schedule.minutesEach, days: c.schedule.days },
    checkins,
    injuryRules,
    safety: st.model.physical && st.model.safety ? { supervisedOnly: st.model.safety.supervised_only, stop: st.model.safety.stop_criteria } : undefined,
    profile
  };
}
