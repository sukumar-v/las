import { DRILL_TYPES, ENGINES, PROBE_TYPES, validateSkillModel as validate, type Capabilities, type EngineId, type SkillModel } from "@las/schema";
import type { LasContext } from "../context.js";

/** What the agent gets back from draft_skill_model: a skeleton, the engines available now, and a starting point if one exists. */
export interface Draft {
  skill: string;
  startFrom?: { kind: "curated" | "previous"; id: string; version: number; model: SkillModel };
  availableEngines: EngineId[];
  unavailableEngines: { id: EngineId; reason: string; fallback: EngineId }[];
  skeleton: Record<string, unknown>;
  rules: string[];
  standardAnswerTypes: readonly string[];
  drillTypes: readonly string[];
}

export function draftSkillModel(ctx: LasContext, skill: string, caps: Capabilities, notes?: string): Draft {
  const previous = ctx.store.findSkillModel(skill);
  const available = caps.engines.filter((e) => e.available).map((e) => e.id);
  const unavailable = caps.engines.filter((e) => !e.available).map((e) => ({ id: e.id, reason: e.reason ?? "not available on this machine", fallback: ENGINES[e.id].fallbacks[0] ?? ("self-report" as EngineId) }));
  const skeleton = {
    schemaVersion: 1,
    skill,
    name: "<Display name>",
    noun: "<lowercase noun used in questions>",
    source: "generated",
    physical: "<true for anything done with the body>",
    engines: "<subset of availableEngines this skill needs, e.g. ['movement', 'audio', 'knowledge', 'self-report']>",
    why: "[3-8 reasons worded for this skill: {id, label}]",
    pictures: "[2-8 six-month pictures: {id, label, why: [why ids], ladderStep, milestone, proof, focus: {category: share}, access?}]",
    probes: `[1-3 level checks using only standard answer types: ${PROBE_TYPES.join(", ")}]`,
    placement: "[rules in order: {when: '<expression over answers>', step}] (first match wins)",
    ladder: "[5-8 steps: {id, label, hours: [low, high], nodes: [node ids], proof: {engine, spec, label, criteria: [{id, label, check}]}}], step 0 is the starting point with hours [0,0] and no proof",
    nodes: "[skill graph: {id, name, requires: [ids], lesson, drills: [ids], mistakes: [ids], review: {prompt, kind, options, answer}}]",
    lessons: "[{id, title, nodes, cards: [1-5 cards, 25 words each: predict | sim | mechanism | diagram | demo | compare | try-it]}]",
    drills: `[{id, type: ${DRILL_TYPES.join(" | ")}, title, nodes, spec, capture?, needs?, success, difficulty: {param, levels}, minutes, intensity, focus, fixes}]`,
    specs: "{id: metric | rubric | test | audio | speech | items | task | sensor | game | self-report spec}",
    mistakes: "[{id, name, nodes, engine, detector: {metric, when, min_share?, min_confidence}, severity, explain: {lesson, card} | {figure}, fix_drill, resolved_after, headline (8 words)}]",
    warmups: "[physical only: {id, title, steps, minutes}]",
    safety: "physical only: {warmup, injury_questions, beginner_caps, stop_criteria, see_professional, supervised_only}",
    access: "[equipment and places]",
    injuries: "{injury: training rule}",
    focus: "{practice-mix category: share}, sums to 100",
    hard_focus: "[categories an injury lowers]",
    key_metrics: "[2-3: {id, label, engine, metric, unit, better, format}]"
  };
  const rules = [
    "Call get_capabilities first and choose engines from availableEngines. When an engine you want is missing, use its fallback, record it under fallbacks, and tell the learner the check is less precise.",
    "Every ladder step past 0 has a proof bound to a spec of the matching engine, or engine self-report.",
    "Specs are data in the spec languages. Metric specs use standard body point names and the built-in functions only.",
    "Every card is 25 words or fewer. Headlines are 8 words or fewer. No essays anywhere.",
    "Physical skills need warm-ups, injury questions, beginner caps, stop criteria and see-a-professional triggers. Supervised-only activities (underwater, ropes, maximal lifts, sparring, firearms, vehicles) are listed and never coached.",
    "Hours per step are ranges; cite sources in notes when you can search.",
    "Call validate_skill_model and fix every error until ok is true. It stores the model."
  ];
  if (notes) rules.push(`Learner notes: ${notes}`);
  const out: Draft = { skill, availableEngines: available, unavailableEngines: unavailable, skeleton, rules, standardAnswerTypes: PROBE_TYPES, drillTypes: DRILL_TYPES };
  if (previous) out.startFrom = { kind: previous.source === "curated" ? "curated" : "previous", id: previous.id, version: previous.version, model: previous.model };
  return out;
}

export function validateAndStore(ctx: LasContext, input: unknown, caps: Capabilities) {
  const r = validate(input, caps);
  if (r.ok && r.model) {
    const row = ctx.store.saveSkillModel(r.model, true);
    return { ...r, stored: { id: row.id, version: row.version } };
  }
  return { ...r, stored: undefined };
}
