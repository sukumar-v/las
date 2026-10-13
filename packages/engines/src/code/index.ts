/**
 * Code engine: measures a code runner's result for any language. It reads only the RunResult and the
 * learner's files; it never branches on the skill or the language. Mistakes are engine-level, the same
 * for every language: compile-error, runtime-error, wrong-output, timeout and edge-case-fails (visible
 * tests pass, hidden ones fail). Each points at a line in the entry file and carries the failing
 * test's expected/got diff in the overlay. A quality failure means the runner itself could not run,
 * never that the learner's code is wrong.
 */
import type { Analysis, AnalysisInput, MetricValue, TestSpec } from "@las/schema";
import type { AnalyzeContext, CodeEvidence } from "../types.js";
import { evalCriteria, finish, metric, metricVars, reRecord, version } from "../common/analysis.js";

type Row = CodeEvidence["result"]["tests"][number];
type Kind = "pass" | "compile" | "timeout" | "runtime" | "not-run" | "wrong";
type MistakeId = "compile-error" | "runtime-error" | "wrong-output" | "timeout" | "edge-case-fails";

/** Runners start every error with a word that says what kind it is (see @las/runners TestRow). */
export function failureKind(r: Row): Kind {
  if (r.pass) return "pass";
  const e = (r.error ?? "").trimStart();
  if (!e) return "wrong";
  if (/^compile\b/i.test(e)) return "compile";
  if (/^timeout\b/i.test(e)) return "timeout";
  if (/^not run\b/i.test(e)) return "not-run";
  return "runtime";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A line in the entry file that `text` names, e.g. `solution.py:12`, `Main.java(4,2)` or `"x.py", line 3`. */
export function lineMentioned(text: string | undefined, entry: string): number | undefined {
  if (!text) return undefined;
  const base = escapeRe(entry.split("/").pop() ?? entry);
  const patterns = [new RegExp(`${base}:(\\d+)`), new RegExp(`${base}\\((\\d+),\\d+\\)`), new RegExp(`${base}["']?,? line (\\d+)`)];
  // prefer a line that reports an error, so a compiler's leading context lines are skipped
  const lines = text.split("\n");
  for (const l of [...lines.filter((x) => /\berror\b/i.test(x)), ...lines]) {
    for (const re of patterns) {
      const m = re.exec(l);
      if (m) return Number(m[1]);
    }
  }
  return undefined;
}

/** Where the function a call names is defined: the first line that names it followed by ( = : or {. */
export function definitionLine(call: string | undefined, source: string | undefined): number | undefined {
  if (!call || !source) return undefined;
  const name = /^\s*(?:[\w$]+\.)*([A-Za-z_$][\w$]*)/.exec(call)?.[1];
  if (!name) return undefined;
  const re = new RegExp(`(^|[^\\w$])${escapeRe(name)}\\s*(\\(|=|:|\\{)`);
  const idx = source.split("\n").findIndex((l) => re.test(l));
  return idx >= 0 ? idx + 1 : undefined;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function analyzeCode(spec: TestSpec, evidence: CodeEvidence, ctx?: AnalyzeContext): Analysis {
  const v = version("code", ctx?.specId, ctx?.modelVersion);
  const r = evidence?.result;
  if (!r || r.error) {
    const why = r?.error ?? "no result from a code runner";
    return reRecord("code", [why], `The code could not be run: ${why}. Try another runner (browser, local or container) or install the toolchain.`, v);
  }
  const entry = spec.entry.replace(/\\/g, "/").replace(/^\.\//, "");
  const source = evidence.files?.[entry] ?? evidence.files?.[spec.entry];
  const rows = r.tests;
  const kinds = rows.map(failureKind);
  const total = rows.length;
  const passed = rows.filter((x) => x.pass).length;
  const hidden = rows.filter((x) => x.hidden);
  const visible = rows.filter((x) => !x.hidden);
  const compiled = r.compiled ? r.compiled.ok : !kinds.includes("compile");
  const lintCount = (r.lint ?? []).reduce((s, l) => s + l.findings.length, 0);

  const metrics: Record<string, MetricValue> = {
    tests_passed: metric(passed),
    tests_total: metric(total),
    pass_rate: metric(total ? passed / total : 0),
    hidden_passed: metric(hidden.filter((x) => x.pass).length),
    hidden_total: metric(hidden.length),
    visible_passed: metric(visible.filter((x) => x.pass).length),
    visible_total: metric(visible.length),
    compiled: metric(compiled ? 1 : 0),
    run_ms: metric(r.timeMs, "ms"),
    lint_findings: metric(lintCount, "", r.lint ? 1 : 0)
  };

  // the line each failing test points at: named in its error, else where its function is defined
  const testLine = (row: Row, i: number): number | undefined => {
    const t = spec.tests[i];
    return lineMentioned(row.error, entry) ?? definitionLine(t && "call" in t ? t.call : undefined, source);
  };

  const allVisiblePass = visible.length > 0 && visible.every((x) => x.pass);
  const groups = new Map<MistakeId, number[]>();
  const add = (id: MistakeId, i: number) => groups.set(id, [...(groups.get(id) ?? []), i]);
  rows.forEach((row, i) => {
    const k = kinds[i];
    if (k === "pass" || k === "not-run") return;
    if (k === "compile") return add("compile-error", i);
    // hidden failures are not described, so their content stays hidden: they are one edge-case mistake
    if (row.hidden && allVisiblePass) return add("edge-case-fails", i);
    add(k === "timeout" ? "timeout" : k === "runtime" ? "runtime-error" : "wrong-output", i);
  });
  if (!compiled && !groups.has("compile-error")) groups.set("compile-error", []);

  const severity: Record<MistakeId, 1 | 2 | 3> = { "compile-error": 3, timeout: 2, "runtime-error": 2, "wrong-output": 2, "edge-case-fails": 1 };
  const compileLine = lineMentioned(r.compiled?.output, entry);
  const mistakes: AnalysisInput["mistakes"] = [];
  for (const [id, idx] of groups) {
    const lines = idx.map((i) => (id === "compile-error" ? compileLine : rows[i].hidden ? definitionLine(callOf(spec, i), source) : testLine(rows[i], i))).filter((l): l is number => l !== undefined);
    const line = (id === "compile-error" ? compileLine : lines[0]) ?? 1;
    mistakes.push({
      id,
      severity: severity[id],
      // test results are deterministic
      confidence: 1,
      at: [...new Set(lines)],
      evidence: { kind: "line", file: entry, line },
      share: total ? Math.min(1, (idx.length || total) / total) : 1
    });
  }
  mistakes.sort((a, b) => b.severity - a.severity);

  const markers: AnalysisInput["markers"] = [];
  rows.forEach((row, i) => {
    if (row.pass || row.hidden || kinds[i] === "not-run") return;
    const line = kinds[i] === "compile" ? compileLine : lineMentioned(row.error, entry);
    if (line !== undefined) markers.push({ t: line, label: clip(row.label, 60), role: "attention" });
  });

  const firstDiff = rows.find((x, i) => !x.pass && !x.hidden && x.expected !== undefined && kinds[i] !== "compile" && kinds[i] !== "not-run");
  const overlay = {
    kind: "test_table" as const,
    rows: rows.map((x, i) => ({
      label: x.label,
      hidden: x.hidden,
      pass: x.pass,
      // hidden tests show only that they passed or why they failed, never their content
      ...(x.hidden ? { error: x.pass ? undefined : kinds[i] } : { expected: x.expected, got: x.got, error: x.error }),
      ...(x.timeMs !== undefined ? { timeMs: x.timeMs } : {})
    })),
    ...(firstDiff ? { diff: { label: firstDiff.label, expected: firstDiff.expected ?? "", got: firstDiff.got ?? "" } } : {}),
    ...(r.compiled && !r.compiled.ok ? { compileOutput: clip(r.compiled.output, 4000) } : {}),
    ...(r.lint ? { lint: r.lint } : {}),
    runner: r.runner
  };

  let praise: AnalysisInput["praise"];
  if (passed === total && total > 0) praise = { metric: "tests_passed", label: total === 1 ? "The test passes" : `All ${total} tests pass` };
  else if (allVisiblePass) praise = { metric: "visible_passed", label: "Every visible test passes" };
  else if (passed > 0) praise = { metric: "tests_passed", label: `${passed} of ${total} tests pass` };

  const criteria = evalCriteria((ctx as { criteria?: Record<string, string> } | undefined)?.criteria ?? {}, metricVars(metrics));

  return finish({
    engine: "code",
    quality: { ok: true, issues: [] },
    metrics,
    markers,
    mistakes,
    criteria,
    ...(praise ? { praise } : {}),
    keyFrames: [],
    overlay,
    version: v,
    precision: "full"
  });
}

function callOf(spec: TestSpec, i: number): string | undefined {
  const t = spec.tests[i];
  return t && "call" in t ? t.call : undefined;
}
