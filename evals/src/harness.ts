/**
 * The agent-eval harness. A scenario is the agent's own work for one skill (a skill model written in the agent's
 * voice); the harness drives it through the real MCP tools in the order the LAS skill prescribes and records every
 * tool call. The assertion functions below return a list of problems (empty means the check holds), so a failing
 * eval says exactly what went wrong.
 */
import {
  AUDIO_METRICS,
  countWords,
  DRILL_ENGINE,
  GAME_METRICS,
  INTERACTION_METRICS,
  parseExpr,
  rootNames,
  SENSOR_METRICS,
  SPEECH_METRICS,
  ENGINE_FOR_SPEC_KIND,
  SPEC_KIND_FOR_ENGINE,
  SUPERVISED_ONLY_PATTERNS,
  type Capabilities,
  type EngineId,
  type EngineSpec,
  type ModelIssue,
  type SkillModel,
  type SkillModelInput
} from "@las/schema";
import { connect } from "../../packages/server/test/helpers.js";

// ---------------------------------------------------------------- types

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
}
export type Transcript = ToolCall[];

/** What draft_skill_model returns (structuredContent). */
export interface Draft {
  skill: string;
  availableEngines: EngineId[];
  unavailableEngines: { id: EngineId; reason: string; fallback: EngineId }[];
  skeleton: Record<string, unknown>;
  rules: string[];
  startFrom?: { kind: string; id: string; version: number };
}

export interface Expectation {
  /** the engines the coverage table (any-skill §8) names for this skill; each must be used through a spec */
  engines: EngineId[];
  /** other engines this model may use besides knowledge and self-report */
  extra?: EngineId[];
  /** the engine marked unavailable in the fallback run */
  main: EngineId;
  /** the routing table's fallback for `main` */
  fallback: EngineId;
  physical: boolean;
  /** key words that must appear under safety.supervised_only; empty means nothing is supervised-only */
  supervisedOnly?: string[];
}

export interface Scenario {
  id: string;
  /** what the learner typed */
  skill: string;
  /** anything the learner said that shapes the model */
  notes?: string;
  expect: Expectation;
  /** the agent writes the model from the draft and the capabilities it read */
  build(draft: Draft, caps: Capabilities): SkillModelInput;
  /** the agent fixes what validate_skill_model reported */
  repair?(errors: ModelIssue[], model: SkillModelInput): SkillModelInput;
}

export type Mode = "real" | "fallback";

export interface Attempt {
  ok: boolean;
  errors: ModelIssue[];
  warnings: ModelIssue[];
}

export interface AgentRun {
  scenario: Scenario;
  mode: Mode;
  caps: Capabilities;
  draft: Draft;
  transcript: Transcript;
  attempts: Attempt[];
  stored?: { id: string; version: number };
  /** the model as stored by the server (read back with get_skill_model) */
  model?: SkillModel;
  summary?: { nodes: number; lessons: number; drills: number; mistakes: number; specs: number; ladderSteps: number; words: number };
}

// ---------------------------------------------------------------- sessions

let realCaps: Promise<Capabilities> | undefined;

/** Capabilities of this machine, detected once per test process (detection spawns ~35 short processes). */
function detectOnce(ctx: { capabilities(fresh?: boolean): Promise<Capabilities> }): Promise<Capabilities> {
  realCaps ??= ctx.capabilities(true);
  return realCaps;
}

/** Marks engines unavailable, the way get_capabilities reports a missing engine. */
export function withUnavailable(caps: Capabilities, missing: { id: EngineId; reason: string }[]): Capabilities {
  const out = structuredClone(caps);
  for (const m of missing) {
    const e = out.engines.find((x) => x.id === m.id);
    if (e) Object.assign(e, { available: false, reason: m.reason, backend: "none" });
  }
  return out;
}

