import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalysisSchema, TestSpecSchema, type Analysis } from "@las/schema";
import { analyzeCode, definitionLine, failureKind, lineMentioned } from "../src/code/index.js";
import type { CodeEvidence } from "../src/types.js";

/** Fixtures are real runner results (the local runner on Python), saved as JSON so this test needs no toolchain. */
function load(name: string) {
  const raw = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "code", `${name}.json`), "utf8"));
  return { spec: TestSpecSchema.parse(raw.spec), evidence: raw.evidence as CodeEvidence };
}
const values = (a: Analysis) => Object.fromEntries(Object.entries(a.metrics).map(([k, m]) => [k, m.value]));
const ids = (a: Analysis) => a.mistakes.map((m) => m.id);
const table = (a: Analysis) => a.overlay as { kind: string; rows: { label: string; hidden: boolean; pass: boolean; expected?: string; got?: string; error?: string }[]; diff?: { label: string; expected: string; got: string } };

describe("code engine", () => {
  it("all tests pass: full metrics, praise, no mistakes", () => {
    const { spec, evidence } = load("all-pass");
    const a = analyzeCode(spec, evidence);
    expect(AnalysisSchema.safeParse(a).success).toBe(true);
    expect(a.engine).toBe("code");
    expect(a.precision).toBe("full");
    expect(a.quality.ok).toBe(true);
    expect(values(a)).toMatchObject({ tests_passed: 3, tests_total: 3, pass_rate: 1, hidden_passed: 1, hidden_total: 1, compiled: 1, run_ms: 40, lint_findings: 0 });
    expect(a.mistakes).toEqual([]);
    expect(a.praise).toEqual({ metric: "tests_passed", label: "All 3 tests pass" });
    expect(table(a).kind).toBe("test_table");
    expect(table(a).diff).toBeUndefined();
  });

  it("compile error: one severe mistake pointing at the line, every test failed, still a good-quality result", () => {
    const { spec, evidence } = load("compile-error");
    const a = analyzeCode(spec, evidence);
    expect(a.quality.ok).toBe(true);
    expect(values(a)).toMatchObject({ compiled: 0, tests_passed: 0, pass_rate: 0 });
    expect(ids(a)).toEqual(["compile-error"]);
    expect(a.mistakes[0]).toMatchObject({ severity: 3, confidence: 1, evidence: { kind: "line", file: "words.py", line: 1 }, share: 1 });
    expect(a.praise).toBeUndefined();
    // only the visible failing test gets a marker
    expect(a.markers).toEqual([{ t: 1, label: 'count_words("a b c")', role: "attention" }]);
  });

  it("hidden tests fail while visible ones pass: edge-case-fails, and hidden content stays hidden", () => {
    const { spec, evidence } = load("hidden-fail");
    const a = analyzeCode(spec, evidence);
    expect(values(a)).toMatchObject({ tests_passed: 1, hidden_passed: 0, hidden_total: 2, visible_passed: 1, compiled: 1 });
    expect(ids(a)).toEqual(["edge-case-fails"]);
    expect(a.mistakes[0]).toMatchObject({ severity: 1, evidence: { kind: "line", file: "words.py", line: 1 } });
    expect(a.mistakes[0].share).toBeCloseTo(2 / 3);
    expect(a.praise).toEqual({ metric: "visible_passed", label: "Every visible test passes" });
    const rows = table(a).rows;
    expect(rows.filter((r) => r.hidden).every((r) => r.expected === undefined && r.got === undefined)).toBe(true);
    expect(rows[1].error).toBe("wrong");
    expect(table(a).diff).toBeUndefined();
    expect(a.markers).toEqual([]);
  });

  it("timeout: the stopped test is a timeout mistake and later tests are not blamed", () => {
    const { spec, evidence } = load("timeout");
    const a = analyzeCode(spec, evidence);
    expect(ids(a)).toEqual(["timeout"]);
    // points where spin() is defined
    expect(a.mistakes[0].evidence).toEqual({ kind: "line", file: "words.py", line: 9 });
    expect(a.mistakes[0].share).toBeCloseTo(1 / 3);
    expect(values(a)).toMatchObject({ tests_passed: 1, run_ms: 1000 });
    expect(a.praise).toEqual({ metric: "tests_passed", label: "1 of 3 tests pass" });
  });

  it("runtime error and wrong output: both mistakes, the diff and a marker at the failing line", () => {
    const { spec, evidence } = load("runtime-and-wrong");
    const a = analyzeCode(spec, evidence);
    expect(ids(a).sort()).toEqual(["runtime-error", "wrong-output"]);
    const runtime = a.mistakes.find((m) => m.id === "runtime-error")!;
    expect(runtime.evidence).toEqual({ kind: "line", file: "words.py", line: 6 });
    const wrong = a.mistakes.find((m) => m.id === "wrong-output")!;
    expect(wrong.evidence).toEqual({ kind: "line", file: "words.py", line: 1 });
    expect(table(a).diff).toEqual({ label: 'first_word("")', expected: "", got: "" });
    expect(a.markers).toContainEqual({ t: 6, label: 'first_word("")', role: "attention" });
  });

  it("the diff shows the first visible wrong answer", () => {
    const { spec, evidence } = load("runtime-and-wrong");
    const ev: CodeEvidence = { ...evidence, result: { ...evidence.result, tests: evidence.result.tests.filter((t) => !t.error) } };
    const sp = TestSpecSchema.parse({ ...spec, tests: spec.tests.slice(1) });
    expect(table(analyzeCode(sp, ev)).diff).toEqual({ label: 'count_words("a  b")', expected: "2", got: "3" });
  });

  it("a runner failure is a quality failure with no metrics, never a learner mistake", () => {
    const { spec, evidence } = load("runner-failed");
    const a = analyzeCode(spec, evidence);
    expect(AnalysisSchema.safeParse(a).success).toBe(true);
    expect(a.quality.ok).toBe(false);
    expect(a.quality.issues[0]).toMatch(/no Python toolchain/);
    expect(a.quality.reRecord).toMatch(/another runner/);
    expect(a.metrics).toEqual({});
    expect(a.mistakes).toEqual([]);
  });

  it("evaluates criteria over the metrics and counts lint findings", () => {
    const { spec, evidence } = load("all-pass");
    const ev: CodeEvidence = { ...evidence, result: { ...evidence.result, lint: [{ tool: "ruff", findings: [{ file: "words.py", line: 1, message: "unused import", rule: "F401" }] }] } };
    const a = analyzeCode(spec, ev, { criteria: { proof: "pass_rate == 1 && lint_findings <= 1", strict: "lint_findings == 0" } } as never);
    expect(a.criteria).toEqual({ proof: true, strict: false });
    expect(a.metrics.lint_findings).toMatchObject({ value: 1, confidence: 1 });
  });

  it("reads failure kinds from the runner's error words", () => {
    const row = (pass: boolean, error?: string) => ({ label: "t", hidden: false, pass, error });
    expect([row(true), row(false), row(false, "compile: x"), row(false, "timeout: y"), row(false, "not run: z"), row(false, "runtime: boom")].map(failureKind)).toEqual(["pass", "wrong", "compile", "timeout", "not-run", "runtime"]);
  });

  it("finds lines in compiler and runtime messages of many languages", () => {
    expect(lineMentioned("In file included from __las_harness.c:9:\nbad.c:4:37: error: expected ';'", "src/bad.c")).toBe(4);
    expect(lineMentioned("Main.java:12: error: ';' expected", "Main.java")).toBe(12);
    expect(lineMentioned("error[E0425]: cannot find value\n --> src/lib.rs:7:5", "src/lib.rs")).toBe(7);
    expect(lineMentioned("app.ts(3,10): error TS2322: Type 'string'", "app.ts")).toBe(3);
    expect(lineMentioned('SyntaxError: invalid syntax (words.py, line 8)', "words.py")).toBe(8);
    expect(lineMentioned("runtime: Error: near line 18: no such table", "schema.sql")).toBeUndefined();
  });

  it("finds where a called function is defined, in any language's syntax", () => {
    const src = ["// helpers", "int add(int a, int b) {", "  return a + b;", "}"].join("\n");
    expect(definitionLine("add(1, 2)", src)).toBe(2);
    expect(definitionLine("Solution.add(1, 2)", src)).toBe(2);
    expect(definitionLine("count_words \"a b\"", "x=1\ncount_words() {\n  echo 1\n}")).toBe(2);
    expect(definitionLine("SELECT name FROM people;", "CREATE VIEW v AS SELECT name FROM people;")).toBeUndefined();
  });
});
