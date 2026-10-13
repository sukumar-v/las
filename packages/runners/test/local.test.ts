/**
 * End-to-end runs with the toolchains installed here. Each fixture folder holds an entry file and a
 * spec whose tests are: two passing calls, a passing hidden call, a deliberate failure, a call that
 * raises an error and one stdin/stdout test; `spin` names a call that never returns. A language whose
 * toolchain is missing is skipped with the reason in the test name, so CI without it still passes.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TestSpecSchema, type TestSpecInput } from "@las/schema";
import { networkPrefix } from "../src/process.js";
import { pickToolchain, runLocal } from "../src/local.js";
import { LANGUAGE_TABLE } from "../src/languages.js";

const root = join(import.meta.dirname, "fixtures");
const fixtures = readdirSync(root).filter((d) => existsSync(join(root, d, "spec.json")));

function load(lang: string) {
  const dir = join(root, lang);
  const raw = JSON.parse(readFileSync(join(dir, "spec.json"), "utf8")) as TestSpecInput & { spin: string; tests: Record<string, unknown>[] };
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (f !== "spec.json") files[f] = readFileSync(join(dir, f), "utf8");
  return { raw, spec: TestSpecSchema.parse(raw), files };
}

/** `it` when the language's toolchain is installed, else a skipped test that says why. */
function itWith(language: string, name: string, fn: () => Promise<void>, timeout?: number) {
  const tc = pickToolchain(language);
  if (tc) it(`${name} (${tc.tool})`, fn, timeout);
  else it.skip(`${name} (skipped: no ${LANGUAGE_TABLE[language as keyof typeof LANGUAGE_TABLE].label} toolchain installed)`, fn);
}

