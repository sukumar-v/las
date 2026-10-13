import { describe, expect, it } from "vitest";
import { LANGUAGES, TestSpecSchema, type Language, type TestSpecInput } from "@las/schema";
import { assembleResult, buildHarness, normalizeOutput, parseHarnessOutput, parseLint, planSteps } from "../src/harness.js";
import { LANGUAGE_TABLE, findClassBodyEnd } from "../src/languages.js";
import type { RunResult, StepResult } from "../src/types.js";
import type { CodeEvidence } from "../../engines/src/types.js";

// RunResult must stay identical to what the code engine reads
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameShape: Same<RunResult, CodeEvidence["result"]> = true;

/** A small entry file per language; only its name and shape matter here, nothing is run. */
const SAMPLES: Record<Language, { entry: string; source: string }> = {
  javascript: { entry: "solution.js", source: "function add(a, b) { return a + b; }\n" },
  typescript: { entry: "src/solution.ts", source: "export function add(a: number, b: number): number { return a + b; }\n" },
  python: { entry: "solution.py", source: "def add(a, b):\n    return a + b\n" },
  sql: { entry: "schema.sql", source: "CREATE TABLE t (x INTEGER);\n" },
  ruby: { entry: "solution.rb", source: "def add(a, b) = a + b\n" },
  php: { entry: "solution.php", source: "<?php function add($a, $b) { return $a + $b; }\n" },
  rust: { entry: "src/lib.rs", source: "pub fn add(a: i32, b: i32) -> i32 { a + b }\n" },
  go: { entry: "main.go", source: "package main\nfunc add(a, b int) int { return a + b }\nfunc main() {}\n" },
  java: { entry: "Solution.java", source: "public class Solution {\n  static int add(int a, int b) { return a + b; }\n}\n" },
  c: { entry: "solution.c", source: "int add(int a, int b) { return a + b; }\n" },
  cpp: { entry: "solution.cpp", source: "int add(int a, int b) { return a + b; }\n" },
  csharp: { entry: "Solution.cs", source: "public static class Solution { public static int add(int a, int b) => a + b; }\n" },
  kotlin: { entry: "Solution.kt", source: "fun add(a: Int, b: Int) = a + b\nfun main() {}\n" },
  swift: { entry: "Solution.swift", source: "func add(_ a: Int, _ b: Int) -> Int { a + b }\n" },
  bash: { entry: "solution.sh", source: "add() { echo $(( $1 + $2 )); }\n" },
  lua: { entry: "solution.lua", source: "function add(a, b) return a + b end\n" },
  r: { entry: "solution.R", source: "add <- function(a, b) a + b\n" },
  haskell: { entry: "Solution.hs", source: "module Solution where\nadd :: Int -> Int -> Int\nadd a b = a + b\n" },
  elixir: { entry: "solution.exs", source: "defmodule Solution do\n  def add(a, b), do: a + b\nend\n" },
  scala: { entry: "Solution.scala", source: "def add(a: Int, b: Int): Int = a + b\n" },
  dart: { entry: "solution.dart", source: "int add(int a, int b) => a + b;\n" },
  zig: { entry: "solution.zig", source: "pub fn add(a: i32, b: i32) i32 {\n    return a + b;\n}\npub fn main() void {}\n" }
};

/** Calls written so none is a substring of another; bash calls are commands, SQL calls are queries. */
function callsFor(lang: Language): string[] {
  if (lang === "bash") return ["add 2 3", "add 10 20", "add 4 5;"];
  if (lang === "sql") return ["SELECT 2 + 3;", "SELECT 10 + 20", "SELECT count(*) FROM t;"];
  if (lang === "elixir") return ["Solution.add(2, 3)", "Solution.add(10, 20)", "Solution.add(4, 5);"];
  return ["add(2, 3)", "add(10, 20)", "add(4, 5);"];
}

function specFor(lang: Language, extra: Partial<TestSpecInput> = {}) {
  const calls = callsFor(lang);
  return TestSpecSchema.parse({
    language: lang,
    entry: SAMPLES[lang].entry,
    tests: [
      { call: calls[0], expect: "5" },
      { call: calls[1], expect: "30", hidden: true },
      { call: calls[2], expect: "" },
      { stdin: "1 2\n", stdout: "3" },
      { native: `tests/check${LANGUAGE_TABLE[lang].exts[0]}` }
    ],
    ...extra
  });
}

