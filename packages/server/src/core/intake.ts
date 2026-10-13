/**
 * Onboarding (DESIGN §5): look → why → picture → level checks → placement → time → around → milestone → plan.
 * Every screen uses the same frame and the standard answer types (§5.2). Options are computed from the
 * learner's own answers by the general rules in rules.ts; all wording and options come from the skill model.
 */
import {
  AnalysisSchema,
  evalWith,
  parseExpr,
  type Analysis,
  type IntakeStep,
  type IntakeView,
  type ItemsSpec,
  type KnowledgeItem,
  type MilestoneSuggestion,
  type OptionView,
  type PlacementView,
  type Probe,
  type RibbonItem,
  type SkillModel,
  type Value
} from "@las/schema";
import type { Intake } from "@las/store";
import type { LasContext } from "../context.js";
import { addWeeks, clamp, isoDay, lc1, LoopError, mean, must, nodesUpTo, weeksTo, scheduleFor, loadSk, placementOf } from "./common.js";
import { loadEngines } from "./engines.js";
import { newCard } from "./fsrs.js";
import { accessOptions, DEADLINES, deadlineWeeks, feasibility, rankPictures, suggestion, suggestMilestones, type DeadlineId, type MilestoneContext } from "./rules.js";
import { planView, routeView } from "./route.js";
import { planSession } from "./planner.js";
import { scheduleCheckins } from "./checkins.js";

export const SECTIONS = ["Look", "Skill", "Why", "Picture it", "Level", "Time", "Milestone", "Plan"];
const SECTION_OF: Record<IntakeStep, number> = { look: 0, skill: 1, why: 2, picture: 3, probe: 4, place: 4, time: 5, around: 5, milestone: 6, plan: 7 };

export interface MilestoneChoice {
  kind: MilestoneSuggestion["kind"];
  step: number;
  title: string;
  proof: string;
}

export interface QuizState {
  history: { itemId: string; correct: boolean }[];
  done: boolean;
  last?: { itemId: string; correct: boolean };
}

export interface Answers {
  look?: string;
  why?: string[];
  picture?: string;
  pictureText?: string;
  /** probe id → answer; null means skipped */
  probes?: Record<string, unknown>;
  quiz?: Record<string, QuizState>;
  /** probe id → attempt id for record/code probes */
  attempts?: Record<string, string>;
  fresh?: boolean;
  adjust?: number;
  placeConfirmed?: boolean;
  minutes?: number;
  deadline?: DeadlineId;
  access?: string[];
  injuries?: string[];
  aroundDone?: boolean;
  milestone?: MilestoneChoice;
  /** revisit_why: why and picture again, then the next milestone, for an existing enrollment */
  revisit?: { sk: string; placement: number };
}

interface StepRef {
  step: IntakeStep;
  probe?: number;
}

function modelOf(ctx: LasContext, intake: Intake): SkillModel {
  return must(ctx.store.getSkillModel(intake.skillModelId)?.model, `The skill model for intake ${intake.id} is missing.`);
}

export function getIntake(ctx: LasContext, intakeId: string): Intake {
  return must(ctx.store.getIntake(intakeId), `Unknown intake "${intakeId}". start_intake creates one.`);
}

const A = (i: Intake) => i.answers as Answers;

function steps(model: SkillModel, a: Answers): StepRef[] {
  const out: StepRef[] = [];
  if (!a.revisit) out.push({ step: "look" });
  out.push({ step: "why" }, { step: "picture" });
  if (!a.revisit) {
    model.probes.forEach((_, i) => out.push({ step: "probe", probe: i }));
    out.push({ step: "place" }, { step: "time" }, { step: "around" });
  }
  out.push({ step: "milestone" }, { step: "plan" });
  return out;
}

function probeDone(a: Answers, p: Probe): boolean {
  if (a.fresh) return true;
  if (p.type === "quiz") return !!a.quiz?.[p.id]?.done || (a.probes ? p.id in a.probes : false);
  return !!a.probes && p.id in a.probes;
}

function isDone(model: SkillModel, intake: Intake, s: StepRef): boolean {
  const a = A(intake);
  switch (s.step) {
    case "look":
      return a.look !== undefined;
    case "why":
      return !!a.why?.length;
    case "picture":
      return !!a.picture || !!a.pictureText?.trim();
    case "probe":
      return probeDone(a, model.probes[s.probe!]);
    case "place":
      return !!a.placeConfirmed;
    case "time":
      return a.minutes !== undefined;
    case "around":
      return !!a.aroundDone;
    case "milestone":
      return !!a.milestone;
    default:
      return !!intake.completedAt;
  }
}

function currentStep(model: SkillModel, intake: Intake): StepRef {
  const all = steps(model, A(intake));
  return all.find((s) => !isDone(model, intake, s)) ?? all[all.length - 1];
}

// ---------------------------------------------------------------------------
// Placement (§5.3 row 3): the model's rules map the evidence to a ladder step; the learner moves it one step at a time

function itemsSpec(model: SkillModel, specId?: string): ItemsSpec | undefined {
  const s = specId ? model.specs[specId] : undefined;
  return s?.kind === "items" ? s : undefined;
}

/** A record/code probe's analysis as plain values the placement rules can read: metrics, pass, ok. */
function analysisValues(an: Analysis): Record<string, Value> {
  const out: Record<string, Value> = { ok: an.quality.ok };
  for (const [k, m] of Object.entries(an.metrics)) out[k] = m.value;
  if (an.criteria.pass !== undefined) out.pass = an.criteria.pass;
  for (const [k, v] of Object.entries(an.criteria)) if (!(k in out)) out[k] = v;
  return out;
}

