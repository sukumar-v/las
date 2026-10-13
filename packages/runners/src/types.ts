/** Shapes shared by every runner. Browser-safe: no node imports here. */
import type { Language, RunnerId } from "@las/schema";

/** One row per test in the spec, in spec order. */
export interface TestRow {
  label: string;
  hidden: boolean;
  pass: boolean;
  expected?: string;
  got?: string;
  /**
   * Why the test did not produce a comparable result. Always starts with one of these words, so the code
   * engine can sort failures without knowing the language:
   * `compile:` the code did not build or load; `timeout:` the time limit stopped it;
   * `runtime:` it crashed or threw; `not run:` an earlier problem stopped the run before this test.
   */
  error?: string;
  timeMs?: number;
}

/** What a runner returns. Must stay identical to CodeEvidence["result"] in @las/engines. */
export interface RunResult {
  runner: "browser" | "local" | "container";
  language: string;
  /** build or load result; for interpreted languages "ok" means the entry file loaded */
  compiled?: { ok: boolean; output: string };
  tests: TestRow[];
  /** wall time of the run steps (not the build), in ms */
  timeMs: number;
  lint?: { tool: string; findings: { file: string; line: number; message: string; rule?: string }[] }[];
  /** set only when the runner itself failed (missing toolchain, container would not start); never for the learner's mistakes */
  error?: string;
}

/** A command as an argument list, run from the workspace root. Paths are workspace-relative. */
export type Argv = string[];

export type LintFormat = "colon" | "eslint-json";

/** The concrete commands for one run, filled in from the language table. */
export interface CommandPlan {
  language: Language;
  /** the toolchain picked, by its main binary */
  tool: string;
  /** container image for this language (external, pulled by the learner's container runtime) */
  image: string;
  /** whether an address-space limit (ulimit -v) is safe for this language's runtime */
  vmLimit: boolean;
  /** extra environment for every step, already filled in */
  env: Record<string, string>;
  /** the generated harness runs every call/expect test; absent when the spec has none */
  harness?: { compile: Argv[]; run: Argv; tests: number[] };
  /** the learner's own program, run once per stdin/stdout test */
  program?: { compile: Argv[]; run: Argv; cases: { index: number; stdin: string; stdout: string }[] };
  /** each native test file: its steps run in order; the test passes when every step exits 0 */
  native: { index: number; steps: Argv[] }[];
  /** lint commands for tools the spec named and the table knows */
  lint: { tool: string; argv: Argv; format: LintFormat }[];
  /** set for browser runs: the harness source and one program source per stdin/stdout test */
  browser?: { harness: string; programs: { index: number; source: string; stdin: string }[] };
}

/** One step's outcome, the same whether it ran locally, in a container or in the browser. */
export interface StepResult {
  /** exit code; null when killed by a signal or never started */
  code: number | null;
  signal?: string | null;
  /** for harness steps this is stdout and stderr merged in arrival order */
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
  /** a dependency failed, so it never ran */
  skipped?: boolean;
  /** the command could not be started at all (missing binary) */
  spawnError?: string;
}

/** What the host has, as reported by get_capabilities. */
export interface RunnerCaps {
  /** languages with a browser runtime loaded in the studio */
  browser: string[];
  local: { language: string; tool: string; consented: boolean }[];
  container: { available: boolean; consented: boolean };
}

export type RunnerChoice = { runner: RunnerId; needsConsent: boolean; reason: string } | { runner: null; reason: string };
