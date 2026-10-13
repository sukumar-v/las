/**
 * Drills and reviews (learning loop §5, DESIGN §9). Knowledge drills are served item by item through the
 * knowledge engine (it gets harder after a right answer and stops after the spec's run of wrong ones);
 * performance drills open a capture. Every drill reports the same outcome shape as a drill.outcome event.
 */
import { DRILL_ENGINE, evalWith, parseExpr, type Drill, type Figure, type ItemsSpec, type KnowledgeItem, type SkillModel } from "@las/schema";
import type { LasContext } from "../context.js";
import { findByDrill, loadSk, LoopError, nodeMap, type SkState } from "./common.js";
import { loadEngines } from "./engines.js";
import { drillEngine, startingDifficulty, CARD_SECONDS } from "./planner.js";
import { handleEvent, sessionState, saveSessionState } from "./sessions.js";
import { coachDrill, liveDrillAnswered } from "./director.js";

const KNOWLEDGE_TYPES = new Set(["choice", "match", "order", "hotspot", "predict-output", "fill"]);

/** The items a knowledge drill draws from: its items spec, or the item ids it lists, narrowed to its nodes when items are tagged. */
export function drillItems(model: SkillModel, drill: Drill): ItemsSpec | undefined {
  const spec = drill.spec ? model.specs[drill.spec] : undefined;
  let base: ItemsSpec | undefined = spec?.kind === "items" ? spec : undefined;
  if (!base && drill.items?.length) {
    const all = Object.values(model.specs).flatMap((s) => (s.kind === "items" ? s.items : []));
    const items = drill.items.map((id) => all.find((it) => it.id === id)).filter((it): it is KnowledgeItem => !!it);
    if (items.length) base = { kind: "items", items, stop_after_wrong: 2 };
  }
  if (!base) return undefined;
  const tagged = base.items.filter((it) => it.nodes.some((n) => drill.nodes.includes(n)));
  return tagged.length ? { ...base, items: tagged } : base;
}

function publicItem(item: KnowledgeItem): Record<string, unknown> {
  const o = { ...(item as Record<string, unknown>) };
  delete o.answer;
  delete o.answers;
  delete o.region;
  return o;
}

export interface DrillStep {
  sk: string;
  drill: Drill;
  kind: "items" | "capture";
  difficulty: number;
  label: string;
  item?: Record<string, unknown>;
  last?: { itemId: string; correct: boolean };
  progress?: { answered: number; correct: number };
  done?: boolean;
  outcome?: Record<string, unknown>;
  attemptId?: string;
  studioPath: string;
}

const quizKey = (sk: string, drillId: string) => `drillquiz.${sk}.${drillId}`;

/**
 * start_drill: knowledge drills serve the next item (with `answer`, grade it first and move on); at the end
 * the drill reports its outcome. Performance drills create an attempt and return a capture.
 */