const placeholder = /\{\w+\}/;

describe("buildHarness for every language in LANGUAGES", () => {
  it("the table covers exactly the schema's languages", () => {
    expect(sameShape).toBe(true);
    expect(Object.keys(LANGUAGE_TABLE).sort()).toEqual([...LANGUAGES].sort());
    for (const lang of LANGUAGES) {
      const def = LANGUAGE_TABLE[lang];
      expect(def.id).toBe(lang);
      expect(def.toolchains.length).toBeGreaterThan(0);
      expect(def.exts.length).toBeGreaterThan(0);
      expect(def.valueFormat.length).toBeGreaterThan(10);
    }
  });

  for (const lang of LANGUAGES) {
    it(`${lang}: harness loads the entry and has one line per test call`, () => {
      const { entry, source } = SAMPLES[lang];
      const spec = specFor(lang);
      const files = { [entry]: source, [`tests/check${LANGUAGE_TABLE[lang].exts[0]}`]: "" };
      const built = buildHarness(spec, files);
      const plan = built.command;
      const harness = built.files[built.entry];
      expect(harness, `harness file ${built.entry}`).toBeTruthy();

      // the generated files: everything not given by the learner, plus rewritten copies
      const generated = Object.entries(built.files).filter(([p, s]) => files[p] !== s);
      expect(generated.length).toBeGreaterThan(0);
      const base = entry.split("/").pop()!;
      const stem = base.slice(0, base.lastIndexOf("."));
      const argv = [...(plan.harness?.compile.flat() ?? []), ...(plan.harness?.run ?? [])];
      // directly, through its build command, or through a rewritten copy of the entry that it imports by name
      const lastLine = source.trim().split("\n").pop()!;
      const viaCopy = generated.some(([p, s]) => p !== built.entry && s.includes(lastLine) && harness.includes(p.split("/").pop()!.replace(/\.\w+$/, "")));
      const loadsEntry = [entry, base, stem].some((r) => harness.includes(r)) || argv.some((a) => a.endsWith(base)) || viaCopy;
      expect(loadsEntry, "the harness or its build command refers to the entry").toBe(true);

      // each call test appears on exactly one generated line; the stdin and native tests do not
      const lines = generated.flatMap(([, s]) => s.split("\n"));
      for (const call of callsFor(lang)) {
        const text = lang === "sql" ? call : call.replace(/;$/, "");
        expect(lines.filter((l) => l.includes(text)).length, `lines with ${call}`).toBe(1);
      }
      expect(plan.harness?.tests).toEqual([0, 1, 2]);

      // every command is fully filled in
      const all = [...argv, ...(plan.program?.compile.flat() ?? []), ...(plan.program?.run ?? []), ...plan.native.flatMap((n) => n.steps.flat())];
      expect(all.filter((a) => placeholder.test(a))).toEqual([]);
      expect(plan.program?.cases).toEqual([{ index: 3, stdin: "1 2\n", stdout: "3" }]);
      expect(plan.native).toHaveLength(1);
      const nativeTemplate = LANGUAGE_TABLE[lang].toolchains[0].native!.flat();
      if (nativeTemplate.some((a) => a.includes("{test"))) expect(plan.native[0].steps.flat().some((a) => a.includes("check"))).toBe(true);
      expect(Object.values(plan.env).filter((v) => placeholder.test(v))).toEqual([]);

      // a run plan: harness build steps (if any), the harness run, the program's build and run, the native steps
      const steps = planSteps(spec, plan);
      expect(steps.find((s) => s.id === "hr")).toMatchObject({ merge: true, limited: true });
      expect(steps.find((s) => s.id === "p3")).toMatchObject({ stdin: "1 2\n", merge: false });
      expect(steps.filter((s) => s.id.startsWith("n4.")).length).toBe(plan.native[0].steps.length);
    });

    if (LANGUAGE_TABLE[lang].browser) {
      it(`${lang}: a browser build has a harness source and a program source`, () => {
        const { entry, source } = SAMPLES[lang];
        const spec = specFor(lang, {});
        const built = buildHarness(spec, { [entry]: source }, { target: "browser" });
        const b = built.command.browser!;
        for (const call of callsFor(lang)) expect(b.harness).toContain(lang === "sql" ? call : call.replace(/;$/, ""));
        if (LANGUAGE_TABLE[lang].browserProgram) expect(b.programs[0].source.length).toBeGreaterThan(0);
        // browser harnesses for wasm interpreters carry the entry's source inline
        if (lang === "ruby" || lang === "php") expect(b.harness).toContain("add");
      });
    }
  }

  it("expands source lists and leaves native tests out of them", () => {
    const spec = TestSpecSchema.parse({ language: "c", entry: "main.c", tests: [{ call: "f()", expect: "1" }, { native: "test_main.c" }] });
    const plan = buildHarness(spec, { "main.c": "int f(void){return 1;}", "util.c": "", "util.h": "", "test_main.c": "" }).command;
    expect(plan.harness!.compile[0]).toContain("util.c");
    expect(plan.harness!.compile[0]).not.toContain("main.c");
    expect(plan.harness!.compile[0]).not.toContain("test_main.c");
    expect(plan.harness!.compile[0]).not.toContain("util.h");
  });

  it("picks another toolchain on request, with its support files", () => {
    const spec = TestSpecSchema.parse({ language: "sql", entry: "db.sql", tests: [{ call: "SELECT 1", expect: "1" }] });
    const shim = buildHarness(spec, { "db.sql": "" });
    expect(shim.command.tool).toBe("python3");
    expect(shim.files["__las_sqlite.py"]).toContain("sqlite3");
    expect(shim.files["__las_harness.sql"]).toContain("SELECT 1;");
    const cli = buildHarness(spec, { "db.sql": "" }, { tool: "sqlite3" });
    expect(cli.command.harness!.run).toEqual(["sqlite3", "-batch", ":memory:", ".read __las_harness.sql"]);
    expect(cli.files["__las_sqlite.py"]).toBeUndefined();
  });

  it("keeps the learner's line numbers in rewritten copies", () => {
    const java = "import java.util.*;\npublic class Solution {\n  // a } in a comment and \"}\" in a string\n  static int add(int a, int b) { return a + b; }\n}\nclass Other { }\n";
    const spec = TestSpecSchema.parse({ language: "java", entry: "Solution.java", tests: [{ call: "add(1, 2)", expect: "3" }] });
    const copy = buildHarness(spec, { "Solution.java": java }).files["las_h/Solution.java"];
    expect(copy.split("\n").length).toBe(java.split("\n").length);
    expect(copy.split("\n")[4]).toContain("LasTests");
    const go = "package words\n\nfunc main() {}\nfunc Count() int { return 1 }\n";
    const goCopy = buildHarness(TestSpecSchema.parse({ language: "go", entry: "w.go", tests: [{ call: "Count()", expect: "1" }] }), { "w.go": go }).files["las_h/w.go"];
    expect(goCopy.split("\n")).toEqual(["package main", "", "func lasUserMain() {}", "func Count() int { return 1 }", ""]);
  });

  it("with no call tests there is no harness, only the program and native steps", () => {
    const spec = TestSpecSchema.parse({ language: "python", entry: "a.py", tests: [{ stdin: "x", stdout: "x" }] });
    const built = buildHarness(spec, { "a.py": "print(input())" });
    expect(built.command.harness).toBeUndefined();
    expect(built.entry).toBe("a.py");
    expect(built.command.program?.run).toEqual(["python3", "-B", "a.py"]);
  });

  it("adds lint commands only for tools the table knows", () => {
    const spec = TestSpecSchema.parse({ language: "python", entry: "a.py", tests: [{ call: "1", expect: "1" }], lint: ["ruff", "unknown-tool"] });
    expect(buildHarness(spec, { "a.py": "" }).command.lint).toEqual([{ tool: "ruff", argv: ["ruff", "check", "--no-cache", "--output-format", "concise", "a.py"], format: "colon" }]);
  });
});

