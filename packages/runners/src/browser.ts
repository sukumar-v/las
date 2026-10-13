/**
 * Browser runners. No node imports: this file is loaded by the studio.
 *
 * Each runtime is lazy and supplied by the host page, so LAS bundles none of them:
 * - jsRuntime: JavaScript (and TypeScript) in a Web Worker built from a Blob, stopped at the time limit;
 * - pyodideRuntime(loadPyodide): Python via Pyodide (MPL-2.0), the host passes pyodide's loadPyodide;
 * - sqlJsRuntime(initSqlJs): SQLite via sql.js (MIT);
 * - rubyRuntime / phpRuntime: adapters for ruby.wasm (MIT) and php-wasm (Apache-2.0), given a loader
 *   that returns an interpreter which runs code and returns what it printed.
 * runInBrowser uses the same harness builder and output parser as the local and container runners.
 *
 * Covered by the studio's end-to-end tests (workers and wasm runtimes need a real browser).
 */
import type { TestSpec } from "@las/schema";
import { assembleResult, buildHarness, normalizePath, runnerFailure } from "./harness.js";
import { LANGUAGE_TABLE } from "./languages.js";
import { runSqlScript } from "./sql-script.js";
import type { RunResult, StepResult } from "./types.js";

export { buildHarness, parseHarnessOutput, normalizeOutput } from "./harness.js";
export { selectRunner } from "./select.js";
export { runSqlScript, splitSql } from "./sql-script.js";
export { LANGUAGE_TABLE } from "./languages.js";
export type * from "./types.js";

export interface BrowserRunOptions {
  timeoutMs?: number;
  stdin?: string;
}

