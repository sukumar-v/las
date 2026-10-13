import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisSchema, TaskSpecSchema } from "@las/schema";
import { analyzeInteraction } from "../src/interaction/index.js";
import type { InteractionEvidence } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
type Ev = InteractionEvidence["events"][number];

const text50 = "the quick brown fox jumps over the lazy dog today ok";
const typing = TaskSpecSchema.parse({ task: "type-text", content: [text50.slice(0, 50)], pass: "wpm >= 40 && accuracy >= 0.9" });

/** A typing stream: one key every `gap` seconds; the keys at `wrong` positions are typed wrong. */
function typed(n: number, gap: number, wrong: number[] = [], text = text50): Ev[] {
  return Array.from({ length: n }, (_, i) => {
    const expected = text[i];
    return { t: Math.round((i + 1) * gap * 1000) / 1000, key: wrong.includes(i) ? "#" : expected, expected };
  });
}

describe("type-text", () => {
  it("measures wpm at 5 characters a word, accuracy, errors, consistency and mean interval", () => {
    // 50 keys, 0.2 s apart, over 10 s; two wrong -> 48 right chars = 9.6 words in 1/6 min = 57.6 wpm
    const a = analyzeInteraction(typing, { events: typed(50, 0.2, [10, 30]), durationS: 10 });
    expect(AnalysisSchema.safeParse(a).success).toBe(true);
    expect(a.metrics.wpm.value).toBeCloseTo(57.6);
    expect(a.metrics.accuracy.value).toBeCloseTo(0.96);
    expect(a.metrics.errors.value).toBe(2);
    expect(a.metrics.consistency.value).toBeCloseTo(1);
    expect(a.metrics.mean_ms.value).toBeCloseTo(200);
    expect(a.metrics.completed.value).toBe(1);
    expect(a.criteria.pass).toBe(true);
    expect(a.praise).toEqual({ metric: "accuracy", label: "Clean accuracy" });
  });

  it("consistency drops when the rhythm is uneven", () => {
    let t = 0;
    const events = Array.from({ length: 30 }, (_, i) => {
      t += i % 2 ? 0.05 : 0.45;
      return { t, key: "a", expected: "a" };
    });
    const a = analyzeInteraction(typing, { events, durationS: 8 });
    expect(a.metrics.consistency.value).toBeLessThan(0.5);
    expect(a.metrics.completed.value).toBe(0);
  });

  it("ignores backspace presses", () => {
    const events = [...typed(10, 0.2), { t: 2.1, key: "Backspace" }];
    const a = analyzeInteraction(typing, { events, durationS: 3 });
    expect(a.metrics.accuracy.value).toBe(1);
    expect(a.metrics.errors.value).toBe(0);
  });

  it("flags rushing when the mistakes come in faster than the clean keys", () => {
    let t = 0;
    const events: Ev[] = [];
    for (let i = 0; i < 24; i++) {
      const bad = i % 6 === 5;
      t += bad ? 0.08 : 0.3;
      events.push({ t, key: bad ? "#" : "a", expected: "a" });
    }
    const a = analyzeInteraction(typing, { events, durationS: 8 });
    const m = a.mistakes.find((x) => x.id === "rushing")!;
    expect(m).toBeDefined();
    expect(m.confidence).toBeGreaterThanOrEqual(0.7);
    expect(m.at).toHaveLength(4);
    expect(m.evidence).toMatchObject({ kind: "time" });
    expect(a.markers.length).toBe(4);
  });

  it("does not call errors rushing when they came after a slow, careful pause", () => {
    let t = 0;
    const events: Ev[] = [];
    for (let i = 0; i < 24; i++) {
      const bad = i % 6 === 5;
      t += bad ? 0.8 : 0.3;
      events.push({ t, key: bad ? "#" : "a", expected: "a" });
    }
    expect(analyzeInteraction(typing, { events, durationS: 10 }).mistakes.find((x) => x.id === "rushing")).toBeUndefined();
  });

  it("flags hesitating on repeated long gaps", () => {
    let t = 0;
    const events: Ev[] = [];
    for (let i = 0; i < 20; i++) {
      t += i === 6 || i === 13 ? 3 : 0.25;
      events.push({ t, key: "a", expected: "a" });
    }
    const a = analyzeInteraction(typing, { events, durationS: 12 });
    const m = a.mistakes.find((x) => x.id === "hesitating")!;
    expect(m.at).toHaveLength(2);
    expect(a.mistakes.find((x) => x.id === "rushing")).toBeUndefined();
  });

  it("asks to do the task again when nothing was recorded", () => {
    const a = analyzeInteraction(typing, { events: [], durationS: 5 });
    expect(a.quality.ok).toBe(false);
    expect(a.quality.reRecord).toBeTruthy();
  });
});

