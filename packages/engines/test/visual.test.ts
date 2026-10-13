import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RubricSpecSchema, AnalysisSchema } from "@las/schema";
import { analyzeVisual, applyRubricGrades, measureVisual, parseVisualMeasure, rubricPrompt } from "../src/visual/index.js";
import type { VisualEvidence } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Build an RGBA image from a function of position. */
function image(w: number, h: number, f: (x: number, y: number) => [number, number, number]): NonNullable<VisualEvidence["pixels"]> {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return { data, width: w, height: h };
}
const gray = (v: number): [number, number, number] => [v, v, v];
const ev = (pixels: VisualEvidence["pixels"], extra: Partial<VisualEvidence> = {}): VisualEvidence => ({ width: pixels?.width ?? 100, height: pixels?.height ?? 100, pixels, ...extra });

const spec = RubricSpecSchema.parse({
  criteria: [
    {
      id: "proportions",
      label: "Proportions",
      levels: { 1: "Off by more than 25%", 2: "Mostly right", 3: "Within 10%" },
      measure: "tapped_points(head_top, chin, feet, target=0.25)",
      level_from: "if(ratio_error < 0.1, 3, if(ratio_error < 0.25, 2, 1))"
    },
    { id: "line_confidence", label: "Line confidence", levels: { 1: "Hesitant", 2: "Some", 3: "Confident strokes" }, weight: 2 }
  ],
  taps: [{ id: "head_top", prompt: "Top of the head" }, { id: "chin", prompt: "Chin" }, { id: "feet", prompt: "Feet" }],
  pass: "proportions >= 2 && line_confidence >= 2"
});
const taps = (chinY: number) => ({ head_top: [0.5, 0.1] as [number, number], chin: [0.5, chinY] as [number, number], feet: [0.5, 0.9] as [number, number] });

