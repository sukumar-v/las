/**
 * One live screen from the coach (docs/design/live-coach.md §7 "What coach_show checks"): the same checks
 * `validate_skill_model` runs, applied to one screen, then the screen resolved into the view the studio draws.
 * `checkScreen` has no side effects; `resolveScreen` may create an attempt (capture) or mark a mistake coached
 * (feedback). Nothing here knows a skill: every check reads the skill model and the learner's state.
 */
import {
  checkItemsSpec,
  checkLesson,
  checkSimSpec,
  CoachScreenInputSchema,
  CONFIDENCE_FLOOR,
  countWords,
  DRILL_PROMPT_WORD_BUDGET,
  DrillSchema,
  FEEDBACK_HEADLINE_BUDGET,
  KNOWLEDGE_ITEM_WORD_BUDGET,
  MESSAGE_WORD_BUDGET,
  PLAN_QUESTION_WORD_BUDGET,
  SUPERVISED_ONLY_PATTERNS,
  type BlockKind,
  type CoachMessageView,
  type CoachScreenInput,
  type Drill,
  type FeedbackView,
  type KnowledgeItem,
  type PlanProposalView,
  type ScreenKind,
  type SessionItem,
  type SummaryView
} from "@las/schema";
import type { LasContext } from "../context.js";
import { categoryOfNode, drillMap, nodeMap, type SkState } from "./common.js";
import { buildFeedback, disputedFor, evidenceVisual, floorFor, mistakeHeadline, reRecordReason, whyVisual } from "./feedback.js";
import { availableAccess, drillEngine, intensityCap, startingDifficulty } from "./planner.js";
import { describe as describeCheckin } from "./checkins.js";
import { readiness, milestoneProof } from "./proof.js";
import { drillItems } from "./practice.js";
import { sessionState } from "./sessions.js";

export interface ScreenIssue {
  path: string;
  message: string;
}

export const KNOWLEDGE_DRILL_TYPES = new Set(["choice", "match", "order", "hotspot", "predict-output", "fill"]);
const CARD_TYPES = ["predict", "sim", "mechanism", "diagram", "demo", "compare", "try-it"];
const REPLAN_OPTION_IDS = new Set(["stone", "smaller", "more-time", "later-date", "stretch", "keep", "change-days", "change-minutes", "pause", "resume"]);
/** keys a coach might use to invent a spec or metric live; specs are written at model time only */
const SPEC_KEYS = ["spec", "specs", "metrics", "metric", "detector", "engineSpec"];

/** What the director knows when a screen comes in. */
export interface ScreenContext {
  ctx: LasContext;
  st: SkState;
  liveSessionId: string;
  screenId: string;
  now: Date;
  location?: string;
  /** the block the session is in now */
  block: BlockKind;
  /** the planner's next item (§10) */
  suggestion?: { item: SessionItem; block: BlockKind; index: number };
  /** the wrap-up summary as the server sees it now */
  summary: () => SummaryView;
}

export interface ResolvedScreen {
  kind: ScreenKind;
  block: BlockKind;
  item: SessionItem | CoachMessageView | PlanProposalView;
  input: CoachScreenInput;
  reason?: string;
  replyTo?: string;
  /** the screen is the planner's suggestion (or close enough): no reason needed, and the plan item counts as served */
  matchesSuggestion: boolean;
  /** nodes the screen works on, for the summary */
  nodes: string[];
  /** a knowledge drill with the coach's own items, served by start_drill */
  coachDrill?: { drill: Drill; items: KnowledgeItem[] };
  /** the attempt a feedback screen is about */
  feedbackAttemptId?: string;
}

const words = (s: string | undefined) => (s ? countWords(s) : 0);
const issue = (path: string, message: string): ScreenIssue => ({ path, message });

/** The drill a scaffold id names. */
const drillOf = (st: SkState, id?: string) => (id ? drillMap(st.model).get(id) : undefined);

/** The practice category a drill counts toward. */
function drillCategory(st: SkState, d: Drill): string {
  return d.focus ?? categoryOfNode(st.model, d.nodes[0] ?? "", "");
}

