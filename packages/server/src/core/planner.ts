/**
 * The session planner (learning loop §2–§3). Deterministic and able to explain itself: every block carries
 * a plain-words reason and the whole decision is written to planner_log so the weights can be tuned later.
 * `decide` is pure (unit-tested); `planSession` gathers the inputs from the store and writes the session.
 */
import { DRILL_ENGINE, ENGINE_FOR_SPEC_KIND, type BlockKind, type Drill, type EngineId, type SessionBlock, type SessionItem, type SessionPlan, type SkillModel } from "@las/schema";
import type { LasContext } from "../context.js";
import { categoryOfNode, clamp, DAY_MS, daysBetween, drillMap, lc1, loadSk, LoopError, mistakeMap, nodeMap, pathNodes, PERFORMANCE_DRILLS, type SkState } from "./common.js";
import { planMix } from "./route.js";
import { loopSettings } from "./settings.js";

/** Score weights (learning loop §3 step 2). Starting values; every decision is logged so they can be tuned. */
export const WEIGHTS = { mastery: 0.35, mistake: 0.25, mix: 0.2, relevance: 0.2 } as const;
/** New material starts once its prerequisites reach 60% mastery (§2 rules). */
export const PREREQ_MASTERY = 0.6;
/** Perform becomes a proof rehearsal once every milestone skill is at 80% (§3 step 5). */
export const PROOF_MASTERY = 0.8;
/** A mistake's weight fades to nothing over 14 days without being seen. */
export const MISTAKE_DECAY_DAYS = 14;
/** One review card takes about 20 seconds. */
export const CARD_SECONDS = 20;
/** Share of a session per block: the middle of each range in §2 (warm-up 10–15%, recall 10–15%, learn 15–20%, practice 35–45%, perform 15–20%, wrap-up ~5%). */
export const SHARES: Record<BlockKind, number> = { warmup: 12.5, recall: 12.5, learn: 17.5, practice: 40, perform: 17.5, wrapup: 5 };
const ORDER: BlockKind[] = ["warmup", "recall", "learn", "practice", "perform", "wrapup"];
/** Mistake states that still count as unresolved. */
export const UNRESOLVED = new Set(["detected", "coached", "improving", "resurfaced"]);

export interface PlannerInput {
  model: SkillModel;
  placement: number;
  milestoneStep: number;
  mastery: Record<string, { p: number; started: boolean }>;
  mistakes: { id: string; state: string; lastSeenAt?: string }[];
  dueReviews: string[];
  mixPlanned: { category: string; share: number }[];
  /** minutes practiced per category over the last 2 weeks */
  minutesByCategory: Record<string, number>;
  /** equipment and places available for this session */
  access: string[];
  intensityCap?: number;
  lastFocus?: string;
  minutes: number;
  short: boolean;
  injuries: string[];
  difficultyOffset: number;
  variation: boolean;
  now: Date;
}

export interface Candidate {
  nodeId: string;
  name: string;
  category: string;
  score: number;
  parts: { mastery: number; mistake: number; mix: number; relevance: number };
  drills: string[];
  topMistake?: string;
}

export interface Decision {
  candidates: Candidate[];
  dropped: { nodeId: string; reason: string }[];
  learn?: string;
  practice: { nodeId: string; drillId: string; difficulty: number }[];
  focus?: string;
  recall: string[];
  perform?: { nodeId?: string; drillId?: string; rehearsal: boolean };
  warmup?: { id: string; title: string; steps: string[] };
  blocks: { kind: BlockKind; minutes: number; reason: string; title: string }[];
  rehearsalReady: boolean;
}

export function drillEngine(model: SkillModel, d: Drill): EngineId {
  const spec = d.spec ? model.specs[d.spec] : undefined;
  return spec ? ENGINE_FOR_SPEC_KIND[spec.kind] : DRILL_ENGINE[d.type];
}

/**
 * Starting difficulty from mastery (§3 step 4): level index = floor(mastery × number of levels),
 * moved by the learner's "too easy / too hard" answer, kept inside the drill's levels.
 */
