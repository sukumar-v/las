import { z } from "zod";
import { countWords } from "../words.js";

/** Knowledge engine: items generated from the skill model. Standard answer types only. */
export const KnowledgeItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), id: z.string(), prompt: z.string().max(200), options: z.array(z.string().max(80)).min(2).max(6), answer: z.number().int().min(0), code: z.string().optional(), audio: z.string().optional(), difficulty: z.number().int().min(1).max(5).default(1), nodes: z.array(z.string()).default([]) }),
  z.object({ type: z.literal("match"), id: z.string(), prompt: z.string().max(200), pairs: z.array(z.tuple([z.string().max(60), z.string().max(60)])).min(2).max(8), difficulty: z.number().int().min(1).max(5).default(1), nodes: z.array(z.string()).default([]) }),
  z.object({ type: z.literal("order"), id: z.string(), prompt: z.string().max(200), items: z.array(z.string().max(60)).min(2).max(8), difficulty: z.number().int().min(1).max(5).default(1), nodes: z.array(z.string()).default([]) }),
  z.object({ type: z.literal("fill"), id: z.string(), prompt: z.string().max(200), text: z.string().max(400), answers: z.array(z.string().max(60)).min(1), hints: z.array(z.string().max(60)).default([]), difficulty: z.number().int().min(1).max(5).default(1), nodes: z.array(z.string()).default([]) }),
  z.object({ type: z.literal("hotspot"), id: z.string(), prompt: z.string().max(200), figure: z.string(), region: z.object({ x: z.number(), y: z.number(), r: z.number() }), difficulty: z.number().int().min(1).max(5).default(1), nodes: z.array(z.string()).default([]) }),
  z.object({ type: z.literal("predict-output"), id: z.string(), prompt: z.string().max(200), code: z.string().max(1200), language: z.string(), options: z.array(z.string().max(80)).min(2).max(6), answer: z.number().int().min(0), difficulty: z.number().int().min(1).max(5).default(1), nodes: z.array(z.string()).default([]) })
]);
export type KnowledgeItem = z.infer<typeof KnowledgeItemSchema>;

export const ItemsSpecSchema = z.object({
  kind: z.literal("items").default("items"),
  items: z.array(KnowledgeItemSchema).min(1),
  /** stop after this many wrong answers in a row (placement quizzes use 2) */
  stop_after_wrong: z.number().int().min(1).max(5).default(2),
  pass: z.string().optional()
});
export type ItemsSpec = z.infer<typeof ItemsSpecSchema>;

export function checkItemsSpec(spec: ItemsSpec): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  spec.items.forEach((it, i) => {
    if (countWords(it.prompt) > 40) issues.push({ path: `items[${i}].prompt`, message: "prompts are 40 words or fewer" });
    if ((it.type === "choice" || it.type === "predict-output") && it.answer >= it.options.length) issues.push({ path: `items[${i}].answer`, message: "answer index out of range" });
  });
  return issues;
}

/** Interaction engine: a task the learner does in the studio with keys or clicks. */
export const TaskSpecSchema = z.object({
  kind: z.literal("task").default("task"),
  task: z.enum(["type-text", "shortcuts", "mental-math", "click-targets", "sequence"]),
  /** the text to type, the shortcuts to press, the problems to answer, etc. */
  content: z.array(z.string().max(400)).min(1).max(100),
  duration_s: z.number().min(5).max(600).optional(),
  pass: z.string().optional()
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;
export const INTERACTION_METRICS = ["wpm", "accuracy", "consistency", "mean_ms", "errors", "completed"] as const;

/** Sensor engine: what to detect from the phone's motion sensors. */
export const SensorSpecSchema = z.object({
  kind: z.literal("sensor").default("sensor"),
  detect: z.enum(["cadence", "swing-tempo", "steadiness", "step-count", "impact"]),
  placement: z.enum(["pocket", "hand", "wrist", "strapped", "on-object"]).default("pocket"),
  duration_s: z.number().min(5).max(600).default(30),
  target: z.record(z.string(), z.number()).optional(),
  pass: z.string().optional()
});
export type SensorSpec = z.infer<typeof SensorSpecSchema>;
export const SENSOR_METRICS = ["cadence_spm", "tempo_ratio", "backswing_ms", "downswing_ms", "steadiness", "steps", "peak_g"] as const;

/** Game engine: rules plus an optional external engine spoken to over a standard protocol. */
export const GameSpecSchema = z.object({
  kind: z.literal("game").default("game"),
  game: z.enum(["chess", "go", "other"]),
  /** a position to start from (FEN for chess, SGF for go) */
  position: z.string().optional(),
  /** moves to analyze (SAN/UCI for chess) */
  moves: z.array(z.string()).optional(),
  /** which side the learner plays */
  side: z.enum(["white", "black", "both"]).default("both"),
  /** external engine protocol; the engine is optional and always has a fallback */
  engine: z.enum(["uci", "gtp", "none"]).default("none"),
  depth: z.number().int().min(1).max(30).default(12),
  /** tactics items used as the fallback when no engine is installed */
  fallback_items: z.array(z.object({ position: z.string(), best: z.string(), prompt: z.string().max(120) })).optional(),
  pass: z.string().optional()
});
export type GameSpec = z.infer<typeof GameSpecSchema>;
export const GAME_METRICS = ["agreement", "blunders", "mistakes", "inaccuracies", "mean_eval_loss_cp", "legal_moves", "puzzles_solved", "puzzles_total"] as const;

/** Self-report: always available, labeled as such. */
export const SelfReportSpecSchema = z.object({
  kind: z.literal("self-report").default("self-report"),
  fields: z.array(z.enum(["minutes", "effort", "felt", "pain", "done", "count", "note", "photo"])).min(1).default(["minutes", "effort", "felt"]),
  /** what counts as done for a self-reported proof, in the learner's words */
  criterion: z.string().max(200).optional(),
  pass: z.string().optional()
});
export type SelfReportSpec = z.infer<typeof SelfReportSpecSchema>;