describe("findClassBodyEnd", () => {
  it("skips braces in comments, strings, chars and text blocks", () => {
    const src = 'class A {\n  String s = "}"; char c = \'}\'; // }\n  /* } */ String t = """\n  }\n  """;\n  void f() { if (true) { } }\n}\nclass B {}';
    const at = findClassBodyEnd(src, "A");
    expect(src.slice(0, at).split("\n").length).toBe(7);
    expect(src[at]).toBe("}");
    expect(findClassBodyEnd(src, "B")).toBe(src.length - 1);
    expect(findClassBodyEnd(src, "Missing")).toBe(-1);
  });
});

describe("parseHarnessOutput", () => {
  const spec = TestSpecSchema.parse({
    language: "python",
    entry: "a.py",
    tests: [
      { call: "f()", expect: "1" },
      { call: "g()", expect: "x\ny" },
      { call: "h()", expect: "2" },
      { call: "k()", expect: "" },
      { stdin: "", stdout: "" }
    ]
  });

  it("reads results, errors, partial output and text outside tests", () => {
    const out = ["noise", "##LAS## begin 0", "1", "##LAS## end 0", "##LAS## begin 1", "x  ", "y", "", "##LAS## end 1", "##LAS## begin 2", "half##LAS## error", "ValueError: bad (a.py:3)", "##LAS## end 2", "##LAS## begin 3", "partial"].join("\n");
    const p = parseHarnessOutput(out, spec);
    expect(p.sawMarkers).toBe(true);
    expect(p.results[0]).toEqual({ got: "1", pass: true });
    expect(p.results[1]).toEqual({ got: "x\ny", pass: true });
    expect(p.results[2]).toEqual({ got: "half", error: "ValueError: bad (a.py:3)", pass: false });
    expect(p.unfinished).toBe(3);
    expect(p.partial).toBe("partial");
    expect(p.outside).toBe("noise");
    expect(p.compileError).toBeUndefined();
  });

  it("reads a marker printed right after output with no newline, and CRLF line ends", () => {
    const p = parseHarnessOutput("##LAS## begin 0\r\n1##LAS## end 0\r\n", spec);
    expect(p.results[0]).toEqual({ got: "1", pass: true });
  });

  it("reads a compile or load error", () => {
    const p = parseHarnessOutput("##LAS## compile-error\nSyntaxError: invalid syntax (a.py, line 2)\n", spec);
    expect(p.compileError).toBe("SyntaxError: invalid syntax (a.py, line 2)");
    expect(p.results).toEqual({});
  });

  it("uses the language's error pattern for tools that print errors (SQL)", () => {
    const sql = TestSpecSchema.parse({ language: "sql", entry: "s.sql", tests: [{ call: "SELECT * FROM t", expect: "1" }] });
    const p = parseHarnessOutput("##LAS## begin 0\nError: near line 4: no such table: t\n##LAS## end 0\n", sql);
    expect(p.results[0]).toEqual({ got: "", error: "Error: near line 4: no such table: t", pass: false });
    const load = parseHarnessOutput("Parse error near line 2: near \"CREAT\": syntax error\n##LAS## begin 0\n##LAS## end 0\n", sql);
    expect(load.compileError).toMatch(/^Parse error/);
  });

  it("normalizes output: line ends, trailing spaces and blank edges", () => {
    expect(normalizeOutput("\r\n a  \r\nb \n\n")).toBe("a\nb");
  });
});