/** The answers object the placement rules are evaluated over: probe id → value, quiz, tap, fresh. */
export function placementVars(model: SkillModel, a: Answers): Record<string, Value> {
  const vars: Record<string, Value> = { fresh: !!a.fresh };
  for (const p of model.probes) {
    const v = a.probes?.[p.id];
    if (p.type === "quiz") {
      const q = a.quiz?.[p.id];
      const hist = q?.history ?? [];
      const obj = { correct: hist.filter((h) => h.correct).length, answered: hist.length, history: hist.map((h) => ({ itemId: h.itemId, correct: h.correct })) };
      vars[p.id] = obj;
      if (vars.quiz === undefined) vars.quiz = obj;
    } else if (p.type === "tap") {
      if (v && typeof v === "object") {
        vars[p.id] = v as Value;
        if (vars.tap === undefined) vars.tap = v as Value;
      }
    } else if (v !== undefined && v !== null) {
      vars[p.id] = v as Value;
    }
  }
  return vars;
}

export interface Placement {
  raw: number;
  step: number;
  adjusted: number;
  evidence: string[];
}

function probeEvidence(model: SkillModel, a: Answers): string[] {
  const out: string[] = [];
  for (const p of model.probes) {
    const v = a.probes?.[p.id];
    const label = (x: unknown) => p.options?.find((o) => String(o.value) === String(x))?.label ?? String(x);
    if (p.type === "quiz") {
      const h = a.quiz?.[p.id]?.history ?? [];
      if (h.length) out.push(`${h.filter((x) => x.correct).length} of ${h.length} questions right`);
    } else if (v === undefined || v === null) {
      continue;
    } else if (p.type === "single" || p.type === "scale") out.push(label(v));
    else if (p.type === "multi" || p.type === "visual-multi") out.push(Array.isArray(v) && v.length ? v.map(label).join(", ") : "None of these yet");
    else if (p.type === "tap") out.push(`${Math.round((v as { meanAbsMs: number }).meanAbsMs)} ms off the beat`);
    else {
      const o = v as Record<string, unknown>;
      out.push(o.pass === true ? `Passed the ${p.type === "code" ? "code" : "recorded"} check` : `Tried the ${p.type === "code" ? "code" : "recorded"} check`);
    }
  }
  return out;
}

/** Placement rules run in order and the first match wins; a rule that can't be evaluated (a skipped probe) doesn't match. */
export function computePlacement(model: SkillModel, a: Answers): Placement {
  const top = model.ladder.length - 1;
  let raw = 0;
  let ruleEvidence: string | undefined;
  if (!a.fresh) {
    const vars = placementVars(model, a);
    for (const r of model.placement) {
      let hit = false;
      try {
        const v = evalWith(parseExpr(r.when), vars);
        hit = v === true || (typeof v === "number" && v !== 0);
      } catch {
        hit = false;
      }
      if (hit) {
        raw = r.step;
        ruleEvidence = r.evidence;
        break;
      }
    }
  }
  if (a.revisit) raw = a.revisit.placement;
  const step = clamp(raw + (a.adjust ?? 0), 0, Math.max(0, top - 1));
  const evidence = a.revisit ? [`Reached "${model.ladder[raw]?.label}"`] : a.fresh ? ["Starting fresh"] : [...(ruleEvidence ? [ruleEvidence] : []), ...probeEvidence(model, a)];
  const adjusted = step - raw;
  if (adjusted > 0) evidence.push(`You moved it up ${adjusted === 1 ? "a step" : `${adjusted} steps`}`);
  if (adjusted < 0) evidence.push(`You moved it down ${adjusted === -1 ? "a step" : `${-adjusted} steps`}`);
  return { raw, step, adjusted, evidence };
}

function milestoneContext(model: SkillModel, a: Answers): MilestoneContext {
  return {
    model,
    placement: computePlacement(model, a).step,
    minutesPerWeek: a.minutes ?? 180,
    deadlineWeeks: deadlineWeeks(a.deadline),
    why: a.why ?? [],
    picture: model.pictures.find((p) => p.id === a.picture),
    pictureText: a.picture ? undefined : a.pictureText
  };
}

export function placementView(model: SkillModel, a: Answers): PlacementView {
  const p = computePlacement(model, a);
  const top = model.ladder.length - 1;
  const rows: PlacementView["rows"] = [];
  for (let i = Math.min(top, p.step + 2); i >= Math.max(0, p.step - 1); i--) {
    rows.push({ step: i, label: model.ladder[i].label, state: i < p.step ? "done" : i === p.step ? "here" : "ahead", weeks: i > p.step ? weeksTo(model, p.step, i, a.minutes ?? 180) : undefined });
  }
  return { step: p.step, evidence: p.evidence, rows, canLower: p.step > 0, canRaise: p.step < top - 1 };
}

// ---------------------------------------------------------------------------
// Views