/**
 * Safety for anything the learner will do (§7): nothing above the intensity cap, nothing that conflicts with a
 * flagged injury, nothing that needs equipment the learner doesn't have here, nothing on the supervised-only list.
 * Decision: an injury conflict is a drill in a category the model lowers for injuries (`hard_focus`) at
 * intensity 3 or more while an injury is flagged; the model's own rule for that injury is quoted.
 */
export function safetyIssues(sc: ScreenContext, d: Drill, texts: (string | undefined)[], path = "drillId"): ScreenIssue[] {
  const { st } = sc;
  const out: ScreenIssue[] = [];
  const cap = intensityCap(sc.ctx, st, sc.now);
  if (cap !== undefined && d.intensity > cap) out.push(issue(path, `"${d.id}" is intensity ${d.intensity}; the cap now is ${cap}. Pick an easier drill`));
  const have = new Set(availableAccess(st, sc.location).map((a) => a.toLowerCase()));
  const missing = d.needs.filter((n) => !have.has(n.toLowerCase()));
  if (missing.length) out.push(issue(path, `"${d.id}" needs ${missing.join(", ")}, which the learner doesn't have here`));
  const injuries = st.constraints.injuries;
  if (injuries.length && (st.model.hard_focus ?? []).includes(drillCategory(st, d)) && d.intensity >= 3) {
    const rule = injuries.map((i) => st.model.injuries?.[i]).find(Boolean);
    out.push(issue(path, `"${d.id}" conflicts with the learner's ${injuries.join(", ")}${rule ? `: ${rule}` : ""}`));
  }
  const text = [d.title, d.prompt, ...texts].filter(Boolean).join(" \n ");
  for (const [re, label] of SUPERVISED_ONLY_PATTERNS) if (re.test(text)) out.push(issue(path, `this touches "${label}": LAS teaches the theory but won't coach the practice`));
  for (const s of st.model.safety?.supervised_only ?? []) if (s && text.toLowerCase().includes(s.toLowerCase())) out.push(issue(path, `"${s}" is supervised-only for this skill`));
  return out;
}

/** True when the screen is the planner's suggestion or works on the same thing (§10). */
export function matchesSuggestion(input: CoachScreenInput, sug?: { item: SessionItem }): boolean {
  if (!sug) return true;
  const it = sug.item;
  const overlap = (a: string[] = [], b: string[] = []) => a.some((x) => b.includes(x));
  switch (input.kind) {
    case "lesson":
      return it.type === "lesson" && overlap(input.nodes, it.nodes);
    case "drill":
      return it.type === "drill" && (input.drillId ? input.drillId === it.drill.id : overlap(input.nodes, it.drill.nodes));
    case "capture":
      return it.type === "capture" && (input.drillId ? input.drillId === it.drillId : !!input.milestoneId && it.kind !== "perform");
    case "wrapup":
      return it.type === "wrapup";
    default:
      // feedback, messages and plan proposals answer what just happened; they aren't a pick of the next item
      return true;
  }
}