/** A fresh in-memory LAS server with a recording client. `missing` simulates engines that aren't available here. */
export async function session(missing: { id: EngineId; reason: string }[] = []) {
  const c = await connect();
  const caps = withUnavailable(await detectOnce(c.ctx), missing);
  c.ctx.capabilities = async () => structuredClone(caps);
  const transcript: Transcript = [];
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await c.call(tool, args);
    transcript.push({ tool, args: structuredClone(args), ok: !r.isError });
    return r;
  };
  return { call, transcript, ctx: c.ctx, close: c.close };
}

/** Why each engine might be missing, worded the way get_capabilities words it. */
export const MISSING_REASON: Record<EngineId, string> = {
  movement: "no camera reported and the pose models could not load",
  audio: "no microphone reported by the studio",
  speech: "no speech model downloaded and no microphone",
  code: "no runner for this language: toolchain, container and browser runtime all missing",
  visual: "text-only agent model and no local vision model",
  knowledge: "unavailable",
  interaction: "the studio is not running",
  sensor: "no phone paired and no motion sensors",
  game: "no UCI engine installed",
  "self-report": "unavailable"
};

/**
 * Run the agent flow for one scenario: get_capabilities -> draft_skill_model -> write the model ->
 * validate_skill_model (repairing up to 3 times) -> get_skill_model.
 */
export async function asAgent(scenario: Scenario, mode: Mode = "real"): Promise<AgentRun> {
  const s = await session(mode === "fallback" ? [{ id: scenario.expect.main, reason: MISSING_REASON[scenario.expect.main] }] : []);
  try {
    const capsResult = await s.call("get_capabilities");
    const caps = capsResult.data.data as Capabilities;
    const draftResult = await s.call("draft_skill_model", { skill: scenario.skill, ...(scenario.notes ? { notes: scenario.notes } : {}) });
    const draft = draftResult.data as Draft;
    let model = scenario.build(draft, caps);
    const attempts: Attempt[] = [];
    let last: any;
    for (let i = 0; i < 4; i++) {
      const r = await s.call("validate_skill_model", { model: model as unknown as Record<string, unknown> });
      last = r.data;
      attempts.push({ ok: !!last.ok, errors: last.errors ?? [], warnings: last.warnings ?? [] });
      if (last.ok || !scenario.repair || i === 3) break;
      model = scenario.repair(last.errors, structuredClone(model));
    }
    const run: AgentRun = { scenario, mode, caps, draft, transcript: s.transcript, attempts, summary: last?.summary };
    if (last?.ok) {
      run.stored = last.stored;
      const got = await s.call("get_skill_model", { skill: last.stored.id });
      run.model = got.data.model as SkillModel;
    }
    return run;
  } finally {
    await s.close();
  }
}

