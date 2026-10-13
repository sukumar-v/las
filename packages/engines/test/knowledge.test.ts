import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisSchema, ItemsSpecSchema } from "@las/schema";
import { analyzeKnowledge, gradeItem, nextItem, shouldStop } from "../src/knowledge/index.js";

const here = dirname(fileURLToPath(import.meta.url));

const spec = ItemsSpecSchema.parse({
  items: [
    { type: "choice", id: "c1", prompt: "Pick one", options: ["a", "b", "c"], answer: 1, difficulty: 1, nodes: ["n1"] },
    { type: "predict-output", id: "p1", prompt: "What prints?", code: "print(1+1)", language: "python", options: ["1", "2"], answer: 1, difficulty: 2, nodes: ["n1", "n2"] },
    { type: "match", id: "m1", prompt: "Match them", pairs: [["cat", "meow"], ["dog", "woof"], ["cow", "moo"]], difficulty: 2, nodes: ["n2"] },
    { type: "order", id: "o1", prompt: "Order them", items: ["first", "second", "third"], difficulty: 3, nodes: ["n3"] },
    { type: "fill", id: "f1", prompt: "Fill in", text: "The ___ is up", answers: ["Sun", "star"], hints: ["s...", "su.."], difficulty: 3, nodes: ["n3"] },
    { type: "hotspot", id: "h1", prompt: "Tap the heart", figure: "fig-1", region: { x: 0.5, y: 0.5, r: 0.1 }, difficulty: 4, nodes: [] }
  ],
  stop_after_wrong: 2,
  pass: "accuracy >= 0.5"
});
const item = (id: string) => spec.items.find((i) => i.id === id)!;

describe("gradeItem", () => {
  it("grades choice and predict-output by index, accepting a numeric string", () => {
    expect(gradeItem(item("c1"), 1).correct).toBe(true);
    expect(gradeItem(item("c1"), "1").correct).toBe(true);
    expect(gradeItem(item("c1"), 0).correct).toBe(false);
    expect(gradeItem(item("c1"), "b").correct).toBe(false);
    expect(gradeItem(item("p1"), 1).correct).toBe(true);
    expect(gradeItem(item("p1"), 0).correct).toBe(false);
  });

  it("grades match without caring about order, but every pair must be right", () => {
    expect(gradeItem(item("m1"), [["cow", "moo"], ["cat", "meow"], ["dog", "woof"]]).correct).toBe(true);
    expect(gradeItem(item("m1"), [["cat", "woof"], ["dog", "meow"], ["cow", "moo"]]).correct).toBe(false);
    expect(gradeItem(item("m1"), [["cat", "meow"]]).correct).toBe(false);
    expect(gradeItem(item("m1"), "nonsense").correct).toBe(false);
  });

  it("grades order as the exact sequence", () => {
    expect(gradeItem(item("o1"), ["first", "second", "third"]).correct).toBe(true);
    expect(gradeItem(item("o1"), ["second", "first", "third"]).correct).toBe(false);
    expect(gradeItem(item("o1"), ["first", "second"]).correct).toBe(false);
  });

  it("grades fill ignoring case and spaces, against any accepted answer", () => {
    expect(gradeItem(item("f1"), "  SUN ").correct).toBe(true);
    expect(gradeItem(item("f1"), "Star").correct).toBe(true);
    expect(gradeItem(item("f1"), "moon").correct).toBe(false);
  });

  it("hints reduce a correct fill score but keep it correct", () => {
    expect(gradeItem(item("f1"), { text: "sun", hints: 0 }).score).toBe(1);
    expect(gradeItem(item("f1"), { text: "sun", hints: 1 })).toEqual({ correct: true, score: 0.75 });
    expect(gradeItem(item("f1"), { text: "sun", hints: 2 }).score).toBe(0.5);
    expect(gradeItem(item("f1"), { text: "sun", hints: 99 }).score).toBe(0.5);
    expect(gradeItem(item("f1"), { text: "moon", hints: 1 })).toEqual({ correct: false, score: 0 });
  });

  it("grades hotspot by the point being inside the region", () => {
    expect(gradeItem(item("h1"), { x: 0.55, y: 0.5 }).correct).toBe(true);
    expect(gradeItem(item("h1"), [0.5, 0.45]).correct).toBe(true);
    expect(gradeItem(item("h1"), { x: 0.7, y: 0.5 }).correct).toBe(false);
    expect(gradeItem(item("h1"), "middle").correct).toBe(false);
  });
});