/** Every check §7 lists, on one screen. No side effects. */
export function checkScreen(sc: ScreenContext, raw: unknown): { ok: boolean; errors: ScreenIssue[]; input?: CoachScreenInput } {
  const errors: ScreenIssue[] = [];
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return { ok: false, errors: [issue("screen", 'a screen is an object with a "kind" (lesson, drill, capture, feedback, message, plan, wrapup), or "suggested"')] };
  // friendly errors for what zod would only call "invalid input"
  if (r.kind === "drill" || r.kind === "capture") {
    for (const k of SPEC_KEYS) if (k in r) errors.push(issue(k, "specs and metrics can't be written live: name a scaffold drill (drillId) whose spec was validated with the skill model"));
    if (r.kind === "drill" && typeof r.type === "string" && !KNOWLEDGE_DRILL_TYPES.has(r.type)) errors.push(issue("type", `a "${r.type}" drill is measured by an engine: name a scaffold drill (drillId) instead of a type`));
  }
  const cardsOf = r.kind === "lesson" ? r.cards : r.kind === "feedback" ? [((r.why as Record<string, unknown> | undefined)?.card)].filter(Boolean) : undefined;
  if (Array.isArray(cardsOf))
    cardsOf.forEach((c, i) => {
      const t = (c as { type?: unknown })?.type;
      if (!CARD_TYPES.includes(String(t))) errors.push(issue(r.kind === "lesson" ? `cards[${i}].type` : "why.card.type", `unknown card type "${String(t)}": use ${CARD_TYPES.join(", ")}`));
    });
  if (errors.length) return { ok: false, errors };
  const parsed = CoachScreenInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => issue(i.path.map((p) => (typeof p === "number" ? `[${p}]` : String(p))).join(".").replace(/\.\[/g, "["), i.message)) };
  const input = parsed.data;
  const { st } = sc;
  const nodes = nodeMap(st.model);
  const unknownNodes = (ns: string[] | undefined, path: string) => (ns ?? []).forEach((n) => !nodes.has(n) && errors.push(issue(path, `unknown node "${n}"`)));
  if (input.kind !== "message" && input.kind !== "plan" && input.kind !== "feedback" && input.reason === undefined && !matchesSuggestion(input, sc.suggestion)) {
    errors.push(issue("reason", `this screen differs from the planner's suggestion (${describeItem(sc.suggestion!.item)}): add a short reason, or show "suggested"`));
  }

  switch (input.kind) {
    case "lesson": {
      unknownNodes(input.nodes, "nodes");
      for (const x of checkLesson({ title: input.title, nodes: input.nodes, cards: input.cards })) errors.push(issue(x.path, x.message));
      input.cards.forEach((c, i) => {
        if (c.type === "sim") for (const x of checkSimSpec(c.sim)) errors.push(issue(`cards[${i}].sim.${x.path}`, x.message));
      });
      break;
    }
    case "drill": {
      const d = drillOf(st, input.drillId);
      if (input.drillId && !d) errors.push(issue("drillId", `"${st.model.name}" has no drill "${input.drillId}"; live screens use the scaffold's drills or a knowledge drill with its own items`));
      if (words(input.prompt) > DRILL_PROMPT_WORD_BUDGET) errors.push(issue("prompt", `${words(input.prompt)} words; a drill prompt has at most ${DRILL_PROMPT_WORD_BUDGET}`));
      if (input.items?.length) {
        const kind = input.type ?? d?.type;
        if (d && !KNOWLEDGE_DRILL_TYPES.has(d.type)) errors.push(issue("items", `"${d.id}" is a ${d.type} drill measured by an engine; only knowledge drills take items`));
        if (!kind || !KNOWLEDGE_DRILL_TYPES.has(kind)) errors.push(issue("type", "a drill with its own items needs a knowledge type: choice, match, order, hotspot, predict-output or fill"));
        if (!d && !input.nodes?.length) errors.push(issue("nodes", "name the nodes this drill practices"));
        unknownNodes(input.nodes, "nodes");
        const ids = new Set<string>();
        input.items.forEach((it, i) => {
          if (ids.has(it.id)) errors.push(issue(`items[${i}].id`, `duplicate item id "${it.id}"`));
          ids.add(it.id);
          const n = countWords(it.prompt) + ("text" in it ? countWords(it.text) : 0);
          if (n > KNOWLEDGE_ITEM_WORD_BUDGET) errors.push(issue(`items[${i}]`, `${n} words; an item has at most ${KNOWLEDGE_ITEM_WORD_BUDGET}`));
        });
        for (const x of checkItemsSpec({ kind: "items", items: input.items, stop_after_wrong: 2 })) if (!x.message.includes("40 words")) errors.push(issue(x.path, x.message));
      } else if (!d) errors.push(issue("drillId", "name a scaffold drill (drillId), or bring a knowledge drill's own items (type, nodes, items)"));
      else {
        if (input.type && input.type !== d.type) errors.push(issue("type", `"${d.id}" is a ${d.type} drill`));
        if (KNOWLEDGE_DRILL_TYPES.has(d.type) && !drillItems(st.model, d)?.items.length) errors.push(issue("items", `"${d.id}" has no pre-written items: bring your own (items)`));
        if (!KNOWLEDGE_DRILL_TYPES.has(d.type) && d.type !== "tap-rhythm" && (!d.spec || !st.model.specs[d.spec])) errors.push(issue("drillId", `"${d.id}" has no validated spec, so it can't be measured live`));
      }
      if (d) {
        const levels = d.difficulty?.levels.length ?? 1;
        if (input.difficulty !== undefined && input.difficulty >= levels) errors.push(issue("difficulty", `"${d.id}" has ${levels} level${levels === 1 ? "" : "s"} (0–${levels - 1})`));
        errors.push(...safetyIssues(sc, d, [input.prompt, input.title]));
      } else {
        const text = [input.title, input.prompt, ...(input.items ?? []).map((i) => i.prompt)].filter(Boolean).join(" \n ");
        for (const [re, label] of SUPERVISED_ONLY_PATTERNS) if (re.test(text)) errors.push(issue("items", `this touches "${label}": LAS teaches the theory but won't coach the practice`));
      }
      break;
    }
    case "capture": {
      if (words(input.prompt) > DRILL_PROMPT_WORD_BUDGET) errors.push(issue("prompt", `${words(input.prompt)} words; at most ${DRILL_PROMPT_WORD_BUDGET}`));
      if (words(input.how) > DRILL_PROMPT_WORD_BUDGET) errors.push(issue("how", `${words(input.how)} words; at most ${DRILL_PROMPT_WORD_BUDGET}`));
      if (input.drillId) {
        const d = drillOf(st, input.drillId);
        if (!d) errors.push(issue("drillId", `"${st.model.name}" has no drill "${input.drillId}"`));
        else {
          if (KNOWLEDGE_DRILL_TYPES.has(d.type)) errors.push(issue("drillId", `"${d.id}" is a knowledge drill: show it as a drill screen`));
          else if (!d.spec || !st.model.specs[d.spec]) errors.push(issue("drillId", `"${d.id}" has no validated spec, so a recording of it can't be measured`));
          errors.push(...safetyIssues(sc, d, [input.prompt, input.how]));
        }
      } else if (input.milestoneId) {
        const m = sc.ctx.store.getMilestone(input.milestoneId);
        if (!m || m.enrollmentId !== st.enrollment.id || m.status === "done") errors.push(issue("milestoneId", "not this learner's active milestone"));
        else if (!milestoneProof(st, m)) errors.push(issue("milestoneId", "this milestone has no proof to record"));
      } else errors.push(issue("drillId", "name the scaffold drill (drillId) or the milestone (milestoneId) to record"));
      break;
    }
    case "feedback": {
      const a = sc.ctx.store.getAttempt(input.attemptId);
      if (!a || a.enrollmentId !== st.enrollment.id) {
        errors.push(issue("attemptId", `unknown attempt "${input.attemptId}" for this learner`));
        break;
      }
      if (!a.analysis) {
        errors.push(issue("attemptId", "not analyzed yet: wait for its attempt.analyzed event"));
        break;
      }
      const an = a.analysis;
      const reRecord = reRecordReason(an, st.model, a.drillId);
      if (reRecord) errors.push(issue("attemptId", `the recording failed its quality check (${reRecord}): that's a re-record, not feedback. Show a capture screen again, or a message`));
      if (words(input.headline) > FEEDBACK_HEADLINE_BUDGET) errors.push(issue("headline", `${words(input.headline)} words; a headline has at most ${FEEDBACK_HEADLINE_BUDGET}`));
      if (words(input.praise) > FEEDBACK_HEADLINE_BUDGET) errors.push(issue("praise", `${words(input.praise)} words; praise has at most ${FEEDBACK_HEADLINE_BUDGET}`));
      const ev = input.evidence;
      let mistakeId: string | undefined;
      if (ev.kind === "mistake") {
        const m = an.mistakes.find((x) => x.id === ev.mistakeId);
        if (!m) errors.push(issue("evidence.mistakeId", `the analysis of ${a.id} has no mistake "${ev.mistakeId}"${an.mistakes.length ? `; it found: ${an.mistakes.map((x) => x.id).join(", ")}` : "; it found none"}`));
        else if (m.confidence < floorFor(st.model, m.id)) errors.push(issue("evidence.mistakeId", `"${m.id}" was seen at confidence ${m.confidence}, below the floor of ${floorFor(st.model, m.id)}: don't coach it`));
        else if (disputedFor(sc.ctx, st.enrollment.id, a.id).has(m.id)) errors.push(issue("evidence.mistakeId", `the learner disputed "${m.id}" on this attempt`));
        else mistakeId = m.id;
      } else if (ev.kind === "marker") {
        if (ev.index >= an.markers.length) errors.push(issue("evidence.index", `the analysis has ${an.markers.length} marker${an.markers.length === 1 ? "" : "s"}`));
      } else {
        const m = an.metrics[ev.metricId];
        if (!m) errors.push(issue("evidence.metricId", `the analysis has no metric "${ev.metricId}"; it has: ${Object.keys(an.metrics).join(", ") || "none"}`));
        else if (m.confidence < CONFIDENCE_FLOOR) errors.push(issue("evidence.metricId", `"${ev.metricId}" was measured at confidence ${m.confidence}, below the floor of ${CONFIDENCE_FLOOR}`));
      }
      if (input.fixDrillId) {
        const fix = drillOf(st, input.fixDrillId);
        const mk = mistakeId ? st.model.mistakes.find((x) => x.id === mistakeId) : undefined;
        if (!fix) errors.push(issue("fixDrillId", `unknown drill "${input.fixDrillId}"`));
        else if (mk && fix.id !== mk.fix_drill && !fix.fixes.includes(mk.id)) errors.push(issue("fixDrillId", `one fix per feedback: "${fix.id}" doesn't fix "${mk.id}" (its fix drill is "${mk.fix_drill}")`));
      }
      if (input.why?.card) for (const x of checkLesson({ title: "why", nodes: [], cards: [input.why.card] })) errors.push(issue(`why.card${x.path.replace(/^cards\[0\]/, "")}`, x.message));
      break;
    }
    case "message": {
      if (words(input.text) > MESSAGE_WORD_BUDGET) errors.push(issue("text", `${words(input.text)} words; a message has at most ${MESSAGE_WORD_BUDGET}`));
      if (input.replyTo && !/^\d+$/.test(input.replyTo)) errors.push(issue("replyTo", "replyTo is the id of the event you answer"));
      else if (input.replyTo && !sc.ctx.store.db.get("SELECT id FROM coach_event WHERE id = ? AND live_session_id = ?", Number(input.replyTo), sc.liveSessionId)) errors.push(issue("replyTo", `no event "${input.replyTo}" in this session`));
      break;
    }
    case "plan": {
      if (words(input.question) > PLAN_QUESTION_WORD_BUDGET) errors.push(issue("question", `${words(input.question)} words; a question has at most ${PLAN_QUESTION_WORD_BUDGET}`));
      const ids = new Set<string>();
      const checkin = input.checkinId ? sc.ctx.store.getCheckin(input.checkinId) : undefined;
      if (input.checkinId && (!checkin || checkin.enrollmentId !== st.enrollment.id || checkin.answeredAt)) errors.push(issue("checkinId", `no open check-in "${input.checkinId}" for this learner`));
      const allowed = checkin ? describeCheckin(st, checkin).options.map((o) => o.id) : [];
      input.options.forEach((o, i) => {
        if (ids.has(o.id)) errors.push(issue(`options[${i}].id`, `duplicate option "${o.id}"`));
        ids.add(o.id);
        const a = o.action;
        if (a.kind === "replan" && !REPLAN_OPTION_IDS.has(a.option.split(":")[0])) errors.push(issue(`options[${i}].action.option`, `"${a.option}" isn't a re-plan option: ${[...REPLAN_OPTION_IDS].join(", ")} (add ":value" for a value)`));
        if (a.kind === "reschedule") {
          if (a.days === undefined && a.minutesPerWeek === undefined && a.targetDate === undefined) errors.push(issue(`options[${i}].action`, "a reschedule option sets days, minutesPerWeek or targetDate"));
          if (a.targetDate !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(a.targetDate)) errors.push(issue(`options[${i}].action.targetDate`, "a date as YYYY-MM-DD"));
          if (a.targetDate !== undefined && !st.milestone) errors.push(issue(`options[${i}].action.targetDate`, "there's no active milestone to move"));
        }
        if (a.kind === "checkin") {
          if (!input.checkinId) errors.push(issue(`options[${i}].action`, "a check-in option needs the screen's checkinId"));
          else if (checkin && !allowed.includes(a.option.split(":")[0])) errors.push(issue(`options[${i}].action.option`, `"${a.option}" isn't an answer to this check-in: ${allowed.join(", ")}`));
        }
      });
      break;
    }
    case "wrapup": {
      if (words(input.praise) > FEEDBACK_HEADLINE_BUDGET) errors.push(issue("praise", `${words(input.praise)} words; at most ${FEEDBACK_HEADLINE_BUDGET}`));
      if (words(input.oneFix) > FEEDBACK_HEADLINE_BUDGET) errors.push(issue("oneFix", `${words(input.oneFix)} words; at most ${FEEDBACK_HEADLINE_BUDGET}`));
      if (words(input.nextNote) > MESSAGE_WORD_BUDGET) errors.push(issue("nextNote", `${words(input.nextNote)} words; at most ${MESSAGE_WORD_BUDGET}`));
      break;
    }
  }
  return { ok: errors.length === 0, errors, input: errors.length ? undefined : input };
}