const hrs = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10}`;

function whyLabel(model: SkillModel, id: string) {
  return model.why.find((w) => w.id === id)?.label ?? id;
}

/** The answer chips (§5.2): everything answered so far; tapping one re-answers that field. */
function ribbon(model: SkillModel, intake: Intake, cur: StepRef): RibbonItem[] {
  const a = A(intake);
  const sec = SECTION_OF[cur.step];
  const out: RibbonItem[] = [{ id: "skill", label: model.name }];
  if (a.why?.length && sec > 2) out.push({ id: "why", label: whyLabel(model, a.why[0]) + (a.why.length > 1 ? " +1" : ""), icon: model.why.find((w) => w.id === a.why![0])?.icon });
  const pic = model.pictures.find((p) => p.id === a.picture)?.label ?? a.pictureText;
  if (pic && sec > 3) out.push({ id: "picture", label: pic });
  if (!a.revisit && sec > 4 && a.placeConfirmed) out.push({ id: "place", label: `Start: ${model.ladder[computePlacement(model, a).step].label}` });
  if (!a.revisit && sec > 5 && a.minutes !== undefined) {
    const dl = DEADLINES.find((d) => d.id === a.deadline && d.weeks);
    out.push({ id: "time", label: `${hrs(a.minutes)} h/wk${dl ? ` · ${dl.label}` : ""}` });
  }
  if (!a.revisit && sec > 5 && a.aroundDone && (a.access?.length || a.injuries?.length)) out.push({ id: "around", label: [...(a.access ?? []), ...(a.injuries ?? [])].join(", ") });
  if (a.milestone && sec > 6) out.push({ id: "milestone", label: a.milestone.title });
  return out;
}

function stripAnswer(item: KnowledgeItem): Record<string, unknown> {
  const { ...rest } = item as Record<string, unknown>;
  delete rest.answer;
  delete rest.answers;
  delete rest.region;
  return rest;
}

/** The record/code probe's attempt, created on first view so the studio has somewhere to post the analysis. */
function probeAttempt(ctx: LasContext, intake: Intake, model: SkillModel, p: Probe): string {
  const a = A(intake);
  const existing = a.attempts?.[p.id];
  if (existing && ctx.store.getAttempt(existing)) return existing;
  const spec = p.spec ? model.specs[p.spec] : undefined;
  const engine = spec ? ({ metric: "movement", rubric: "visual", test: "code", audio: "audio", speech: "speech", items: "knowledge", task: "interaction", sensor: "sensor", game: "game", "self-report": "self-report" } as const)[spec.kind] : "self-report";
  // decision: the attempt belongs to the intake until set_milestone re-points it to the new enrollment
  const att = ctx.store.createAttempt({ enrollmentId: intake.id, kind: "probe", engine, specId: p.spec, attemptNo: 1, prompt: p.question, spec: { probe: p.id } });
  ctx.store.updateIntake(intake.id, { answers: { ...a, attempts: { ...(a.attempts ?? {}), [p.id]: att.id } } });
  return att.id;
}

export async function intakeView(ctx: LasContext, intakeOrId: Intake | string, at?: IntakeStep): Promise<IntakeView> {
  let intake = typeof intakeOrId === "string" ? getIntake(ctx, intakeOrId) : intakeOrId;
  const model = modelOf(ctx, intake);
  let cur = currentStep(model, intake);
  if (at) cur = steps(model, A(intake)).find((s) => s.step === at) ?? cur;
  const a = A(intake);
  const all = steps(model, a);
  const base = {
    intakeId: intake.id,
    step: cur.step,
    stepIndex: all.findIndex((s) => s.step === cur.step && s.probe === cur.probe),
    sections: a.revisit ? SECTIONS.filter((s) => ["Why", "Picture it", "Milestone", "Plan"].includes(s)) : SECTIONS,
    sectionIndex: SECTION_OF[cur.step],
    ribbon: ribbon(model, intake, cur),
    sk: intake.enrollmentId
  };
  switch (cur.step) {
    case "look":
      return {
        ...base,
        question: "Pick a look",
        sub: "Paste a design prompt, describe it, add a screenshot, or keep it plain.",
        answerType: "single",
        field: "look",
        options: [
          { value: "plain", label: "Keep it plain" },
          { value: "chat", label: "Describe it in the chat", detail: "A prompt, a description, a screenshot or a tokens file" }
        ],
        value: a.look,
        cta: { label: "Continue", enabled: true, secondary: "Skip" }
      };
    case "why": {
      const picked = a.why ?? [];
      return {
        ...base,
        question: a.revisit ? `What's pulling you toward ${model.noun} now?` : `What's pulling you toward ${model.noun}?`,
        sub: "Pick up to two.",
        answerType: "multi",
        max: 2,
        field: "why",
        options: model.why.map((w) => ({ value: w.id, label: w.label, icon: w.icon })),
        value: picked,
        cta: { label: picked.length ? "Continue" : "Pick one or two", enabled: picked.length > 0 }
      };
    }
    case "picture": {
      const because = (a.why ?? []).map((id) => lc1(whyLabel(model, id))).join(" and ");
      return {
        ...base,
        question: "Six months from now, what are you doing?",
        sub: because ? `You're here to ${because}. These fit that best.` : undefined,
        answerType: "single",
        field: "picture",
        options: rankPictures(model, a.why ?? []).map(({ picture, fit }) => ({ value: picture.id, label: picture.label, badge: fit ? "Fits your why" : undefined })),
        value: a.picture ?? a.pictureText,
        payload: { textField: "pictureText", placeholder: "Or say it your way" },
        cta: { label: "Continue", enabled: !!(a.picture || a.pictureText) }
      };
    }
    case "probe": {
      const p = model.probes[cur.probe!];
      const first = cur.probe === 0;
      const payload: Record<string, unknown> = { probeId: p.id, optional: p.optional, spec: p.spec, index: cur.probe, of: model.probes.length };
      let label = "Continue";
      let enabled = true;
      if (p.type === "quiz") {
        const spec = itemsSpec(model, p.spec);
        const q = a.quiz?.[p.id] ?? { history: [], done: false };
        if (spec && !q.done) {
          const eng = await loadEngines();
          const item = eng.nextItem(spec, q.history);
          if (item) payload.item = stripAnswer(item);
          else {
            q.done = true;
            intake = ctx.store.updateIntake(intake.id, { answers: { ...a, quiz: { ...(a.quiz ?? {}), [p.id]: q } } });
          }
        }
        payload.quiz = { answered: q.history.length, correct: q.history.filter((h) => h.correct).length, last: q.last, done: q.done, stopAfterWrong: spec?.stop_after_wrong };
        enabled = q.done;
        label = q.done ? "Continue" : "Answer to continue";
      } else if (p.type === "tap") {
        payload.spec = p.spec ? model.specs[p.spec] : undefined;
        label = a.probes?.[p.id] ? "Continue" : "Skip";
      } else if (p.type === "record" || p.type === "code") {
        payload.attemptId = probeAttempt(ctx, intake, model, p);
        payload.studioPath = `/app/capture/${payload.attemptId}`;
        label = a.probes?.[p.id] ? "Continue" : "Skip";
      } else if (p.type === "multi" || p.type === "visual-multi") {
        const v = a.probes?.[p.id];
        label = Array.isArray(v) && v.length ? "Continue" : "None of these yet";
      } else {
        enabled = a.probes?.[p.id] !== undefined;
      }
      return {
        ...base,
        question: p.question,
        sub: p.sub,
        answerType: p.type,
        field: p.id,
        max: p.max,
        options: p.options?.map((o): OptionView => ({ value: o.value, label: o.label, detail: o.detail, figure: o.figure })),
        value: a.probes?.[p.id],
        payload,
        cta: { label, enabled, secondary: first ? "I'm completely new to this" : p.optional ? "Skip" : undefined }
      };
    }
    case "place":
      return {
        ...base,
        question: "Here's where you start",
        sub: a.fresh ? "Starting from the first step." : "Based on what you just showed us.",
        answerType: "none",
        field: "place",
        payload: { placement: placementView(model, a), actions: [{ value: "too-hard", label: "Too hard" }, { value: "too-easy", label: "Too easy" }] },
        cta: { label: "Looks right", enabled: true, secondary: "Too easy / Too hard" }
      };
    case "time": {
      const minutes = a.minutes ?? 180;
      return {
        ...base,
        question: "How much time can you give it?",
        sub: "A rough guess is fine. You can change it any week.",
        answerType: "slider",
        field: "time",
        options: DEADLINES.map((d) => ({ value: d.id, label: d.label })),
        value: { minutes, deadline: a.deadline ?? "none" },
        payload: { min: 30, max: 600, step: 30, unit: "minutes per week", schedule: scheduleFor(minutes), deadlineField: "deadline" },
        cta: { label: "Continue", enabled: true }
      };
    }
    case "around": {
      const injuries = Object.keys(model.injuries ?? {});
      const any = !!(a.access?.length || a.injuries?.length);
      return {
        ...base,
        question: "Anything we should plan around?",
        sub: "Tap what applies. Skip if nothing does.",
        answerType: "multi",
        field: "around",
        options: accessOptions(model, a.picture).map((x) => ({ value: x, label: x })),
        value: { access: a.access ?? [], injuries: a.injuries ?? [] },
        payload: { access: accessOptions(model, a.picture), injuries: injuries.map((x) => ({ value: x, label: x })), injuryQuestion: injuries.length ? "Anything that hurts?" : undefined },
        cta: { label: any ? "Continue" : "Nothing to add", enabled: true }
      };
    }
    case "milestone": {
      const c = milestoneContext(model, a);
      const sugs = suggestMilestones(c);
      const own = a.milestone && !sugs.some((s) => s.step === a.milestone!.step && s.title === a.milestone!.title) ? [suggestion(c, a.milestone.kind, a.milestone.step, a.milestone.title, a.milestone.proof)] : [];
      const all = [...own, ...sugs];
      const pic = c.picture?.label ?? c.pictureText;
      const ok = !!a.milestone && a.milestone.step > c.placement;
      return {
        ...base,
        question: a.revisit ? "Pick your next milestone" : "Pick your first milestone",
        sub: pic ? `Your ${a.revisit ? "next" : "first"} step toward ${lc1(pic)}.` : "Something you could show us.",
        answerType: "single",
        field: "milestone",
        options: all.map((s) => ({ value: `${s.kind}:${s.step}`, label: s.title, detail: s.proof, badge: s.kindLabel })),
        value: a.milestone ? `${a.milestone.kind}:${a.milestone.step}` : undefined,
        payload: {
          suggestions: all,
          ladder: model.ladder.map((s, i) => (i > c.placement ? { step: i, label: s.label, weeks: weeksTo(model, c.placement, i, c.minutesPerWeek), feasibility: feasibility(c, i) } : { step: i, label: s.label, done: true })),
          placeholder: model.copy?.placeholder ?? "Or say it your way",
          customField: "milestone"
        },
        cta: { label: ok ? "Build my plan" : "Pick a milestone", enabled: ok, secondary: "Show the full ladder" }
      };
    }
    default: {
      const sk = intake.enrollmentId;
      const plan = sk ? planView(ctx, sk) : undefined;
      return {
        ...base,
        question: plan?.milestone.title ?? a.milestone?.title ?? "Your plan",
        answerType: "none",
        payload: plan ? { plan } : { needs: "set_milestone" },
        done: !!intake.completedAt,
        cta: { label: "Start session 1", enabled: !!sk, secondary: "Start over" }
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Answers

/**
 * Re-answering an earlier step invalidates later answers that depend on it (§5.2 "tap one to edit it").
 * Decision: why → milestone (suggestion order changes); picture → milestone and access not offered any more;
 * level (any probe, fresh) → the learner's adjustment, the placement confirmation and the milestone;
 * placement and time → milestone (weeks and feasibility change). "Around" changes only the mix.
 */
function invalidate(model: SkillModel, a: Answers, what: "why" | "picture" | "level" | "place" | "time"): void {
  if (what === "level") {
    a.adjust = 0;
    delete a.placeConfirmed;
  }
  if (what === "picture" && a.access) {
    // drop equipment that only another picture asked for; keep the basics and anything typed in
    const offered = new Set(accessOptions(model, a.picture));
    const pictureOnly = new Set(model.pictures.flatMap((p) => p.access ?? []).filter((x) => !model.access.includes(x)));
    a.access = a.access.filter((x) => offered.has(x) || !pictureOnly.has(x));
  }
  delete a.milestone;
}

function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null || v === "") return [];
  return [v];
}