export interface BrowserRuntime {
  language: string;
  run(files: Record<string, string>, entry: string, harnessSource: string, opts?: BrowserRunOptions): Promise<{ stdout: string; error?: string }>;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// ---------------------------------------------------------------------------------------------
// JavaScript and TypeScript

/** The worker's own code: captures console output and gives the harness a way to load scripts. */
export const JS_WORKER_SOURCE = `
self.onmessage = async (ev) => {
  const { files, entry, source } = ev.data;
  const send = (text) => self.postMessage({ type: "out", text });
  const fmt = (a) => a.map((x) => { if (typeof x === "string") return x; try { const s = JSON.stringify(x); return s === undefined ? String(x) : s; } catch { return String(x); } }).join(" ");
  for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = (...a) => send(fmt(a) + "\\n");
  self.__las_write = (s) => send(String(s));
  self.__las_files = files;
  self.__las_entry = entry;
  self.__las_loadScript = (src, name) => {
    const url = URL.createObjectURL(new Blob([src + "\\n//# sourceURL=" + name], { type: "text/javascript" }));
    try { importScripts(url); } finally { URL.revokeObjectURL(url); }
  };
  try {
    await (0, eval)(source);
    self.postMessage({ type: "done" });
  } catch (e) {
    self.postMessage({ type: "error", message: String((e && e.stack) || e) });
  }
};
`;

const TYPE = String.raw`[\w.$]+(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?(?:\[\])*(?:\s*\|\s*(?:[\w.$]+(?:<[^<>]*>)?(?:\[\])*|'[^']*'|"[^"]*"))*`;

function stripParams(params: string): string {
  return params.replace(new RegExp(String.raw`([\w$\]}])\s*\??\s*:\s*${TYPE}`, "g"), "$1").replace(/\b(public|private|protected|readonly)\s+/g, "");
}

/**
 * Removes TypeScript types so the code runs as JavaScript. Uses the TypeScript compiler when the host
 * page has loaded it as `globalThis.ts`; otherwise a regex pass that handles simple annotations only:
 * parameter, return and variable types, interfaces and type aliases, `as` casts, `!`, generics on
 * functions, access modifiers and class field types. Enums, namespaces, decorators and complex
 * generics need the compiler. Line numbers are kept.
 */
export function stripTypes(src: string): string {
  const ts = (globalThis as { ts?: { transpileModule(s: string, o: unknown): { outputText: string } } }).ts;
  if (ts?.transpileModule) return ts.transpileModule(src, { compilerOptions: { target: 99, module: 99 } }).outputText;
  const blank = (m: string) => m.replace(/[^\n]/g, "");
  return src
    .replace(/^[ \t]*(?:export\s+)?import\s+type\b[^;\n]*;?/gm, blank)
    .replace(/^[ \t]*(?:export\s+)?(?:declare\s+)?interface\s+[\w$]+[^{]*\{[\s\S]*?\n\}/gm, blank)
    .replace(/^[ \t]*(?:export\s+)?(?:declare\s+)?type\s+[\w$]+(?:<[^>]*>)?\s*=[\s\S]*?;[ \t]*$/gm, blank)
    .replace(/\b(function\s*\*?\s*[\w$]*\s*)<[^<>()]*>\s*\(/g, "$1(")
    .replace(/\b(class\s+[\w$]+)\s*<[^{]*?>(?=\s*(?:extends|implements|\{))/g, "$1")
    .replace(new RegExp(String.raw`(function\s*\*?\s*[\w$]*\s*\()([^()]*)\)\s*(?::\s*${TYPE})?`, "g"), (_m, head: string, params: string) => `${head}${stripParams(params)})`)
    .replace(new RegExp(String.raw`\(([^()]*)\)\s*(?::\s*${TYPE}\s*)?=>`, "g"), (_m, params: string) => `(${stripParams(params)}) =>`)
    .replace(new RegExp(String.raw`^([ \t]*(?:(?:static|async|get|set)\s+)*[\w$]+\s*)\(([^()]*)\)\s*(?::\s*${TYPE})?\s*\{`, "gm"), (m, head: string, params: string) => {
      if (/^\s*(if|for|while|switch|catch|return|function)\b/.test(head)) return m;
      // constructor(public x: T) also assigns this.x, on the same line
      const props = /^\s*constructor\b/.test(head) ? [...params.matchAll(/\b(?:public|private|protected|readonly)\s+(?:readonly\s+)?([\w$]+)/g)].map((p) => ` this.${p[1]} = ${p[1]};`).join("") : "";
      return `${head}(${stripParams(params)}) {${props}`;
    })
    .replace(new RegExp(String.raw`\b(const|let|var)\s+([\w$]+)\s*:\s*${TYPE}\s*(?==)`, "g"), "$1 $2 ")
    .replace(new RegExp(String.raw`^([ \t]*(?:(?:public|private|protected|readonly|static)\s+)*)([\w$]+)\s*[?!]?\s*:\s*${TYPE}\s*(=|;)`, "gm"), (_m, mods: string, name: string, end: string) => `${mods.replace(/\b(public|private|protected|readonly)\s+/g, "")}${name}${end === "=" ? " =" : ";"}`)
    .replace(new RegExp(String.raw`\s+as\s+(?:const\b|${TYPE})`, "g"), "")
    .replace(/([\w$\])])!(?=[.[),;\s])/g, "$1")
    .replace(/\bimplements\s+[\w$.,\s<>]+(?=\{)/g, "")
    .replace(/\b(public|private|protected|readonly)\s+(?=[\w$])/g, "");
}

/** The part of a Worker the JavaScript runtime uses. */
export interface WorkerLike {
  postMessage(data: unknown): void;
  terminate(): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

/** A classic Web Worker from a Blob URL. Hosts whose content security policy blocks blob: workers pass their own. */
export function blobWorker(source: string): WorkerLike & { url?: string } {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url) as unknown as WorkerLike;
  const terminate = worker.terminate.bind(worker);
  worker.terminate = () => {
    terminate();
    URL.revokeObjectURL(url);
  };
  return worker;
}

/** JavaScript in a Web Worker built from a Blob; TypeScript files are stripped of types first. */
export function jsRuntime(opts: { language?: "javascript" | "typescript"; timeoutMs?: number; createWorker?: (source: string) => WorkerLike } = {}): BrowserRuntime {
  const create = opts.createWorker ?? blobWorker;
  return {
    language: opts.language ?? "javascript",
    run(files, entry, source, o = {}) {
      const prepared: Record<string, string> = {};
      for (const [p, s] of Object.entries(files)) prepared[p] = /\.(ts|mts|cts|tsx)$/.test(p) ? stripTypes(s) : s;
      return new Promise((resolve) => {
        const worker = create(JS_WORKER_SOURCE);
        let out = "";
        let settled = false;
        const finish = (error?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          worker.terminate();
          resolve(error ? { stdout: out, error } : { stdout: out });
        };
        const timer = setTimeout(() => finish("timeout"), o.timeoutMs ?? opts.timeoutMs ?? 10000);
        worker.onmessage = (e: MessageEvent<{ type: string; text?: string; message?: string }>) => {
          if (e.data.type === "out") out += e.data.text ?? "";
          else if (e.data.type === "done") finish();
          else finish(e.data.message ?? "error");
        };
        worker.onerror = (e: ErrorEvent) => {
          e.preventDefault();
          finish(e.message || "the worker failed");
        };
        worker.postMessage({ files: prepared, entry, source });
      });
    }
  };
}

export const typescriptRuntime = (opts: { timeoutMs?: number; createWorker?: (source: string) => WorkerLike } = {}) => jsRuntime({ ...opts, language: "typescript" });

// ---------------------------------------------------------------------------------------------
// Python (Pyodide)

/** The part of a Pyodide instance this runner uses. */
export interface PyodideLike {
  runPythonAsync(code: string): Promise<unknown>;
  setStdout(o: { batched: (s: string) => void }): void;
  setStderr(o: { batched: (s: string) => void }): void;
  FS: { mkdirTree(path: string): void; writeFile(path: string, data: string): void };
}

/**
 * Python through Pyodide. Pyodide runs on the thread that loaded it, so a long loop cannot be stopped
 * from here: hosts that need a hard time limit load Pyodide in a worker and pass a loader for it.
 * A run that returns after the limit is still reported as a timeout.
 */
export function pyodideRuntime(loadPyodide: () => Promise<PyodideLike>): BrowserRuntime {
  let py: Promise<PyodideLike> | undefined;
  let n = 0;
  return {
    language: "python",
    async run(files, _entry, source, o = {}) {
      const p = await (py ??= loadPyodide());
      const dir = `/tmp/las_${++n}`;
      for (const [path, content] of Object.entries(files)) {
        const full = `${dir}/${path}`;
        p.FS.mkdirTree(full.slice(0, full.lastIndexOf("/")));
        p.FS.writeFile(full, content);
      }
      let out = "";
      const sink = { batched: (s: string) => void (out += s + "\n") };
      p.setStdout(sink);
      p.setStderr(sink);
      const t0 = now();
      try {
        // forget modules from earlier runs so the learner's files are read again
        await p.runPythonAsync(`import os, sys\nfor _k, _m in list(sys.modules.items()):\n    if (getattr(_m, "__file__", None) or "").startswith("/tmp/las_"):\n        del sys.modules[_k]\nos.chdir(${JSON.stringify(dir)})`);
        await p.runPythonAsync(source);
        return o.timeoutMs && now() - t0 > o.timeoutMs ? { stdout: out, error: "timeout" } : { stdout: out };
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (/SystemExit/.test(msg)) return { stdout: out };
        return { stdout: out, error: msg };
      } finally {
        try {
          await p.runPythonAsync("import os\nos.chdir('/')");
        } catch {}
      }
    }
  };
}

// ---------------------------------------------------------------------------------------------
// SQL (sql.js)

export interface SqlJsLike {
  Database: new () => { exec(sql: string): { columns: string[]; values: unknown[][] }[]; close(): void };
}

export function sqlJsRuntime(initSqlJs: () => Promise<SqlJsLike>): BrowserRuntime {
  let sql: Promise<SqlJsLike> | undefined;
  return {
    language: "sql",
    async run(files, _entry, source) {
      const SQL = await (sql ??= initSqlJs());
      const db = new SQL.Database();
      try {
        return { stdout: runSqlScript(source, files, (q) => db.exec(q)) };
      } finally {
        db.close();
      }
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Ruby (ruby.wasm) and PHP (php-wasm): thin adapters

/** What a host adapter for a WebAssembly interpreter provides: run code, return what it printed. */
export interface WasmInterpreter {
  run(code: string, opts?: BrowserRunOptions): Promise<{ stdout: string; error?: string }>;
}

function interpreterRuntime(language: string, loader: () => Promise<WasmInterpreter>): BrowserRuntime {
  let vm: Promise<WasmInterpreter> | undefined;
  return {
    language,
    async run(_files, _entry, source, o) {
      const i = await (vm ??= loader());
      return i.run(source, o);
    }
  };
}

/** The harness inlines the entry file, so the interpreter needs no file system. */
export const rubyRuntime = (loader: () => Promise<WasmInterpreter>) => interpreterRuntime("ruby", loader);
export const phpRuntime = (loader: () => Promise<WasmInterpreter>) => interpreterRuntime("php", loader);

// ---------------------------------------------------------------------------------------------

/** Runs the spec's tests with a browser runtime and returns the same RunResult the other runners do. */
export async function runInBrowser(spec: TestSpec, files: Record<string, string>, runtimes: BrowserRuntime[]): Promise<RunResult> {
  const def = LANGUAGE_TABLE[spec.language];
  const rt = runtimes.find((r) => r.language === spec.language) ?? (spec.language === "typescript" ? runtimes.find((r) => r.language === "javascript") : undefined);
  if (!def.browser || !rt) return runnerFailure(spec, "browser", `no browser runtime for ${def.label} is loaded`);
  const built = buildHarness(spec, files, { target: "browser" });
  const plan = built.command;
  const timeoutMs = spec.limits.time_s * 1000;
  const entry = normalizePath(spec.entry);
  const results: Record<string, StepResult> = {};
  let runnerError: string | undefined;

  const step = async (source: string, stdin?: string): Promise<StepResult> => {
    const t0 = now();
    try {
      const r = await rt.run(built.files, entry, source, { timeoutMs, stdin });
      const timedOut = r.error === "timeout";
      return { code: r.error && !timedOut ? 1 : 0, signal: null, stdout: r.stdout, stderr: r.error && !timedOut ? r.error : "", timedOut, ms: now() - t0 };
    } catch (e) {
      runnerError ??= `the ${def.label} browser runtime failed: ${String((e as Error)?.message ?? e)}`;
      return { code: null, stdout: "", stderr: "", timedOut: false, ms: now() - t0, spawnError: runnerError };
    }
  };

  if (plan.harness && plan.browser) results.hr = await step(plan.browser.harness);
  for (const p of plan.browser?.programs ?? []) if (p.source) results[`p${p.index}`] = await step(p.source, p.stdin);
  return assembleResult(spec, plan, results, "browser", { missingReason: "this kind of test needs the local or container runner", error: runnerError });
}
