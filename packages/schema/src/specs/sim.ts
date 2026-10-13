import { z } from "zod";
import { calledFunctions, rootNames } from "../expr/ast.js";
import { parseExpr } from "../expr/parser.js";
import { STANDARD_FUNCTION_NAMES } from "../expr/evaluate.js";
import { countWords } from "../words.js";

/**
 * A simulation is declarative: parameters with ranges, formulas in the expression
 * language, a figure and a live readout. Nothing the agent writes runs as code.
 */
export const SimParamSchema = z.object({
  label: z.string().max(30),
  min: z.number(),
  max: z.number(),
  step: z.number().positive().optional(),
  default: z.number().optional(),
  unit: z.string().max(12).optional()
});

export const SimFigureSchema = z.discriminatedUnion("kind", [
  /** y = f(x) plot over a parameter's range; `series` are formula names, `x` a parameter name */
  z.object({ kind: z.literal("plot"), x: z.string(), series: z.array(z.string()).min(1).max(4), marker: z.string().optional() }),
  /** bars from formulas or params */
  z.object({ kind: z.literal("bars"), values: z.array(z.string()).min(1).max(8) }),
  /** a dial/gauge of one formula value with a range */
  z.object({ kind: z.literal("gauge"), value: z.string(), min: z.number(), max: z.number(), good: z.tuple([z.number(), z.number()]).optional() }),
  /** a stick figure/linkage: named points placed by formulas (x,y in 0..100) and segments between them */
  z.object({
    kind: z.literal("linkage"),
    points: z.record(z.string(), z.tuple([z.string(), z.string()])),
    segments: z.array(z.tuple([z.string(), z.string()])),
    labels: z.record(z.string(), z.string()).optional()
  }),
  /** a timeline of events in beats or seconds; `events` is a formula returning a list of times */
  z.object({ kind: z.literal("timeline"), events: z.string(), length: z.string(), reference: z.string().optional() }),
  /** a grid heatmap: rows x cols from a formula of (row, col) */
  z.object({ kind: z.literal("grid"), rows: z.number().int().min(1).max(16), cols: z.number().int().min(1).max(16), cell: z.string() })
]);

export const SimSpecSchema = z.object({
  kind: z.literal("sim").default("sim"),
  title: z.string().max(60),
  /** one instruction line, 25 words or fewer */
  prompt: z.string().max(200).optional(),
  params: z.record(z.string().regex(/^[a-z_][a-z0-9_]*$/), SimParamSchema).refine((p) => Object.keys(p).length >= 1 && Object.keys(p).length <= 4, "1 to 4 parameters"),
  formulas: z.record(z.string().regex(/^[a-z_][a-z0-9_]*$/), z.string().min(1)).prefault({}),
  figure: SimFigureSchema,
  /** which formulas/params to show as live numbers, with labels and units */
  readout: z.array(z.object({ value: z.string(), label: z.string().max(30), unit: z.string().max(12).optional(), decimals: z.number().int().min(0).max(4).default(0) })).max(4).default([]),
  /** optional takeaway shown after interaction, 25 words or fewer */
  takeaway: z.string().max(200).optional()
});
export type SimSpec = z.infer<typeof SimSpecSchema>;
export type SimSpecInput = z.input<typeof SimSpecSchema>;

const SIM_FUNCTIONS = new Set([...STANDARD_FUNCTION_NAMES, "pi", "tan", "atan", "atan2", "asin", "acos", "deg", "rad", "lerp", "range_list", "seq"]);

export function checkSimSpec(spec: SimSpec): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const names = new Set<string>([...Object.keys(spec.params), "row", "col", "t", "i"]);
  if (spec.prompt && countWords(spec.prompt) > 25) issues.push({ path: "prompt", message: "25 words or fewer" });
  if (spec.takeaway && countWords(spec.takeaway) > 25) issues.push({ path: "takeaway", message: "25 words or fewer" });
  for (const [k, p] of Object.entries(spec.params)) {
    if (p.min >= p.max) issues.push({ path: `params.${k}`, message: "min must be below max" });
  }
  const check = (src: string, path: string) => {
    try {
      const e = parseExpr(src);
      for (const n of rootNames(e)) if (!names.has(n)) issues.push({ path, message: `unknown name "${n}"` });
      for (const f of calledFunctions(e)) if (!SIM_FUNCTIONS.has(f)) issues.push({ path, message: `unknown function "${f}"` });
    } catch (e) {
      issues.push({ path, message: (e as Error).message });
    }
  };
  for (const [k, src] of Object.entries(spec.formulas)) {
    check(src, `formulas.${k}`);
    names.add(k);
  }
  const fig = spec.figure;
  const refs: string[] = [];
  if (fig.kind === "plot") refs.push(fig.x, ...fig.series, ...(fig.marker ? [fig.marker] : []));
  if (fig.kind === "bars") refs.push(...fig.values);
  if (fig.kind === "gauge") refs.push(fig.value);
  if (fig.kind === "timeline") {
    check(fig.events, "figure.events");
    check(fig.length, "figure.length");
  }
  if (fig.kind === "grid") check(fig.cell, "figure.cell");
  if (fig.kind === "linkage") {
    for (const [p, [x, y]] of Object.entries(fig.points)) {
      check(x, `figure.points.${p}[0]`);
      check(y, `figure.points.${p}[1]`);
    }
    for (const [a, b] of fig.segments) if (!(a in fig.points) || !(b in fig.points)) issues.push({ path: "figure.segments", message: `segment ${a}-${b} uses an undefined point` });
  }
  for (const r of refs) if (!names.has(r)) issues.push({ path: "figure", message: `"${r}" is not a parameter or formula` });
  for (const r of spec.readout) if (!names.has(r.value)) issues.push({ path: "readout", message: `"${r.value}" is not a parameter or formula` });
  return issues;
}