function resolveMilestone(model: SkillModel, a: Answers, value: unknown): MilestoneChoice {
  const c = milestoneContext(model, a);
  const top = model.ladder.length - 1;
  const sugs = suggestMilestones(c);
  const toChoice = (s: MilestoneSuggestion): MilestoneChoice => ({ kind: s.kind, step: s.step, title: s.title, proof: s.proof });
  if (typeof value === "string") {
    const [kind, stepS] = value.split(":");
    const hit = sugs.find((s) => s.kind === kind && (stepS === undefined || s.step === Number(stepS)));
    if (hit) return toChoice(hit);
    if (kind === "stone" || kind === "ladder") {
      const step = Number(stepS);
      if (Number.isInteger(step)) return toChoice(suggestion(c, kind, clamp(step, 0, top)));
    }
    if (/^\d+$/.test(value)) return toChoice(suggestion(c, "ladder", clamp(Number(value), 0, top)));
    if (value.trim().length > 2) return toChoice(suggestion(c, "custom", Math.min(c.placement + 1, top), value.trim()));
  }
  if (typeof value === "number") return toChoice(suggestion(c, "ladder", clamp(Math.round(value), 0, top)));
  if (value && typeof value === "object") {
    const v = value as { kind?: string; step?: number; title?: string; custom?: string; text?: string; proof?: string };
    const text = v.custom ?? v.text;
    if (text) return toChoice(suggestion(c, "custom", clamp(v.step ?? c.placement + 1, 0, top), text.trim(), v.proof));
    if (v.kind && v.step === undefined) {
      const hit = sugs.find((s) => s.kind === v.kind);
      if (hit) return toChoice(hit);
    }
    if (v.step !== undefined) {
      const hit = sugs.find((s) => s.step === v.step && (!v.kind || s.kind === v.kind));
      if (hit && !v.title) return toChoice(hit);
      return toChoice(suggestion(c, (v.kind as MilestoneSuggestion["kind"]) ?? "ladder", clamp(v.step, 0, top), v.title, v.proof));
    }
  }
  throw new LoopError(`Pick a milestone: one of ${sugs.map((s) => `"${s.kind}:${s.step}"`).join(", ")}, a ladder step number, or your own words.`);
}

