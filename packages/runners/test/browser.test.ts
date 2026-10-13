/**
 * Browser runners under node. Real Web Workers and WebAssembly runtimes are covered by the studio's
 * end-to-end tests; here the JavaScript worker's own code runs in a node `vm` context standing in for
 * the worker, SQL runs through node's built-in SQLite standing in for sql.js, and Ruby/PHP adapters
 * get an interpreter that shells out to the local toolchain when one is installed.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { TestSpecSchema } from "@las/schema";
import { jsRuntime, phpRuntime, rubyRuntime, runInBrowser, sqlJsRuntime, stripTypes, typescriptRuntime, type SqlJsLike, type WasmInterpreter, type WorkerLike } from "../src/browser.js";
import { runSqlScript, splitSql } from "../src/sql-script.js";
import { which } from "../src/process.js";

function fixture(lang: string) {
  const dir = join(import.meta.dirname, "fixtures", lang);
  const raw = JSON.parse(readFileSync(join(dir, "spec.json"), "utf8"));
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (f !== "spec.json") files[f] = readFileSync(join(dir, f), "utf8");
  return { raw, spec: TestSpecSchema.parse({ ...raw, runner: ["browser"] }), files };
}

/** Runs the worker's real source in a vm context with the few worker globals it uses. */
function vmWorker(source: string): WorkerLike {
  const blobs = new Map<string, string>();
  let n = 0;
  const w: WorkerLike = { onmessage: null, onerror: null, postMessage: () => {}, terminate: () => {} };
  const ctx = vm.createContext({
    console: {},
    Blob: class {
      text: string;
      constructor(parts: string[]) {
        this.text = parts.join("");
      }
    },
    URL: { createObjectURL: (b: { text: string }) => (blobs.set(`blob:${++n}`, b.text), `blob:${n}`), revokeObjectURL: (u: string) => blobs.delete(u) },
    importScripts: (u: string) => vm.runInContext(blobs.get(u)!, ctx, { filename: "learner-script" }),
    postMessage: (data: unknown) => setTimeout(() => w.onmessage?.({ data } as MessageEvent), 0)
  }) as { self?: unknown; onmessage?: (e: { data: unknown }) => Promise<void> };
  ctx.self = ctx;
  vm.runInContext(source, ctx);
  w.postMessage = (data) => setTimeout(() => void ctx.onmessage?.({ data }), 0);
  return w;
}

describe("stripTypes (no TypeScript compiler loaded)", () => {
  it("removes simple annotations and keeps line numbers", () => {
    const ts = [
      "interface Point {",
      "  x: number;",
      "}",
      "type Id = string | number;",
      "export function dist(p: Point, q?: Point): number {",
      "  const k: number = 2;",
      "  return Math.hypot(p.x - (q?.x ?? 0), k * 0);",
      "}",
      "const twice = (n: number): number => n * 2;",
      "class Box<T> {",
      "  private items: T[] = [];",
      "  constructor(public label: string) {}",
      "  add(item: T): void { this.items.push(item); }",
      "  size(): number { return this.items.length; }",
      "}",
      "function first<T>(xs: T[]): T { return xs[0]!; }",
      "const v = first([3, 4]) as number;"
    ].join("\n");
    const js = stripTypes(ts);
    expect(js.split("\n").length).toBe(ts.split("\n").length);
    const run = new Function(`${js.replace(/^export /gm, "")}\nconst b = new Box("x"); b.add(1); b.add(2);\nreturn [dist({ x: 3 }), twice(4), b.size(), b.label, v];`);
    expect(run()).toEqual([3, 8, 2, "x", 3]);
  });
});

describe("SQL script runner", () => {
  it("splits statements around quotes, comments and trigger bodies", () => {
    const parts = splitSql("SELECT 'a;b'; -- c;\nCREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE y SET n = 1; END;\nSELECT 2");
    expect(parts.map((p) => p.sql.trim())).toEqual(["SELECT 'a;b';", "-- c;\nCREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE y SET n = 1; END;", "SELECT 2"]);
  });

  it("prints like the sqlite3 shell's list mode and handles the dot commands LAS uses", () => {
    const seen: string[] = [];
    const exec = (sql: string) => {
      seen.push(sql.trim());
      if (/missing/.test(sql)) throw new Error("no such table: missing");
      return /SELECT/i.test(sql) ? [{ columns: ["a", "b"], values: [[1, null], ["x", 2.5]] }] : [];
    };
    const out = runSqlScript([".headers on", ".read 'db.sql'", ".print ##LAS## begin 0", "SELECT a,", "  b FROM t;", ".print ##LAS## end 0", "SELECT * FROM missing;", ".nonsense"].join("\n"), { "db.sql": "CREATE TABLE t (a, b);\n" }, exec);
    expect(seen).toEqual(["CREATE TABLE t (a, b);", "SELECT a,\n  b FROM t;", "SELECT * FROM missing;"]);
    expect(out).toBe(['##LAS## begin 0', "a|b", "1|", "x|2.5", "##LAS## end 0", "Error: near line 7: no such table: missing", 'Error: unknown command or invalid arguments: "nonsense"', ""].join("\n"));
  });
});