export function startingDifficulty(d: Drill, mastery: number, offset = 0): number {
  const levels = d.difficulty?.levels.length ?? 1;
  return clamp(Math.floor(mastery * levels) + offset, 0, levels - 1);
}

/**
 * Splits the session's minutes over the blocks present by their shares, at least a minute each,
 * so the blocks always add up to the session length.
 */
export function allocateMinutes(kinds: BlockKind[], minutes: number): Record<BlockKind, number> {
  const out = {} as Record<BlockKind, number>;
  const total = kinds.reduce((t, k) => t + SHARES[k], 0) || 1;
  const exact = Object.fromEntries(kinds.map((k) => [k, (minutes * SHARES[k]) / total])) as Record<BlockKind, number>;
  for (const k of kinds) out[k] = Math.max(1, Math.floor(exact[k]));
  let diff = minutes - kinds.reduce((t, k) => t + out[k], 0);
  // largest remainder first, so each block stays close to its share
  const byRemainder = [...kinds].sort((a, b) => exact[b] - out[b] - (exact[a] - out[a]) || SHARES[b] - SHARES[a]);
  for (let i = 0; diff > 0; i++, diff--) out[byRemainder[i % byRemainder.length]]++;
  while (diff < 0) {
    const big = kinds.filter((k) => out[k] > 1).sort((a, b) => out[b] - exact[b] - (out[a] - exact[a]))[0];
    if (!big) break;
    out[big]--;
    diff++;
  }
  return out;
}

function usable(d: Drill, input: PlannerInput): { ok: boolean; why?: string } {
  if (input.intensityCap !== undefined && d.intensity > input.intensityCap) return { ok: false, why: "too intense for now" };
  const have = new Set(input.access.map((a) => a.toLowerCase()));
  const missing = d.needs.filter((n) => !have.has(n.toLowerCase()));
  if (missing.length) return { ok: false, why: `needs ${missing.join(", ")}` };
  return { ok: true };
}