describe("nextItem", () => {
  it("starts at the lowest difficulty", () => {
    expect(nextItem(spec, [])!.id).toBe("c1");
  });

  it("gets harder after a correct answer", () => {
    expect(nextItem(spec, [{ itemId: "c1", correct: true }])!.difficulty).toBe(2);
    expect(nextItem(spec, [{ itemId: "c1", correct: true }, { itemId: "p1", correct: true }])!.difficulty).toBe(3);
  });

  it("stays at the same difficulty after a wrong answer", () => {
    const n = nextItem(spec, [{ itemId: "c1", correct: true }, { itemId: "p1", correct: false }]);
    expect(n!.id).toBe("m1");
    expect(n!.difficulty).toBe(2);
  });

  it("stops after stop_after_wrong wrong answers in a row, not before", () => {
    const one = [{ itemId: "c1", correct: false }];
    expect(nextItem(spec, one)).not.toBeNull();
    const two = [...one, { itemId: "p1", correct: false }];
    expect(shouldStop(spec, two)).toBe(true);
    expect(nextItem(spec, two)).toBeNull();
    // a right answer in between resets the run
    expect(nextItem(spec, [{ itemId: "c1", correct: false }, { itemId: "p1", correct: true }, { itemId: "m1", correct: false }])).not.toBeNull();
  });

  it("uses the nearest difficulty when none is left at the wanted one, and stops when the items run out", () => {
    const hist = [{ itemId: "c1", correct: true }, { itemId: "p1", correct: true }, { itemId: "o1", correct: true }, { itemId: "h1", correct: true }];
    // wanted difficulty 5 does not exist; the nearest unanswered one is picked
    expect(nextItem(spec, hist)!.id).toBe("f1");
    const all = spec.items.map((i) => ({ itemId: i.id, correct: true }));
    expect(nextItem(spec, all)).toBeNull();
  });

  it("walks a whole quiz: each correct answer leads to a harder item", () => {
    const hist: { itemId: string; correct: boolean }[] = [];
    const seen: number[] = [];
    for (let it = nextItem(spec, hist); it; it = nextItem(spec, hist)) {
      seen.push(it.difficulty);
      hist.push({ itemId: it.id, correct: true });
    }
    // harder each time until the hardest item, then the leftovers nearest to it
    expect(seen).toEqual([1, 2, 3, 4, 3, 2]);
  });
});

