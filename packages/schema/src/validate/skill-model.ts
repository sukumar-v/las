import { SkillModelSchema, type SkillModel } from "../skill-model.js";
import { checkLesson } from "../lesson.js";
import { checkSimSpec } from "../specs/sim.js";
import { DRILL_ENGINE } from "../drill.js";
import { checkSpec, ENGINE_FOR_SPEC_KIND, type EngineSpec } from "../specs/index.js";
import { parseExpr } from "../expr/parser.js";
import { countWords, FEEDBACK_HEADLINE_BUDGET } from "../words.js";
import type { Capabilities } from "../capabilities.js";
import type { EngineId } from "../engines.js";

export interface ModelIssue {
  path: string;
  check: string;
  message: string;
}

export interface ModelValidation {
  ok: boolean;
  errors: ModelIssue[];
  warnings: ModelIssue[];
  model?: SkillModel;
  /** engines the model uses that are available now */
  enginesAvailable?: EngineId[];
  summary?: { nodes: number; lessons: number; drills: number; mistakes: number; specs: number; ladderSteps: number; words: number };
}

/** Activities LAS teaches the theory of but won't coach or assess. */
export const SUPERVISED_ONLY_PATTERNS: [RegExp, string][] = [
  [/breath[- ]?hold|free ?div|apnea|underwater/i, "breath-holding and anything underwater"],
  [/belay|rope ?system|lead climb|rappel|abseil/i, "rope systems and belaying"],
  [/one[- ]rep max|1rm|max(imal)? (load|lift|attempt)/i, "heavy lifting with a maximal load"],
  [/full[- ]contact|sparring/i, "full-contact sparring"],
  [/firearm|gun|rifle|pistol|shooting/i, "firearms"],
  [/driv(e|ing) (a )?(car|truck|motor)|motorcycle|pilot|aircraft|flying lesson/i, "vehicles and aircraft"]
];

const safeParseExpr = (src: string, path: string, errors: ModelIssue[], check: string) => {
  try {
    parseExpr(src);
  } catch (e) {
    errors.push({ path, check, message: (e as Error).message });
  }
};

/**
 * Runs every check a skill model must pass (skill models §4 and any-skill §6).
 * `capabilities` lets it confirm each proof can be measured by an engine available now.
 */