export interface AnswerResult {
  intake: Intake;
  view: IntakeView;
  /** extra information for the answer just given (quiz: was it right?) */
  feedback?: Record<string, unknown>;
}

export async function recordAnswer(ctx: LasContext, intakeId: string, field: string, value: unknown): Promise<AnswerResult> {
  const intake = getIntake(ctx, intakeId);
  const model = modelOf(ctx, intake);
  if (intake.completedAt) throw new LoopError("This onboarding is finished. Use replan to change the plan, or revisit_why to set the next milestone.");
  const a: Answers = structuredClone(A(intake));
  let feedback: Record<string, unknown> | undefined;
  const probe = model.probes.find((p) => p.id === field);
  if (probe) {
    feedback = await answerProbe(ctx, intake, model, a, probe, value);
  } else {
    switch (field) {
      case "look":
        a.look = String(value ?? "plain");
        break;
      case "why": {
        const ids = asList(value).map(String);
        const known = new Set(model.why.map((w) => w.id));
        const bad = ids.filter((i) => !known.has(i));
        if (bad.length) throw new LoopError(`Unknown why option(s): ${bad.join(", ")}. Options: ${[...known].join(", ")}.`);
        if (!ids.length) throw new LoopError("Pick at least one reason.");
        if (ids.length > 2) throw new LoopError("Pick up to two reasons.");
        a.why = ids;
        invalidate(model, a, "why");
        break;
      }
      case "picture":
      case "pictureText": {
        const s = typeof value === "object" && value ? String((value as { text?: string }).text ?? "") : String(value ?? "");
        const hit = field === "picture" ? model.pictures.find((p) => p.id === s) : undefined;
        if (hit) {
          a.picture = hit.id;
          delete a.pictureText;
        } else if (s.trim().length > 2) {
          a.pictureText = s.trim().slice(0, 120);
          delete a.picture;
        } else throw new LoopError(`Pick a picture (${model.pictures.map((p) => p.id).join(", ")}) or say it in a few words.`);
        invalidate(model, a, "picture");
        break;
      }
      case "fresh":
        a.fresh = value !== false;
        invalidate(model, a, "level");
        break;
      case "place":
      case "adjust": {
        const v = String(value);
        if (["ok", "confirm", "true", "looks-right"].includes(v)) a.placeConfirmed = true;
        else {
          const delta = ["too-easy", "1", "+1", "up"].includes(v) ? 1 : ["too-hard", "-1", "down"].includes(v) ? -1 : 0;
          if (!delta) throw new LoopError(`Placement answers are "ok", "too-easy" or "too-hard".`);
          a.adjust = (a.adjust ?? 0) + delta;
          // clamp so the next tap moves it from where it is now
          a.adjust = computePlacement(model, a).adjusted;
          delete a.placeConfirmed;
          invalidate(model, a, "place");
        }
        break;
      }
      case "time":
      case "minutes":
      case "deadline": {
        const v = (value && typeof value === "object" ? value : field === "deadline" ? { deadline: value } : { minutes: value }) as { minutes?: unknown; deadline?: unknown };
        if (v.minutes !== undefined) a.minutes = clamp(Math.round(Number(v.minutes) || 180), 30, 600);
        if (v.deadline !== undefined) {
          if (!DEADLINES.some((d) => d.id === v.deadline)) throw new LoopError(`Deadlines are ${DEADLINES.map((d) => d.id).join(", ")}.`);
          a.deadline = v.deadline as DeadlineId;
        }
        a.minutes ??= 180;
        invalidate(model, a, "time");
        break;
      }
      case "around":
      case "access":
      case "injuries": {
        const v = (value && typeof value === "object" && !Array.isArray(value) ? value : field === "injuries" ? { injuries: value } : { access: value }) as { access?: unknown; injuries?: unknown };
        if (v.access !== undefined) a.access = asList(v.access).map(String).slice(0, 20);
        if (v.injuries !== undefined) {
          const known = new Set(Object.keys(model.injuries ?? {}));
          const inj = asList(v.injuries).map(String);
          const bad = inj.filter((i) => !known.has(i));
          if (bad.length) throw new LoopError(`Unknown injury option(s): ${bad.join(", ")}. Options: ${[...known].join(", ") || "none"}.`);
          a.injuries = inj;
        }
        a.aroundDone = true;
        break;
      }
      case "milestone":
        a.milestone = resolveMilestone(model, a, value);
        if (a.milestone.step <= milestoneContext(model, a).placement) throw new LoopError("You're already past this. Pick something higher up the ladder.");
        break;
      default:
        throw new LoopError(`Unknown field "${field}". Fields: look, why, picture, ${model.probes.map((p) => p.id).join(", ")}, fresh, place, time, around, milestone.`);
    }
  }
  const updated = ctx.store.updateIntake(intake.id, { answers: a as Record<string, unknown>, step: currentStep(model, { ...intake, answers: a as Record<string, unknown> }).step });
  // a revisit updates the intent as soon as the why and picture change (revisit_why)
  if (a.revisit && (field === "why" || field === "picture" || field === "pictureText")) {
    const st = loadSk(ctx, a.revisit.sk);
    const afterwards = model.pictures.find((p) => p.id === a.picture)?.label ?? a.pictureText ?? st.intent?.afterwards ?? "";
    ctx.store.setIntent(st.enrollment.id, a.why ?? st.intent?.why ?? [], afterwards, true);
  }
  return { intake: updated, view: await intakeView(ctx, updated), feedback };
}