describe("measurements", () => {
  it("parses a measure call with options", () => {
    expect(parseVisualMeasure("tapped_points(a, b, target=0.5)")).toEqual({ fn: "tapped_points", args: ["a", "b"], opts: { target: "0.5" } });
    expect(parseVisualMeasure("not a call")).toBeNull();
  });

  it("tapped points give distances in pixels and a ratio with its error to a target", () => {
    const r = measureVisual("tapped_points(head_top, chin, feet, target=0.25)", { width: 100, height: 200, taps: taps(0.3) });
    expect(r.values.d1).toBeCloseTo(40);
    expect(r.values.d2).toBeCloseTo(120);
    expect(r.values.span).toBeCloseTo(160);
    expect(r.values.ratio).toBeCloseTo(0.25);
    expect(r.values.ratio_error).toBeCloseTo(0);
    expect(r.region).toMatchObject({ x: 0.5, y: 0.1, w: 0 });
  });

  it("proportion is the ratio of two segments, angle is measured at the middle point", () => {
    const t = { a: [0.1, 0.1], b: [0.1, 0.5], c: [0.5, 0.1], d: [0.5, 0.3] } as Record<string, [number, number]>;
    expect(measureVisual("proportion(a, b, c, d)", { width: 100, height: 100, taps: t }).values.ratio).toBeCloseTo(2);
    const right = { p: [0.2, 0.5], q: [0.2, 0.2], r: [0.6, 0.2] } as Record<string, [number, number]>;
    expect(measureVisual("angle(p, q, r)", { width: 100, height: 100, taps: right }).values.angle).toBeCloseTo(90);
  });

  it("reports a missing tap instead of throwing", () => {
    const r = measureVisual("tapped_points(a, b)", { width: 10, height: 10, taps: { a: [0, 0] } });
    expect(r.values).toEqual({});
    expect(r.issues[0]).toContain("missing tapped point: b");
  });

  it("tells a symmetric image from an asymmetric one", () => {
    const sym = image(40, 40, (x, y) => gray(Math.min(x, 39 - x) * 6 + y));
    const asym = image(40, 40, (x) => gray(x < 20 ? 0 : 255));
    expect(measureVisual("symmetry(vertical)", ev(sym)).values.symmetry).toBeCloseTo(1);
    expect(measureVisual("symmetry(vertical)", ev(asym)).values.symmetry).toBeCloseTo(0);
    // the same left/right split is perfectly symmetric top to bottom
    expect(measureVisual("symmetry(horizontal)", ev(asym)).values.symmetry).toBeCloseTo(1);
  });

  it("tells a dark image from a bright one, and finds clipping", () => {
    const dark = measureVisual("exposure()", ev(image(20, 20, () => gray(0)))).values;
    const bright = measureVisual("exposure()", ev(image(20, 20, () => gray(255)))).values;
    const mid = measureVisual("exposure()", ev(image(20, 20, () => gray(128)))).values;
    expect(dark.mean_luma).toBeCloseTo(0);
    expect(dark.dark_clip).toBe(1);
    expect(bright.mean_luma).toBeCloseTo(1);
    expect(bright.bright_clip).toBe(1);
    expect(mid.mean_luma).toBeCloseTo(128 / 255);
    expect(mid.clipping).toBe(0);
  });

  it("finds a color cast", () => {
    const warm = measureVisual("color_balance()", ev(image(10, 10, () => [200, 100, 100]))).values;
    expect(warm.r_offset).toBeGreaterThan(0.1);
    expect(warm.g_offset).toBeLessThan(0);
    expect(measureVisual("color_balance()", ev(image(10, 10, () => gray(90)))).values.cast).toBeCloseTo(0);
  });

  it("edge density is zero for a flat image and high for stripes", () => {
    expect(measureVisual("edge_density()", ev(image(40, 40, () => gray(100)))).values.edge_density).toBe(0);
    const stripes = measureVisual("edge_density()", ev(image(40, 40, (x) => gray((x >> 2) % 2 ? 255 : 0)))).values.edge_density;
    expect(stripes).toBeGreaterThan(0.4);
  });

  it("counts separate strokes", () => {
    const three = image(120, 100, (x) => ((x >= 20 && x < 22) || (x >= 60 && x < 62) || (x >= 100 && x < 102) ? gray(0) : gray(255)));
    expect(measureVisual("line_count()", ev(three)).values.line_count).toBe(3);
    expect(measureVisual("line_count()", ev(image(50, 50, () => gray(255)))).values.line_count).toBe(0);
  });

  it("text counts words and matches the expected text", () => {
    const r = measureVisual("text()", { width: 1, height: 1, ocrText: "The quick brown fox" }, { expectedText: "the quick red fox" });
    expect(r.values.word_count).toBe(4);
    expect(r.values.matched).toBeCloseTo(0.75);
  });

  it("asks for pixels when a pixel measure has none", () => {
    expect(measureVisual("exposure()", { width: 1, height: 1 }).issues[0]).toContain("needs image pixels");
  });
});