/** A short description of a session item, for errors and the planner log. */
export function describeItem(it: SessionItem): string {
  switch (it.type) {
    case "lesson":
      return `lesson "${it.title}" on ${it.nodes.join(", ")}`;
    case "drill":
      return `drill "${it.drill.id}"`;
    case "capture":
      return it.drillId ? `capture of "${it.drillId}"` : `${it.kind} capture`;
    case "review":
      return `${it.count} review card${it.count === 1 ? "" : "s"}`;
    default:
      return it.type;
  }
}

const BLOCK_FOR: Partial<Record<ScreenKind, BlockKind>> = { lesson: "learn", drill: "practice", capture: "perform", wrapup: "wrapup", warmup: "warmup", recall: "recall" };

/** Turns a checked screen into what the studio draws. May create an attempt (capture) or mark a mistake coached (feedback). */
export function resolveScreen(sc: ScreenContext, input: CoachScreenInput): ResolvedScreen {
  const { st, ctx } = sc;
  const matches = input.kind !== "message" && input.kind !== "plan" && input.kind !== "feedback" && !!sc.suggestion && matchesSuggestion(input, sc.suggestion);
  const base = { input, reason: "reason" in input ? input.reason : undefined, matchesSuggestion: matches, block: BLOCK_FOR[input.kind as ScreenKind] ?? sc.block };
  switch (input.kind) {
    case "lesson":
      return { ...base, kind: "lesson", item: { type: "lesson", lessonId: `coach.${sc.screenId}`, title: input.title, cards: input.cards, nodes: input.nodes }, nodes: input.nodes };
    case "drill": {
      const d = drillOf(st, input.drillId);
      if (input.items?.length) {
        const drill = DrillSchema.parse({
          id: `coach.${sc.screenId}`.toLowerCase(),
          type: input.type ?? d!.type,
          title: input.title ?? d?.title ?? "Practice",
          prompt: input.prompt ?? d?.prompt,
          nodes: input.nodes?.length ? input.nodes : d!.nodes,
          items: input.items.map((i) => i.id),
          minutes: d?.minutes ?? 3,
          intensity: 1,
          focus: d?.focus
        });
        const items = input.items.map((it) => ({ ...it, nodes: it.nodes.length ? it.nodes : drill.nodes }));
        return { ...base, kind: "drill", item: { type: "drill", drill, difficulty: 0, label: drill.title }, nodes: drill.nodes, coachDrill: { drill, items } };
      }
      const drill = { ...d!, ...(input.prompt ? { prompt: input.prompt } : {}), ...(input.title ? { title: input.title } : {}) };
      const state = sessionState(ctx.store.getSession(sc.liveSessionId)?.summary);
      const mastery = ctx.store.getMastery(st.enrollment.id);
      const m = Math.min(...drill.nodes.map((n) => mastery.get(n)?.pKnown ?? 0));
      const levels = drill.difficulty?.levels.length ?? 1;
      const difficulty = Math.max(0, Math.min(levels - 1, input.difficulty ?? state.difficulty[drill.id] ?? startingDifficulty(drill, m)));
      if (input.difficulty !== undefined) {
        // the coach's level becomes the drill's level in this session (start_drill reads it)
        state.difficulty[drill.id] = difficulty;
        const s = ctx.store.getSession(sc.liveSessionId);
        if (s) ctx.store.updateSession(s.id, { summary: { ...(s.summary ?? {}), state } });
      }
      const lv = drill.difficulty?.levels[difficulty];
      return { ...base, kind: "drill", item: { type: "drill", drill, difficulty, label: lv !== undefined ? `${drill.difficulty!.param}: ${lv}` : drill.title }, nodes: drill.nodes };
    }
    case "capture": {
      if (input.drillId) {
        const d = drillOf(st, input.drillId)!;
        const engine = drillEngine(st.model, d);
        const c = d.capture;
        const how = input.how ?? c?.guide;
        const att = ctx.store.createAttempt({ sessionId: sc.liveSessionId, enrollmentId: st.enrollment.id, drillId: d.id, kind: "perform", engine, specId: d.spec, attemptNo: 1, prompt: input.prompt ?? d.prompt ?? d.title, spec: { capture: c, how } });
        return { ...base, kind: "capture", item: { type: "capture", attemptSpecId: att.id, engine, specId: d.spec ?? "", prompt: input.prompt ?? d.prompt ?? d.title, how, drillId: d.id, kind: "perform", angle: c?.angle, durationS: c?.duration_s }, nodes: d.nodes };
      }
      const m = ctx.store.getMilestone(input.milestoneId!)!;
      const proof = milestoneProof(st, m)!;
      // the real proof once the learner is ready (one continuous take, like run_proof_check); a rehearsal before that
      const kind: "proof" | "rehearsal" = readiness(ctx, st, m).ready ? "proof" : "rehearsal";
      const prompt = input.prompt ?? (m.proof as { label?: string })?.label ?? proof.label;
      const att = ctx.store.createAttempt({ sessionId: sc.liveSessionId, enrollmentId: st.enrollment.id, milestoneId: m.id, kind, engine: proof.engine, specId: proof.spec, attemptNo: 1, prompt, spec: { capture: proof.capture, criteria: proof.criteria, singleTake: kind === "proof" } });
      return { ...base, kind: "capture", item: { type: "capture", attemptSpecId: att.id, engine: proof.engine, specId: proof.spec ?? "", prompt, how: input.how ?? proof.capture?.guide, kind, angle: proof.capture?.angle, durationS: proof.capture?.duration_s }, nodes: st.model.ladder[m.ladderStep]?.nodes ?? [] };
    }
    case "feedback":
      return { ...base, kind: "feedback", item: { type: "feedback", view: coachFeedback(sc, input) }, nodes: [], feedbackAttemptId: input.attemptId };
    case "message":
      return { ...base, kind: "message", block: sc.block, replyTo: input.replyTo, item: { type: "message", screenId: sc.screenId, text: input.text, figure: input.figure, replyTo: input.replyTo, leaving: input.leaving, at: sc.now.toISOString() }, nodes: [] };
    case "plan":
      return { ...base, kind: "plan", block: sc.block, reason: input.reason, item: { type: "plan", screenId: sc.screenId, sk: st.enrollment.id, question: input.question, reason: input.reason, options: input.options.map((o) => ({ id: o.id, label: o.label, detail: o.detail })), checkinId: input.checkinId }, nodes: [] };
    case "wrapup":
      return { ...base, kind: "wrapup", item: { type: "wrapup", summary: wrapupSummary(sc.summary(), input) }, nodes: [] };
  }
}