async function answerProbe(ctx: LasContext, intake: Intake, model: SkillModel, a: Answers, p: Probe, value: unknown): Promise<Record<string, unknown> | undefined> {
  a.probes ??= {};
  a.fresh = false;
  invalidate(model, a, "level");
  if (value === null || value === undefined || value === "skip") {
    a.probes[p.id] = null;
    if (p.type === "quiz") a.quiz = { ...(a.quiz ?? {}), [p.id]: { history: a.quiz?.[p.id]?.history ?? [], done: true } };
    return { skipped: true };
  }
  switch (p.type) {
    case "single":
    case "scale": {
      const opt = p.options?.find((o) => String(o.value) === String(value));
      if (!opt) throw new LoopError(`"${String(value)}" isn't an option. Options: ${p.options?.map((o) => o.value).join(", ")}.`);
      a.probes[p.id] = opt.value;
      return undefined;
    }
    case "multi":
    case "visual-multi": {
      const vals = asList(value);
      const opts = p.options ?? [];
      const picked = vals.map((v) => opts.find((o) => String(o.value) === String(v))).filter((o): o is NonNullable<typeof o> => !!o);
      if (picked.length !== vals.length) throw new LoopError(`Some picks aren't options. Options: ${opts.map((o) => o.value).join(", ")}.`);
      if (p.max && picked.length > p.max) throw new LoopError(`Pick up to ${p.max}.`);
      a.probes[p.id] = picked.map((o) => o.value);
      return undefined;
    }
    case "quiz": {
      const spec = itemsSpec(model, p.spec);
      if (!spec) throw new LoopError(`Probe "${p.id}" has no items spec.`);
      const eng = await loadEngines();
      const q: QuizState = structuredClone(a.quiz?.[p.id] ?? { history: [], done: false });
      if (q.done) throw new LoopError("This check is finished.");
      const answers = (value as { answers?: unknown[] }).answers ?? [value];
      let last: { itemId: string; correct: boolean } | undefined;
      for (const raw of answers) {
        const { itemId, answer } = raw as { itemId?: string; answer?: unknown };
        const item = spec.items.find((it) => it.id === itemId);
        if (!item) throw new LoopError(`Answer with {itemId, answer}; "${String(itemId)}" isn't an item of this check.`);
        if (q.history.some((h) => h.itemId === item.id)) continue;
        const g = eng.gradeItem(item, answer);
        last = { itemId: item.id, correct: g.correct };
        q.history.push(last);
        // the quiz gets harder each question and stops after the model's number of wrong answers (§5.2)
        if (!eng.nextItem(spec, q.history)) {
          q.done = true;
          break;
        }
      }
      q.last = last;
      a.quiz = { ...(a.quiz ?? {}), [p.id]: q };
      a.probes[p.id] = { correct: q.history.filter((h) => h.correct).length, answered: q.history.length };
      if (!q.done) delete a.probes[p.id];
      return { correct: last?.correct, done: q.done };
    }
    case "tap": {
      const offsets = (Array.isArray(value) ? value : ((value as { offsets?: unknown[] }).offsets ?? [])).map(Number).filter(Number.isFinite);
      if (!offsets.length) throw new LoopError("Send the tap offsets in ms, e.g. [12, -30, 8].");
      a.probes[p.id] = { meanAbsMs: Math.round(mean(offsets.map(Math.abs)) * 10) / 10, count: offsets.length, meanMs: Math.round(mean(offsets) * 10) / 10 };
      return { meanAbsMs: (a.probes[p.id] as { meanAbsMs: number }).meanAbsMs };
    }
    default: {
      // record / code: the evaluate flow produced an analysis for this probe's attempt
      const v = value as { attemptId?: string; analysis?: unknown };
      const attemptId = v.attemptId ?? a.attempts?.[p.id] ?? probeAttempt(ctx, intake, model, p);
      let analysis: Analysis | undefined;
      if (v.analysis) {
        const parsed = AnalysisSchema.safeParse(v.analysis);
        if (!parsed.success) throw new LoopError(`That isn't an analysis: ${parsed.error.issues[0]?.message}`);
        analysis = parsed.data;
        ctx.store.setAttemptAnalysis(attemptId, analysis);
      } else analysis = ctx.store.getAttempt(attemptId)?.analysis;
      if (!analysis) throw new LoopError(`Attempt ${attemptId} has no analysis yet. Record it in the studio, or skip this check.`);
      a.attempts = { ...(a.attempts ?? {}), [p.id]: attemptId };
      a.probes[p.id] = analysisValues(analysis);
      return { attemptId, ok: analysis.quality.ok };
    }
  }
}