describe("grades", () => {
  it("applies grades with regions at full confidence and drops unknown criteria", () => {
    const { applied, issues } = applyRubricGrades(spec, [
      { criterion: "proportions", level: 2, confidence: 0.9, region: { x: 0.1, y: 0.1, w: 0.4, h: 0.5 } },
      { criterion: "nope", level: 1, confidence: 1 }
    ]);
    expect(applied.proportions).toMatchObject({ level: 2, confidence: 0.9, cited: true });
    expect(issues.join(" ")).toContain('unknown criterion "nope"');
  });

  it("halves the confidence of a grade with no region", () => {
    const { applied, issues } = applyRubricGrades(spec, [{ criterion: "line_confidence", level: 1, confidence: 0.9 }]);
    expect(applied.line_confidence.confidence).toBeCloseTo(0.45);
    expect(applied.line_confidence.cited).toBe(false);
    expect(issues[0]).toContain("region");
  });

  it("does not halve when the rubric needs no citation", () => {
    const loose = RubricSpecSchema.parse({ ...spec, must_cite: "none" });
    expect(applyRubricGrades(loose, [{ criterion: "line_confidence", level: 2, confidence: 0.9 }]).applied.line_confidence.confidence).toBe(0.9);
  });

  it("snaps a level to one the criterion defines and keeps the more confident duplicate", () => {
    const { applied } = applyRubricGrades(spec, [
      { criterion: "proportions", level: 9, confidence: 0.6, region: { x: 0, y: 0, w: 1, h: 1 } },
      { criterion: "proportions", level: 1, confidence: 0.95, region: { x: 0, y: 0, w: 1, h: 1 } }
    ]);
    expect(applied.proportions.level).toBe(1);
  });

  it("builds the analysis from agent grades: score, mistake in a region, praise, pass", () => {
    const a = analyzeVisual(spec, {
      width: 100,
      height: 200,
      taps: taps(0.3),
      grader: "agent",
      grades: [
        { criterion: "proportions", level: 3, confidence: 0.9, region: { x: 0.3, y: 0.1, w: 0.4, h: 0.8 } },
        { criterion: "line_confidence", level: 1, confidence: 0.85, region: { x: 0.2, y: 0.5, w: 0.3, h: 0.2 }, note: "re-stroked" }
      ]
    });
    expect(AnalysisSchema.safeParse(a).success).toBe(true);
    expect(a.precision).toBe("full");
    expect(a.metrics.proportions_level.value).toBe(3);
    expect(a.metrics.line_confidence_level.value).toBe(1);
    // weights 1 and 2: (1*1 + 2*0) / 3
    expect(a.metrics.score.value).toBeCloseTo(1 / 3);
    expect(a.mistakes).toHaveLength(1);
    expect(a.mistakes[0]).toMatchObject({ id: "line_confidence", severity: 3, confidence: 0.85, evidence: { kind: "region", x: 0.2, y: 0.5 } });
    expect(a.praise).toEqual({ metric: "proportions_level", label: "Proportions" });
    expect(a.criteria.pass).toBe(false);
    expect((a.overlay as any).kind).toBe("regions");
    expect((a.overlay as any).regions).toHaveLength(2);
    expect((a.overlay as any).taps.chin).toEqual([0.5, 0.3]);
  });

  it("passes when the levels clear the bar", () => {
    const a = analyzeVisual(spec, { width: 10, height: 10, grades: [{ criterion: "proportions", level: 2, confidence: 0.9, region: { x: 0, y: 0, w: 1, h: 1 } }, { criterion: "line_confidence", level: 3, confidence: 0.9, region: { x: 0, y: 0, w: 1, h: 1 } }] });
    expect(a.criteria.pass).toBe(true);
    expect(a.mistakes[0].id).toBe("proportions");
  });

  it("a grade with no region is too weak to become a mistake, and says why", () => {
    const a = analyzeVisual(spec, { width: 10, height: 10, grades: [{ criterion: "line_confidence", level: 1, confidence: 0.9 }, { criterion: "proportions", level: 3, confidence: 0.9, region: { x: 0, y: 0, w: 1, h: 1 } }] });
    expect(a.metrics.line_confidence_confidence.value).toBeCloseTo(0.45);
    expect(a.mistakes).toHaveLength(0);
    expect(a.quality.issues.join(" ")).toContain("does not point at a region");
  });

  it("the ctx proof criteria are evaluated over levels and metrics", () => {
    const a = analyzeVisual(spec, { width: 10, height: 10, grades: [{ criterion: "proportions", level: 3, confidence: 0.9, region: { x: 0, y: 0, w: 1, h: 1 } }, { criterion: "line_confidence", level: 2, confidence: 0.9, region: { x: 0, y: 0, w: 1, h: 1 } }] }, { criteria: { good_shape: "proportions_level >= 3", steady: "score > 0.9" } } as any);
    expect(a.criteria).toMatchObject({ good_shape: true, steady: false });
  });
});