export function decide(input: PlannerInput): Decision {
  const { model } = input;
  const nodes = nodeMap(model);
  const drills = drillMap(model);
  const mistakes = mistakeMap(model);
  const m = (id: string) => input.mastery[id]?.p ?? nodes.get(id)?.bkt.p_init ?? 0;
  const started = (id: string) => !!input.mastery[id]?.started;
  const path = pathNodes(model, input.placement, input.milestoneStep);
  const required = new Set(model.ladder[input.milestoneStep]?.nodes ?? []);
  const earlier = new Set(model.ladder.slice(input.placement + 1, input.milestoneStep).flatMap((s) => s.nodes));
  const unresolved = input.mistakes.filter((x) => UNRESOLVED.has(x.state) && mistakes.has(x.id));
  const prereqsMet = (id: string) => (nodes.get(id)?.requires ?? []).every((r) => m(r) >= PREREQ_MASTERY);

  // 1. Candidates: route nodes whose prerequisites are met, plus nodes with unresolved mistakes
  const ids = path.filter(prereqsMet);
  for (const x of unresolved) for (const n of mistakes.get(x.id)!.nodes) if (nodes.has(n) && !ids.includes(n)) ids.push(n);

  // mix gap: planned share minus actual share over 2 weeks, normalized so the most under-practiced category is 1
  const planned = new Map(input.mixPlanned.map((x) => [x.category, x.share / 100]));
  const totalMin = Object.values(input.minutesByCategory).reduce((t, v) => t + v, 0);
  const gap = (c: string) => Math.max(0, (planned.get(c) ?? 0) - (totalMin ? (input.minutesByCategory[c] ?? 0) / totalMin : 0));
  const maxGap = Math.max(0, ...[...planned.keys()].map(gap));
  const categoryOf = (id: string) => categoryOfNode(model, id, input.mixPlanned[0]?.category ?? "");

  // 2. Score each candidate
  const scored: Candidate[] = ids.map((id) => {
    const node = nodes.get(id)!;
    let mistakeTerm = 0;
    let topMistake: string | undefined;
    for (const x of unresolved) {
      const mk = mistakes.get(x.id)!;
      if (!mk.nodes.includes(id)) continue;
      const age = x.lastSeenAt ? daysBetween(x.lastSeenAt, input.now) : MISTAKE_DECAY_DAYS;
      const v = (mk.severity / 3) * Math.max(0, 1 - age / MISTAKE_DECAY_DAYS);
      if (v > mistakeTerm) {
        mistakeTerm = v;
        topMistake = mk.id;
      }
    }
    const parts = { mastery: 1 - m(id), mistake: mistakeTerm, mix: maxGap > 0 ? gap(categoryOf(id)) / maxGap : 0, relevance: required.has(id) ? 1 : earlier.has(id) ? 0.5 : 0 };
    const score = WEIGHTS.mastery * parts.mastery + WEIGHTS.mistake * parts.mistake + WEIGHTS.mix * parts.mix + WEIGHTS.relevance * parts.relevance;
    const ok = node.drills.map((d) => drills.get(d)).filter((d): d is Drill => !!d && usable(d, input).ok);
    return { nodeId: id, name: node.name, category: categoryOf(id), score: Math.round(score * 1000) / 1000, parts, drills: ok.map((d) => d.id), topMistake };
  });

  // drop: no usable drill (injury/intensity cap or missing equipment), or the main focus of the last session
  const dropped: Decision["dropped"] = [];
  let kept = scored.filter((c) => {
    if (c.drills.length) return true;
    const why = nodes.get(c.nodeId)!.drills.map((d) => drills.get(d)).filter((d): d is Drill => !!d).map((d) => usable(d, input).why)[0] ?? "no drills";
    dropped.push({ nodeId: c.nodeId, reason: `No drill fits: ${why}` });
    return false;
  });
  if (input.lastFocus && kept.length > 1 && kept.some((c) => c.nodeId === input.lastFocus)) {
    kept = kept.filter((c) => c.nodeId !== input.lastFocus);
    dropped.push({ nodeId: input.lastFocus, reason: "Main focus of your last session" });
  }
  const order = new Map(model.nodes.map((n, i) => [n.id, i]));
  kept.sort((a, b) => b.score - a.score || order.get(a.nodeId)! - order.get(b.nodeId)!);

  // 3. Pick: one new concept (lowest mastery, unstarted, prerequisites met), the top 1–2 to practice
  const learnable = kept.filter((c) => !started(c.nodeId) && prereqsMet(c.nodeId)).sort((a, b) => m(a.nodeId) - m(b.nodeId) || order.get(a.nodeId)! - order.get(b.nodeId)!);
  const learn = input.short ? undefined : learnable[0]?.nodeId;
  // decision: two practice skills when the session is 30 minutes or longer, one otherwise
  const nPractice = input.short ? 1 : input.minutes >= 30 ? 2 : 1;
  const unresolvedIds = new Set(unresolved.map((x) => x.id));
  const pickDrill = (c: Candidate, wantPerformance?: boolean): Drill | undefined => {
    let list = c.drills.map((d) => drills.get(d)!);
    if (wantPerformance !== undefined) list = list.filter((d) => PERFORMANCE_DRILLS.has(d.type) === wantPerformance);
    // fix drills for this node's open mistakes first (close the loop, §2)
    list.sort((a, b) => Number(b.fixes.some((f) => unresolvedIds.has(f))) - Number(a.fixes.some((f) => unresolvedIds.has(f))));
    if (input.variation && list.length > 1) return list[1];
    return list[0];
  };
  const practice = kept.slice(0, nPractice).map((c) => {
    const d = pickDrill(c, false) ?? pickDrill(c)!;
    return { nodeId: c.nodeId, drillId: d.id, difficulty: startingDifficulty(d, m(c.nodeId), input.difficultyOffset) };
  });
  const focus = practice[0]?.nodeId ?? learn;

  // 5. Perform: the practiced skill's performance drill; a proof rehearsal once every milestone skill is at 80%
  const rehearsalReady = path.length > 0 && path.every((id) => m(id) >= PROOF_MASTERY);
  let perform: Decision["perform"];
  if (!input.short) {
    if (rehearsalReady && model.ladder[input.milestoneStep]?.proof) perform = { rehearsal: true };
    else {
      for (const id of [...practice.map((p) => p.nodeId), ...(learn ? [learn] : [])]) {
        const c = kept.find((k) => k.nodeId === id);
        const d = c ? pickDrill(c, true) : undefined;
        if (d) {
          perform = { nodeId: id, drillId: d.id, rehearsal: false };
          break;
        }
      }
    }
  }

  // warm-up: physical skills only, always there when an injury is flagged (§2 table)
  let warmup: Decision["warmup"];
  if (model.physical && model.warmups?.length) {
    const w = model.warmups.find((x) => x.for_injuries?.some((i) => input.injuries.includes(i))) ?? model.warmups.find((x) => x.id === model.safety?.warmup) ?? model.warmups[0];
    if (!input.short || input.injuries.length) warmup = { id: w.id, title: w.title, steps: w.steps };
  }

  const kinds: BlockKind[] = [];
  if (warmup) kinds.push("warmup");
  if (input.dueReviews.length) kinds.push("recall");
  if (learn) kinds.push("learn");
  if (practice.length) kinds.push("practice");
  if (perform) kinds.push("perform");
  if (!input.short) kinds.push("wrapup");
  if (!kinds.length) kinds.push("wrapup");
  const minutes = input.short ? 5 : input.minutes;
  // a short session is recall plus one drill: recall gets 2 minutes (1 with a warm-up), the drill the rest
  const alloc = input.short ? shortAlloc(kinds) : allocateMinutes(kinds, minutes);
  const recall = input.dueReviews.slice(0, Math.max(1, Math.floor(((alloc.recall ?? 0) * 60) / CARD_SECONDS)));

  const name = (id?: string) => (id ? (nodes.get(id)?.name ?? id) : "");
  const top = kept.find((c) => c.nodeId === practice[0]?.nodeId);
  const reasons: Record<BlockKind, string> = {
    warmup: input.injuries.length ? `Your ${input.injuries.map(lc1).join(" and ")} need a warm-up before any load.` : "A warm body learns faster and gets hurt less.",
    recall: `${input.dueReviews.length} card${input.dueReviews.length === 1 ? " is" : "s are"} due: bringing them back now makes them stick.`,
    learn: `${name(learn)} is new, and what it builds on is in place.`,
    practice: top ? practiceReason(top, mistakes) : "",
    perform: perform?.rehearsal ? "Every skill for your milestone is at 80% or more: rehearse the proof." : `One real attempt at ${drills.get(perform?.drillId ?? "")?.title ?? "it"}, analyzed, so you can see what changed.`,
    wrapup: "What changed, and what's next."
  };
  if (!practice.length && !learn) reasons.wrapup = kept.length ? reasons.wrapup : "Nothing on your route fits this place and time. Try another location or a longer session.";
  const titles: Record<BlockKind, string> = {
    warmup: warmup?.title ?? "Warm-up",
    recall: "Recall",
    learn: model.lessons.find((l) => l.id === nodes.get(learn ?? "")?.lesson)?.title ?? name(learn),
    practice: practice.length > 1 ? `${name(practice[0].nodeId)} and ${name(practice[1].nodeId)}` : name(practice[0]?.nodeId) || "Practice",
    perform: perform?.rehearsal ? "Proof rehearsal" : (drills.get(perform?.drillId ?? "")?.title ?? "Perform"),
    wrapup: "Wrap-up"
  };
  const blocks = ORDER.filter((k) => kinds.includes(k)).map((k) => ({ kind: k, minutes: alloc[k], reason: reasons[k], title: titles[k] }));
  return { candidates: kept, dropped, learn, practice, focus, recall, perform, warmup, blocks, rehearsalReady };
}