/** The fallbacks map the agent records: for each engine it wanted that get_capabilities says is missing, what it used. */
export function recordFallbacks(draft: Draft, wanted: Partial<Record<EngineId, EngineId>>): Record<string, EngineId> | undefined {
  const out: Record<string, EngineId> = {};
  for (const u of draft.unavailableEngines) if (wanted[u.id]) out[u.id] = wanted[u.id]!;
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------- assertions

/** get_capabilities came before drafting and before any validation. */
export function calledCapabilitiesFirst(transcript: Transcript): string[] {
  const p: string[] = [];
  const first = (tool: string) => transcript.findIndex((c) => c.tool === tool);
  const caps = first("get_capabilities");
  if (caps !== 0) p.push(`the first tool call was ${transcript[0]?.tool ?? "nothing"}, not get_capabilities`);
  const draft = first("draft_skill_model");
  const validate = first("validate_skill_model");
  if (draft < 0) p.push("draft_skill_model was never called");
  if (validate < 0) p.push("validate_skill_model was never called");
  if (caps < 0 || (draft >= 0 && draft < caps) || (validate >= 0 && validate < caps)) p.push("drafted or validated before get_capabilities");
  if (draft >= 0 && validate >= 0 && validate < draft) p.push("validated before drafting");
  return p;
}

const ALWAYS_ALLOWED: EngineId[] = ["knowledge", "self-report"];

/** The model uses the engines the coverage table names, each through a spec of its kind, and nothing unexpected. */
export function enginesMatch(model: SkillModel, expected: Expectation): string[] {
  const p: string[] = [];
  const kinds = new Set(Object.values(model.specs).map((s) => s.kind));
  const used = new Set<EngineId>([
    ...model.ladder.flatMap((s) => (s.proof ? [s.proof.engine] : [])),
    ...model.drills.map((d) => DRILL_ENGINE[d.type]),
    ...Object.values(model.specs).map((s) => ENGINE_FOR_SPEC_KIND[s.kind])
  ]);
  for (const e of expected.engines) {
    if (!model.engines.includes(e)) p.push(`expected engine "${e}" is not in model.engines`);
    if (e !== "self-report" && !kinds.has(SPEC_KIND_FOR_ENGINE[e])) p.push(`expected engine "${e}" has no ${SPEC_KIND_FOR_ENGINE[e]} spec`);
    if (!used.has(e)) p.push(`expected engine "${e}" is listed but nothing uses it`);
  }
  const allowed = new Set<EngineId>([...expected.engines, ...(expected.extra ?? []), ...ALWAYS_ALLOWED, expected.fallback]);
  for (const e of model.engines) if (!allowed.has(e)) p.push(`unexpected engine "${e}"`);
  return p;
}

/** Fallbacks the routing table allows for each engine (SKILL.md routing, spec-languages §Fallbacks). */
export const ROUTING: Record<EngineId, EngineId[]> = {
  movement: ["self-report"],
  audio: ["self-report"],
  speech: ["self-report"],
  visual: ["self-report"],
  interaction: ["self-report"],
  sensor: ["movement", "self-report"],
  code: ["knowledge"],
  game: ["knowledge"],
  knowledge: [],
  "self-report": []
};

/**
 * Every proof whose engine is unavailable names an available fallback (with a spec of the fallback's kind unless it
 * is self-report), the model's `fallbacks` map records exactly the missing engines, and each fallback follows the
 * routing table, including its details: predict-output items for code, a tactics quiz and fallback_items for the
 * game, a reference recording for speech, tapped measurements plus a photo for visual work.
 */
export function fallbacksUsed(model: SkillModel, caps: Capabilities): string[] {
  const p: string[] = [];
  const available = new Set<EngineId>(caps.engines.filter((e) => e.available).map((e) => e.id));
  available.add("self-report");
  const missing = model.engines.filter((e) => !available.has(e));
  const map = model.fallbacks ?? {};
  const specs = model.specs;
  model.ladder.forEach((s, k) => {
    const pr = s.proof;
    if (!pr || available.has(pr.engine)) return;
    if (!pr.fallback) return void p.push(`ladder[${k}] proof uses missing engine "${pr.engine}" with no fallback`);
    if (!available.has(pr.fallback)) p.push(`ladder[${k}] fallback "${pr.fallback}" is not available either`);
    const fs = pr.fallback_spec ? specs[pr.fallback_spec] : undefined;
    if (pr.fallback !== "self-report" && !fs) p.push(`ladder[${k}] fallback "${pr.fallback}" names no existing fallback_spec`);
    if (pr.fallback_spec && !fs) p.push(`ladder[${k}] fallback_spec "${pr.fallback_spec}" does not exist`);
    if (fs && ENGINE_FOR_SPEC_KIND[fs.kind] !== pr.fallback) p.push(`ladder[${k}] fallback_spec "${pr.fallback_spec}" is a ${fs.kind} spec, not for ${pr.fallback}`);
    if (map[pr.engine] !== pr.fallback) p.push(`ladder[${k}] falls back to "${pr.fallback}" but model.fallbacks.${pr.engine} is ${JSON.stringify(map[pr.engine])}`);
  });
  for (const e of missing) if (!map[e]) p.push(`engine "${e}" is missing here but model.fallbacks does not record what replaces it`);
  for (const [wanted, used] of Object.entries(map) as [EngineId, EngineId][]) {
    if (available.has(wanted)) p.push(`model.fallbacks claims "${wanted}" is missing, but it is available`);
    if (!available.has(used)) p.push(`model.fallbacks.${wanted} = "${used}", which is not available`);
    if (!ROUTING[wanted]?.includes(used)) p.push(`model.fallbacks.${wanted} = "${used}" is not in the routing table (${ROUTING[wanted]?.join(", ") || "no fallback"})`);
    if (!model.engines.includes(used)) p.push(`fallback engine "${used}" is not in model.engines`);
    const proofsFor = model.ladder.flatMap((s) => (s.proof && s.proof.engine === wanted ? [s.proof] : []));
    const fallbackSpecs = proofsFor.flatMap((pr) => (pr.fallback_spec && specs[pr.fallback_spec] ? [specs[pr.fallback_spec]] : []));
    if (wanted === "code" && !fallbackSpecs.some((s) => s.kind === "items" && s.items.some((i) => i.type === "predict-output"))) p.push("code falls back to knowledge without predict-output items");
    if (wanted === "game") {
      if (!fallbackSpecs.some((s) => s.kind === "items")) p.push("game falls back to knowledge without a tactics quiz");
      if (!Object.values(specs).some((s) => s.kind === "game" && (s.fallback_items?.length ?? 0) > 0)) p.push("game spec has no fallback_items");
    }
    if (wanted === "speech" && !fallbackSpecs.some((s) => s.kind === "self-report" && /reference recording/i.test(s.criterion ?? ""))) p.push("speech falls back to self-report without a reference recording (fallback_spec)");
    if (wanted === "visual") {
      if (!Object.values(specs).some((s) => s.kind === "rubric" && (s.taps?.length ?? 0) > 0)) p.push("visual falls back without tapped measurements (rubric taps)");
      if (!fallbackSpecs.some((s) => s.kind === "self-report" && s.fields.includes("photo"))) p.push("visual falls back to self-report without a photo (fallback_spec)");
    }
  }
  return p;
}

/** Same counting as the server's lesson check: card text plus predict options and reveal plus a sim card's prompt. */
export function cardWords(card: SkillModel["lessons"][number]["cards"][number]): number {
  let w = countWords(card.text);
  if (card.type === "predict") w += card.options.reduce((t, o) => t + countWords(o), 0) + (card.reveal ? countWords(card.reveal) : 0);
  if (card.type === "sim" && card.sim.prompt) w += countWords(card.sim.prompt);
  return w;
}

/** Every learner-facing text stays inside its budget. */
export function wordBudgetHeld(model: SkillModel): string[] {
  const p: string[] = [];
  const over = (what: string, text: string, max: number) => {
    const n = countWords(text);
    if (n > max) p.push(`${what}: ${n} words (max ${max}): "${text}"`);
  };
  model.lessons.forEach((l) =>
    l.cards.forEach((c, i) => {
      const n = cardWords(c);
      if (n > 25) p.push(`lesson ${l.id} card ${i}: ${n} words (max 25)`);
      if (c.type === "sim" && c.sim.takeaway) over(`lesson ${l.id} card ${i} takeaway`, c.sim.takeaway, 25);
    })
  );
  for (const x of model.mistakes) over(`mistake ${x.id} headline`, x.headline, 8);
  for (const q of model.probes) over(`probe ${q.id}`, q.question, 25);
  for (const d of model.drills) if (d.prompt) over(`drill ${d.id} prompt`, d.prompt, 25);
  for (const s of model.ladder) {
    over(`ladder ${s.id} label`, s.label, 10);
    if (s.proof) over(`ladder ${s.id} proof label`, s.proof.label, 25);
  }
  for (const [id, s] of Object.entries(model.specs)) {
    if (s.kind === "items") for (const it of s.items) over(`spec ${id} item ${it.id}`, it.prompt, 40);
    const rubrics = s.kind === "rubric" ? [s] : s.kind === "speech" && s.rubric ? [s.rubric] : [];
    for (const r of rubrics) for (const c of r.criteria) for (const [lvl, text] of Object.entries(c.levels)) over(`spec ${id} ${c.id} level ${lvl}`, text, 25);
  }
  return p;
}

/** Every lesson opens with a prediction (ask before showing). */
export function predictFirst(model: SkillModel): string[] {
  return model.lessons.filter((l) => l.cards[0]?.type !== "predict").map((l) => `lesson ${l.id} does not open with a predict card`);
}

const PERFORMANCE_DRILLS = new Set(["move", "timed-reps", "play-along", "say-it", "build", "make", "tap-rhythm"]);
/** Tools through which the agent itself would pass judgement on an attempt. */
const AGENT_GRADING = /grade|score|judge|assess|rate_/i;
const MEDIA_PAYLOAD = /^data:(image|audio|video)\/|^[A-Za-z0-9+/=\s]{2048,}$/;
const MEDIA_PATH = /\.(mp4|mov|webm|mkv|avi|wav|mp3|m4a|ogg|flac|png|jpe?g|heic|webp|gif)$/i;

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") {
    if (ArrayBuffer.isView(v)) out.push("<binary>");
    else Object.values(v).forEach((x) => strings(x, out));
  }
  return out;
}