/** The coach's words over the server's summary. */
export function wrapupSummary(s: SummaryView, input?: { praise?: string; oneFix?: string; nextNote?: string }): SummaryView {
  if (!input) return s;
  return {
    ...s,
    praise: input.praise ?? s.praise,
    oneFix: input.oneFix ? { headline: input.oneFix, mistakeId: s.oneFix?.mistakeId ?? "", fixDrillTitle: s.oneFix?.fixDrillTitle } : s.oneFix,
    nextNote: input.nextNote ?? s.nextNote
  };
}

/** The feedback card built from the analysis (buildFeedback), with the coach's headline, evidence, fix, why and praise. */
function coachFeedback(sc: ScreenContext, input: Extract<CoachScreenInput, { kind: "feedback" }>): FeedbackView {
  const { ctx, st } = sc;
  const base = buildFeedback(ctx, input.attemptId);
  const an = base.analysis;
  const view: FeedbackView = { ...base, headline: input.headline, reRecord: undefined };
  const ev = input.evidence;
  let mistakeId: string | undefined;
  if (ev.kind === "mistake") {
    const m = an.mistakes.find((x) => x.id === ev.mistakeId)!;
    mistakeId = m.id;
    const vis = evidenceVisual(st.model, an, m);
    Object.assign(view, { mistakeId: m.id, severity: m.severity, confidence: m.confidence, evidence: { ref: m.evidence, figure: vis.figure, frame: vis.frame, label: base.mistakeId === m.id ? base.evidence.label : undefined }, why: whyVisual(st.model, m.id) });
    const s = ctx.store.getMistakeStates(st.enrollment.id).get(m.id);
    if (s && (s.state === "detected" || s.state === "resurfaced")) ctx.store.setMistakeState({ ...s, state: "coached" });
  } else if (ev.kind === "marker") {
    const mk = an.markers[ev.index];
    const frame = an.keyFrames.length ? [...an.keyFrames].sort((a, b) => Math.abs(a.t - mk.t) - Math.abs(b.t - mk.t))[0].ref : undefined;
    Object.assign(view, { mistakeId: undefined, severity: undefined, confidence: undefined, evidence: { ref: { kind: "time", t: mk.t }, frame, label: mk.label }, why: undefined });
  } else {
    const m = an.metrics[ev.metricId];
    Object.assign(view, { mistakeId: undefined, severity: undefined, confidence: m.confidence, evidence: { ref: { kind: "none" }, label: `${ev.metricId.replace(/_/g, " ")}: ${Math.round(m.value * 100) / 100}${m.unit ? ` ${m.unit}` : ""}` }, why: undefined });
  }
  const mk = mistakeId ? st.model.mistakes.find((x) => x.id === mistakeId) : undefined;
  const fixId = input.fixDrillId ?? (mistakeId ? mk?.fix_drill : base.fixDrillId);
  const fix = fixId ? drillMap(st.model).get(fixId) : undefined;
  view.fixDrillId = fix?.id;
  view.fixDrillTitle = fix?.title;
  if (input.why) view.why = { figure: input.why.figure, card: input.why.card };
  if (input.praise) view.praise = { headline: input.praise, metric: base.praise?.metric };
  if (!view.headline.trim()) view.headline = mistakeHeadline(mk, mistakeId ?? "");
  return view;
}