export async function startDrill(ctx: LasContext, drillId: string, opts: { sk?: string; sessionId?: string; difficulty?: number; answer?: { itemId: string; answer: unknown }; history?: { itemId: string; correct: boolean }[] } = {}, now = new Date()): Promise<DrillStep> {
  const session = opts.sessionId ? ctx.store.getSession(opts.sessionId) : undefined;
  if (opts.sessionId && !session) throw new LoopError(`Unknown session "${opts.sessionId}".`);
  const st: SkState = session ? loadSk(ctx, session.enrollmentId) : findByDrill(ctx, drillId, opts.sk);
  const sk = st.enrollment.id;
  // a live coach's knowledge drill with its own items (docs/design/live-coach.md §7)
  const custom = coachDrill(ctx, session?.id, drillId);
  const drill = st.model.drills.find((d) => d.id === drillId) ?? custom?.drill;
  if (!drill) throw new LoopError(`"${st.model.name}" has no drill "${drillId}".`);
  const mastery = ctx.store.getMastery(sk);
  const m = Math.min(...drill.nodes.map((n) => mastery.get(n)?.pKnown ?? nodeMap(st.model).get(n)?.bkt.p_init ?? 0));
  const state = session ? sessionState(session.summary) : undefined;
  const levels = drill.difficulty?.levels.length ?? 1;
  const difficulty = Math.max(0, Math.min(levels - 1, opts.difficulty ?? state?.difficulty[drill.id] ?? startingDifficulty(drill, m)));
  const lv = drill.difficulty?.levels[difficulty];
  const label = lv !== undefined ? `${drill.difficulty!.param}: ${lv}` : drill.title;
  const items = KNOWLEDGE_TYPES.has(drill.type) ? (custom ? { kind: "items" as const, items: custom.items, stop_after_wrong: 2 } : drillItems(st.model, drill)) : undefined;
  if (items) {
    const eng = await loadEngines();
    let history: { itemId: string; correct: boolean }[] = session ? (state!.quiz[drill.id] ?? []) : ctx.store.getSetting<{ itemId: string; correct: boolean }[]>(quizKey(sk, drill.id), []);
    // the studio may grade on the device and send the history it has
    if (Array.isArray(opts.history)) history = opts.history.filter((h) => h && typeof h.itemId === "string").map((h) => ({ itemId: h.itemId, correct: !!h.correct }));
    let last: DrillStep["last"];
    if (opts.answer) {
      const item = items.items.find((it) => it.id === opts.answer!.itemId);
      if (!item) throw new LoopError(`"${opts.answer.itemId}" isn't an item of this drill.`);
      if (!history.some((h) => h.itemId === item.id)) {
        const g = eng.gradeItem(item, opts.answer.answer);
        last = { itemId: item.id, correct: g.correct };
        history = [...history, last];
      }
    }
    const next = eng.nextItem(items, history);
    const save = (h: typeof history) => {
      if (session) {
        const s = sessionState(ctx.store.getSession(session.id)!.summary);
        s.quiz[drill.id] = h;
        saveSessionState(ctx, session.id, s);
      } else ctx.store.setSetting(quizKey(sk, drill.id), h);
    };
    const correct = history.filter((h) => h.correct).length;
    if (!next && history.length) {
      // the drill is over: report it like the studio would
      const accuracy = correct / history.length;
      let success = accuracy >= 0.7;
      if (drill.success) {
        try {
          const v = evalWith(parseExpr(drill.success), { correct, total: history.length, accuracy });
          if (typeof v === "boolean") success = v;
        } catch {
          /* keep the 70% default: practice aims at 70–85% (§2) */
        }
      }
      save([]);
      const outcome = await handleEvent(ctx, { type: "drill.outcome", sessionId: session?.id, outcome: { drillId: drill.id, nodes: drill.nodes, success, score: accuracy, metrics: { correct, total: history.length, accuracy }, mistakes: [], difficulty } }, now, { lastItem: last });
      return { sk, drill, kind: "items", difficulty, label, last, progress: { answered: history.length, correct }, done: true, outcome, studioPath: `/app/drill/${drill.id}?sk=${sk}` };
    }
    save(history);
    // each answer reaches a live coach as drill.answered; the last one comes with the outcome above
    if (last) liveDrillAnswered(ctx, session?.id, { drillId: drill.id, itemId: last.itemId, correct: last.correct, difficulty, done: false });
    return { sk, drill, kind: "items", difficulty, label, item: next ? publicItem(next) : undefined, last, progress: { answered: history.length, correct }, done: !next, studioPath: `/app/drill/${drill.id}?sk=${sk}` };
  }
  // performance and interaction drills: a capture in the studio
  const engine = drill.spec ? drillEngine(st.model, drill) : DRILL_ENGINE[drill.type];
  const att = ctx.store.createAttempt({ sessionId: session?.id, enrollmentId: sk, drillId: drill.id, kind: "drill", engine, specId: drill.spec, attemptNo: 1, prompt: drill.prompt ?? drill.title, spec: { capture: drill.capture, difficulty, label } });
  return { sk, drill, kind: "capture", difficulty, label, attemptId: att.id, studioPath: `/app/capture/${att.id}` };
}

export interface ReviewCardView {
  cardId: string;
  nodeId: string;
  name: string;
  prompt: string;
  kind: string;
  options?: string[];
  answer?: number | string;
  figure?: Figure;
  dueAt: string;
}

/** review_cards: due FSRS cards with each node's review prompt from the skill model. */
export function reviewCards(ctx: LasContext, sk: string, n = 10, now = new Date()): { sk: string; cards: ReviewCardView[]; due: number; minutes: number } {
  const st = loadSk(ctx, sk);
  const nodes = nodeMap(st.model);
  const due = ctx.store.dueReviews(st.enrollment.id, now.toISOString(), 200);
  const cards = due.slice(0, Math.max(1, Math.min(50, n))).map((c) => {
    const node = nodes.get(c.nodeId);
    const r = node?.review;
    return { cardId: c.id, nodeId: c.nodeId, name: node?.name ?? c.nodeId, prompt: r?.prompt ?? node?.name ?? c.nodeId, kind: r?.kind ?? "recall", options: r?.options, answer: r?.answer, figure: r?.figure, dueAt: c.dueAt };
  });
  return { sk: st.enrollment.id, cards, due: due.length, minutes: Math.ceil((cards.length * CARD_SECONDS) / 60) };
}