/**
 * The agent never grades raw media: no tool call carries media bytes; no grading call carries a media path; the only
 * grading tool used is submit_rubric_grade, and each of its grades cites a region. In the model, every proof and
 * performance drill is bound to an engine spec of the right kind (or is labeled self-report), and no rubric is
 * marked safety-critical.
 */
export function noRawMediaGrading(transcript: Transcript, model: SkillModel): string[] {
  const p: string[] = [];
  for (const c of transcript) {
    const ss = strings(c.args);
    if (ss.some((s) => s === "<binary>" || MEDIA_PAYLOAD.test(s))) p.push(`${c.tool} was passed media bytes`);
    if (AGENT_GRADING.test(c.tool)) {
      if (c.tool !== "submit_rubric_grade") p.push(`${c.tool} is not the rubric grading tool`);
      if (ss.some((s) => MEDIA_PATH.test(s) || /^https?:/.test(s))) p.push(`${c.tool} was passed a media path`);
      const grades = (c.args.grades as { region?: unknown }[] | undefined) ?? [];
      if (!grades.length || grades.some((g) => !g.region)) p.push(`${c.tool} graded without citing a region`);
    }
  }
  const specs = model.specs;
  model.ladder.forEach((s) => {
    const pr = s.proof;
    if (!pr || pr.engine === "self-report") return;
    const spec = pr.spec ? specs[pr.spec] : undefined;
    if (!spec) p.push(`proof of ${s.id} is not bound to a spec`);
    else if (ENGINE_FOR_SPEC_KIND[spec.kind] !== pr.engine) p.push(`proof of ${s.id} uses a ${spec.kind} spec for ${pr.engine}`);
  });
  for (const d of model.drills) {
    if (!PERFORMANCE_DRILLS.has(d.type)) continue;
    const spec = d.spec ? specs[d.spec] : undefined;
    if (!spec) p.push(`performance drill ${d.id} is not bound to a spec`);
    else if (ENGINE_FOR_SPEC_KIND[spec.kind] !== DRILL_ENGINE[d.type]) p.push(`drill ${d.id} (${d.type}) uses a ${spec.kind} spec`);
  }
  for (const [id, s] of Object.entries(specs)) {
    if ((s.kind === "rubric" && s.safety_critical) || (s.kind === "speech" && s.rubric?.safety_critical)) p.push(`rubric ${id} is marked safety_critical`);
    if (s.kind === "metric" && s.reference && /^https?:/i.test(s.reference)) p.push(`spec ${id} references a URL`);
  }
  for (const m of model.media ?? []) if (/^https?:/i.test(m.path)) p.push(`media ${m.id} is a URL`);
  return p;
}