describe("assembleResult", () => {
  const ok = (stdout: string, extra: Partial<StepResult> = {}): StepResult => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false, ms: 12, ...extra });
  const spec = TestSpecSchema.parse({
    language: "c",
    entry: "s.c",
    tests: [
      { call: "a()", expect: "1" },
      { call: "b()", expect: "2", hidden: true },
      { call: "c()", expect: "3" },
      { stdin: "x", stdout: "y" },
      { stdin: "z", stdout: "z" },
      { native: "t.c" }
    ],
    limits: { time_s: 2 }
  });
  const plan = buildHarness(spec, { "s.c": "", "t.c": "" }).command;

  it("a crash stops the run: the crashed test is a runtime error, the rest did not run", () => {
    const r = assembleResult(spec, plan, {
      hc0: ok(""),
      hr: ok("##LAS## begin 0\n1\n##LAS## end 0\n##LAS## begin 1\nthread overflowed", { code: null, signal: "SIGABRT" }),
      pc0: ok(""),
      p3: ok("y\n"),
      p4: ok("", { code: 139, stderr: "Segmentation fault" }),
      "n5.0": ok(""),
      "n5.1": ok("assertion failed", { code: 1 })
    }, "local");
    expect(r.compiled).toEqual({ ok: true, output: "" });
    expect(r.tests.map((t) => t.pass)).toEqual([true, false, false, true, false, false]);
    expect(r.tests[1].error).toMatch(/^runtime: thread overflowed — stopped by signal SIGABRT/);
    expect(r.tests[1].label).toBe("hidden test 2");
    expect(r.tests[2].error).toBe("not run: an earlier test stopped the program");
    expect(r.tests[4].error).toMatch(/^runtime: Segmentation fault — stopped by signal 11/);
    expect(r.tests[5]).toMatchObject({ pass: false, got: "assertion failed" });
    expect(r.tests[5].error).toBeUndefined();
    expect(r.timeMs).toBe(48);
  });

  it("a build failure fails every test it covers with a compile error and the first error line", () => {
    const r = assembleResult(spec, plan, {
      hc0: ok("In file included from __las_harness.c:9:\ns.c:3:5: error: expected ';'", { code: 1 }),
      hr: { code: null, stdout: "", stderr: "", timedOut: false, ms: 0, skipped: true },
      pc0: ok("s.c:3:5: error: expected ';'", { code: 1 }),
      "n5.0": ok("t.c:1:1: error: nope", { code: 1 })
    }, "local");
    expect(r.compiled?.ok).toBe(false);
    expect(r.compiled?.output).toContain("s.c:3:5: error");
    expect(r.tests[0].error).toBe("compile: s.c:3:5: error: expected ';'");
    expect(r.tests[3].error).toMatch(/^compile:/);
    expect(r.tests[5].error).toBe("compile: t.c:1:1: error: nope");
  });

  it("a time-out before any test finished marks every call test as a timeout", () => {
    const r = assembleResult(spec, plan, { hc0: ok(""), hr: ok("", { code: null, signal: "SIGKILL", timedOut: true }), pc0: ok(""), p3: ok("", { timedOut: true, code: null }) }, "local");
    expect(r.tests.slice(0, 3).every((t) => t.error?.startsWith("timeout:"))).toBe(true);
    expect(r.tests[3].error).toBe("timeout: stopped after 2 s");
    expect(r.tests[4].error).toMatch(/^not run:/);
  });

  it("an entry that cannot load without printing markers is a compile failure", () => {
    const py = TestSpecSchema.parse({ language: "scala", entry: "A.scala", tests: [{ call: "f()", expect: "1" }] });
    const p = buildHarness(py, { "A.scala": "" }).command;
    const r = assembleResult(py, p, { hr: ok("[error] ./las_h/A.scala:3:1: Not found: f", { code: 1 }) }, "local");
    expect(r.compiled).toEqual({ ok: false, output: "[error] ./A.scala:3:1: Not found: f" });
    expect(r.tests[0].error).toBe("compile: [error] ./A.scala:3:1: Not found: f");
  });

  it("tests a runner could not run say why", () => {
    const r = assembleResult(spec, plan, {}, "browser", { missingReason: "this kind of test needs the local or container runner" });
    expect(r.tests[5].error).toBe("not run: this kind of test needs the local or container runner");
  });
});