describe("runLocal end to end", () => {
  it("has fixtures for at least 8 languages", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(8);
  });

  for (const lang of fixtures) {
    const { raw, spec, files } = load(lang);

    itWith(spec.language, `${lang}: pass, deliberate failure, error and stdin test`, async () => {
      const r = await runLocal(spec, files);
      expect(r.error).toBeUndefined();
      expect(r.runner).toBe("local");
      expect(r.language).toBe(spec.language);
      expect(r.compiled?.ok, r.compiled?.output).toBe(true);
      expect(r.tests.map((t) => t.pass)).toEqual([true, true, true, false, false, true]);
      expect(r.tests[2]).toMatchObject({ hidden: true, label: "hidden test 3" });
      // the deliberate failure is a wrong answer, not an error
      expect(r.tests[3]).toMatchObject({ label: "deliberate failure", expected: raw.tests[3].expect });
      expect(r.tests[3].error).toBeUndefined();
      expect(r.tests[3].got).not.toBe(raw.tests[3].expect);
      expect(r.tests[4].error).toMatch(/^runtime: /);
      expect(r.tests[5].got).toBe(raw.tests[5].stdout);
      expect(r.timeMs).toBeGreaterThan(0);
    });

    itWith(spec.language, `${lang}: the time limit stops an endless loop`, async () => {
      const spin = TestSpecSchema.parse({ ...raw, tests: [raw.tests[0], { call: raw.spin, expect: "" }, raw.tests[1]], limits: { time_s: 1 } });
      const r = await runLocal(spin, files);
      expect(r.tests[0].pass).toBe(true);
      expect(r.tests[1].error).toBe("timeout: stopped after 1 s");
      expect(r.tests[2].error).toMatch(/^not run: /);
      // run time only (builds are separate): the 1 s limit plus process start-up
      expect(r.timeMs).toBeGreaterThanOrEqual(900);
      expect(r.timeMs).toBeLessThan(3000);
    });
  }

  const broken: [string, string, string, number][] = [
    ["python", "s.py", "def add(a, b)\n    return a + b\n", 1],
    ["c", "s.c", "int x;\nint add(int a, int b) { return a + b }\n", 2],
    ["java", "S.java", "public class S {\n  static int add(int a, int b) { return a + b }\n}\n", 2],
    ["rust", "s.rs", "fn add(a: i32, b: i32) -> i32 {\n    a + c\n}\n", 2]
  ];
  for (const [language, entry, source, line] of broken) {
    itWith(language, `${language}: a compile error fails every call test and names the line`, async () => {
      const spec = TestSpecSchema.parse({ language, entry, tests: [{ call: "add(1, 2)", expect: "3" }, { call: "add(2, 2)", expect: "4", hidden: true }] });
      const r = await runLocal(spec, { [entry]: source });
      expect(r.error).toBeUndefined();
      expect(r.compiled?.ok).toBe(false);
      expect(r.compiled?.output).toMatch(new RegExp(`${entry.replace(".", "\\.")}(:${line}\\b|", line ${line}|, line ${line})`));
      expect(r.tests.every((t) => !t.pass && t.error?.startsWith("compile: "))).toBe(true);
      // rewritten copies stay out of what the learner sees
      expect(r.compiled?.output).not.toContain("las_h/");
    });
  }

  itWith("javascript", "javascript: native test files run with the language's own test command", async () => {
    const spec = TestSpecSchema.parse({ language: "javascript", entry: "n.js", tests: [{ native: "good.test.js" }, { native: "bad.test.js" }, { call: "add(1, 1)", expect: "2" }] });
    const r = await runLocal(spec, {
      "n.js": "exports.add = (a, b) => a + b;\n",
      "good.test.js": "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('./n.js');\ntest('adds', () => assert.equal(add(1, 2), 3));\n",
      "bad.test.js": "const test = require('node:test');\nconst assert = require('node:assert');\ntest('fails', () => assert.equal(1, 2));\n"
    });
    expect(r.tests.map((t) => t.pass)).toEqual([true, false, true]);
    expect(r.tests[1].error).toBeUndefined();
    expect(r.tests[1].got).toMatch(/fail 1/);
  });

  itWith("go", "go: native tests and a learner package that is not main", async () => {
    const spec = TestSpecSchema.parse({ language: "go", entry: "w.go", tests: [{ native: "w_test.go" }, { call: "Add(1, 2)", expect: "3" }, { call: "Pair()", expect: "1 two" }] });
    const r = await runLocal(spec, {
      "w.go": 'package w\n\nfunc Add(a, b int) int { return a + b }\nfunc Pair() (int, string) { return 1, "two" }\n',
      "w_test.go": 'package w\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal("bad")\n\t}\n}\n'
    });
    expect(r.tests.map((t) => t.pass)).toEqual([true, true, true]);
  });

  itWith("c", "c: crashes are caught per test and lint findings come back", async () => {
    const spec = TestSpecSchema.parse({ language: "c", entry: "x.c", tests: [{ call: "boom()", expect: "" }, { call: "ok()", expect: "1" }], lint: ["gcc-warnings"] });
    const r = await runLocal(spec, { "x.c": "#include <stddef.h>\nint boom(void) { int *p = NULL; return *p; }\nint ok(void) { int unused; return 1; }\n" });
    expect(r.tests[0].error).toMatch(/^runtime: .*segmentation fault/);
    expect(r.tests[1].pass).toBe(true);
    expect(r.lint?.[0].tool).toBe("gcc-warnings");
    expect(r.lint?.[0].findings).toContainEqual(expect.objectContaining({ file: "x.c", line: 3, rule: "-Wunused-variable" }));
  });

  itWith("python", "python: only an allow-listed environment reaches the program", async () => {
    process.env.LAS_TEST_SECRET = "should-not-leak";
    try {
      const spec = TestSpecSchema.parse({ language: "python", entry: "e.py", tests: [{ call: "repr(os.environ.get('LAS_TEST_SECRET'))", expect: "None" }, { call: "'PATH' in os.environ", expect: "True" }] });
      const r = await runLocal(spec, { "e.py": "import os\n" });
      expect(r.tests.map((t) => t.pass)).toEqual([true, true]);
    } finally {
      delete process.env.LAS_TEST_SECRET;
    }
  });

  const isolated = process.platform === "linux" && networkPrefix().length > 0;
  (isolated && pickToolchain("python") ? it : it.skip)(`python: no network inside the run${isolated ? "" : " (skipped: unshare -n is not available here)"}`, async () => {
    const spec = TestSpecSchema.parse({ language: "python", entry: "n.py", tests: [{ call: "connect()", expect: "blocked" }] });
    const src = "import socket\n\ndef connect():\n    try:\n        socket.create_connection(('1.1.1.1', 53), timeout=2)\n        return 'connected'\n    except OSError:\n        return 'blocked'\n";
    const r = await runLocal(spec, { "n.py": src });
    expect(r.tests[0]).toMatchObject({ pass: true, got: "blocked" });
  });

  (process.platform === "linux" && pickToolchain("python") ? it : it.skip)("python: the memory limit stops a huge allocation", async () => {
    const spec = TestSpecSchema.parse({ language: "python", entry: "m.py", tests: [{ call: "hog()", expect: "" }, { call: "1 + 1", expect: "2" }], limits: { memory_mb: 128 } });
    const r = await runLocal(spec, { "m.py": "def hog():\n    return len(bytearray(2_000_000_000))\n" });
    expect(r.tests[0].error).toMatch(/^runtime: MemoryError/);
    expect(r.tests[1].pass).toBe(true);
  });

  it("refuses file paths outside the workspace without running anything", async () => {
    const spec = TestSpecSchema.parse({ language: "python", entry: "a.py", tests: [{ call: "1", expect: "1" }] });
    const r = await runLocal(spec, { "a.py": "", "../escape.py": "" });
    expect(r.error).toMatch(/inside the workspace/);
    expect(r.tests[0].error).toMatch(/^not run: /);
  });

  const missing = Object.values(LANGUAGE_TABLE).find((d) => !pickToolchain(d.id));
  (missing ? it : it.skip)(`a missing toolchain is a runner error, not a test failure${missing ? ` (${missing.id})` : " (skipped: every toolchain is installed)"}`, async () => {
    const spec = TestSpecSchema.parse({ language: missing!.id, entry: `a${missing!.exts[0]}`, tests: [{ call: "f()", expect: "1" }] });
    const r = await runLocal(spec, { [`a${missing!.exts[0]}`]: "" });
    expect(r.error).toMatch(/toolchain was found/);
    expect(r.tests[0]).toMatchObject({ pass: false });
    expect(r.tests[0].error).toMatch(/^not run: /);
  });
});