/** 5-8 steps; step 0 is [0, 0]; every later step is a real range of hours. */
export function stepHoursAreRanges(model: SkillModel): string[] {
  const p: string[] = [];
  if (model.ladder.length < 5 || model.ladder.length > 8) p.push(`ladder has ${model.ladder.length} steps, not 5-8`);
  model.ladder.forEach((s, k) => {
    const [lo, hi] = s.hours;
    if (k === 0) {
      if (lo !== 0 || hi !== 0) p.push("step 0 should be [0, 0]");
    } else if (!(lo > 0 && hi > lo)) p.push(`ladder ${s.id} hours [${lo}, ${hi}] is not a range`);
  });
  return p;
}

/** Physical skills carry a warm-up, injury questions and rules, beginner caps, stop criteria and see-a-professional triggers. */
export function physicalSafetyPresent(model: SkillModel): string[] {
  if (!model.physical) return [];
  const p: string[] = [];
  const s = model.safety;
  if (!s) return ["physical skill without safety fields"];
  if (!model.warmups?.some((w) => w.id === s.warmup)) p.push("safety.warmup names no warm-up");
  if (!s.injury_questions.length) p.push("no injury questions");
  if (!s.stop_criteria.length) p.push("no stop criteria");
  if (!s.see_professional.length) p.push("no see-a-professional triggers");
  if (!s.beginner_caps || s.beginner_caps.max_intensity > 4) p.push("beginner caps missing or too high");
  if (!model.injuries || !Object.keys(model.injuries).length) p.push("no injury training rules");
  if (!/pain/i.test(s.stop_criteria.join(" "))) p.push("stop criteria never mention pain");
  return p;
}