// ---------------------------------------------------------------------------
// Tools

export async function startIntake(ctx: LasContext, skillModelId: string, opts: { revisitSk?: string } = {}): Promise<{ intake: Intake; view: IntakeView; whyOptions: OptionView[] }> {
  const row = ctx.store.getSkillModel(skillModelId) ?? ctx.store.findSkillModel(skillModelId);
  if (!row) throw new LoopError(`Unknown skill model "${skillModelId}". validate_skill_model stores one and returns its id.`);
  if (!row.validatedAt) throw new LoopError(`Skill model "${row.id}" hasn't passed validation. Fix it with validate_skill_model first.`);
  const learner = ctx.store.getOrCreateLearner();
  let intake = ctx.store.createIntake(learner.id, row.id);
  const answers: Answers = {};
  // the look screen is skipped when the learner already picked a look (theming §2)
  if (ctx.store.activeTheme(learner.id, null)) answers.look = "theme";
  if (opts.revisitSk) {
    const st = loadSk(ctx, opts.revisitSk);
    const prev = (st.intake?.answers ?? {}) as Answers;
    Object.assign(answers, {
      revisit: { sk: st.enrollment.id, placement: placementOf(ctx, st.enrollment.id) },
      minutes: st.constraints.minutesPerWeek,
      deadline: prev.deadline ?? "none",
      access: st.constraints.access,
      injuries: st.constraints.injuries,
      aroundDone: true
    } satisfies Answers);
    intake = ctx.store.updateIntake(intake.id, { answers: answers as Record<string, unknown>, enrollmentId: st.enrollment.id, step: "why" });
  } else intake = ctx.store.updateIntake(intake.id, { answers: answers as Record<string, unknown> });
  const view = await intakeView(ctx, intake);
  return { intake, view, whyOptions: row.model.why.map((w) => ({ value: w.id, label: w.label, icon: w.icon })) };
}

export function placeLearner(ctx: LasContext, intakeId: string): { placement: Placement; view: PlacementView } {
  const intake = getIntake(ctx, intakeId);
  const model = modelOf(ctx, intake);
  const a = A(intake);
  return { placement: computePlacement(model, a), view: placementView(model, a) };
}

export function milestoneSuggestions(ctx: LasContext, intakeId: string): MilestoneSuggestion[] {
  const intake = getIntake(ctx, intakeId);
  return suggestMilestones(milestoneContext(modelOf(ctx, intake), A(intake)));
}