describe("runInBrowser", () => {
  it("fails as a runner error when no runtime for the language is loaded", async () => {
    const { spec, files } = fixture("python");
    const r = await runInBrowser(spec, files, []);
    expect(r.error).toMatch(/no browser runtime for Python/);
    expect(r.runner).toBe("browser");
  });

  it("javascript: the worker runs the harness and the stdin program", async () => {
    const { spec, files, raw } = fixture("javascript");
    const r = await runInBrowser(spec, files, [jsRuntime({ createWorker: vmWorker })]);
    expect(r.error).toBeUndefined();
    expect(r.compiled?.ok).toBe(true);
    expect(r.tests.map((t) => t.pass)).toEqual([true, true, true, false, false, true]);
    expect(r.tests[4].error).toMatch(/^runtime: RangeError: division by zero/);
    expect(r.tests[5].got).toBe(raw.tests[5].stdout);
  });

  it("typescript: files are stripped of types before they run", async () => {
    const { spec, files } = fixture("typescript");
    const r = await runInBrowser(spec, files, [typescriptRuntime({ createWorker: vmWorker })]);
    expect(r.tests.map((t) => t.pass)).toEqual([true, true, true, false, false, true]);
  });

  it("javascript: imports of other workspace files and node's fs work in the browser too", async () => {
    const spec = TestSpecSchema.parse({ language: "javascript", entry: "src/main.js", tests: [{ call: "total()", expect: "42" }, { call: "label()", expect: "util" }, { stdin: "7\n", stdout: "8" }] });
    const files = {
      "src/main.js": 'import { helper, name as label } from "./util.js";\nimport fs from "node:fs";\nconst { one } = require("./lib/one.cjs");\nexport function total() {\n  return helper() + one;\n}\nif (require.main === module) console.log(Number(fs.readFileSync(0, "utf8")) + one);\n',
      "src/util.js": 'export const helper = () => 41;\nexport function name() {\n  return "util";\n}\n',
      "src/lib/one.cjs": "module.exports = { one: 1 };\n"
    };
    const r = await runInBrowser(spec, files, [jsRuntime({ createWorker: vmWorker })]);
    expect(r.tests.map((t) => [t.pass, t.got])).toEqual([[true, "42"], [true, "util"], [true, "8"]]);
  });

  it("javascript: a syntax error in the learner's file is a compile error", async () => {
    const spec = TestSpecSchema.parse({ language: "javascript", entry: "a.js", tests: [{ call: "f()", expect: "1" }] });
    const r = await runInBrowser(spec, { "a.js": "function f( {" }, [jsRuntime({ createWorker: vmWorker })]);
    expect(r.compiled?.ok).toBe(false);
    expect(r.tests[0].error).toMatch(/^compile: SyntaxError/);
  });

  const require = createRequire(import.meta.url);
  let sqlite: { DatabaseSync: new (p: string) => { prepare(s: string): { all(): Record<string, unknown>[] }; close(): void } } | undefined;
  try {
    sqlite = require("node:sqlite");
  } catch {}
  (sqlite ? it : it.skip)(`sql: the sql.js adapter runs the same harness${sqlite ? "" : " (skipped: node:sqlite is not available)"}`, async () => {
    // node's built-in SQLite stands in for sql.js: same exec() shape
    const fakeSqlJs: SqlJsLike = {
      Database: class {
        db = new sqlite!.DatabaseSync(":memory:");
        exec(sql: string) {
          const rows = this.db.prepare(sql).all();
          return rows.length ? [{ columns: Object.keys(rows[0]), values: rows.map((r) => Object.values(r)) }] : [];
        }
        close() {
          this.db.close();
        }
      }
    };
    const { spec, files } = fixture("sql");
    const r = await runInBrowser(spec, files, [sqlJsRuntime(async () => fakeSqlJs)]);
    expect(r.compiled?.ok).toBe(true);
    expect(r.tests.map((t) => t.pass)).toEqual([true, true, true, false, false, true]);
    expect(r.tests[4].error).toMatch(/^runtime: Error: near line \d+: no such table: missing_table/);
  });

  const viaCli = (bin: string): WasmInterpreter => ({
    async run(code) {
      const r = spawnSync(bin, [], { input: code, encoding: "utf8", timeout: 20000 });
      return r.status === 0 || r.stdout ? { stdout: r.stdout } : { stdout: r.stdout, error: r.stderr };
    }
  });
  for (const [lang, make] of [["ruby", rubyRuntime], ["php", phpRuntime]] as const) {
    (which(lang) ? it : it.skip)(`${lang}: the wasm adapter's harness carries the entry inline${which(lang) ? "" : ` (skipped: ${lang} not installed)`}`, async () => {
      const { spec, files } = fixture(lang);
      const r = await runInBrowser(spec, files, [make(async () => viaCli(lang))]);
      // the call tests run; PHP has no browser stdin program, so that test says why it did not run
      expect(r.tests.slice(0, 5).map((t) => t.pass)).toEqual([true, true, true, false, false]);
      expect(r.tests[4].error).toMatch(/^runtime: /);
      if (lang === "php") expect(r.tests[5].error).toMatch(/^not run: this kind of test needs the local or container runner/);
      else expect(r.tests[5].pass).toBe(true);
    });
  }
});
