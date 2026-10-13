/**
 * The general part of every runner: turn a test spec into commands (from the language table), parse
 * the harness's marked output and assemble a RunResult. Browser-safe: no node imports here.
 */
import type { TestCase, TestSpec } from "@las/schema";
import { LANGUAGE_TABLE, MARK, MIRROR, extOf, type HarnessCase, type HarnessContext } from "./languages.js";
import type { Argv, CommandPlan, LintFormat, RunResult, StepResult, TestRow } from "./types.js";

export interface BuildOptions {
  /** "browser" builds sources for a browser runtime instead of commands */
  target?: "native" | "browser";
  /** pick this toolchain (by its main binary) instead of the first in the table */
  tool?: string;
  memoryMb?: number;
}

export const normalizePath = (p: string) => p.replace(/\\/g, "/").replace(/^(\.\/)+/, "");

/** Output compared as text: line endings unified, trailing spaces on each line and blank edges ignored. */
export function normalizeOutput(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

function harnessContext(spec: TestSpec, files: Record<string, string>, target: "native" | "browser"): HarnessContext {
  const entry = normalizePath(spec.entry);
  const entryBase = entry.split("/").pop() ?? entry;
  const dot = entryBase.lastIndexOf(".");
  const normFiles: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) normFiles[normalizePath(k)] = v;
  const cases: HarnessCase[] = [];
  spec.tests.forEach((t, index) => {
    // in SQL every query ends with ; so the statement rule does not apply
    if ("call" in t) cases.push({ index, call: t.call.trim(), statement: spec.language !== "sql" && /;\s*$/.test(t.call) });
  });
  return {
    entry,
    entryBase,
    entryStem: dot > 0 ? entryBase.slice(0, dot) : entryBase,
    entryDir: entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/")) : "",
    files: normFiles,
    cases,
    nativePaths: spec.tests.flatMap((t) => ("native" in t ? [normalizePath(t.native)] : [])),
    target
  };
}

/**
 * Generates the test harness and the commands to build and run it, for any language in the table.
 * Returns the full set of files to write (the learner's plus generated ones), the harness entry and the plan.
 */
export function buildHarness(spec: TestSpec, files: Record<string, string>, opts: BuildOptions = {}): { files: Record<string, string>; entry: string; command: CommandPlan } {
  const def = LANGUAGE_TABLE[spec.language];
  const target = opts.target ?? "native";
  const ctx = harnessContext(spec, files, target);
  const tc = (opts.tool && def.toolchains.find((t) => t.tool === opts.tool)) || def.toolchains[0];
  const generated = ctx.cases.length ? def.harness(ctx) : {};
  const harnessPath = def.harnessFile.replace("{entry}", ctx.entry);
  const memoryMb = opts.memoryMb ?? spec.limits.memory_mb;
  const sources = (def.sources?.(ctx) ?? Object.keys(ctx.files).filter((p) => def.exts.includes(extOf(p)) && !ctx.nativePaths.includes(p))).sort();
  const vars: Record<string, string> = {
    tool: tc.tool,
    entry: ctx.entry,
    entryDir: ctx.entryDir,
    entryBase: ctx.entryBase,
    entryStem: ctx.entryStem,
    harness: harnessPath,
    memoryMb: String(memoryMb),
    memoryBytesHex: (memoryMb * 1024 * 1024).toString(16),
    ...def.vars?.(ctx)
  };
  const lists: Record<string, string[]> = {
    "{sources}": sources,
    "{otherSources}": sources.filter((s) => s !== ctx.entry),
    "{mirrorSources}": Object.keys(generated)
      .filter((p) => p.startsWith(MIRROR + "/") && def.exts.includes(extOf(p)))
      .sort()
  };
  const fillText = (s: string, extra: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k: string) => extra[k] ?? vars[k] ?? m);
  const fill = (argv: Argv, extra: Record<string, string> = {}): Argv => argv.flatMap((a) => lists[a] ?? [fillText(a, extra)]);

  const stdinCases = spec.tests.flatMap((t, index) => ("stdin" in t ? [{ index, stdin: t.stdin, stdout: t.stdout }] : []));
  const command: CommandPlan = {
    language: spec.language,
    tool: tc.tool,
    image: def.image ?? "",
    vmLimit: def.vmLimit,
    env: Object.fromEntries(Object.entries(def.env ?? {}).map(([k, v]) => [k, fillText(v, {})])),
    harness: ctx.cases.length ? { compile: (tc.compile ?? []).map((a) => fill(a)), run: fill(tc.run), tests: ctx.cases.map((c) => c.index) } : undefined,
    program: stdinCases.length ? { compile: (tc.programCompile ?? []).map((a) => fill(a)), run: fill(tc.program), cases: stdinCases } : undefined,
    native: spec.tests.flatMap((t, index) => {
      if (!("native" in t) || !tc.native) return [];
      const test = normalizePath(t.native);
      const testBase = test.split("/").pop() ?? test;
      const testStem = testBase.includes(".") ? testBase.slice(0, testBase.lastIndexOf(".")) : testBase;
      return [{ index, steps: tc.native.map((a) => fill(a, { test, testStem, testClass: testStem })) }];
    }),
    lint: (spec.lint ?? []).flatMap((tool) => {
      const l = def.lint[tool];
      return l ? [{ tool, argv: fill(l.argv), format: l.format ?? ("colon" as LintFormat) }] : [];
    })
  };
  if (target === "browser") {
    command.browser = {
      harness: generated[harnessPath] ?? "",
      programs: stdinCases.map((c) => ({ index: c.index, source: def.browserProgram?.(ctx, c.stdin) ?? "", stdin: c.stdin }))
    };
  }
  return { files: { ...ctx.files, ...(tc.files ?? {}), ...generated }, entry: ctx.cases.length ? harnessPath : ctx.entry, command };
}