function shortAlloc(kinds: BlockKind[]): Record<BlockKind, number> {
  const out = {} as Record<BlockKind, number>;
  let left = 5;
  if (kinds.includes("warmup")) {
    out.warmup = 1;
    left -= 1;
  }
  if (kinds.includes("recall")) {
    out.recall = kinds.includes("practice") ? (kinds.includes("warmup") ? 1 : 2) : left;
    left -= out.recall;
  }
  if (kinds.includes("practice")) out.practice = left;
  else if (!kinds.includes("recall")) out[kinds[kinds.length - 1]] = (out[kinds[kinds.length - 1]] ?? 0) + left;
  return out;
}

/** The plain-words reason for the practice pick: the biggest weighted part of its score. */
function practiceReason(c: Candidate, mistakes: ReturnType<typeof mistakeMap>): string {
  const w = { mastery: WEIGHTS.mastery * c.parts.mastery, mistake: WEIGHTS.mistake * c.parts.mistake, mix: WEIGHTS.mix * c.parts.mix, relevance: WEIGHTS.relevance * c.parts.relevance };
  const top = (Object.keys(w) as (keyof typeof w)[]).reduce((a, b) => (w[b] > w[a] ? b : a));
  if (top === "mistake" && c.topMistake) return `Your last attempt showed: ${lc1(mistakes.get(c.topMistake)?.headline || mistakes.get(c.topMistake)?.name || c.topMistake)}.`;
  if (top === "mix" && c.category) return `You've had less ${lc1(c.category)} than planned these two weeks.`;
  if (top === "relevance") return `Your milestone needs ${lc1(c.name)}.`;
  return `${c.name} is the biggest gap between you and your milestone.`;
}