describe("pending grades", () => {
  it("returns measurements only, reduced precision, and says grading is pending", () => {
    const a = analyzeVisual(spec, { width: 100, height: 200, taps: taps(0.3) });
    expect(a.precision).toBe("reduced");
    expect(a.quality.ok).toBe(true);
    expect(a.quality.issues.join(" ")).toContain("grading pending");
    expect(a.metrics.proportions_ratio.value).toBeCloseTo(0.25);
    // level_from maps the measurement to a level when no grade exists
    expect(a.metrics.proportions_level.value).toBe(3);
    expect(a.metrics.line_confidence_level).toBeUndefined();
    expect((a.overlay as any).grader).toBe("none");
  });

  it("level_from follows the measurement (a chin placed too high drops the level)", () => {
    const a = analyzeVisual(spec, { width: 100, height: 200, taps: taps(0.4) });
    expect(a.metrics.proportions_ratio.value).toBeCloseTo(0.375);
    expect(a.metrics.proportions_level.value).toBe(1);
    expect(a.mistakes[0]).toMatchObject({ id: "proportions", evidence: { kind: "region" } });
  });

  it("a submitted grade wins over level_from", () => {
    const a = analyzeVisual(spec, { width: 100, height: 200, taps: taps(0.3), grades: [{ criterion: "proportions", level: 1, confidence: 0.9, region: { x: 0, y: 0, w: 1, h: 1 } }] });
    expect(a.metrics.proportions_level.value).toBe(1);
    expect(a.precision).toBe("reduced");
    expect(a.quality.issues.join(" ")).toContain("grading pending for: line_confidence");
  });
});

describe("rubricPrompt", () => {
  it("lists the criteria and levels, the citation rule, the taps and the JSON to send back", () => {
    const p = rubricPrompt(spec, taps(0.3));
    expect(p).toContain("proportions (Proportions)");
    expect(p).toContain("3 = Within 10%");
    expect(p).toContain("region of the image");
    expect(p).toContain("chin (Chin): 0.500, 0.300");
    const json = JSON.parse(p.slice(p.indexOf("{")));
    expect(json.grades[0]).toMatchObject({ criterion: "proportions", level: 2 });
    expect(json.grades[0].region).toBeDefined();
  });

  it("leaves out the region instruction when nothing needs citing", () => {
    expect(rubricPrompt(RubricSpecSchema.parse({ ...spec, must_cite: "none" }))).not.toContain("region");
  });
});

describe("drift", () => {
  const stripes = image(60, 60, (x, y) => (x % 7 < 3 ? gray(30 + y) : [220, 200, 180]));
  const fixed = analyzeVisual(
    RubricSpecSchema.parse({
      criteria: [
        { id: "balance", levels: { 1: "Lopsided", 2: "Fair", 3: "Even" }, measure: "symmetry(vertical)", level_from: "if(symmetry > 0.9, 3, if(symmetry > 0.7, 2, 1))" },
        { id: "light", levels: { 1: "Poor", 2: "Fine" }, measure: "exposure()", level_from: "if(clipping < 0.05, 2, 1)" },
        { id: "detail", levels: { 1: "Flat", 2: "Busy" }, measure: "edge_density()" },
        { id: "strokes", levels: { 1: "Few", 2: "Many" }, measure: "line_count()" },
        { id: "tone", levels: { 1: "Cast", 2: "Neutral" }, measure: "color_balance()" },
        { id: "shape", levels: { 1: "Off", 2: "Close" }, measure: "tapped_points(a, b, c, target=0.5)" }
      ],
      pass: "balance >= 2"
    }),
    { width: 60, height: 60, pixels: stripes, taps: { a: [0.1, 0.1], b: [0.1, 0.4], c: [0.1, 0.7] } }
  );
  const round = (m: Record<string, { value: number }>) => Object.fromEntries(Object.entries(m).map(([k, x]) => [k, Math.round(x.value * 1e6) / 1e6]));
  const path = join(here, "fixtures/visual/expected.json");

  it("fixed input gives the same metrics as the stored fixture", () => {
    const got = { metrics: round(fixed.metrics), criteria: fixed.criteria, precision: fixed.precision };
    if (process.env.UPDATE_FIXTURES || !existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(got, null, 2) + "\n");
    }
    expect(got).toEqual(JSON.parse(readFileSync(path, "utf8")));
  });
});
