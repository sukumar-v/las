/**
 * The local runner: the learner's own toolchains, run as separate processes in a fresh temp folder.
 *
 * Limits, all best effort and documented as such:
 * - time: each step has a time limit; on expiry its whole process group is killed;
 * - memory: an address-space limit (prlimit, or `ulimit -v` in a sh wrapper) for runtimes where that
 *   is safe; JVM, Node, Go and .NET get their own heap flags from the language table instead;
 * - network: on Linux the step runs under `unshare -n` (or `unshare -r -n`) when available; package
 *   managers also get offline settings. Elsewhere there is no network block, so the container runner
 *   is the choice when code must be fully isolated;
 * - environment: only a short allow-list of variables is passed (PATH, HOME, toolchain homes).
 * The local runner is not a file-system sandbox: code runs as the learner. That is why it needs the
 * learner's consent before its first use (see selectRunner).
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { TestSpec } from "@las/schema";
import { assembleResult, buildHarness, lintBinary, normalizePath, parseLint, planSteps, runnerFailure, stepOk } from "./harness.js";
import { LANGUAGE_TABLE, type Toolchain } from "./languages.js";
import { exec, memoryPrefix, networkPrefix, which } from "./process.js";
import type { RunResult, StepResult } from "./types.js";

export interface LocalOptions {
  /** parent folder for the temp workspace (default: the system temp folder) */
  workDir?: string;
  /** overrides spec.limits.time_s */
  timeoutS?: number;
  /** overrides spec.limits.memory_mb */
  memoryMb?: number;
  /** extra environment variables */
  env?: Record<string, string>;
  /** set false to skip `unshare -n` (default true) */
  isolateNetwork?: boolean;
  /** keep the temp folder for debugging */
  keep?: boolean;
}

const PASS_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "SYSTEMROOT",
  "PATHEXT",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "RUSTUP_HOME",
  "CARGO_HOME",
  "RUSTUP_TOOLCHAIN",
  "GOROOT",
  "GOPATH",
  "GOCACHE",
  "GOMODCACHE",
  "JAVA_HOME",
  "DOTNET_ROOT",
  "GEM_HOME",
  "GEM_PATH",
  "R_HOME",
  "R_LIBS_USER",
  "ZIG_GLOBAL_CACHE_DIR",
  "PUB_CACHE",
  "MIX_HOME",
  "HEX_HOME",
  "GHCUP_INSTALL_BASE_PREFIX",
  "STACK_ROOT",
  "CABAL_DIR",
  "COURSIER_CACHE"
];

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  env.LANG ??= "C.UTF-8";
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  return { ...env, ...extra };
}

/** The first toolchain for a language whose binaries are all on PATH. */
export function pickToolchain(language: string, path = process.env.PATH ?? ""): Toolchain | undefined {
  const def = (LANGUAGE_TABLE as Record<string, (typeof LANGUAGE_TABLE)[keyof typeof LANGUAGE_TABLE]>)[language];
  return def?.toolchains.find((t) => which(t.tool, path) && (t.needs ?? []).every((n) => which(n, path)));
}

/** Local toolchains for every language in the table, with versions: what get_capabilities reports. */
export function detectLocalToolchains(): { language: string; tool: string; version?: string }[] {
  const found: { language: string; tool: string; version?: string }[] = [];
  for (const def of Object.values(LANGUAGE_TABLE)) {
    const tc = pickToolchain(def.id);
    if (!tc) continue;
    let version: string | undefined;
    if (tc.versionArgs) {
      const r = spawnSync(tc.tool, tc.versionArgs, { encoding: "utf8", timeout: 15000, env: baseEnv() });
      version = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n").find((l) => l.trim() && !/^Picked up/.test(l))?.trim();
    }
    found.push({ language: def.id, tool: tc.tool, ...(version ? { version } : {}) });
  }
  return found;
}

function unsafePath(p: string): boolean {
  const n = normalizePath(p);
  return isAbsolute(p) || /^[A-Za-z]:/.test(p) || n.split("/").includes("..");
}

async function writeFiles(dir: string, files: Record<string, string>) {
  for (const [p, content] of Object.entries(files)) {
    const full = join(dir, p);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

export async function runLocal(spec: TestSpec, files: Record<string, string>, opts: LocalOptions = {}): Promise<RunResult> {
  const def = LANGUAGE_TABLE[spec.language];
  const run: TestSpec = opts.timeoutS ? { ...spec, limits: { ...spec.limits, time_s: opts.timeoutS } } : spec;
  const memoryMb = opts.memoryMb ?? spec.limits.memory_mb;
  const env = baseEnv(opts.env);
  const tc = pickToolchain(spec.language, env.PATH);
  if (!tc) return runnerFailure(spec, "local", `no ${def.label} toolchain was found on this computer (looked for ${def.toolchains.map((t) => t.tool).join(", ")})`);
  const bad = [spec.entry, ...Object.keys(files)].filter(unsafePath);
  if (bad.length) return runnerFailure(spec, "local", `file paths must stay inside the workspace: ${bad.join(", ")}`);

  const built = buildHarness(run, files, { tool: tc.tool, memoryMb });
  const plan = built.command;
  const dir = await mkdtemp(join(opts.workDir ?? tmpdir(), "las-run-"));
  try {
    await writeFiles(dir, built.files);
    await mkdir(join(dir, ".tmp"), { recursive: true });
    Object.assign(env, { TMPDIR: join(dir, ".tmp"), TMP: join(dir, ".tmp"), TEMP: join(dir, ".tmp") }, plan.env, opts.env ?? {});
    const net = opts.isolateNetwork === false ? [] : networkPrefix();

    const results: Record<string, StepResult> = {};
    let runnerError: string | undefined;
    for (const step of planSteps(run, plan)) {
      if (!step.after.every((id) => stepOk(results[id]))) {
        results[step.id] = { code: null, stdout: "", stderr: "", timedOut: false, ms: 0, skipped: true };
        continue;
      }
      if (!which(step.argv[0], env.PATH) && !step.argv[0].startsWith("./")) {
        results[step.id] = { code: null, stdout: "", stderr: "", timedOut: false, ms: 0, spawnError: `${step.argv[0]} is not installed` };
        if (!step.id.startsWith("n")) runnerError ??= `${step.argv[0]} is not installed`;
        continue;
      }
      const argv = [...net, ...(step.limited && plan.vmLimit ? memoryPrefix(memoryMb) : []), ...step.argv];
      results[step.id] = await exec(argv, { cwd: dir, env, stdin: step.stdin, timeoutS: step.timeoutS, merge: step.merge });
      if (results[step.id].spawnError && !step.id.startsWith("n")) runnerError ??= results[step.id].spawnError;
    }

    const lint: NonNullable<RunResult["lint"]> = [];
    const known = Object.keys(files).map(normalizePath);
    for (const l of plan.lint) {
      if (!which(lintBinary(spec.language, l.tool), env.PATH)) continue;
      const r = await exec([...net, ...l.argv], { cwd: dir, env, timeoutS: 60, merge: true });
      if (r.spawnError || r.timedOut) continue;
      lint.push({ tool: l.tool, findings: parseLint(r.stdout, l.format, known, dir) });
    }
    return assembleResult(run, plan, results, "local", { lint: lint.length ? lint : undefined, error: runnerError });
  } finally {
    if (!opts.keep) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