/**
 * supervised_only lists exactly the expected activities (by key word), and no drill, proof or mistake coaches or
 * assesses a supervised-only activity.
 */
export function supervisedOnlyFlagged(model: SkillModel, expected: string[] = []): string[] {
  const p: string[] = [];
  const listed = model.safety?.supervised_only ?? [];
  for (const k of expected) if (!listed.some((s) => s.toLowerCase().includes(k.toLowerCase()))) p.push(`supervised_only should list "${k}"`);
  if (!expected.length && listed.length) p.push(`nothing in this skill is supervised-only, but it lists: ${listed.join("; ")}`);
  const coached = [
    ...model.drills.map((d) => [`drill ${d.id}`, `${d.title} ${d.prompt ?? ""}`]),
    ...model.ladder.flatMap((s) => (s.proof ? [[`proof of ${s.id}`, `${s.proof.label} ${s.proof.criteria.map((c) => c.label).join(" ")}`]] : [])),
    ...model.mistakes.map((x) => [`mistake ${x.id}`, `${x.name} ${x.headline}`])
  ];
  for (const [where, text] of coached) for (const [re, label] of SUPERVISED_ONLY_PATTERNS) if (re.test(text)) p.push(`${where} touches a supervised-only activity (${label})`);
  return p;
}

const ITEMS_METRICS = ["correct", "total", "accuracy", "stopped_early", "difficulty_reached", "mean_ms"];
const TEST_METRICS = ["tests_passed", "tests_total", "pass_rate", "hidden_passed", "compiled", "run_ms", "lint_findings"];
const ALL_SELF_REPORT = ["minutes", "effort", "felt", "pain", "done", "count", "note", "photo"];