describe("analyzeKnowledge", () => {
  it("counts correct answers, accuracy, timing, and difficulty reached", () => {
    const a = analyzeKnowledge(spec, {
      answers: [
        { itemId: "c1", answer: 1, ms: 3000 },
        { itemId: "p1", answer: 1, ms: 5000 },
        { itemId: "m1", answer: [["cat", "meow"], ["dog", "woof"], ["cow", "moo"]], ms: 4000 },
        { itemId: "o1", answer: ["second", "first", "third"], ms: 6000 }
      ]
    });
    expect(AnalysisSchema.safeParse(a).success).toBe(true);
    expect(a.metrics.correct.value).toBe(3);
    expect(a.metrics.total.value).toBe(4);
    expect(a.metrics.accuracy.value).toBeCloseTo(0.75);
    expect(a.metrics.mean_ms.value).toBeCloseTo(4500);
    expect(a.metrics.stopped_early.value).toBe(0);
    expect(a.metrics.difficulty_reached.value).toBe(2);
    expect(a.criteria.pass).toBe(true);
    expect(a.precision).toBe("full");
  });

  it("a hint costs accuracy but the answer still counts as correct", () => {
    const a = analyzeKnowledge(spec, { answers: [{ itemId: "f1", answer: { text: "sun", hints: 2 }, ms: 4000 }] });
    expect(a.metrics.correct.value).toBe(1);
    expect(a.metrics.accuracy.value).toBeCloseTo(0.5);
  });

  it("stops counting after the stop rule and flags stopped_early", () => {
    const a = analyzeKnowledge(spec, {
      answers: [
        { itemId: "c1", answer: 1, ms: 3000 },
        { itemId: "p1", answer: 0, ms: 3000 },
        { itemId: "m1", answer: [], ms: 3000 },
        { itemId: "o1", answer: ["first", "second", "third"], ms: 3000 }
      ]
    });
    expect(a.metrics.stopped_early.value).toBe(1);
    expect(a.metrics.total.value).toBe(3);
    expect(a.metrics.correct.value).toBe(1);
    expect(a.quality.issues.join(" ")).toContain("after the stop rule");
  });

  it("flags fast wrong answers as guessing and very slow correct ones as slow, citing the item", () => {
    const a = analyzeKnowledge(spec, {
      answers: [
        { itemId: "c1", answer: 0, ms: 600 },
        { itemId: "p1", answer: 1, ms: 40000 },
        { itemId: "m1", answer: [["cat", "meow"], ["dog", "woof"], ["cow", "moo"]], ms: 5000 },
        { itemId: "o1", answer: ["third"], ms: 400 }
      ]
    });
    const guess = a.mistakes.find((m) => m.id === "guessing")!;
    expect(guess.evidence).toEqual({ kind: "item", id: "c1" });
    expect(guess.at).toEqual([0, 3]);
    expect(guess.share).toBeCloseTo(0.5);
    expect(guess.severity).toBe(3);
    expect(guess.confidence).toBeGreaterThanOrEqual(0.7);
    const slow = a.mistakes.find((m) => m.id === "slow")!;
    expect(slow.evidence).toEqual({ kind: "item", id: "p1" });
    expect(slow.at).toEqual([1]);
  });

  it("does not call a slow wrong answer guessing", () => {
    const a = analyzeKnowledge(spec, { answers: [{ itemId: "c1", answer: 0, ms: 9000 }] });
    expect(a.mistakes).toEqual([]);
  });

  it("breaks results down per skill-model node in the overlay", () => {
    const a = analyzeKnowledge(spec, {
      answers: [
        { itemId: "c1", answer: 1, ms: 3000 },
        { itemId: "p1", answer: 0, ms: 3000 }
      ]
    });
    const o = a.overlay as any;
    expect(o.kind).toBe("items");
    expect(o.nodes.n1).toEqual({ correct: 1, total: 2, accuracy: 0.5 });
    expect(o.nodes.n2).toEqual({ correct: 0, total: 1, accuracy: 0 });
    expect(o.items).toHaveLength(2);
  });

  it("asks for answers when there are none, and ignores unknown or repeated items", () => {
    expect(analyzeKnowledge(spec, { answers: [] }).quality.ok).toBe(false);
    const a = analyzeKnowledge(spec, { answers: [{ itemId: "zzz", answer: 1, ms: 1 }, { itemId: "c1", answer: 1, ms: 3000 }, { itemId: "c1", answer: 0, ms: 3000 }] });
    expect(a.metrics.total.value).toBe(1);
    expect(a.metrics.correct.value).toBe(1);
    expect(a.quality.issues.join(" ")).toContain("unknown item");
    expect(a.quality.issues.join(" ")).toContain("more than once");
  });

  it("evaluates ctx proof criteria over the metrics", () => {
    const a = analyzeKnowledge(spec, { answers: [{ itemId: "c1", answer: 1, ms: 3000 }] }, { criteria: { all_right: "accuracy == 1 && total >= 1" } } as any);
    expect(a.criteria.all_right).toBe(true);
  });
});

describe("drift", () => {
  it("fixed input gives the same metrics as the stored fixture", () => {
    const a = analyzeKnowledge(spec, {
      answers: [
        { itemId: "c1", answer: 1, ms: 2500 },
        { itemId: "p1", answer: 1, ms: 21000 },
        { itemId: "m1", answer: [["cat", "meow"], ["dog", "woof"], ["cow", "moo"]], ms: 4100 },
        { itemId: "f1", answer: { text: "sun", hints: 1 }, ms: 7000 },
        { itemId: "o1", answer: ["second", "first", "third"], ms: 900 },
        { itemId: "h1", answer: { x: 0.9, y: 0.9 }, ms: 1200 }
      ]
    });
    const got = { metrics: Object.fromEntries(Object.entries(a.metrics).map(([k, m]) => [k, Math.round(m.value * 1e6) / 1e6])), mistakes: a.mistakes.map((m) => ({ id: m.id, severity: m.severity, at: m.at })), criteria: a.criteria };
    const path = join(here, "fixtures/knowledge/expected.json");
    if (process.env.UPDATE_FIXTURES || !existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(got, null, 2) + "\n");
    }
    expect(got).toEqual(JSON.parse(readFileSync(path, "utf8")));
  });
});