export function validateSkillModel(input: unknown, capabilities?: Capabilities | null): ModelValidation {
  const parsed = SkillModelSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => ({ path: i.path.join("."), check: "schema", message: i.message })), warnings: [] };
  }
  const m = parsed.data;
  const errors: ModelIssue[] = [];
  const warnings: ModelIssue[] = [];
  const err = (path: string, check: string, message: string) => errors.push({ path, check, message });
  const warn = (path: string, check: string, message: string) => warnings.push({ path, check, message });

  const available = new Set<EngineId>(capabilities ? capabilities.engines.filter((e) => e.available).map((e) => e.id) : []);
  available.add("self-report");
  const nodeIds = new Set(m.nodes.map((n) => n.id));
  const lessonIds = new Set(m.lessons.map((l) => l.id));
  const drillIds = new Set(m.drills.map((d) => d.id));
  const mistakeIds = new Set(m.mistakes.map((x) => x.id));
  const whyIds = new Set(m.why.map((w) => w.id));
  const specs = new Map<string, EngineSpec>();
  const engines = new Set<EngineId>(m.engines);
  let words = 0;

  // Specs parse and use known points, functions and runners
  for (const [id, raw] of Object.entries(m.specs)) {
    const r = checkSpec(raw);
    for (const i of r.issues) err(`specs.${id}.${i.path}`, "spec", i.message);
    if (r.spec) {
      specs.set(id, r.spec);
      const eng = ENGINE_FOR_SPEC_KIND[r.spec.kind];
      if (!engines.has(eng)) err(`specs.${id}`, "engines", `a ${r.spec.kind} spec needs engine "${eng}" in model.engines`);
    }
  }
  const specEngine = (id: string): EngineId | undefined => {
    const s = specs.get(id);
    return s ? ENGINE_FOR_SPEC_KIND[s.kind] : undefined;
  };

  // Audio and speech pass/mistake expressions parse
  for (const [id, s] of specs) {
    if (s.kind === "audio" || s.kind === "speech") {
      if (s.pass) safeParseExpr(s.pass, `specs.${id}.pass`, errors, "expr");
      s.mistakes.forEach((x, k) => safeParseExpr(x.when, `specs.${id}.mistakes[${k}].when`, errors, "expr"));
    }
    if ((s.kind === "task" || s.kind === "sensor" || s.kind === "game" || s.kind === "self-report" || s.kind === "items" || s.kind === "rubric") && s.pass) safeParseExpr(s.pass, `specs.${id}.pass`, errors, "expr");
  }

  // Lessons: word budget, sim cards checked
  m.lessons.forEach((l, i) => {
    for (const issue of checkLesson(l)) err(`lessons[${i}].${issue.path}`, "word-budget", issue.message);
    l.cards.forEach((c, k) => {
      if (c.type === "sim") for (const issue of checkSimSpec(c.sim)) err(`lessons[${i}].cards[${k}].sim.${issue.path}`, "spec", issue.message);
    });
    for (const c of l.cards) words += countWords(c.text);
    for (const n of l.nodes) if (!nodeIds.has(n)) err(`lessons[${i}].nodes`, "refs", `unknown node "${n}"`);
  });

  // Drills: standard types, engine spec of the right kind, success expressions parse
  m.drills.forEach((d, i) => {
    for (const n of d.nodes) if (!nodeIds.has(n)) err(`drills[${i}].nodes`, "refs", `unknown node "${n}"`);
    const needEngine = DRILL_ENGINE[d.type];
    if (d.prompt) {
      words += countWords(d.prompt);
      if (countWords(d.prompt) > 25) err(`drills[${i}].prompt`, "word-budget", "25 words or fewer");
    }
    if (needEngine !== "knowledge" || d.spec) {
      if (!d.spec) {
        if (needEngine !== "knowledge" && needEngine !== "interaction") err(`drills[${i}].spec`, "spec", `a "${d.type}" drill needs a ${needEngine} spec`);
      } else if (!specs.has(d.spec)) err(`drills[${i}].spec`, "refs", `unknown spec "${d.spec}"`);
      else {
        const eng = specEngine(d.spec)!;
        if (eng !== needEngine && !(needEngine === "knowledge" && eng === "knowledge")) err(`drills[${i}].spec`, "spec", `a "${d.type}" drill is scored by ${needEngine}, but "${d.spec}" is a ${specs.get(d.spec)!.kind} spec`);
      }
    }
    if (d.type === "choice" || d.type === "match" || d.type === "order" || d.type === "predict-output" || d.type === "fill" || d.type === "hotspot") {
      if (!d.spec && !d.items?.length) err(`drills[${i}]`, "spec", `a "${d.type}" drill needs an items spec or inline item ids`);
    }
    if (d.success) safeParseExpr(d.success, `drills[${i}].success`, errors, "expr");
    for (const f of d.fixes) if (!mistakeIds.has(f)) err(`drills[${i}].fixes`, "refs", `unknown mistake "${f}"`);
  });

  // Nodes: lesson, drills, review, prerequisites, cycles, reachability
  const nodeById = new Map(m.nodes.map((n) => [n.id, n]));
  m.nodes.forEach((n, i) => {
    if (!lessonIds.has(n.lesson)) err(`nodes[${i}].lesson`, "refs", `unknown lesson "${n.lesson}"`);
    for (const d of n.drills) if (!drillIds.has(d)) err(`nodes[${i}].drills`, "refs", `unknown drill "${d}"`);
    for (const x of n.mistakes) if (!mistakeIds.has(x)) err(`nodes[${i}].mistakes`, "refs", `unknown mistake "${x}"`);
    for (const r of n.requires) {
      if (!nodeIds.has(r)) err(`nodes[${i}].requires`, "refs", `unknown prerequisite "${r}"`);
      if (r === n.id) err(`nodes[${i}].requires`, "graph", "a node can't require itself");
    }
    words += countWords(n.review.prompt);
  });
  // cycles
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string, path: string[]): void => {
    const s = state.get(id) ?? 0;
    if (s === 1) {
      err("nodes", "graph", `cycle: ${[...path, id].join(" -> ")}`);
      return;
    }
    if (s === 2) return;
    state.set(id, 1);
    for (const r of nodeById.get(id)?.requires ?? []) if (nodeById.has(r)) visit(r, [...path, id]);
    state.set(id, 2);
  };
  for (const n of m.nodes) visit(n.id, []);
  // reachability from step 0: every node is in some ladder step, or a prerequisite of one
  const inLadder = new Set<string>();
  const addReq = (id: string) => {
    if (inLadder.has(id)) return;
    inLadder.add(id);
    for (const r of nodeById.get(id)?.requires ?? []) addReq(r);
  };
  m.ladder.forEach((s) => s.nodes.forEach(addReq));
  for (const n of m.nodes) if (!inLadder.has(n.id)) err(`nodes.${n.id}`, "graph", `node "${n.id}" is not on the path to any ladder step`);
  // a node must not be required for a step before any step that covers its prerequisites' steps: the planner handles order; here we check a node isn't required by step k while a prerequisite first appears at step > k
  const firstStep = new Map<string, number>();
  m.ladder.forEach((s, k) => s.nodes.forEach((n) => { if (!firstStep.has(n)) firstStep.set(n, k); }));
  for (const [id, k] of firstStep) for (const r of nodeById.get(id)?.requires ?? []) {
    const rk = firstStep.get(r);
    if (rk !== undefined && rk > k) warn(`ladder[${k}].nodes`, "graph", `"${id}" is needed at step ${k} but its prerequisite "${r}" first appears at step ${rk}`);
  }

  // Ladder: hours ascend as ranges; every step past 0 has a proof bound to a spec
  m.ladder.forEach((s, k) => {
    if (s.hours[0] > s.hours[1]) err(`ladder[${k}].hours`, "ladder", "hours range must be [low, high]");
    if (countWords(s.label) > 10) err(`ladder[${k}].label`, "word-budget", "ladder labels are 10 words or fewer");
    if (k === 0) {
      if (s.hours[1] !== 0) warn(`ladder[0].hours`, "ladder", "step 0 is the starting point; hours should be [0, 0]");
      return;
    }
    if (s.nodes.length === 0) err(`ladder[${k}].nodes`, "ladder", "each step past 0 names the nodes it needs");
    for (const n of s.nodes) if (!nodeIds.has(n)) err(`ladder[${k}].nodes`, "refs", `unknown node "${n}"`);
    if (!s.proof) {
      err(`ladder[${k}].proof`, "proof", "every ladder step has a proof bound to an engine spec");
      return;
    }
    const p = s.proof;
    if (countWords(p.label) > 25) err(`ladder[${k}].proof.label`, "word-budget", "25 words or fewer");
    words += countWords(p.label);
    if (!engines.has(p.engine)) err(`ladder[${k}].proof.engine`, "engines", `"${p.engine}" is not in model.engines`);
    if (p.engine !== "self-report") {
      if (!p.spec) err(`ladder[${k}].proof.spec`, "proof", "a proof names the engine spec it is measured by, or is labeled self-report");
      else if (!specs.has(p.spec)) err(`ladder[${k}].proof.spec`, "refs", `unknown spec "${p.spec}"`);
      else if (specEngine(p.spec) !== p.engine) err(`ladder[${k}].proof.spec`, "proof", `spec "${p.spec}" is for ${specEngine(p.spec)}, not ${p.engine}`);
    }
    for (const c of p.criteria) safeParseExpr(c.check, `ladder[${k}].proof.criteria.${c.id}`, errors, "expr");
    if (capabilities) {
      if (!available.has(p.engine)) {
        if (p.fallback && available.has(p.fallback)) {
          if (p.fallback !== "self-report" && (!p.fallback_spec || !specs.has(p.fallback_spec))) err(`ladder[${k}].proof.fallback_spec`, "proof", `fallback engine "${p.fallback}" needs a spec`);
          else warn(`ladder[${k}].proof`, "capabilities", `"${p.engine}" is not available now; the ${p.fallback} fallback will be used and the check is less precise`);
        } else err(`ladder[${k}].proof`, "capabilities", `"${p.engine}" is not available on this machine and no available fallback is named (self-report is always available)`);
      }
    }
    const spec = p.spec ? specs.get(p.spec) : undefined;
    if (spec?.kind === "rubric" && spec.safety_critical) err(`ladder[${k}].proof`, "safety", "rubric grading alone is never the proof for anything safety-critical");
  });

  // Mistakes: detector, fix drill, explanation visual
  m.mistakes.forEach((x, i) => {
    for (const n of x.nodes) if (!nodeIds.has(n)) err(`mistakes[${i}].nodes`, "refs", `unknown node "${n}"`);
    if (!drillIds.has(x.fix_drill)) err(`mistakes[${i}].fix_drill`, "refs", `unknown drill "${x.fix_drill}"`);
    if ("lesson" in x.explain) {
      const ex = x.explain;
      const lesson = m.lessons.find((l) => l.id === ex.lesson);
      if (!lesson) err(`mistakes[${i}].explain.lesson`, "refs", `unknown lesson "${ex.lesson}"`);
      else if (ex.card >= lesson.cards.length) err(`mistakes[${i}].explain.card`, "refs", `lesson "${lesson.id}" has ${lesson.cards.length} cards`);
    }
    if (!engines.has(x.engine)) err(`mistakes[${i}].engine`, "engines", `"${x.engine}" is not in model.engines`);
    safeParseExpr(x.detector.when, `mistakes[${i}].detector.when`, errors, "expr");
    if (countWords(x.headline) > FEEDBACK_HEADLINE_BUDGET) err(`mistakes[${i}].headline`, "word-budget", `${FEEDBACK_HEADLINE_BUDGET} words or fewer`);
  });

  // Pictures and why
  m.pictures.forEach((p, i) => {
    for (const w of p.why) if (!whyIds.has(w)) err(`pictures[${i}].why`, "refs", `unknown why "${w}"`);
    if (p.ladderStep >= m.ladder.length) err(`pictures[${i}].ladderStep`, "refs", `ladder has ${m.ladder.length} steps`);
    const sum = Object.values(p.focus).reduce((t, v) => t + v, 0);
    if (Math.abs(sum - 100) > 5) err(`pictures[${i}].focus`, "mix", `practice mix sums to ${sum}, not 100`);
  });
  const sumFocus = Object.values(m.focus).reduce((t, v) => t + v, 0);
  if (Math.abs(sumFocus - 100) > 5) err("focus", "mix", `practice mix sums to ${sumFocus}, not 100`);
  for (const h of m.hard_focus ?? []) if (!(h in m.focus)) warn("hard_focus", "refs", `"${h}" is not a focus category`);

  // Probes: standard types only (schema), specs for quiz/tap/record/code, options for choices
  m.probes.forEach((p, i) => {
    words += countWords(p.question);
    if (countWords(p.question) > 25) err(`probes[${i}].question`, "word-budget", "25 words or fewer");
    if (["single", "multi", "scale", "visual-multi"].includes(p.type) && !(p.options && p.options.length >= 2)) err(`probes[${i}].options`, "probe", `a "${p.type}" probe needs options`);
    if (["quiz", "tap", "record", "code"].includes(p.type)) {
      if (!p.spec) err(`probes[${i}].spec`, "probe", `a "${p.type}" probe needs a spec`);
      else if (!specs.has(p.spec)) err(`probes[${i}].spec`, "refs", `unknown spec "${p.spec}"`);
    }
    if (p.type === "visual-multi" && p.options?.some((o) => !o.figure)) err(`probes[${i}].options`, "probe", "visual-multi options need figures");
  });
  if (m.placement.length === 0) warn("placement", "placement", "no placement rules: every learner starts at step 0");
  m.placement.forEach((r, i) => {
    safeParseExpr(r.when, `placement[${i}].when`, errors, "expr");
    if (r.step >= m.ladder.length) err(`placement[${i}].step`, "refs", `ladder has ${m.ladder.length} steps`);
  });

  // Key metrics
  m.key_metrics.forEach((k, i) => {
    if (!engines.has(k.engine)) err(`key_metrics[${i}].engine`, "engines", `"${k.engine}" is not in model.engines`);
  });

  // Physical safety
  const text = [m.skill, m.name, ...m.ladder.map((s) => s.label), ...m.pictures.map((p) => p.label + " " + p.milestone)].join(" \n ");
  if (m.physical) {
    if (!m.safety) err("safety", "safety", "physical skills need safety fields: warm-up, injury questions, beginner caps, stop criteria, see-a-professional triggers");
    else {
      if (!m.warmups?.some((w) => w.id === m.safety!.warmup)) err("safety.warmup", "refs", `unknown warm-up "${m.safety.warmup}"`);
      for (const [re, label] of SUPERVISED_ONLY_PATTERNS) {
        if (re.test(text) && !m.safety.supervised_only.some((s) => s.toLowerCase().includes(label.split(" ")[0].toLowerCase()) || re.test(s))) {
          err("safety.supervised_only", "safety", `this skill touches "${label}": LAS teaches the theory but won't coach or assess the practice; list it under safety.supervised_only and keep it out of proofs`);
        }
      }
    }
    if (!m.injuries || Object.keys(m.injuries).length === 0) warn("injuries", "safety", "physical skills usually map injuries to training rules");
    for (const d of m.drills) if (d.intensity >= 4 && (m.safety?.beginner_caps.max_intensity ?? 3) < d.intensity) {
      // allowed, but the planner caps beginners; nothing to report
    }
  }

  // Media licenses
  m.media?.forEach((f, i) => {
    if (f.path.startsWith("http")) err(`media[${i}].path`, "assets", "media must be a local file (learner's device or pack), never fetched from the web");
  });

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    warnings,
    model: ok ? m : undefined,
    enginesAvailable: capabilities ? [...engines].filter((e) => available.has(e)) : undefined,
    summary: { nodes: m.nodes.length, lessons: m.lessons.length, drills: m.drills.length, mistakes: m.mistakes.length, specs: specs.size, ladderSteps: m.ladder.length, words }
  };
}