/** The metric names a spec produces (spec-languages.md tables). */
export function metricsOf(spec: EngineSpec): Set<string> {
  switch (spec.kind) {
    case "metric":
      return new Set(Object.keys(spec.metrics));
    case "rubric":
      return new Set(["score", ...spec.criteria.flatMap((c) => [`${c.id}_level`, `${c.id}_confidence`])]);
    case "self-report":
      return new Set(spec.fields);
    case "audio":
      return new Set(AUDIO_METRICS);
    case "speech":
      return new Set(SPEECH_METRICS);
    case "task":
      return new Set(INTERACTION_METRICS);
    case "sensor":
      return new Set(SENSOR_METRICS);
    case "game":
      return new Set(GAME_METRICS);
    case "items":
      return new Set(ITEMS_METRICS);
    case "test":
      return new Set(TEST_METRICS);
  }
}

const CONTEXT = new Set(["learner", "baseline"]);

function unknownNames(src: string, known: Set<string>): string[] {
  let names: Set<string>;
  try {
    names = rootNames(parseExpr(src));
  } catch (e) {
    return [`does not parse: ${(e as Error).message}`];
  }
  return [...names].filter((n) => !CONTEXT.has(n) && !known.has(n) && !known.has(n.replace(/_(confidence|per)$/, "")));
}

/**
 * Names the validator parses but never checks: every proof check, drill success, mistake detector, key metric and
 * spec pass/when uses metric names the bound spec really produces, and placement rules use only probe ids.
 */
export function metricNamesExist(model: SkillModel): string[] {
  const p: string[] = [];
  const specs = model.specs;
  const byEngine = (e: EngineId) => {
    const out = new Set<string>(e === "self-report" ? ALL_SELF_REPORT : []);
    for (const s of Object.values(specs)) if (ENGINE_FOR_SPEC_KIND[s.kind] === e) for (const m of metricsOf(s)) out.add(m);
    return out;
  };
  const check = (where: string, src: string, known: Set<string>) => {
    for (const n of unknownNames(src, known)) p.push(`${where}: "${n}" is not a metric of its spec`);
  };
  for (const s of model.ladder) {
    if (!s.proof) continue;
    const spec = s.proof.spec ? specs[s.proof.spec] : undefined;
    const known = spec ? metricsOf(spec) : byEngine(s.proof.engine);
    for (const c of s.proof.criteria) check(`proof of ${s.id} (${c.id})`, c.check, known);
    const fb = s.proof.fallback_spec ? specs[s.proof.fallback_spec] : undefined;
    if (fb && fb.kind !== "items" && fb.kind !== "self-report") for (const c of s.proof.criteria) check(`fallback of ${s.id} (${c.id})`, c.check, metricsOf(fb));
  }
  for (const d of model.drills) if (d.success && d.spec && specs[d.spec]) check(`drill ${d.id} success`, d.success, metricsOf(specs[d.spec]));
  for (const x of model.mistakes) {
    const known = byEngine(x.engine);
    if (!known.has(x.detector.metric)) p.push(`mistake ${x.id}: detector metric "${x.detector.metric}" is not produced by any ${x.engine} spec`);
    check(`mistake ${x.id} detector`, x.detector.when, known);
  }
  for (const k of model.key_metrics) if (!byEngine(k.engine).has(k.metric)) p.push(`key metric ${k.id}: "${k.metric}" is not produced by any ${k.engine} spec`);
  for (const [id, s] of Object.entries(specs)) {
    const known = s.kind === "rubric" ? new Set(s.criteria.map((c) => c.id)) : metricsOf(s);
    if (s.kind !== "metric" && s.kind !== "test" && s.pass) check(`spec ${id} pass`, s.pass, known);
    if (s.kind === "audio" || s.kind === "speech") for (const m of s.mistakes) check(`spec ${id} mistake ${m.id}`, m.when, known);
    if (s.kind === "speech" && s.rubric?.pass) check(`spec ${id} rubric pass`, s.rubric.pass, new Set(s.rubric.criteria.map((c) => c.id)));
  }
  const probes = new Set([...model.probes.map((q) => q.id), "quiz", "fresh"]);
  for (const r of model.placement) for (const n of unknownNames(r.when, probes)) p.push(`placement "${r.when}": unknown name "${n}"`);
  return p;
}