describe("parseLint", () => {
  it("reads file:line:col shapes, tsc's file(line,col) and rule ids", () => {
    const out = [
      "a.py:3:1: F401 [*] `os` imported but unused",
      "/tmp/las-run-x/s.sh:2:6: warning: Double quote to prevent globbing. [SC2086]",
      "s.c:4:9: warning: unused variable 'x' [-Wunused-variable]",
      "app.ts(7,3): error TS2322: Type 'string' is not assignable to type 'number'.",
      "las_h/other.c:1:1: warning: not the learner's file",
      "Found 1 error."
    ].join("\n");
    expect(parseLint(out, "colon", ["a.py", "s.sh", "s.c", "app.ts"], "/tmp/las-run-x")).toEqual([
      { file: "a.py", line: 3, message: "[*] `os` imported but unused", rule: "F401" },
      { file: "s.sh", line: 2, message: "Double quote to prevent globbing.", rule: "SC2086" },
      { file: "s.c", line: 4, message: "unused variable 'x'", rule: "-Wunused-variable" },
      { file: "app.ts", line: 7, message: "Type 'string' is not assignable to type 'number'.", rule: "TS2322" }
    ]);
  });

  it("reads eslint's JSON", () => {
    const json = JSON.stringify([{ filePath: "/w/s.js", messages: [{ line: 2, message: "'x' is never used.", ruleId: "no-unused-vars" }] }]);
    expect(parseLint(json, "eslint-json", ["s.js"], "/w")).toEqual([{ file: "s.js", line: 2, message: "'x' is never used.", rule: "no-unused-vars" }]);
  });
});
