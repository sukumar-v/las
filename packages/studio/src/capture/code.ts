/**
 * Code runs in the browser sandbox when the language has a browser runtime: JavaScript and TypeScript in a
 * Web Worker, Python with Pyodide (MPL-2.0) and SQL with sql.js (MIT), both served from the studio's /vendor.
 * Other languages go to the server's local toolchain or container runner, after the learner says yes once.
 */
import type { TestSpec } from "@las/schema";
import { jsRuntime, typescriptRuntime, pyodideRuntime, sqlJsRuntime, runInBrowser, LANGUAGE_TABLE, type BrowserRuntime, type RunResult, type PyodideLike, type SqlJsLike } from "@las/runners/browser";

export const BROWSER_LANGUAGES = ["javascript", "typescript", "python", "sql"] as const;

let runtimes: BrowserRuntime[] | undefined;

function browserRuntimes(): BrowserRuntime[] {
  runtimes ??= [
    jsRuntime(),
    typescriptRuntime(),
    pyodideRuntime(async () => {
      const url = "/vendor/pyodide/pyodide.mjs";
      const mod = await import(/* @vite-ignore */ url);
      return (await mod.loadPyodide({ indexURL: "/vendor/pyodide/" })) as PyodideLike;
    }),
    sqlJsRuntime(async () => {
      const mod = await import("sql.js");
      const init = (mod.default ?? mod) as (o: { locateFile: (f: string) => string }) => Promise<SqlJsLike>;
      return init({ locateFile: () => "/vendor/sqljs/sql-wasm-browser.wasm" });
    })
  ];
  return runtimes;
}

/** Whether this spec runs here in the browser (its runner list allows it and the language has a runtime). */
export function runsInBrowser(spec: Pick<TestSpec, "language" | "runner" | "tests">): boolean {
  const def = LANGUAGE_TABLE[spec.language];
  if (!def?.browser || !(BROWSER_LANGUAGES as readonly string[]).includes(spec.language)) return false;
  if (!(spec.runner ?? ["browser"]).includes("browser")) return false;
  return !spec.tests.some((t) => "native" in t);
}

export async function runHere(spec: TestSpec, files: Record<string, string>): Promise<RunResult> {
  return runInBrowser(spec, files, browserRuntimes());
}

/** The editor's starting files: the spec's starter, else an empty entry file. */
export function starterFiles(spec: Pick<TestSpec, "entry" | "starter">): Record<string, string> {
  return spec.starter && Object.keys(spec.starter).length ? { ...spec.starter } : { [spec.entry]: "" };
}

/** Rows for the live test list: hidden tests show as "hidden" until they run. */
export function testRows(spec: Pick<TestSpec, "tests">, result?: Pick<RunResult, "tests">): { label: string; pass?: boolean }[] {
  return spec.tests.map((t, i) => {
    const r = result?.tests[i];
    const label = t.hidden ? "hidden test" : (t.label ?? ("call" in t ? `${t.call} → ${t.expect}` : "stdin" in t ? `input → ${t.stdout.slice(0, 30)}` : t.native));
    return { label, pass: r ? r.pass : undefined };
  });
}
