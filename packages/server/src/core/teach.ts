/**
 * Teaching visuals (DESIGN §7, learning loop §4). The tool shapes leave no room for an essay: lessons are
 * 1–5 cards of at most 25 words and are rejected over budget; simulations are declarative (parameters,
 * formulas in the expression language, a figure, a readout), so nothing the agent writes runs as code.
 */
import { checkLesson, checkSimSpec, FigureSchema, LessonSpecSchema, SimSpecSchema, type Card, type Figure, type LessonSpec, type SimSpec } from "@las/schema";
import type { LasContext } from "../context.js";
import { loadSk, LoopError, type SkState } from "./common.js";
import { evidenceVisual, whyVisual } from "./feedback.js";

const firstIssue = (issues: { path: string; message: string }[]) => issues.map((i) => `${i.path}: ${i.message}`);

export function renderLesson(input: unknown): LessonSpec {
  const r = LessonSpecSchema.safeParse(input);
  if (!r.success) throw new LoopError(`Not a lesson spec: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  const issues = checkLesson(r.data);
  if (issues.length) {
    const card = Number(/cards\[(\d+)\]/.exec(issues[0].path)?.[1] ?? 0);
    throw new LoopError(`Rejected: ${firstIssue(issues).join("; ")}. Cut the words or move them into a figure.`, { issues, card: r.data.cards[card] as unknown as Record<string, unknown> });
  }
  return r.data;
}

export function renderSim(input: unknown): SimSpec {
  const r = SimSpecSchema.safeParse(input);
  if (!r.success) throw new LoopError(`Not a sim spec: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  const issues = checkSimSpec(r.data);
  if (issues.length) throw new LoopError(`Rejected: ${firstIssue(issues).join("; ")}. Simulations use parameters, formulas in the expression language and the standard functions only.`, { issues });
  return r.data;
}

export function renderDiagram(input: unknown): Figure {
  const r = FigureSchema.safeParse(input);
  if (!r.success) throw new LoopError(`Not a figure: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Kinds: mermaid, graph, figure, notation, rhythm, code, chart, contour, space, media, mechanism.`);
  return r.data;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/**
 * A mechanism figure, cached per concept because generating one is slow (DESIGN §7). When the agent's
 * anatomy skill (or any figure source) supplies a figure, it is validated and cached; until then the
 * widget draws the named mechanism placeholder from the theme.
 */
export function renderMechanism(ctx: LasContext, concept: string, figure?: unknown): { concept: string; figure: Figure; cached: boolean; source: "cache" | "supplied" | "placeholder" } {
  const key = `mechanism.${slug(concept)}`;
  if (figure !== undefined) {
    const f = renderDiagram(figure);
    ctx.store.setSetting(key, f);
    return { concept, figure: f, cached: true, source: "supplied" };
  }
  const hit = ctx.store.getSetting<Figure | null>(key, null);
  if (hit) return { concept, figure: hit, cached: true, source: "cache" };
  return { concept, figure: { kind: "mechanism", concept: concept.slice(0, 80) }, cached: false, source: "placeholder" };
}

export interface MistakeExplanation {
  sk: string;
  mistakeId: string;
  name: string;
  headline: string;
  why?: { figure?: Figure; card?: Card };
  /** the learner's own frame and the measured evidence when an attempt is given */
  learner?: { attemptId: string; frame?: string; figure?: Figure; label?: string };
  fixDrillId: string;
  fixDrillTitle?: string;
}

/** The mistake's explanation visual, using the learner's own frame when there is one. */
export function explainMistake(ctx: LasContext, mistakeId: string, opts: { attemptId?: string; sk?: string } = {}): MistakeExplanation {
  let st: SkState | undefined;
  const attempt = opts.attemptId ? ctx.store.getAttempt(opts.attemptId) : undefined;
  if (opts.attemptId && !attempt) throw new LoopError(`Unknown attempt "${opts.attemptId}".`);
  if (attempt) st = loadSk(ctx, attempt.enrollmentId);
  else if (opts.sk) st = loadSk(ctx, opts.sk);
  else {
    for (const e of ctx.store.listEnrollments()) {
      const m = ctx.store.getSkillModel(e.skillModelId)?.model;
      if (m?.mistakes.some((x) => x.id === mistakeId)) {
        st = loadSk(ctx, e.id);
        break;
      }
    }
  }
  const mk = st?.model.mistakes.find((x) => x.id === mistakeId);
  if (!st || !mk) throw new LoopError(`No skill model has a mistake "${mistakeId}". Pass sk.`);
  let learner: MistakeExplanation["learner"];
  const am = attempt?.analysis?.mistakes.find((x) => x.id === mistakeId);
  if (attempt?.analysis) {
    const v = evidenceVisual(st.model, attempt.analysis, am);
    learner = { attemptId: attempt.id, frame: v.frame, figure: v.figure, label: am ? undefined : "Not seen in this attempt" };
  }
  return { sk: st.enrollment.id, mistakeId, name: mk.name, headline: mk.headline, why: whyVisual(st.model, mistakeId), learner, fixDrillId: mk.fix_drill, fixDrillTitle: st.model.drills.find((d) => d.id === mk.fix_drill)?.title };
}