export function checkFeasibility(ctx: LasContext, intakeId: string, milestone: unknown) {
  const intake = getIntake(ctx, intakeId);
  const model = modelOf(ctx, intake);
  const a = A(intake);
  const choice = resolveMilestone(model, a, milestone);
  const c = milestoneContext(model, a);
  const f = feasibility(c, choice.step);
  const weeks = weeksTo(model, c.placement, choice.step, c.minutesPerWeek);
  return {
    milestone: choice,
    verdict: f.label,
    kind: f.kind,
    weeks,
    message: f.message,
    steppingStone: f.stoneStep !== undefined ? { step: f.stoneStep, title: model.ladder[f.stoneStep].label, weeks: weeksTo(model, c.placement, f.stoneStep, c.minutesPerWeek), value: `stone:${f.stoneStep}` } : undefined
  };
}

/**
 * set_milestone: creates the enrollment, intent, constraints, the milestone with its target date, the
 * starting mastery (nodes the placement covers start known), review cards for those nodes, the first
 * session and the check-in schedule. For a revisit it adds the next milestone to the same enrollment.
 */
export async function setMilestone(ctx: LasContext, intakeId: string, milestone?: unknown, now = new Date()) {
  let intake = getIntake(ctx, intakeId);
  const model = modelOf(ctx, intake);
  if (milestone !== undefined) intake = (await recordAnswer(ctx, intakeId, "milestone", milestone)).intake;
  const a = A(intake);
  if (!a.why?.length) throw new LoopError("Answer why first (record_answer field why).");
  if (!a.milestone) throw new LoopError("Pick a milestone first (suggest_milestones lists them).");
  if (intake.completedAt) throw new LoopError("This onboarding already set its milestone.");
  const placement = computePlacement(model, a);
  const choice = a.milestone;
  const minutes = a.minutes ?? 180;
  const c = milestoneContext(model, a);
  const weeks = weeksTo(model, placement.step, choice.step, minutes);
  const feas = feasibility(c, choice.step);
  const afterwards = model.pictures.find((p) => p.id === a.picture)?.label ?? a.pictureText ?? "";
  const learner = ctx.store.getOrCreateLearner();
  let sk: string;
  if (a.revisit) {
    sk = a.revisit.sk;
    ctx.store.setIntent(sk, a.why, afterwards, true);
    ctx.store.setEnrollmentStatus(sk, "active");
  } else {
    const e = ctx.store.createEnrollment(learner.id, intake.skillModelId);
    sk = e.id;
    ctx.store.setIntent(sk, a.why, afterwards, false);
    const dw = deadlineWeeks(a.deadline);
    ctx.store.setConstraints({
      enrollmentId: sk,
      minutesPerWeek: minutes,
      deadline: dw ? isoDay(addWeeks(now, dw)) : undefined,
      access: a.access ?? [],
      injuries: a.injuries ?? [],
      schedule: { ...scheduleFor(minutes), window: { start: 18, end: 21 } }
    });
    // starting mastery: nodes of ladder steps up to the placement start known (0.85, started); others at the node's p_init
    const known = new Set(nodesUpTo(model, placement.step));
    for (const n of model.nodes) {
      if (known.has(n.id)) {
        ctx.store.setMastery(sk, n.id, 0.85, 0, true);
        const card = newCard(now);
        ctx.store.upsertReviewCard({ enrollmentId: sk, nodeId: n.id, fsrs: card.state, dueAt: card.dueAt });
      } else ctx.store.setMastery(sk, n.id, n.bkt.p_init, 0, false);
    }
    // probe attempts belonged to the intake; they belong to the enrollment now
    ctx.store.db.run("UPDATE attempt SET enrollment_id = ? WHERE enrollment_id = ?", sk, intake.id);
  }
  const proof = model.ladder[choice.step]?.proof;
  const ms = ctx.store.addMilestone({
    enrollmentId: sk,
    title: choice.title,
    ladderStep: choice.step,
    proof: { ...(proof ?? { engine: "self-report", criteria: [{ id: "done", label: choice.title, check: "done" }] }), label: choice.proof },
    targetDate: isoDay(addWeeks(now, weeks)),
    kind: choice.kind,
    estimateWeeks: weeks,
    feasibility: feas.label
  });
  intake = ctx.store.updateIntake(intake.id, { placement: { step: placement.step, evidence: placement.evidence, raw: placement.raw, adjusted: placement.adjusted }, enrollmentId: sk, completedAt: now.toISOString(), step: "plan" });
  ctx.store.logPlanChange(sk, a.revisit ? "next milestone" : "onboarding", `milestone:${choice.kind}:${choice.step}`);
  const firstSession = planSession(ctx, sk, { now, plannedAt: now.toISOString() });
  scheduleCheckins(ctx, sk, now);
  const st = loadSk(ctx, sk);
  return { sk, milestoneId: ms.id, route: routeView(ctx, st), firstSession, plan: planView(ctx, sk), view: await intakeView(ctx, intake) };
}

/** placement.adjusted from the studio: the same as tapping too easy / too hard. */
export async function adjustPlacement(ctx: LasContext, intakeId: string, delta: 1 | -1) {
  return recordAnswer(ctx, intakeId, "place", delta > 0 ? "too-easy" : "too-hard");
}

/** For tests and routes: how many probes, which step is current. */
export function currentStepOf(ctx: LasContext, intakeId: string): IntakeStep {
  const intake = getIntake(ctx, intakeId);
  return currentStep(modelOf(ctx, intake), intake).step;
}