describe("other tasks", () => {
  it("mental-math: accuracy and mean response time from the previous answer", () => {
    const spec = TaskSpecSchema.parse({ task: "mental-math", content: ["2+2", "3*3", "9-4", "8/2"], pass: "accuracy >= 0.75" });
    const events: Ev[] = [
      { t: 2, correct: true },
      { t: 5, correct: true },
      { t: 6, correct: false },
      { t: 10, correct: true }
    ];
    const a = analyzeInteraction(spec, { events, durationS: 10 });
    expect(a.metrics.accuracy.value).toBeCloseTo(0.75);
    expect(a.metrics.mean_ms.value).toBeCloseTo(2500);
    expect(a.metrics.completed.value).toBe(1);
    expect(a.metrics.wpm).toBeUndefined();
    expect(a.metrics.consistency).toBeUndefined();
    expect(a.criteria.pass).toBe(true);
  });

  it("shortcuts: right when key matches expected; incomplete when not every prompt was answered", () => {
    const spec = TaskSpecSchema.parse({ task: "shortcuts", content: ["Ctrl+C", "Ctrl+V", "Ctrl+Z"] });
    const a = analyzeInteraction(spec, { events: [{ t: 1, key: "Ctrl+C", expected: "Ctrl+C" }, { t: 2.5, key: "Ctrl+X", expected: "Ctrl+V" }], durationS: 3 });
    expect(a.metrics.accuracy.value).toBeCloseTo(0.5);
    expect(a.metrics.completed.value).toBe(0);
    expect(a.markers[0]).toMatchObject({ t: 2.5, label: "expected Ctrl+V" });
  });

  it("click-targets and sequence: accuracy and mean_ms; a timed task that ran its full time is completed", () => {
    const spec = TaskSpecSchema.parse({ task: "click-targets", content: ["a", "b", "c", "d", "e"], duration_s: 10 });
    const events: Ev[] = [{ t: 1, x: 0.1, y: 0.1, target: "a", correct: true }, { t: 2, x: 0.5, y: 0.5, target: "b", correct: false }];
    const a = analyzeInteraction(spec, { events, durationS: 10 });
    expect(a.metrics.accuracy.value).toBe(0.5);
    expect(a.metrics.mean_ms.value).toBeCloseTo(1000);
    expect(a.metrics.completed.value).toBe(1);
    const seq = analyzeInteraction(TaskSpecSchema.parse({ task: "sequence", content: ["1", "2"] }), { events: [{ t: 1 }, { t: 2 }], durationS: 2 });
    expect(seq.metrics.accuracy.value).toBe(1);
  });

  it("evaluates ctx proof criteria", () => {
    const a = analyzeInteraction(typing, { events: typed(50, 0.2), durationS: 10 }, { criteria: { fast_enough: "wpm >= 55", clean: "errors == 0" } } as any);
    expect(a.criteria).toMatchObject({ fast_enough: true, clean: true });
  });
});

describe("drift", () => {
  it("fixed input gives the same metrics as the stored fixture", () => {
    let t = 0;
    const events: Ev[] = [];
    for (let i = 0; i < 40; i++) {
      const bad = i % 9 === 8;
      t += bad ? 0.1 : 0.2 + (i % 4) * 0.05 + (i === 20 ? 2.2 : 0);
      events.push({ t: Math.round(t * 1000) / 1000, key: bad ? "#" : text50[i], expected: text50[i] });
    }
    const a = analyzeInteraction(typing, { events, durationS: 14 });
    const got = { metrics: Object.fromEntries(Object.entries(a.metrics).map(([k, m]) => [k, Math.round(m.value * 1e6) / 1e6])), mistakes: a.mistakes.map((m) => ({ id: m.id, severity: m.severity, at: m.at })), criteria: a.criteria };
    const path = join(here, "fixtures/interaction/expected.json");
    if (process.env.UPDATE_FIXTURES || !existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(got, null, 2) + "\n");
    }
    expect(got).toEqual(JSON.parse(readFileSync(path, "utf8")));
  });
});