// ---------------------------------------------------------------------------
// I/O: gather inputs, write the session and the log

export interface PlanOptions {
  minutes?: number;
  location?: string;
  short?: boolean;
  now?: Date;
  plannedAt?: string;
  /** re-plan this session in place */
  sessionId?: string;
  /** create a new session even if one is planned */
  fresh?: boolean;
}

/**
 * Where the learner is decides what's possible (§2 rules). Decision: `location` is either a place or a
 * comma-separated list of what's at hand. When it names any equipment or place from the skill model, that
 * list is exactly what's available now; otherwise it's added to what the learner said they have.
 */
export function availableAccess(st: SkState, location?: string): string[] {
  const base = [...st.constraints.access, ...(st.constraints.location ? [st.constraints.location] : [])];
  if (!location?.trim()) return base;
  const items = location.split(",").map((s) => s.trim()).filter(Boolean);
  const known = new Set([...st.model.access, ...st.model.pictures.flatMap((p) => p.access ?? [])].map((s) => s.toLowerCase()));
  return items.some((i) => known.has(i.toLowerCase())) ? items : [...base, ...items];
}

export function intensityCap(ctx: LasContext, st: SkState, now: Date): number | undefined {
  let cap: number | undefined;
  const caps = st.model.safety?.beginner_caps;
  // beginners and anyone with an injury flagged stay under the model's beginner cap (physical skills)
  if (st.model.physical && caps && (st.placement <= 1 || st.constraints.injuries.length)) cap = caps.max_intensity;
  const pain = loopSettings.pain(ctx, st.enrollment.id, now);
  if (pain) cap = Math.min(cap ?? 5, pain.cap);
  if (loopSettings.lighterUntil(ctx, st.enrollment.id, now)) cap = Math.max(1, (cap ?? 5) - 1);
  return cap;
}

export function sessionMinutes(ctx: LasContext, st: SkState, opts: PlanOptions, now: Date): { minutes: number; short: boolean } {
  let minutes = opts.minutes ?? st.constraints.schedule.minutesEach;
  if (opts.short || minutes <= 5) return { minutes: 5, short: true };
  minutes = clamp(Math.round(minutes), 10, 60);
  const caps = st.model.safety?.beginner_caps;
  if (st.model.physical && caps && st.placement <= 1) minutes = Math.min(minutes, caps.max_minutes);
  if (loopSettings.lighterUntil(ctx, st.enrollment.id, now)) minutes = Math.max(10, Math.round((minutes * 0.7) / 5) * 5);
  return { minutes, short: false };
}

