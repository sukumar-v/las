import { z } from "zod";
import { SimSpecSchema } from "./specs/sim.js";
import { CARD_WORD_BUDGET, countWords } from "./words.js";

/** Figures a card can show. All are drawn from the theme; none carry style. */
export const FigureSchema = z.discriminatedUnion("kind", [
  /** a named mechanism figure (anatomy skill when present, else a diagram) */
  z.object({ kind: z.literal("mechanism"), concept: z.string().max(80) }),
  z.object({ kind: z.literal("mermaid"), source: z.string().max(4000) }),
  /** declarative diagram: nodes and edges */
  z.object({ kind: z.literal("graph"), nodes: z.array(z.object({ id: z.string(), label: z.string().max(40) })).max(24), edges: z.array(z.tuple([z.string(), z.string()])).max(48), direction: z.enum(["LR", "TB"]).default("LR") }),
  /** a stick figure or linkage with named points in 0..100 coordinates */
  z.object({ kind: z.literal("figure"), points: z.record(z.string(), z.tuple([z.number(), z.number()])), segments: z.array(z.tuple([z.string(), z.string()])), marks: z.array(z.object({ at: z.string(), label: z.string().max(20), role: z.enum(["good", "attention", "reference", "neutral"]).default("neutral") })).default([]) }),
  /** music notation in ABC */
  z.object({ kind: z.literal("notation"), abc: z.string().max(4000) }),
  /** a rhythm/strum grid: one char per subdivision, e.g. "D_DU_UDU" */
  z.object({ kind: z.literal("rhythm"), pattern: z.string().max(64), subdivisions: z.number().int().min(2).max(32).default(8), highlight: z.array(z.number().int()).default([]) }),
  /** code with an optional execution trace */
  z.object({ kind: z.literal("code"), language: z.string(), source: z.string().max(2000), trace: z.array(z.object({ line: z.number().int(), vars: z.record(z.string(), z.string()) })).max(40).optional() }),
  /** a chart of values */
  z.object({ kind: z.literal("chart"), type: z.enum(["bar", "line", "dots"]), series: z.array(z.object({ label: z.string().max(30), values: z.array(z.number()).max(64) })).min(1).max(5), labels: z.array(z.string().max(16)).optional() }),
  /** a media file the learner supplied (never fetched from the web) */
  z.object({ kind: z.literal("media"), ref: z.string(), type: z.enum(["video", "audio", "image"]), ghost: z.boolean().default(false) }),
  /** a pitch/tone contour sketch: list of relative pitches over time */
  z.object({ kind: z.literal("contour"), values: z.array(z.number()).min(2).max(64), label: z.string().max(30).optional() }),
  /** a simple vowel/articulation chart point: position in a 2D space */
  z.object({ kind: z.literal("space"), axes: z.tuple([z.string().max(20), z.string().max(20)]), points: z.array(z.object({ label: z.string().max(12), x: z.number().min(0).max(1), y: z.number().min(0).max(1), role: z.enum(["good", "attention", "reference", "neutral"]).default("neutral") })).max(12) })
]);
export type Figure = z.infer<typeof FigureSchema>;

const text = z.string().max(240);

export const CardSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("predict"), text, options: z.array(z.string().max(60)).min(2).max(4), answer: z.number().int().min(0), figure: FigureSchema.optional(), figures: z.array(FigureSchema).max(4).optional(), reveal: z.string().max(120).optional() }),
  z.object({ type: z.literal("sim"), text, sim: SimSpecSchema }),
  z.object({ type: z.literal("mechanism"), text, concept: z.string().max(80), figure: FigureSchema.optional() }),
  z.object({ type: z.literal("diagram"), text, figure: FigureSchema }),
  z.object({ type: z.literal("demo"), text, figure: FigureSchema, playback: z.enum(["steps", "loop", "once"]).default("steps") }),
  z.object({ type: z.literal("compare"), text, left: FigureSchema, right: FigureSchema, leftLabel: z.string().max(20).optional(), rightLabel: z.string().max(20).optional(), hotspot: z.string().max(30).optional(), answer: z.enum(["left", "right"]).optional() }),
  z.object({ type: z.literal("try-it"), text, action: z.enum(["tap-rhythm", "say-it", "hold-pose", "type-it", "count"]), pattern: z.string().max(64).optional(), target: z.string().max(120).optional(), seconds: z.number().int().min(1).max(60).optional() })
]);
export type Card = z.infer<typeof CardSchema>;

export const LessonSpecSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-_.]*$/).optional(),
  title: z.string().max(60),
  nodes: z.array(z.string()).default([]),
  cards: z.array(CardSchema).min(1).max(5)
});
export type LessonSpec = z.infer<typeof LessonSpecSchema>;
export type LessonSpecInput = z.input<typeof LessonSpecSchema>;

/** Every card stays within the word budget. Figures don't count; option labels and reveals do. */
export function checkLesson(lesson: LessonSpec): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  lesson.cards.forEach((c, i) => {
    let words = countWords(c.text);
    if (c.type === "predict") {
      words += c.options.reduce((t, o) => t + countWords(o), 0);
      if (c.reveal) words += countWords(c.reveal);
      if (c.answer >= c.options.length) issues.push({ path: `cards[${i}].answer`, message: "answer index out of range" });
    }
    if (c.type === "sim" && c.sim.prompt) words += countWords(c.sim.prompt);
    if (words > CARD_WORD_BUDGET) issues.push({ path: `cards[${i}]`, message: `${words} words; a card has at most ${CARD_WORD_BUDGET}` });
  });
  if (lesson.cards[0] && lesson.cards[0].type !== "predict") issues.push({ path: "cards[0]", message: "warning: the first card should be a prediction when possible" });
  return issues.filter((i) => !i.message.startsWith("warning"));
}