/** The binary a lint tool needs, from the table. */
export function lintBinary(language: string, tool: string): string {
  return (LANGUAGE_TABLE as Record<string, { lint: Record<string, { bin?: string }> }>)[language]?.lint[tool]?.bin ?? tool;
}

// ---------------------------------------------------------------------------------------------
// parsing the harness output

export interface ParsedHarness {
  /** set when the entry failed to build or load */
  compileError?: string;
  /** finished call tests, by spec index */
  results: Record<number, { got: string; error?: string; pass: boolean }>;
  /** a test that began but never ended: the program crashed or was stopped */
  unfinished?: number;
  /** what that test printed before it stopped */
  partial?: string;
  sawMarkers: boolean;
  /** output outside any test (top-level prints, warnings) */
  outside: string;
}

const MARK_RE = new RegExp(`${MARK} (begin|end|error|compile-error)(?: (\\d+))?\\s*$`);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Reads the marked lines every harness prints and compares each call's output with its `expect`. */
export function parseHarnessOutput(stdout: string, spec: TestSpec): ParsedHarness {
  const errorPattern = LANGUAGE_TABLE[spec.language]?.errorPattern;
  const out: ParsedHarness = { results: {}, sawMarkers: false, outside: "" };
  const outside: string[] = [];
  let cur: number | null = null;
  let got: string[] = [];
  let err: string[] | null = null;
  let compile: string[] | null = null;

  const finish = (i: number) => {
    const t = spec.tests[i] as TestCase | undefined;
    let gotText = got.join("\n");
    let error = err ? err.join("\n").trim() : undefined;
    if (error === undefined && errorPattern) {
      const m = errorPattern.exec(gotText);
      if (m) {
        error = gotText.slice(m.index).trim();
        gotText = gotText.slice(0, m.index);
      }
    }
    const expected = t && "call" in t ? t.expect : "";
    out.results[i] = { got: normalizeOutput(gotText), ...(error !== undefined ? { error: clip(error || "error", 2000) } : {}), pass: error === undefined && normalizeOutput(gotText) === normalizeOutput(expected) };
  };

  for (const line of stdout.replace(/\r\n?/g, "\n").split("\n")) {
    if (compile) {
      compile.push(line);
      continue;
    }
    const m = MARK_RE.exec(line);
    const text = m ? line.slice(0, m.index) : line;
    if (!m || text) {
      if (cur === null) outside.push(text);
      else (err ?? got).push(text);
    }
    if (!m) continue;
    out.sawMarkers = true;
    const idx = m[2] !== undefined ? Number(m[2]) : undefined;
    if (m[1] === "compile-error") compile = [];
    else if (m[1] === "begin" && idx !== undefined) {
      cur = idx;
      got = [];
      err = null;
    } else if (m[1] === "error" && cur !== null) err = err ?? [];
    else if (m[1] === "end" && cur !== null) {
      finish(cur);
      cur = null;
    }
  }
  if (compile) out.compileError = normalizeOutput((compile as string[]).join("\n")) || "the entry file did not load";
  if (cur !== null) {
    out.unfinished = cur;
    out.partial = [...got, ...(err ?? [])].join("\n");
  }
  out.outside = outside.join("\n");
  if (!out.compileError && errorPattern) {
    const m = errorPattern.exec(out.outside);
    if (m) out.compileError = normalizeOutput(out.outside.slice(m.index));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// steps: the plan flattened, so local, container and browser runners execute it the same way

export interface PlannedStep {
  id: string;
  argv: Argv;
  stdin?: string;
  /** stdout and stderr merged in arrival order (harness steps) */
  merge: boolean;
  /** run limits apply (memory); builds are only time-limited */
  limited: boolean;
  timeoutS: number;
  /** ids that must have succeeded for this step to run */
  after: string[];
}

/** Builds get more time than runs: at least a minute, or twice the run limit. */
export const buildTimeoutS = (spec: TestSpec) => Math.max(60, spec.limits.time_s * 2);

export function planSteps(spec: TestSpec, plan: CommandPlan): PlannedStep[] {
  const steps: PlannedStep[] = [];
  const runT = spec.limits.time_s;
  const buildT = buildTimeoutS(spec);
  const runBuilds = LANGUAGE_TABLE[spec.language].toolchains.find((t) => t.tool === plan.tool)?.runBuilds ?? false;
  if (plan.harness) {
    const ids: string[] = [];
    plan.harness.compile.forEach((argv, k) => {
      steps.push({ id: `hc${k}`, argv, merge: true, limited: false, timeoutS: buildT, after: [...ids] });
      ids.push(`hc${k}`);
    });
    steps.push({ id: "hr", argv: plan.harness.run, merge: true, limited: true, timeoutS: runBuilds ? buildT + runT : runT, after: ids });
  }
  if (plan.program) {
    const ids: string[] = [];
    plan.program.compile.forEach((argv, k) => {
      steps.push({ id: `pc${k}`, argv, merge: true, limited: false, timeoutS: buildT, after: [...ids] });
      ids.push(`pc${k}`);
    });
    for (const c of plan.program.cases) steps.push({ id: `p${c.index}`, argv: plan.program.run, stdin: c.stdin, merge: false, limited: true, timeoutS: runBuilds ? buildT + runT : runT, after: ids });
  }
  for (const n of plan.native) {
    n.steps.forEach((argv, k) => {
      const last = k === n.steps.length - 1;
      steps.push({ id: `n${n.index}.${k}`, argv, merge: true, limited: last, timeoutS: buildT + (last ? runT : 0), after: k ? [`n${n.index}.${k - 1}`] : [] });
    });
  }
  return steps;
}

/** A step succeeded: it ran, was not stopped and exited 0. */
export const stepOk = (r: StepResult | undefined) => !!r && !r.skipped && !r.spawnError && !r.timedOut && r.code === 0;

// ---------------------------------------------------------------------------------------------
// assembling the result

function labelFor(t: TestCase, i: number): string {
  if (t.label) return t.label;
  if (t.hidden) return `hidden test ${i + 1}`;
  if ("call" in t) return clip(t.call.replace(/\s*\n\s*/g, " "), 60);
  if ("stdin" in t) return clip(`input: ${t.stdin.split("\n")[0] || "(empty)"}`, 60);
  return clip(t.native, 60);
}

const tail = (s: string, lines = 4) =>
  clip(
    normalizeOutput(s)
      .split("\n")
      .filter((l) => l.trim())
      .slice(-lines)
      .join("\n"),
    600
  );

function exitInfo(r: StepResult): string {
  if (r.signal) return `stopped by signal ${r.signal}`;
  if (r.code !== null && r.code !== 0) return r.code > 128 ? `stopped by signal ${r.code - 128}` : `exit code ${r.code}`;
  return "the program stopped";
}

const firstLine = (s: string) => {
  const lines = normalizeOutput(s).split("\n").filter((l) => l.trim());
  // compilers often lead with context ("In file included from ..."): prefer the first line that names an error
  return (lines.find((l) => /\berror\b/i.test(l)) ?? lines[0] ?? "").trim();
};
const stripMirror = (s: string) => s.split(`${MIRROR}/`).join("");

export interface AssembleExtras {
  lint?: RunResult["lint"];
  error?: string;
  /** why tests with no step result did not run (for example "native tests need a local toolchain") */
  missingReason?: string;
}

/** Turns step results into a RunResult. Shared by every runner so results read the same everywhere. */
export function assembleResult(spec: TestSpec, plan: CommandPlan, results: Record<string, StepResult>, runner: RunResult["runner"], extras: AssembleExtras = {}): RunResult {
  const rows: TestRow[] = spec.tests.map((t, i) => ({
    label: labelFor(t, i),
    hidden: t.hidden ?? false,
    pass: false,
    ...("call" in t ? { expected: t.expect } : "stdin" in t ? { expected: t.stdout } : {})
  }));
  const buildOut: string[] = [];
  let built = true;
  let timeMs = 0;
  const runT = spec.limits.time_s;

  const compileSteps = (prefix: string, n: number): boolean => {
    let ok = true;
    for (let k = 0; k < n; k++) {
      const r = results[`${prefix}${k}`];
      if (!r || r.skipped) {
        ok = false;
        continue;
      }
      const text = stripMirror(normalizeOutput(r.stdout + (r.stderr ? "\n" + r.stderr : "")));
      if (text) buildOut.push(text);
      if (r.timedOut) buildOut.push(`the build took longer than ${buildTimeoutS(spec)} s`);
      if (!stepOk(r)) ok = false;
    }
    return ok;
  };

  if (plan.harness) {
    const ok = compileSteps("hc", plan.harness.compile.length);
    const r = results.hr;
    let failed: string | undefined;
    if (!ok) failed = firstLine(buildOut.join("\n")) || "the code did not build";
    else if (r && !r.skipped && !r.spawnError) {
      const parsed = parseHarnessOutput(r.stdout + (r.stderr ? "\n" + r.stderr : ""), spec);
      timeMs += r.ms;
      if (parsed.compileError !== undefined) {
        failed = firstLine(parsed.compileError);
        buildOut.push(stripMirror(parsed.compileError));
      } else if (!parsed.sawMarkers && !r.timedOut && (r.code !== 0 || r.signal)) {
        // the harness never started its tests: the entry could not build or load (for example a build inside the run step)
        const text = stripMirror(normalizeOutput(r.stdout + "\n" + r.stderr));
        failed = firstLine(text) || exitInfo(r);
        buildOut.push(text || exitInfo(r));
      } else {
        let stopped = false;
        for (const i of plan.harness.tests) {
          const res = parsed.results[i];
          if (res) {
            Object.assign(rows[i], { got: res.got, pass: res.pass }, res.error !== undefined ? { error: `runtime: ${res.error}` } : {});
          } else if (i === parsed.unfinished) {
            stopped = true;
            rows[i].got = normalizeOutput(parsed.partial ?? "");
            rows[i].error = r.timedOut ? `timeout: stopped after ${runT} s` : `runtime: ${[tail(parsed.partial ?? ""), exitInfo(r)].filter(Boolean).join(" — ")}`;
          } else if (r.timedOut && !parsed.sawMarkers) {
            rows[i].error = `timeout: stopped after ${runT} s, before this test finished`;
          } else {
            rows[i].error = stopped || r.timedOut ? "not run: an earlier test stopped the program" : `not run: the program stopped before this test (${exitInfo(r)})`;
          }
        }
      }
    } else {
      for (const i of plan.harness.tests) rows[i].error = `not run: ${r?.spawnError ?? extras.missingReason ?? "the tests did not run"}`;
    }
    if (failed !== undefined) {
      built = false;
      for (const i of plan.harness.tests) rows[i].error = `compile: ${failed}`;
    }
  }

  if (plan.program) {
    const ok = compileSteps("pc", plan.program.compile.length);
    if (!ok) built = false;
    for (const c of plan.program.cases) {
      const row = rows[c.index];
      if (!ok) {
        row.error = `compile: ${firstLine(buildOut.join("\n")) || "the program did not build"}`;
        continue;
      }
      const r = results[`p${c.index}`];
      if (!r || r.skipped || r.spawnError) {
        row.error = `not run: ${r?.spawnError ?? extras.missingReason ?? "the program did not run"}`;
        continue;
      }
      timeMs += r.ms;
      row.timeMs = Math.round(r.ms);
      row.got = normalizeOutput(r.stdout);
      if (r.timedOut) {
        row.error = `timeout: stopped after ${runT} s`;
        continue;
      }
      row.pass = !r.signal && normalizeOutput(r.stdout) === normalizeOutput(c.stdout);
      if (!row.pass && (r.code !== 0 || r.signal)) row.error = `runtime: ${[tail(r.stderr || r.stdout), exitInfo(r)].filter(Boolean).join(" — ")}`;
    }
  }

  for (const n of plan.native) {
    const row = rows[n.index];
    const last = n.steps.length - 1;
    let reason: string | undefined;
    for (let k = 0; k <= last; k++) {
      const r = results[`n${n.index}.${k}`];
      if (!r || r.skipped || r.spawnError) {
        reason = reason ?? `not run: ${r?.spawnError ?? extras.missingReason ?? "the test did not run"}`;
        break;
      }
      const text = normalizeOutput(r.stdout + (r.stderr ? "\n" + r.stderr : ""));
      if (r.timedOut) {
        reason = `timeout: stopped after ${k === last ? runT : buildTimeoutS(spec)} s`;
        break;
      }
      if (k < last && r.code !== 0) {
        reason = `compile: ${firstLine(text) || "the test did not build"}`;
        buildOut.push(text);
        built = false;
        break;
      }
      if (k === last) {
        timeMs += r.ms;
        row.timeMs = Math.round(r.ms);
        row.got = tail(text, 12);
        row.pass = r.code === 0 && !r.signal;
      }
    }
    if (reason) row.error = reason;
  }
  // native tests the plan has no command for
  spec.tests.forEach((t, i) => {
    if ("native" in t && !plan.native.some((n) => n.index === i)) rows[i].error = `not run: ${extras.missingReason ?? `no native test command for ${spec.language}`}`;
  });

  return {
    runner,
    language: spec.language,
    compiled: { ok: built, output: clip(buildOut.filter(Boolean).join("\n"), 20000) },
    tests: rows,
    timeMs: Math.round(timeMs),
    ...(extras.lint ? { lint: extras.lint } : {}),
    ...(extras.error ? { error: extras.error } : {})
  };
}

/** A RunResult for when the runner itself could not run: every test is marked not run. */
export function runnerFailure(spec: TestSpec, runner: RunResult["runner"], error: string): RunResult {
  return {
    runner,
    language: spec.language,
    tests: spec.tests.map((t, i) => ({ label: labelFor(t, i), hidden: t.hidden ?? false, pass: false, error: `not run: ${error}` })),
    timeMs: 0,
    error
  };
}

// ---------------------------------------------------------------------------------------------
// lint output

type Finding = { file: string; line: number; message: string; rule?: string };

/**
 * Reads lint output in the common `file:line[:col]: message` shape (or `file(line,col): message`),
 * or eslint's JSON. `known` keeps findings to the learner's files.
 */
export function parseLint(output: string, format: LintFormat, known: string[], workDir = ""): Finding[] {
  const rel = (f: string) => normalizePath(workDir && f.startsWith(workDir) ? f.slice(workDir.length).replace(/^[\\/]+/, "") : f);
  const keep = (f: string) => !known.length || known.includes(f) || known.some((k) => k.endsWith("/" + f) || f.endsWith("/" + k));
  const findings: Finding[] = [];
  if (format === "eslint-json") {
    try {
      const data = JSON.parse(output.slice(output.indexOf("["))) as { filePath: string; messages: { line?: number; message: string; ruleId?: string | null }[] }[];
      for (const f of data) for (const m of f.messages) if (keep(rel(f.filePath))) findings.push({ file: rel(f.filePath), line: m.line ?? 1, message: m.message, ...(m.ruleId ? { rule: m.ruleId } : {}) });
    } catch {}
    return findings;
  }
  const re = /([^\s:()'"]+\.[A-Za-z0-9]+)(?::(\d+)(?::\d+)?|\((\d+),\d+\))\s*[:-]?\s*(.*)$/;
  for (const line of output.replace(/\r\n?/g, "\n").split("\n")) {
    const m = re.exec(line);
    if (!m) continue;
    const file = rel(m[1]);
    if (!keep(file)) continue;
    let message = m[4].trim().replace(/^(warning|error|info|note|style|convention|refactor)\b\s*[:-]?\s*/i, "");
    let rule: string | undefined;
    const trailing = /\s*\[([\w\-/.:]+)\]$/.exec(message) ?? /\s+-\s+([a-z_]+)$/.exec(message);
    if (trailing) {
      rule = trailing[1];
      message = message.slice(0, trailing.index).trim();
    } else {
      const lead = /^([A-Z]+\d+|[A-Z]\d{4}|SC\d+)\b[:\s]*/.exec(message);
      if (lead) {
        rule = lead[1];
        message = message.slice(lead[0].length).trim();
      }
    }
    if (!message) continue;
    findings.push({ file, line: Number(m[2] ?? m[3]), message: clip(message, 300), ...(rule ? { rule } : {}) });
  }
  return findings;
}