function captureHow(d?: Drill): { how?: string; angle?: string; durationS?: number } {
  const c = d?.capture;
  if (!c) return {};
  const parts = [c.guide, c.angle && c.angle !== "any" ? `Camera ${c.angle.replace("-", " at ")}${c.angle === "side-45" ? "°" : ""}` : "", c.distance_m ? `about ${c.distance_m} m back` : ""].filter(Boolean);
  return { how: parts.join(", ") || undefined, angle: c.angle, durationS: c.duration_s };
}

export function planSession(ctx: LasContext, sk: string, opts: PlanOptions = {}): SessionPlan {
  const now = opts.now ?? new Date();
  const st = loadSk(ctx, sk);
  const e = st.enrollment.id;
  const ms = st.milestone;
  if (!ms) throw new LoopError("No active milestone. Set one first (set_milestone, or revisit_why after a milestone is done).");
  const model = st.model;
  const mastery = ctx.store.getMastery(e);
  const { minutes, short } = sessionMinutes(ctx, st, opts, now);
  const sessions = ctx.store.listSessions(e, 200);
  const lastDone = sessions.find((s) => s.status === "done");
  const input: PlannerInput = {
    model,
    placement: st.placement,
    milestoneStep: ms.ladderStep,
    mastery: Object.fromEntries([...mastery].map(([k, v]) => [k, { p: v.pKnown, started: v.started }])),
    mistakes: [...ctx.store.getMistakeStates(e).values()].map((x) => ({ id: x.mistakeId, state: x.state, lastSeenAt: x.lastSeenAt })),
    dueReviews: ctx.store.dueReviews(e, now.toISOString()).map((c) => c.id),
    mixPlanned: planMix(st).mix,
    minutesByCategory: ctx.store.timeSince(e, new Date(now.getTime() - 14 * DAY_MS).toISOString()).byCategory,
    access: availableAccess(st, opts.location),
    intensityCap: intensityCap(ctx, st, now),
    lastFocus: (lastDone?.plan as SessionPlan | undefined)?.focus?.nodeId,
    minutes,
    short,
    injuries: st.constraints.injuries,
    difficultyOffset: loopSettings.difficultyOffset(ctx, e) - (loopSettings.lighterUntil(ctx, e, now) ? 1 : 0),
    variation: loopSettings.variation(ctx, e),
    now
  };
  const d = decide(input);

  // the session row: re-plan a planned session that hasn't started, else create one
  const reuse = opts.sessionId ? ctx.store.getSession(opts.sessionId) : opts.fresh ? undefined : sessions.find((s) => s.status === "planned" && !s.startedAt);
  const row = reuse ?? ctx.store.createSession({ enrollmentId: e, plannedAt: opts.plannedAt ?? now.toISOString(), plan: {}, location: opts.location });
  if (reuse) ctx.store.db.run("DELETE FROM attempt WHERE session_id = ? AND analysis IS NULL", reuse.id);

  const drills = drillMap(model);
  const nodes = nodeMap(model);
  const items: Record<BlockKind, SessionItem[]> = { warmup: [], recall: [], learn: [], practice: [], perform: [], wrapup: [{ type: "wrapup" }] };
  if (d.warmup) items.warmup.push({ type: "warmup", steps: d.warmup.steps });
  if (d.recall.length) items.recall.push({ type: "review", cardIds: d.recall, count: d.recall.length });
  if (d.learn) {
    const n = nodes.get(d.learn)!;
    const lesson = model.lessons.find((l) => l.id === n.lesson);
    // a lesson without cards (fallback content left to the live coach) isn't served on its own
    if (lesson?.cards.length) items.learn.push({ type: "lesson", lessonId: lesson.id, title: lesson.title, cards: lesson.cards, nodes: lesson.nodes.length ? lesson.nodes : [n.id] });
  }
  for (const p of d.practice) {
    const drill = drills.get(p.drillId)!;
    const lv = drill.difficulty?.levels[p.difficulty];
    items.practice.push({ type: "drill", drill, difficulty: p.difficulty, label: lv !== undefined ? `${drill.difficulty!.param}: ${lv}` : drill.title });
  }
  if (d.perform) {
    if (d.perform.rehearsal) {
      const proof = model.ladder[ms.ladderStep].proof!;
      const engine = proof.engine;
      const att = ctx.store.createAttempt({ sessionId: row.id, enrollmentId: e, milestoneId: ms.id, kind: "rehearsal", engine, specId: proof.spec, attemptNo: 1, prompt: proof.label, spec: { capture: proof.capture, criteria: proof.criteria } });
      items.perform.push({ type: "capture", attemptSpecId: att.id, engine, specId: proof.spec ?? "", prompt: (ms.proof as { label?: string })?.label ?? proof.label, how: proof.capture?.guide, kind: "rehearsal", angle: proof.capture?.angle, durationS: proof.capture?.duration_s });
    } else {
      const drill = drills.get(d.perform.drillId!)!;
      const engine = drillEngine(model, drill);
      const h = captureHow(drill);
      const att = ctx.store.createAttempt({ sessionId: row.id, enrollmentId: e, drillId: drill.id, kind: "perform", engine, specId: drill.spec, attemptNo: 1, prompt: drill.prompt ?? drill.title, spec: { capture: drill.capture, how: h.how } });
      items.perform.push({ type: "capture", attemptSpecId: att.id, engine, specId: drill.spec ?? "", prompt: drill.prompt ?? drill.title, how: h.how, drillId: drill.id, kind: "perform", angle: h.angle, durationS: h.durationS });
    }
  }
  const blocks: SessionBlock[] = d.blocks.map((b) => ({ ...b, items: items[b.kind] }));
  if (d.learn && !items.learn.length) {
    const n = nodes.get(d.learn)!;
    const lesson = model.lessons.find((l) => l.id === n.lesson);
    const lb = blocks.find((b) => b.kind === "learn");
    if (lb) lb.lesson = { lessonId: lesson?.id ?? n.lesson, title: lesson?.title ?? n.name, nodes: lesson?.nodes.length ? lesson.nodes : [n.id] };
  }
  const n = sessions.filter((s) => s.status === "done").length + 1;
  const focusName = d.focus ? (nodes.get(d.focus)?.name ?? d.focus) : "Review";
  const plan: SessionPlan = {
    sessionId: row.id,
    sk: e,
    skill: model.name,
    title: `Session ${n}: ${focusName}`,
    minutes: blocks.reduce((t, b) => t + b.minutes, 0),
    focus: { nodeId: d.focus ?? "", name: focusName, reason: blocks.find((b) => b.kind === "practice")?.reason ?? blocks.find((b) => b.kind === "learn")?.reason ?? blocks[0]?.reason ?? "" },
    blocks,
    location: opts.location,
    short: short || undefined,
    status: "planned"
  };
  const state = { difficulty: Object.fromEntries(d.practice.map((p) => [p.drillId, p.difficulty])), run: {}, quiz: {}, blocks: {} };
  ctx.store.updateSession(row.id, { plan, location: opts.location ?? row.location, plannedAt: opts.plannedAt ?? row.plannedAt, summary: { state } });
  ctx.store.logPlanner(row.id, {
    at: now.toISOString(),
    weights: WEIGHTS,
    inputs: { placement: input.placement, milestoneStep: input.milestoneStep, minutes, short, access: input.access, intensityCap: input.intensityCap, lastFocus: input.lastFocus, dueReviews: input.dueReviews.length, mixPlanned: input.mixPlanned, minutesByCategory: input.minutesByCategory, injuries: input.injuries, difficultyOffset: input.difficultyOffset, variation: input.variation },
    candidates: d.candidates,
    dropped: d.dropped,
    picks: { learn: d.learn, practice: d.practice, perform: d.perform, recall: d.recall.length, rehearsalReady: d.rehearsalReady },
    blocks: d.blocks
  });
  return plan;
}

/** The session plan as stored, with its live status. */
export function sessionPlanOf(ctx: LasContext, sessionId: string): SessionPlan {
  const s = ctx.store.getSession(sessionId);
  if (!s) throw new LoopError(`Unknown session "${sessionId}".`);
  return { ...(s.plan as SessionPlan), status: s.status, startedAt: s.startedAt };
}