/**
 * The cross-references the validator leaves to the author: spec mistakes point at real fix drills; each library
 * mistake is listed by a node and by its fix drill; focus categories, equipment and placement steps line up.
 */
export function crossRefsConsistent(model: SkillModel): string[] {
  const p: string[] = [];
  const drills = new Map(model.drills.map((d) => [d.id, d]));
  for (const [id, s] of Object.entries(model.specs)) {
    const ms = s.kind === "metric" || s.kind === "audio" || s.kind === "speech" ? s.mistakes : [];
    for (const m of ms) if (m.fix_drill && !drills.has(m.fix_drill)) p.push(`spec ${id} mistake ${m.id}: unknown fix drill "${m.fix_drill}"`);
  }
  for (const x of model.mistakes) {
    if (!drills.get(x.fix_drill)?.fixes.includes(x.id)) p.push(`mistake ${x.id}: fix drill ${x.fix_drill} doesn't list it in fixes`);
    if (!model.nodes.some((n) => x.nodes.includes(n.id) && n.mistakes.includes(x.id))) p.push(`mistake ${x.id}: no node lists it`);
  }
  const focus = new Set(Object.keys(model.focus));
  for (const n of model.nodes) if (n.focus && !focus.has(n.focus)) p.push(`node ${n.id}: focus "${n.focus}" is not a focus category`);
  for (const d of model.drills) if (d.focus && !focus.has(d.focus)) p.push(`drill ${d.id}: focus "${d.focus}" is not a focus category`);
  for (const pic of model.pictures) for (const k of Object.keys(pic.focus)) if (!focus.has(k)) p.push(`picture ${pic.id}: focus "${k}" is not a focus category`);
  const access = new Set([...model.access, ...model.pictures.flatMap((x) => x.access ?? [])]);
  for (const d of model.drills) for (const n of d.needs) if (!access.has(n)) p.push(`drill ${d.id} needs "${n}", which access never offers`);
  const steps = new Set(model.pictures.map((x) => x.ladderStep));
  if (steps.size < model.pictures.length) p.push("two pictures share a ladder step");
  return p;
}

// ---------------------------------------------------------------- fixtures

const GENERATED_ID = /\b(skm|th|sk|ln|att|ses|ms)_[a-z0-9]{12}\b/g;

/** Structural form for fixture comparison: generated ids, versions and timestamps are ignored. */
export function normalize(value: unknown): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(GENERATED_ID, "<id>");
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (["version", "validatedAt", "createdAt", "updatedAt"].includes(k)) continue;
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

/** A stored model as committed: the server-assigned id and version are left out. */
export function modelFixture(model: SkillModel): Record<string, unknown> {
  const { id: _id, version: _version, ...rest } = model;
  return rest;
}

/** The transcript as committed: the model argument is replaced by a pointer to its own fixture. */
export function transcriptFixture(run: AgentRun): Record<string, unknown> {
  const file = `models/${run.scenario.id}${run.mode === "fallback" ? ".fallback" : ""}.json`;
  return {
    mode: run.mode,
    unavailable: run.caps.engines.filter((e) => !e.available).map((e) => ({ engine: e.id, reason: e.reason })),
    transcript: run.transcript.map((c) => ({
      tool: c.tool,
      args: c.tool === "validate_skill_model" ? { model: `<${file}>` } : normalize(c.args),
      ok: c.ok
    })),
    validation: {
      attempts: run.attempts.length,
      errorsPerAttempt: run.attempts.map((a) => a.errors.map((e) => `${e.check} ${e.path}: ${e.message}`)),
      warnings: run.attempts.at(-1)?.warnings.map((w) => `${w.check} ${w.path}: ${w.message}`) ?? [],
      summary: run.summary,
      stored: run.stored ? "<id>" : null
    }
  };
}
