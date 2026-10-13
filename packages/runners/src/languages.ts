/**
 * Everything LAS knows about each programming language, in one table. Browser-safe: no node imports.
 *
 * Each row says how to run that language: file extensions, toolchains (commands with placeholders),
 * the generated test harness, how a value is printed, native test and lint commands, a container
 * image and whether a browser runtime exists. Engines and runners never branch on a language name;
 * they read this table. Container images are external and optional: the learner's container
 * runtime pulls them, LAS never bundles them.
 *
 * The harness contract, the same for every language:
 * - load the entry file; if it fails to build or load, print `##LAS## compile-error` then the reason;
 * - for each call test, print `##LAS## begin <i>`, evaluate the call and print its value,
 *   on an exception print `##LAS## error` then a one-line reason (with `file:line` when known),
 *   then print `##LAS## end <i>` and flush.
 * A call that ends with `;` is run as a statement: only what it prints counts.
 *
 * Placeholders in command templates: {tool} {entry} {entryDir} {entryBase} {entryStem} {harness}
 * {memoryMb} {test} {testStem} {testClass}, plus per-language ones from `vars`. An argument that is
 * exactly {sources}, {otherSources} or {mirrorSources} expands to a list of files.
 */
import type { Language } from "@las/schema";
import type { Argv, LintFormat } from "./types.js";

export const MARK = "##LAS##";
/** Folder for rewritten copies of the learner's files, for languages whose harness must live beside them. */
export const MIRROR = "las_h";

export interface HarnessCase {
  /** index in spec.tests */
  index: number;
  /** the call as written, trimmed */
  call: string;
  /** ends with `;`: run it as a statement and print nothing extra */
  statement: boolean;
}

export interface HarnessContext {
  entry: string;
  entryBase: string;
  entryStem: string;
  /** folder of the entry, "" at the workspace root */
  entryDir: string;
  files: Record<string, string>;
  cases: HarnessCase[];
  /** native test files, so they are left out of {sources} */
  nativePaths: string[];
  target: "native" | "browser";
}

export interface Toolchain {
  /** main binary, looked up on PATH */
  tool: string;
  /** other binaries this toolchain also needs */
  needs?: string[];
  /** prints the version, for get_capabilities */
  versionArgs?: string[];
  /** build the harness (skipped for interpreters) */
  compile?: Argv[];
  run: Argv;
  /** the run step also builds, so it gets the build time allowance */
  runBuilds?: boolean;
  /** build the learner's own program for stdin/stdout tests */
  programCompile?: Argv[];
  program: Argv;
  /** steps for one native test file; the last one is the test run */
  native?: Argv[];
  /** support files this toolchain needs in the workspace */
  files?: Record<string, string>;
}

export interface LintDef {
  /** binary to look for; defaults to the lint tool's name */
  bin?: string;
  argv: Argv;
  format?: LintFormat;
}

export type BrowserRuntimeKind = "javascript" | "typescript" | "python" | "sql" | "ruby" | "php";

export interface LanguageDef {
  id: Language;
  label: string;
  exts: string[];
  /** how a call's value is printed, for whoever writes `expect` */
  valueFormat: string;
  /** container image, from Docker Hub; official images unless `imageNote` says otherwise */
  image?: string;
  imageNote?: string;
  /** which toolchain the image provides */
  imageTool?: string;
  browser?: BrowserRuntimeKind;
  /** an address-space limit (ulimit -v) is safe; false for runtimes that reserve large virtual memory (JVM, V8, Go, .NET) */
  vmLimit: boolean;
  env?: Record<string, string>;
  harnessFile: string;
  /** generated files (path -> content); always includes harnessFile */
  harness(ctx: HarnessContext): Record<string, string>;
  /** source that runs the learner's program on the given stdin inside a browser runtime */
  browserProgram?(ctx: HarnessContext, stdin: string): string;
  vars?(ctx: HarnessContext): Record<string, string>;
  /** source files for {sources}; defaults to every workspace file with one of `exts` */
  sources?(ctx: HarnessContext): string[];
  toolchains: Toolchain[];
  lint: Record<string, LintDef>;
  /** a line in a test's output that means the call failed (for tools that print errors instead of throwing) */
  errorPattern?: RegExp;
}

// ---------------------------------------------------------------------------------------------
// small helpers for writing source in other languages

const code = String.raw;
/** a double-quoted literal with JSON escapes: valid in JS, Python, Java, Kotlin, C#, Go, Swift, R */
const dq = (s: string) => JSON.stringify(s);
/** a single-quoted literal where only \\ and \' are escapes: Ruby, PHP, Dart (with $ escaped) */
const sq = (s: string) => "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
function luaLong(s: string): string {
  let eq = "";
  while (s.includes("]" + eq + "]")) eq += "=";
  // Lua drops a newline right after the opening bracket, so keep a leading one by doubling it
  return "[" + eq + "[" + (s.startsWith("\n") ? "\n" : "") + s + "]" + eq + "]";
}
const noSemi = (call: string) => call.replace(/;\s*$/, "");
export const extOf = (p: string) => {
  const b = p.split("/").pop() ?? p;
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i).toLowerCase() : "";
};
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** Copies every file with one of `exts` into the mirror folder, rewriting the entry. */
function mirror(ctx: HarnessContext, exts: string[], rewrite: (src: string) => string, only?: (path: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, src] of Object.entries(ctx.files)) {
    if (!exts.includes(extOf(p)) || ctx.nativePaths.includes(p)) continue;
    if (only && !only(p)) continue;
    out[`${MIRROR}/${p}`] = p === ctx.entry ? rewrite(src) : src;
  }
  return out;
}

/** Finds the closing brace of `class <name>`'s body, skipping comments, strings and chars. */
export function findClassBodyEnd(src: string, name: string): number {
  let i = 0;
  let depth = 0;
  let armed = false;
  let inBody = false;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src.slice(i, i + 2);
    if (c2 === "//") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c2 === "/*") {
      const e = src.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (src.startsWith('"""', i)) {
      const e = src.indexOf('"""', i + 3);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (!inBody && /[A-Za-z_$]/.test(c) && (i === 0 || !/[\w$]/.test(src[i - 1]))) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))!;
      if (m[0] === "class") {
        const rest = /^\s+([A-Za-z_$][\w$]*)/.exec(src.slice(i + 5));
        if (rest && rest[1] === name) armed = true;
      }
      i += m[0].length;
      continue;
    }
    if (c === "{") {
      if (armed && !inBody) {
        inBody = true;
        depth = 0;
      }
      if (inBody) depth++;
    } else if (c === "}" && inBody) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// JavaScript and TypeScript

function jsNodeHarness(ctx: HarnessContext, ts: boolean): string {
  const calls = ctx.cases.map((c) => `await lasRun(${c.index}, ${dq(c.call)}, ${c.statement});`).join("\n");
  return code`// Generated by LAS: runs each test call and prints marked results. Do not edit.
import { readFileSync } from "node:fs";
import * as lasModule from "node:module";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
const M = "##LAS##";
const ENTRY = resolve(${dq(ctx.entry)});
const BASE = basename(ENTRY);
const TS = ${String(ts)};
const strip = (src) => (TS && lasModule.stripTypeScriptTypes ? lasModule.stripTypeScriptTypes(src) : src);
function where(e) {
  const line = String((e && e.stack) || "").split("\n").find((l) => l.includes(BASE));
  const m = line && line.match(/:(\d+)(?::\d+)?\)?\s*$/);
  return m ? " (" + BASE + ":" + m[1] + ")" : "";
}
const describe = (e) => (e && e.name ? e.name + ": " + e.message : String(e)) + where(e);
function show(v) {
  if (v === undefined) return;
  if (typeof v === "string") return console.log(v);
  if (v !== null && typeof v === "object") {
    try {
      const s = JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x instanceof Set ? [...x] : x));
      if (s !== undefined) return console.log(s);
    } catch {}
  }
  console.log(String(v));
}
try {
  const src = readFileSync(ENTRY, "utf8");
  if (/^\s*(import\s*[\w{*'"]|export\s)/m.test(src) || /\.m[jt]s$/.test(ENTRY)) {
    Object.assign(globalThis, await import(pathToFileURL(ENTRY).href));
  } else {
    const module = { exports: {} };
    Object.assign(globalThis, { require: lasModule.createRequire(ENTRY), module, exports: module.exports, __filename: ENTRY, __dirname: dirname(ENTRY) });
    vm.runInThisContext(strip(src), { filename: ENTRY });
    if (module.exports && typeof module.exports === "object") Object.assign(globalThis, module.exports);
  }
} catch (e) {
  console.log(M + " compile-error");
  console.log(describe(e));
  process.exit(1);
}
async function lasRun(i, src, statement) {
  console.log(M + " begin " + i);
  try {
    let v = vm.runInThisContext(strip(src), { filename: "test" });
    if (v && typeof v.then === "function") v = await v;
    if (!statement) show(v);
  } catch (e) {
    console.log(M + " error");
    console.log(describe(e));
  }
  console.log(M + " end " + i);
}
${calls}
`;
}

/**
 * Shared by the browser harness and browser programs. The entry file runs as a plain script so its
 * top-level functions are globals; `import` lines become calls to a small `require` that serves
 * `fs` (stdin only), `readline` and the workspace's own relative files (run as CommonJS modules).
 * `process` is a stub. Line numbers are kept.
 */
function jsBrowserPrelude(ctx: HarnessContext, stdin: string, program: boolean): string {
  return code`const M = "##LAS##";
const ENTRY = ${dq(ctx.entry)};
const LAS_STDIN = ${dq(stdin)};
const lasLines = LAS_STDIN.split("\n");
if (lasLines[lasLines.length - 1] === "") lasLines.pop();
const lasListeners = { line: [], close: [], data: [], end: [] };
const lasOn = function (ev, f) { (lasListeners[ev] || (lasListeners[ev] = [])).push(f); return this; };
const lasWrite = { write: (s) => { __las_write(String(s)); return true; } };
self.process = { argv: ${program ? `["node", ENTRY]` : `["browser"]`}, env: {}, platform: "browser", stdin: { on: lasOn, setEncoding() { return this; }, resume() { return this; } }, stdout: lasWrite, stderr: lasWrite, exit: (c) => { throw { lasExit: c || 0 }; } };
const LAS_BUILTINS = {
  fs: { readFileSync(f) { if (f === 0 || f === "/dev/stdin") return LAS_STDIN; throw new Error("files other than stdin are not available in the browser runner"); } },
  readline: { createInterface: () => ({ on: lasOn, close() {}, [Symbol.asyncIterator]: async function* () { yield* lasLines; } }) }
};
const lasNewlines = (s) => s.replace(/[^\n]/g, "");
function lasImportClause(clause, spec) {
  const req = "require(" + JSON.stringify(spec) + ")";
  const c = clause.trim();
  let m = /^\*\s+as\s+([\w$]+)$/.exec(c);
  if (m) return "const " + m[1] + " = " + req + ";";
  m = /^([\w$]+)?\s*,?\s*(?:\{([\s\S]*)\})?$/.exec(c);
  if (!m) return "";
  const out = [];
  if (m[1]) out.push("const " + m[1] + " = ((r) => (r && typeof r === 'object' && 'default' in r ? r.default : r))(" + req + ");");
  if (m[2] !== undefined) {
    const names = m[2].split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("type ")).map((s) => s.replace(/\s+as\s+/, ": "));
    out.push("const { " + names.join(", ") + " } = " + req + ";");
  }
  return out.join(" ");
}
function lasImports(src) {
  return src
    .replace(/^([ \t]*)import\s+type\b[^;\n]*;?/gm, "$1")
    .replace(/^([ \t]*)import\s+([^'";]*?)\s+from\s*(['"])([^'"\n]+)\3;?/gm, (m, ind, clause, _q, spec) => ind + lasImportClause(clause, spec) + lasNewlines(m))
    .replace(/^([ \t]*)import\s*(['"])([^'"\n]+)\2;?/gm, (_m, ind, _q, spec) => ind + "require(" + JSON.stringify(spec) + ");");
}
/** The entry runs as a script: export keywords are dropped so its declarations become globals. */
function lasStripModules(src) {
  return lasImports(src)
    .replace(/^([ \t]*)export\s*\{[^}]*\}\s*(from\s*['"][^'"\n]+['"])?;?/gm, (m, ind) => ind + lasNewlines(m))
    .replace(/^([ \t]*)export\s+default\s+(?=(async\s+)?(function|class)\b)/gm, "$1")
    .replace(/^([ \t]*)export\s+default\s+/gm, "$1var __default = ")
    .replace(/^([ \t]*)export\s+/gm, "$1");
}
/** Other workspace files run as CommonJS modules. */
function lasToCommonJs(src) {
  const names = [];
  const body = lasImports(src)
    .replace(/^([ \t]*)export\s*\{([^}]*)\}\s*(?:from\s*(['"])([^'"\n]+)\3)?;?/gm, (m, ind, list, _q, from) => {
      const pairs = list.split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("type ")).map((s) => { const [a, b] = s.split(/\s+as\s+/); return [a.trim(), (b || a).trim()]; });
      if (from) return ind + "Object.assign(module.exports, ((r) => ({" + pairs.map(([a, b]) => JSON.stringify(b) + ": r[" + JSON.stringify(a) + "]").join(", ") + "}))(require(" + JSON.stringify(from) + ")));" + lasNewlines(m);
      names.push(...pairs);
      return ind + lasNewlines(m);
    })
    .replace(/^([ \t]*)export\s+default\s+(async\s+)?(function\s*\*?|class)\s*([\w$]+)/gm, (_m, ind, a, kw, name) => { names.push([name, "default"]); return ind + (a || "") + kw + " " + name; })
    .replace(/^([ \t]*)export\s+default\s+/gm, "$1module.exports.default = ")
    .replace(/^([ \t]*)export\s+((?:async\s+)?function\s*\*?\s*|class\s+|const\s+|let\s+|var\s+)([\w$]+)/gm, (_m, ind, kw, name) => { names.push([name, name]); return ind + kw + name; });
  return body + "\n" + names.map(([a, b]) => "module.exports[" + JSON.stringify(b) + "] = " + a + ";").join(" ");
}
const lasModules = {};
function lasResolve(from, spec) {
  if (!/^\.\.?\//.test(spec)) return null;
  const parts = from.split("/").slice(0, -1);
  for (const p of spec.split("/")) { if (p === "..") parts.pop(); else if (p !== ".") parts.push(p); }
  const p = parts.join("/");
  for (const c of [p, p + ".js", p + ".mjs", p + ".cjs", p + ".ts", p + "/index.js", p + "/index.ts"]) if (__las_files[c] !== undefined) return c;
  return null;
}
function lasRequire(from) {
  return function require(spec) {
    const name = String(spec).replace(/^node:/, "");
    if (Object.prototype.hasOwnProperty.call(LAS_BUILTINS, name)) return LAS_BUILTINS[name];
    const path = lasResolve(from, String(spec));
    if (!path) throw new Error("module " + spec + " is not available in the browser runner");
    if (lasModules[path]) return lasModules[path].exports;
    const module = (lasModules[path] = { exports: {} });
    (0, eval)("(function (module, exports, require) {" + lasToCommonJs(__las_files[path]) + "\n})\n//# sourceURL=" + path)(module, module.exports, lasRequire(path));
    return module.exports;
  };
}
self.module = { exports: {} };
self.exports = self.module.exports;
self.require = lasRequire(ENTRY);
self.require.main = ${program ? "self.module" : "undefined"};
`;
}

function jsBrowserHarness(ctx: HarnessContext): string {
  const calls = ctx.cases.map((c) => `await lasRun(${c.index}, ${dq(c.call)}, ${c.statement});`).join("\n");
  return code`(async () => {
${jsBrowserPrelude(ctx, "", false)}
const BASE = ENTRY.split("/").pop();
function where(e) {
  const line = String((e && e.stack) || "").split("\n").find((l) => l.includes(BASE));
  const m = line && line.match(/:(\d+)(?::\d+)?\)?\s*$/);
  return m ? " (" + BASE + ":" + m[1] + ")" : "";
}
const describe = (e) => (e && e.name ? e.name + ": " + e.message : String(e && e.lasExit !== undefined ? "process.exit(" + e.lasExit + ") was called" : e)) + where(e);
function show(v) {
  if (v === undefined) return;
  if (typeof v === "string") return console.log(v);
  if (v !== null && typeof v === "object") {
    try {
      const s = JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x instanceof Set ? [...x] : x));
      if (s !== undefined) return console.log(s);
    } catch {}
  }
  console.log(String(v));
}
try {
  __las_loadScript(lasStripModules(__las_files[ENTRY]), ENTRY);
  if (self.module.exports && typeof self.module.exports === "object") Object.assign(self, self.module.exports);
} catch (e) {
  console.log(M + " compile-error");
  console.log(describe(e));
  return;
}
async function lasRun(i, src, statement) {
  console.log(M + " begin " + i);
  try {
    let v = (0, eval)(src);
    if (v && typeof v.then === "function") v = await v;
    if (!statement) show(v);
  } catch (e) {
    console.log(M + " error");
    console.log(describe(e));
  }
  console.log(M + " end " + i);
}
${calls}
})()
`;
}

function jsBrowserProgram(ctx: HarnessContext, stdin: string): string {
  return code`(async () => {
${jsBrowserPrelude(ctx, stdin, true)}
try {
  __las_loadScript(lasStripModules(__las_files[ENTRY]), ENTRY);
  for (const f of lasListeners.data) f(LAS_STDIN);
  for (const f of lasListeners.end) f();
  for (const l of lasLines) for (const f of lasListeners.line) f(l);
  for (const f of lasListeners.close) f();
} catch (e) {
  if (!(e && "lasExit" in e)) throw e;
}
})()
`;
}

// ---------------------------------------------------------------------------------------------
// Python

function pythonHarness(ctx: HarnessContext): string {
  const calls = ctx.cases.map((c) => `_las_run(${c.index}, ${dq(c.call)}, ${c.statement ? "True" : "False"})`).join("\n");
  return code`# Generated by LAS: runs each test call and prints marked results. Do not edit.
import importlib.util, os, sys, traceback
M = "##LAS##"
ENTRY = ${dq(ctx.entry)}
BASE = os.path.basename(ENTRY)
sys.path.insert(0, os.path.dirname(os.path.abspath(ENTRY)))
def _las_describe(e):
    line = None
    if isinstance(e, SyntaxError):
        return "%s: %s" % (type(e).__name__, e)
    for fr in traceback.extract_tb(e.__traceback__):
        if os.path.basename(fr.filename) == BASE:
            line = fr.lineno
    return "%s: %s%s" % (type(e).__name__, e, " (%s:%d)" % (BASE, line) if line else "")
try:
    _las_spec = importlib.util.spec_from_file_location("las_entry", ENTRY)
    _las_mod = importlib.util.module_from_spec(_las_spec)
    sys.modules["las_entry"] = _las_mod
    _las_spec.loader.exec_module(_las_mod)
except BaseException as e:
    print(M + " compile-error")
    print(_las_describe(e), flush=True)
    sys.exit(1)
_las_globals = vars(_las_mod)
def _las_run(i, src, statement):
    print(M + " begin %d" % i, flush=True)
    try:
        if statement:
            exec(compile(src, "<test>", "exec"), _las_globals)
        else:
            v = eval(compile(src, "<test>", "eval"), _las_globals)
            if v is not None:
                print(v)
    except BaseException as e:
        print(M + " error")
        print(_las_describe(e))
    print(M + " end %d" % i, flush=True)
${calls}
`;
}

// ---------------------------------------------------------------------------------------------
// SQL: a call is a query run after the entry file (schema and data) is read

function sqlHarness(ctx: HarnessContext): string {
  const lines = [".bail off", ".headers off", ".mode list", `.read ${sq(ctx.entry)}`];
  for (const c of ctx.cases) {
    const q = c.call.trim();
    lines.push(`.print ${MARK} begin ${c.index}`, /;\s*$/.test(q) ? q : q + ";", `.print ${MARK} end ${c.index}`);
  }
  return lines.join("\n") + "\n";
}

/** A stand-in for the sqlite3 shell, for machines with Python but without the sqlite3 command. */
const SQLITE_SHIM = code`# LAS sqlite3 stand-in: the part of the sqlite3 shell that LAS uses (.read .print .mode .headers .separator .bail).
import sqlite3, sys
sys.stdout.reconfigure(line_buffering=True)
def fmt(v):
    if v is None:
        return ""
    if isinstance(v, float):
        s = "%.15g" % v
        return s if any(ch in s for ch in ".en") else s + ".0"
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace")
    return str(v)
class Shell:
    def __init__(self, db, bail):
        self.con = sqlite3.connect(db, isolation_level=None)
        self.headers = False
        self.sep = "|"
        self.bail = bail
        self.failed = False
    def stmt(self, sql, line):
        try:
            cur = self.con.execute(sql)
            if cur.description:
                rows = cur.fetchall()
                if self.headers and rows:
                    print(self.sep.join(d[0] for d in cur.description))
                for r in rows:
                    print(self.sep.join(fmt(v) for v in r))
        except (sqlite3.Error, sqlite3.Warning) as e:
            self.failed = True
            print("Error: near line %d: %s" % (line, e), flush=True)
            if self.bail:
                sys.exit(1)
    def script(self, text):
        buf = ""
        start = 1
        for n, line in enumerate(text.splitlines(), 1):
            if not buf.strip() and line.lstrip().startswith("."):
                self.dot(line.strip())
                buf = ""
                continue
            if not buf.strip():
                start = n
            buf += line + "\n"
            while True:
                i = buf.find(";")
                cut = None
                while i != -1:
                    if sqlite3.complete_statement(buf[: i + 1]):
                        cut = i + 1
                        break
                    i = buf.find(";", i + 1)
                if cut is None:
                    break
                sql, buf = buf[:cut], buf[cut:]
                if sql.strip():
                    self.stmt(sql, start)
                start = n
        if buf.strip():
            self.stmt(buf, start)
    def dot(self, line):
        parts = line.split(None, 1)
        cmd, arg = parts[0], (parts[1] if len(parts) > 1 else "")
        val = arg.strip().strip("'\"")
        if cmd == ".read":
            try:
                with open(val, encoding="utf-8") as f:
                    text = f.read()
            except OSError:
                self.failed = True
                print('Error: cannot open "%s"' % val)
                return
            self.script(text)
        elif cmd == ".print":
            print(arg)
        elif cmd == ".headers":
            self.headers = val.lower() in ("on", "1", "yes", "true")
        elif cmd == ".mode":
            self.sep = {"csv": ",", "tabs": "\t"}.get(val, "|")
        elif cmd == ".separator":
            self.sep = val
        elif cmd == ".bail":
            self.bail = val.lower() in ("on", "1", "yes", "true")
        else:
            print('Error: unknown command or invalid arguments: "%s"' % cmd[1:])
def main(argv):
    pre, db, extra, bail = [], None, [], False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "-cmd":
            pre.append(argv[i + 1])
            i += 2
            continue
        if a == "-bail":
            bail = True
        elif a.startswith("-"):
            pass
        elif db is None:
            db = a
        else:
            extra.append(a)
        i += 1
    sh = Shell(db or ":memory:", bail)
    for c in pre:
        sh.script(c)
    if extra:
        for c in extra:
            sh.script(c)
    else:
        sh.script(sys.stdin.read())
    sys.stdout.flush()
    sys.exit(1 if sh.failed else 0)
main(sys.argv[1:])
`;

// ---------------------------------------------------------------------------------------------
// Ruby and PHP (browser variants inline the entry source, since wasm builds may have no file system)

function rubyHarness(ctx: HarnessContext): string {
  const calls = ctx.cases.map((c) => `las_run(${c.index}, ${sq(c.call)}, ${c.statement})`).join("\n");
  const load = ctx.target === "browser" ? `TOPLEVEL_BINDING.eval(${sq(ctx.files[ctx.entry] ?? "")}, LAS_ENTRY, 1)` : "load File.expand_path(LAS_ENTRY)";
  return code`# Generated by LAS: runs each test call and prints marked results. Do not edit.
$stdout.sync = true
$stderr.sync = true
LAS_M = "##LAS##"
LAS_ENTRY = ${sq(ctx.entry)}
LAS_BASE = File.basename(LAS_ENTRY)
def las_describe(e)
  line = (e.backtrace || []).find { |l| l.include?(LAS_BASE) }
  m = line && line.match(/:(\d+)/)
  m ||= e.message.match(/#{Regexp.escape(LAS_BASE)}:(\d+)/)
  "#{e.class}: #{e.message.lines.first.to_s.strip}" + (m ? " (#{LAS_BASE}:#{m[1]})" : "")
end
def las_show(v)
  return if v.nil?
  puts(v.is_a?(String) ? v : v.inspect)
end
begin
  ${load}
rescue Exception => e
  puts "#{LAS_M} compile-error"
  puts las_describe(e)
  exit 1
end
def las_run(i, src, statement)
  puts "#{LAS_M} begin #{i}"
  begin
    v = TOPLEVEL_BINDING.eval(src, "(test)", 1)
    las_show(v) unless statement
  rescue Exception => e
    puts "#{LAS_M} error"
    puts las_describe(e)
  end
  puts "#{LAS_M} end #{i}"
end
${calls}
`;
}

function phpHarness(ctx: HarnessContext): string {
  const calls = ctx.cases.map((c) => `las_run(${c.index}, ${sq(c.call)}, ${c.statement ? "true" : "false"});`).join("\n");
  const load = ctx.target === "browser" ? `eval('?>' . ${sq(ctx.files[ctx.entry] ?? "")});` : "require_once __DIR__ . '/' . LAS_ENTRY;";
  return code`<?php
// Generated by LAS: runs each test call and prints marked results. Do not edit.
const LAS_M = '##LAS##';
const LAS_ENTRY = ${sq(ctx.entry)};
function las_describe(Throwable $e): string {
    $base = basename(LAS_ENTRY);
    $line = null;
    if (basename($e->getFile()) === $base) $line = $e->getLine();
    else foreach ($e->getTrace() as $f) if (isset($f['file']) && basename($f['file']) === $base) { $line = $f['line']; break; }
    return get_class($e) . ': ' . $e->getMessage() . ($line ? " ($base:$line)" : '');
}
function las_show($v): void {
    if ($v === null) return;
    if (is_string($v)) echo $v, "\n";
    elseif (is_bool($v)) echo $v ? 'true' : 'false', "\n";
    elseif (is_int($v)) echo $v, "\n";
    elseif (is_float($v)) echo var_export($v, true), "\n";
    else echo json_encode($v), "\n";
}
try {
    ${load}
} catch (Throwable $e) {
    echo LAS_M, " compile-error\n", las_describe($e), "\n";
    exit(1);
}
function las_run(int $i, string $src, bool $statement): void {
    echo LAS_M, " begin $i\n";
    try {
        if ($statement) eval($src);
        else las_show(eval('return ' . $src . ';'));
    } catch (Throwable $e) {
        echo LAS_M, " error\n", las_describe($e), "\n";
    }
    echo LAS_M, " end $i\n";
    flush();
}
${calls}
`;
}

// ---------------------------------------------------------------------------------------------
// compiled languages: the call is written into the harness source

function rustHarness(ctx: HarnessContext): Record<string, string> {
  const testsPath = `${MIRROR}/${ctx.entryDir ? ctx.entryDir + "/" : ""}las_tests.rs`;
  const fns = ctx.cases
    .map((c) =>
      c.statement
        ? `fn las_t${c.index}() -> Option<String> { { ${c.call} } None }`
        : `fn las_t${c.index}() -> Option<String> { let las_v = { ${c.call} }; Some((&LasWrap(las_v)).las_show()) }`
    )
    .join("\n");
  const runs = ctx.cases.map((c) => `    las_case(${c.index}, las_t${c.index});`).join("\n");
  const tests = code`// Generated by LAS: runs each test call and prints marked results. Do not edit.
#![allow(unused_imports, dead_code, unused_variables, unused_mut, unreachable_code, non_snake_case, unused_braces)]
use super::*;
pub struct LasWrap<T>(pub T);
pub trait LasViaDisplay { fn las_show(&self) -> String; }
impl<T: std::fmt::Display> LasViaDisplay for LasWrap<T> { fn las_show(&self) -> String { format!("{}", self.0) } }
pub trait LasViaDebug { fn las_show(&self) -> String; }
impl<T: std::fmt::Debug> LasViaDebug for &LasWrap<T> { fn las_show(&self) -> String { format!("{:?}", self.0) } }
const LAS_BASE: &str = ${dq(ctx.entryBase)};
fn las_case(i: usize, f: fn() -> Option<String>) {
    println!("##LAS## begin {}", i);
    if let Ok(Some(s)) = std::panic::catch_unwind(f) {
        if s != "()" { println!("{}", s); }
    }
    println!("##LAS## end {}", i);
}
${fns}
pub fn run() {
    std::panic::set_hook(Box::new(|info| {
        let p = info.payload();
        let msg = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_else(|| "panic".to_string());
        let at = info.location().map(|l| { let f = l.file().rsplit('/').next().unwrap_or(""); if f == LAS_BASE { format!(" ({}:{})", f, l.line()) } else { String::new() } }).unwrap_or_default();
        println!("##LAS## error");
        println!("panicked: {}{}", msg, at);
    }));
${runs}
}
`;
  const main = code`// Generated by LAS. Do not edit.
#![allow(dead_code, unused_imports, unused_variables, unused_mut, non_snake_case)]
#[path = ${dq(ctx.entry)}]
mod las_entry;
fn main() { las_entry::las_tests::run(); }
`;
  return {
    // appended after the learner's last line, so their line numbers do not move
    ...mirror(ctx, [".rs"], (src) => `${src}\n#[path = "las_tests.rs"]\npub mod las_tests;\n`),
    [testsPath]: tests,
    [`${MIRROR}/las_main.rs`]: main
  };
}

function goHarness(ctx: HarnessContext): Record<string, string> {
  const inEntryDir = (p: string) => dirOf(p) === ctx.entryDir && !p.endsWith("_test.go");
  const files: Record<string, string> = {};
  for (const [p, src] of Object.entries(ctx.files)) {
    if (extOf(p) !== ".go" || !inEntryDir(p) || ctx.nativePaths.includes(p)) continue;
    // same line count: only the package clause and a func main are renamed
    files[`${MIRROR}/${p.split("/").pop()}`] = src.replace(/^package\s+\w+/m, "package main").replace(/^func\s+main\s*\(\s*\)/m, "func lasUserMain()");
  }
  const runs = ctx.cases.map((c) => (c.statement ? `\tlasCase(${c.index}, func() { ${c.call} })` : `\tlasCase(${c.index}, func() { lasShow(${c.call}) })`)).join("\n");
  files[`${MIRROR}/lasharness.go`] = code`// Generated by LAS: runs each test call and prints marked results. Do not edit.
package main

import (
	lasdebug "runtime/debug"
	lasfmt "fmt"
	lasstrings "strings"
)

const lasBase = ${dq(ctx.entryBase)}

func lasShow(vs ...any) {
	parts := make([]string, len(vs))
	for i, v := range vs {
		parts[i] = lasfmt.Sprint(v)
	}
	lasfmt.Println(lasstrings.Join(parts, " "))
}

func lasWhere() string {
	for _, l := range lasstrings.Split(string(lasdebug.Stack()), "\n") {
		i := lasstrings.Index(l, "/"+lasBase+":")
		if i < 0 {
			continue
		}
		rest := l[i+len(lasBase)+2:]
		if j := lasstrings.IndexAny(rest, " \t"); j >= 0 {
			rest = rest[:j]
		}
		return " (" + lasBase + ":" + rest + ")"
	}
	return ""
}

func lasCase(i int, f func()) {
	lasfmt.Printf("##LAS## begin %d\n", i)
	func() {
		defer func() {
			if r := recover(); r != nil {
				lasfmt.Println("##LAS## error")
				lasfmt.Printf("panic: %v%s\n", r, lasWhere())
			}
		}()
		f()
	}()
	lasfmt.Printf("##LAS## end %d\n", i)
}

func main() {
${runs}
}
`;
  return files;
}

function javaInfo(ctx: HarnessContext): { pkg: string; injected: boolean } {
  const src = ctx.files[ctx.entry] ?? "";
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(src)?.[1] ?? "";
  return { pkg, injected: findClassBodyEnd(src, ctx.entryStem) >= 0 };
}

function javaHarness(ctx: HarnessContext): Record<string, string> {
  const { pkg, injected } = javaInfo(ctx);
  const cases = ctx.cases.map((c) => (c.statement ? `t(${c.index}, () -> { ${c.call} });` : `t(${c.index}, () -> ${c.call});`)).join(" ");
  // one line, so the learner's line numbers stay the same after it is inserted
  const tests = [
    "public static final class LasTests {",
    "interface F { Object get() throws Throwable; } interface V { void run() throws Throwable; }",
    `static final String BASE = ${dq(ctx.entryBase)};`,
    "static void show(Object v) { if (v != null && v.getClass().isArray()) { String s = java.util.Arrays.deepToString(new Object[] { v }); System.out.println(s.substring(1, s.length() - 1)); } else System.out.println(String.valueOf(v)); }",
    'static String where(Throwable e) { for (StackTraceElement el : e.getStackTrace()) if (BASE.equals(el.getFileName())) return " (" + BASE + ":" + el.getLineNumber() + ")"; return ""; }',
    'static void begin(int i) { System.out.println("##LAS## begin " + i); }',
    'static void end(int i) { System.out.println("##LAS## end " + i); System.out.flush(); }',
    'static void fail(Throwable e) { System.out.println("##LAS## error"); System.out.println(e + where(e)); }',
    "static void t(int i, F f) { begin(i); try { show(f.get()); } catch (Throwable e) { fail(e); } end(i); }",
    "static void t(int i, V f) { begin(i); try { f.run(); } catch (Throwable e) { fail(e); } end(i); }",
    `public static void run() { ${cases} }`,
    "}"
  ].join(" ");
  const out = mirror(ctx, [".java"], (src) => {
    const at = findClassBodyEnd(src, ctx.entryStem);
    return at < 0 ? src : src.slice(0, at) + " " + tests + " " + src.slice(at);
  });
  out[`${MIRROR}/LasHarness.java`] = code`// Generated by LAS. Do not edit.
${pkg ? `package ${pkg};` : ""}
public class LasHarness {
    public static void main(String[] args) throws Exception {
        System.setOut(new java.io.PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), true, "UTF-8"));
        ${injected ? `${ctx.entryStem}.LasTests.run();` : "LasTests.run();"}
    }
    ${injected ? "" : tests}
}
`;
  return out;
}

const C_COMMON = code`static sigjmp_buf las_env;
static volatile sig_atomic_t las_active = 0;
static void las_on_signal(int sig) {
  if (las_active) siglongjmp(las_env, sig);
  signal(sig, SIG_DFL);
  raise(sig);
}
static const char *las_signame(int s) {
  switch (s) {
    case SIGSEGV: return "segmentation fault (bad memory access or stack overflow)";
    case SIGFPE: return "arithmetic error (for example division by zero)";
    case SIGABRT: return "aborted (for example a failed assert)";
    case SIGBUS: return "bus error (bad memory access)";
    case SIGILL: return "illegal instruction";
    default: return "signal";
  }
}
static void las_setup(void) {
  static char las_stack[1 << 16];
  stack_t ss;
  memset(&ss, 0, sizeof ss);
  ss.ss_sp = las_stack;
  ss.ss_size = sizeof las_stack;
  sigaltstack(&ss, NULL);
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = las_on_signal;
  sa.sa_flags = SA_ONSTACK | SA_NODEFER;
  sigemptyset(&sa.sa_mask);
  int sigs[] = { SIGSEGV, SIGFPE, SIGABRT, SIGBUS, SIGILL };
  for (unsigned k = 0; k < sizeof sigs / sizeof sigs[0]; k++) sigaction(sigs[k], &sa, NULL);
  setvbuf(stdout, NULL, _IOLBF, 0);
}
`;

function cHarness(ctx: HarnessContext): string {
  const fns = ctx.cases.map((c) => (c.statement ? `static void las_t${c.index}(void) { ${c.call} }` : `static void las_t${c.index}(void) { LAS_SHOW((${c.call})); }`)).join("\n");
  const runs = ctx.cases.map((c) => `  las_case(${c.index}, las_t${c.index});`).join("\n");
  return code`/* Generated by LAS: runs each test call and prints marked results. Do not edit. */
#include <setjmp.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define main las_user_main
#include ${dq(ctx.entry)}
#undef main
${C_COMMON}
static void las_show_b(bool v) { puts(v ? "true" : "false"); }
static void las_show_c(char v) { printf("%c\n", v); }
static void las_show_ll(long long v) { printf("%lld\n", v); }
static void las_show_ull(unsigned long long v) { printf("%llu\n", v); }
static void las_show_f(float v) { printf("%.7g\n", (double)v); }
static void las_show_d(double v) { printf("%.15g\n", v); }
static void las_show_ld(long double v) { printf("%.18Lg\n", v); }
static void las_show_s(const char *v) { puts(v ? v : "(null)"); }
static void las_show_p(const void *v) { printf("%p\n", v); }
#define LAS_SHOW(x) _Generic((x), \
  bool: las_show_b, char: las_show_c, signed char: las_show_ll, unsigned char: las_show_ull, \
  short: las_show_ll, unsigned short: las_show_ull, int: las_show_ll, unsigned int: las_show_ull, \
  long: las_show_ll, unsigned long: las_show_ull, long long: las_show_ll, unsigned long long: las_show_ull, \
  float: las_show_f, double: las_show_d, long double: las_show_ld, \
  char *: las_show_s, const char *: las_show_s, default: las_show_p)(x)
static void las_case(int i, void (*f)(void)) {
  int sig;
  printf("##LAS## begin %d\n", i);
  fflush(stdout);
  if ((sig = sigsetjmp(las_env, 1)) == 0) {
    las_active = 1;
    f();
    las_active = 0;
  } else {
    las_active = 0;
    fflush(stdout);
    printf("\n##LAS## error\nruntime error: %s\n", las_signame(sig));
  }
  printf("##LAS## end %d\n", i);
  fflush(stdout);
}
${fns}
int main(void) {
  las_setup();
${runs}
  return 0;
}
`;
}

function cppHarness(ctx: HarnessContext): string {
  const runs = ctx.cases.map((c) => (c.statement ? `  las_case(${c.index}, []() { ${c.call} });` : `  las_case(${c.index}, []() { return ${c.call}; });`)).join("\n");
  return code`// Generated by LAS: runs each test call and prints marked results. Do not edit.
#include <csetjmp>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <exception>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <sstream>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <signal.h>
#include <setjmp.h>
#define main las_user_main
#include ${dq(ctx.entry)}
#undef main
${C_COMMON}
template <class T, class = void> struct las_streamable : std::false_type {};
template <class T> struct las_streamable<T, std::void_t<decltype(std::declval<std::ostream&>() << std::declval<const T&>())>> : std::true_type {};
template <class T, class = void> struct las_iterable : std::false_type {};
template <class T> struct las_iterable<T, std::void_t<decltype(std::begin(std::declval<const T&>())), decltype(std::end(std::declval<const T&>()))>> : std::true_type {};
template <class T, class = void> struct las_pair : std::false_type {};
template <class T> struct las_pair<T, std::void_t<decltype(std::declval<const T&>().first), decltype(std::declval<const T&>().second)>> : std::true_type {};
template <class T> void las_write(std::ostream& o, const T& v) {
  if constexpr (std::is_same_v<T, bool>) o << (v ? "true" : "false");
  else if constexpr (std::is_convertible_v<const T&, std::string_view>) o << std::string_view(v);
  else if constexpr (las_pair<T>::value) { o << "("; las_write(o, v.first); o << ", "; las_write(o, v.second); o << ")"; }
  else if constexpr (las_iterable<T>::value) {
    o << "[";
    bool first = true;
    for (const auto& x : v) { if (!first) o << ", "; first = false; las_write(o, x); }
    o << "]";
  }
  else if constexpr (las_streamable<T>::value) o << v;
  else o << "<value>";
}
template <class F> void las_case(int i, F f) {
  std::cout << "##LAS## begin " << i << std::endl;
  int sig;
  if ((sig = sigsetjmp(las_env, 1)) == 0) {
    las_active = 1;
    try {
      if constexpr (std::is_void_v<decltype(f())>) f();
      else {
        auto&& v = f();
        std::ostringstream s;
        s << std::setprecision(15);
        las_write(s, v);
        std::cout << s.str() << std::endl;
      }
    } catch (const std::exception& e) {
      std::cout << "\n##LAS## error\nexception: " << e.what() << std::endl;
    } catch (...) {
      std::cout << "\n##LAS## error\nexception (not a std::exception)" << std::endl;
    }
    las_active = 0;
  } else {
    las_active = 0;
    std::cout << "\n##LAS## error\nruntime error: " << las_signame(sig) << std::endl;
  }
  std::cout << "##LAS## end " << i << std::endl;
}
int main() {
  las_setup();
${runs}
  return 0;
}
`;
}

function csharpInfo(ctx: HarnessContext): { usingStatic: string } {
  const src = ctx.files[ctx.entry] ?? "";
  const ns = /^\s*namespace\s+([\w.]+)/m.exec(src)?.[1];
  const hasClass = new RegExp(`\\bclass\\s+${ctx.entryStem}\\b`).test(src);
  return { usingStatic: hasClass ? `using static ${ns ? ns + "." : ""}${ctx.entryStem};` : "" };
}

function csharpProject(sources: string[], extra: string[], startup?: string): string {
  const items = [...sources.map((s) => `../${s}`), ...extra].map((s) => `    <Compile Include=${dq(s)} />`).join("\n");
  return code`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net$(NETCoreAppMaximumVersion)</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>disable</Nullable>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <AssemblyName>las</AssemblyName>
    <NoWarn>$(NoWarn);CS8981;CS0168;CS0219;CS7022</NoWarn>${startup ? `\n    <StartupObject>${startup}</StartupObject>` : ""}
  </PropertyGroup>
  <ItemGroup>
${items}
  </ItemGroup>
</Project>
`;
}

function csSources(ctx: HarnessContext): string[] {
  return Object.keys(ctx.files).filter((p) => extOf(p) === ".cs" && !ctx.nativePaths.includes(p));
}

function csharpHarness(ctx: HarnessContext): Record<string, string> {
  const { usingStatic } = csharpInfo(ctx);
  const runs = ctx.cases.map((c) => (c.statement ? `        Run(${c.index}, () => { ${c.call} });` : `        Run(${c.index}, () => ${c.call});`)).join("\n");
  const sources = csSources(ctx);
  return {
    [`${MIRROR}/las.csproj`]: csharpProject(sources, ["LasHarness.cs"], "LasHarness"),
    [`${MIRROR}/prog/las.csproj`]: csharpProject(sources.map((s) => `../${s}`), []),
    [`${MIRROR}/LasHarness.cs`]: code`// Generated by LAS: runs each test call and prints marked results. Do not edit.
using System;
using System.Collections;
using System.Globalization;
using System.Linq;
${usingStatic}
public static class LasHarness {
    const string Base = ${dq(ctx.entryBase)};
    static string Format(object v) {
        if (v == null) return "null";
        if (v is string s) return s;
        if (v is IEnumerable e) return "[" + string.Join(", ", e.Cast<object>().Select(Format)) + "]";
        return Convert.ToString(v, CultureInfo.InvariantCulture);
    }
    static string Where(Exception e) {
        foreach (var l in (e.StackTrace ?? "").Split('\n')) {
            var i = l.IndexOf(Base + ":line ");
            if (i >= 0) return " (" + Base + ":" + l.Substring(i + Base.Length + 6).Trim() + ")";
        }
        return "";
    }
    static void Begin(int i) => Console.WriteLine("##LAS## begin " + i);
    static void End(int i) { Console.WriteLine("##LAS## end " + i); Console.Out.Flush(); }
    static void Fail(Exception e) { Console.WriteLine("##LAS## error"); Console.WriteLine(e.GetType().Name + ": " + e.Message + Where(e)); }
    static void Run(int i, Func<object> f) { Begin(i); try { var v = f(); if (v != null) Console.WriteLine(Format(v)); } catch (Exception e) { Fail(e); } End(i); }
    static void Run(int i, Action f) { Begin(i); try { f(); } catch (Exception e) { Fail(e); } End(i); }
    public static void Main() {
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
${runs}
    }
}
`
  };
}

function kotlinHarness(ctx: HarnessContext): Record<string, string> {
  const pkg = /^\s*package\s+([\w.]+)/m.exec(ctx.files[ctx.entry] ?? "")?.[1];
  const runs = ctx.cases.map((c) => (c.statement ? `    lasRun(${c.index}, true) { ${noSemi(c.call)}; Unit }` : `    lasRun(${c.index}, false) { ${c.call} }`)).join("\n");
  return {
    ...mirror(ctx, [".kt"], (src) => src.replace(/^(\s*)fun\s+main\s*\(/m, "$1fun lasUserMain(")),
    [`${MIRROR}/LasHarness.kt`]: code`// Generated by LAS: runs each test call and prints marked results. Do not edit.
${pkg ? `import ${pkg}.*` : ""}
private const val LAS_BASE = ${dq(ctx.entryBase)}
private fun lasShow(v: Any?) {
    when (v) {
        is Unit -> return
        null -> println("null")
        is String -> println(v)
        is Array<*> -> println(v.contentDeepToString())
        is IntArray -> println(v.contentToString())
        is LongArray -> println(v.contentToString())
        is DoubleArray -> println(v.contentToString())
        is BooleanArray -> println(v.contentToString())
        is CharArray -> println(v.contentToString())
        else -> println(v)
    }
}
private fun lasWhere(e: Throwable): String {
    val el = e.stackTrace.firstOrNull { it.fileName == LAS_BASE } ?: return ""
    return " (" + LAS_BASE + ":" + el.lineNumber + ")"
}
private fun lasRun(i: Int, statement: Boolean, f: () -> Any?) {
    println("##LAS## begin " + i)
    try {
        val v = f()
        if (!statement) lasShow(v)
    } catch (e: Throwable) {
        println("##LAS## error")
        println(e.toString() + lasWhere(e))
    }
    println("##LAS## end " + i)
    System.out.flush()
}
fun main() {
${runs}
}
`
  };
}

function swiftHarness(ctx: HarnessContext): Record<string, string> {
  const runs = ctx.cases.map((c) => (c.statement ? `lasRun(${c.index}, true) { ${noSemi(c.call)}; return () }` : `lasRun(${c.index}, false) { try ${c.call} }`)).join("\n");
  return {
    ...mirror(ctx, [".swift"], (s) => s),
    [`${MIRROR}/main.swift`]: code`// Generated by LAS: runs each test call and prints marked results. Do not edit.
import Foundation
setvbuf(stdout, nil, _IOLBF, 0)
func lasShow(_ v: Any) {
    if v is Void { return }
    let m = Mirror(reflecting: v)
    if m.displayStyle == .optional {
        if let c = m.children.first { lasShow(c.value) } else { print("nil") }
        return
    }
    if let s = v as? String { print(s) } else { print(String(describing: v)) }
}
func lasRun(_ i: Int, _ statement: Bool, _ f: () throws -> Any) {
    print("##LAS## begin \(i)")
    do {
        let v = try f()
        if !statement { lasShow(v) }
    } catch {
        print("##LAS## error")
        print("\(error)")
    }
    print("##LAS## end \(i)")
}
${runs}
`
  };
}

function bashHarness(ctx: HarnessContext): string {
  const calls = ctx.cases.map((c) => `las_run ${c.index} ${shq(c.call)}`).join("\n");
  return code`# Generated by LAS: runs each test call and prints marked results. Do not edit.
las_entry=${shq(ctx.entry)}
if ! las_err=$(bash -n "./$las_entry" 2>&1); then
  printf '##LAS## compile-error\n%s\n' "$las_err"
  exit 1
fi
source "./$las_entry" </dev/null
set +e +u
las_run() {
  printf '##LAS## begin %s\n' "$1"
  ( eval "$2" ) </dev/null 2>&1
  las_status=$?
  if [ "$las_status" -ge 126 ]; then
    printf '\n##LAS## error\nexit status %s\n' "$las_status"
  fi
  printf '##LAS## end %s\n' "$1"
}
${calls}
`;
}

function luaHarness(ctx: HarnessContext): string {
  const calls = ctx.cases.map((c) => `las_run(${c.index}, ${luaLong(c.call)}, ${c.statement})`).join("\n");
  return code`-- Generated by LAS: runs each test call and prints marked results. Do not edit.
io.stdout:setvbuf("line")
local M = "##LAS##"
local ENTRY = ${luaLong(ctx.entry)}
local BASE = ENTRY:match("[^/]+$")
local loadsrc = loadstring or load
local function describe(err)
  local s = tostring(err)
  local line = s:match(BASE:gsub("%p", "%%%0") .. ":(%d+)")
  local first = s:match("^[^\n]*")
  return first .. ((line and not first:find(BASE, 1, true)) and (" (" .. BASE .. ":" .. line .. ")") or "")
end
local ok, mod = pcall(dofile, ENTRY)
if not ok then
  print(M .. " compile-error")
  print(describe(mod))
  os.exit(1)
end
if type(mod) == "table" then
  for k, v in pairs(mod) do if _G[k] == nil then _G[k] = v end end
end
local function ser(v, depth)
  if type(v) == "string" then return depth > 0 and string.format("%q", v) or v end
  if type(v) ~= "table" then return tostring(v) end
  if depth > 4 then return "{...}" end
  local parts, n = {}, #v
  for i = 1, n do parts[#parts + 1] = ser(v[i], depth + 1) end
  local keys = {}
  for k in pairs(v) do if not (type(k) == "number" and k >= 1 and k <= n and k % 1 == 0) then keys[#keys + 1] = k end end
  table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
  for _, k in ipairs(keys) do parts[#parts + 1] = tostring(k) .. " = " .. ser(v[k], depth + 1) end
  return "{" .. table.concat(parts, ", ") .. "}"
end
local function pack(...) return { n = select("#", ...), ... } end
function las_run(i, src, statement)
  print(M .. " begin " .. i)
  local f, err = loadsrc("return " .. src, "=test")
  if not f or statement then f, err = loadsrc(src, "=test") end
  if not f then
    print(M .. " error")
    print(describe(err))
  else
    local r = pack(xpcall(f, debug.traceback))
    if r[1] then
      if not statement and r.n > 1 then
        local out = {}
        for k = 2, r.n do out[#out + 1] = ser(r[k], 0) end
        if not (r.n == 2 and r[2] == nil) then print(table.concat(out, " ")) end
      end
    else
      print(M .. " error")
      print(describe(r[2]))
    end
  end
  print(M .. " end " .. i)
  io.stdout:flush()
end
${calls}
`;
}

function rHarness(ctx: HarnessContext): string {
  const calls = ctx.cases.map((c) => `.las_run(${c.index}L, ${dq(c.call)}, ${c.statement ? "TRUE" : "FALSE"})`).join("\n");
  return code`# Generated by LAS: runs each test call and prints marked results. Do not edit.
.las_entry <- ${dq(ctx.entry)}
.las_ok <- tryCatch({ source(.las_entry, local = globalenv(), keep.source = TRUE); TRUE }, error = function(e) {
  cat("##LAS## compile-error\n", conditionMessage(e), "\n", sep = "")
  FALSE
})
if (!.las_ok) quit(status = 1)
.las_show <- function(v) {
  if (is.null(v)) return(invisible(NULL))
  if (is.atomic(v) && is.null(dim(v))) cat(paste(as.character(v), collapse = " "), "\n", sep = "") else print(v)
}
.las_run <- function(i, src, statement) {
  cat("##LAS## begin ", i, "\n", sep = "")
  tryCatch({
    v <- withVisible(eval(parse(text = src), envir = globalenv()))
    if (!statement && v$visible) .las_show(v$value)
  }, error = function(e) {
    cat("##LAS## error\n", conditionMessage(e), "\n", sep = "")
  })
  cat("##LAS## end ", i, "\n", sep = "")
  flush(stdout())
}
${calls}
`;
}

function haskellModule(src: string): string | undefined {
  return /^module\s+([\w.]+)/m.exec(src)?.[1];
}

function haskellHarness(ctx: HarnessContext): Record<string, string> {
  const src = ctx.files[ctx.entry] ?? "";
  const copy = haskellModule(src) ? src.replace(/^module\s+[\w.]+/m, "module LasEntry") : `module LasEntry where\n{-# LINE 1 ${dq(ctx.entry)} #-}\n${src}`;
  const runs = ctx.cases.map((c) => `  lasRun ${c.index} (lasShow (${noSemi(c.call)}))`).join("\n");
  return {
    [`${MIRROR}/LasEntry.hs`]: copy,
    [`${MIRROR}/LasHarness.hs`]: code`-- Generated by LAS: runs each test call and prints marked results. Do not edit.
{-# LANGUAGE FlexibleInstances, UndecidableInstances, ExtendedDefaultRules #-}
{-# OPTIONS_GHC -Wno-type-defaults -Wno-dodgy-imports #-}
module Main (main) where
import LasEntry hiding (main)
import qualified Control.Exception as LasE
import qualified System.IO as LasIO

class LasShow a where
  lasShow :: a -> String
instance {-# OVERLAPPING #-} LasShow String where
  lasShow = id
instance {-# OVERLAPPING #-} LasShow () where
  lasShow _ = ""
instance {-# OVERLAPPABLE #-} Show a => LasShow a where
  lasShow = show

lasRun :: Int -> String -> IO ()
lasRun i s = do
  putStrLn ("##LAS## begin " ++ show i)
  r <- LasE.try (LasE.evaluate (seq (foldr seq () s) s))
  case r of
    Left e -> do
      putStrLn "##LAS## error"
      putStrLn (head (lines (show (e :: LasE.SomeException)) ++ [""]))
    Right v -> if null v then return () else putStrLn v
  putStrLn ("##LAS## end " ++ show i)
  LasIO.hFlush LasIO.stdout

main :: IO ()
main = do
  LasIO.hSetBuffering LasIO.stdout LasIO.LineBuffering
${runs}
  return ()
`
  };
}

function elixirHarness(ctx: HarnessContext): string {
  const calls = ctx.cases.map((c) => `LasHarness.run(${c.index}, ${dq(noSemi(c.call)).replace(/#\{/g, "\\#{")}, ${c.statement})`).join("\n");
  return code`# Generated by LAS: runs each test call and prints marked results. Do not edit.
defmodule LasHarness do
  @base ${dq(ctx.entryBase)}
  def where(stack) do
    Enum.find_value(stack, "", fn
      {_, _, _, opts} -> if Path.basename(to_string(opts[:file] || "")) == @base, do: " (#{@base}:#{opts[:line]})"
      _ -> nil
    end)
  end
  def show(v) when is_binary(v), do: IO.puts(v)
  def show(nil), do: :ok
  def show(v), do: IO.puts(inspect(v))
  def run(i, src, statement) do
    IO.puts("##LAS## begin #{i}")
    try do
      {v, _} = Code.eval_string(src)
      unless statement, do: show(v)
    rescue
      e -> IO.puts("##LAS## error"); IO.puts(Exception.message(e) <> where(__STACKTRACE__))
    catch
      kind, reason -> IO.puts("##LAS## error"); IO.puts("#{kind}: #{inspect(reason)}")
    end
    IO.puts("##LAS## end #{i}")
  end
end
try do
  Code.require_file(${dq(ctx.entry)})
rescue
  e -> IO.puts("##LAS## compile-error"); IO.puts(Exception.message(e)); System.halt(1)
end
${calls}
`;
}

function scalaHarness(ctx: HarnessContext): Record<string, string> {
  const src = ctx.files[ctx.entry] ?? "";
  const pkg = /^\s*package\s+([\w.]+)/m.exec(src)?.[1];
  const imports = [pkg ? `import ${pkg}.*` : "", new RegExp(`\\bobject\\s+${ctx.entryStem}\\b`).test(src) ? `import ${pkg ? pkg + "." : ""}${ctx.entryStem}.*` : ""].filter(Boolean).join("\n");
  const runs = ctx.cases.map((c) => (c.statement ? `    lasRun(${c.index}, true) { ${noSemi(c.call)}; () }` : `    lasRun(${c.index}, false) { ${c.call} }`)).join("\n");
  return {
    ...mirror(ctx, [".scala", ".sc"], (s) => s),
    [`${MIRROR}/LasHarness.scala`]: code`// Generated by LAS: runs each test call and prints marked results. Do not edit.
${imports}
object LasHarness {
  private val base = ${dq(ctx.entryBase)}
  private def lasShow(v: Any): Unit = v match {
    case () => ()
    case null => println("null")
    case s: String => println(s)
    case a: Array[?] => println(a.mkString("[", ", ", "]"))
    case x => println(x.toString)
  }
  private def lasWhere(e: Throwable): String =
    e.getStackTrace.find(_.getFileName == base).map(el => " (" + base + ":" + el.getLineNumber + ")").getOrElse("")
  private def lasRun(i: Int, statement: Boolean)(f: => Any): Unit = {
    println("##LAS## begin " + i)
    try { val v = f; if (!statement) lasShow(v) }
    catch { case e: Throwable => println("##LAS## error"); println(e.toString + lasWhere(e)) }
    println("##LAS## end " + i)
    Console.out.flush()
  }
  def main(args: Array[String]): Unit = {
${runs}
  }
}
`
  };
}

function dartHarness(ctx: HarnessContext): string {
  const runs = ctx.cases.map((c) => (c.statement ? `  await lasRun(${c.index}, true, () { ${c.call} });` : `  await lasRun(${c.index}, false, () => ${c.call});`)).join("\n");
  return code`// Generated by LAS: runs each test call and prints marked results. Do not edit.
import 'dart:io';
import ${sq(ctx.entry).replace(/\$/g, "\\$")};

const lasBase = ${sq(ctx.entryBase).replace(/\$/g, "\\$")};
void lasShow(Object? v) {
  if (v == null) return;
  print(v is String ? v : v.toString());
}
String lasWhere(StackTrace st) {
  final m = RegExp(RegExp.escape(lasBase) + r':(\d+)').firstMatch(st.toString());
  return m == null ? '' : ' (' + lasBase + ':' + m.group(1)! + ')';
}
Future<void> lasRun(int i, bool statement, dynamic Function() f) async {
  print('##LAS## begin ' + i.toString());
  try {
    var v = f();
    if (v is Future) v = await v;
    if (!statement) lasShow(v);
  } catch (e, st) {
    print('##LAS## error');
    print(e.toString().split('\n').first + lasWhere(st));
  }
  print('##LAS## end ' + i.toString());
}
Future<void> main() async {
${runs}
  await stdout.flush();
}
`;
}

function zigHarness(ctx: HarnessContext): Record<string, string> {
  const runs = ctx.cases
    .map((c) => `    las_std.debug.print("##LAS## begin ${c.index}\\n", .{});\n    ${c.statement ? c.call : `lasShow(${c.call});`}\n    las_std.debug.print("##LAS## end ${c.index}\\n", .{});`)
    .join("\n");
  const appended = code`

// Generated by LAS: runs each test call and prints marked results. Do not edit.
const las_std = @import("std");
fn lasShow(v: anytype) void {
    const T = @TypeOf(v);
    switch (@typeInfo(T)) {
        .void => {},
        .error_union => {
            if (v) |x| lasShow(x) else |err| las_std.debug.print("##LAS## error\nerror.{s}\n", .{@errorName(err)});
        },
        .optional => {
            if (v) |x| lasShow(x) else las_std.debug.print("null\n", .{});
        },
        .pointer => |p| {
            if (p.size == .slice and p.child == u8) {
                las_std.debug.print("{s}\n", .{v});
            } else if (p.size == .one and @typeInfo(p.child) == .array and @typeInfo(p.child).array.child == u8) {
                las_std.debug.print("{s}\n", .{v});
            } else {
                las_std.debug.print("{any}\n", .{v});
            }
        },
        else => las_std.debug.print("{any}\n", .{v}),
    }
}
pub fn main() void {
${runs}
}
`;
  return mirror(ctx, [".zig"], (src) => src.replace(/^(\s*)pub\s+fn\s+main\s*\(/m, "$1pub fn lasUserMain(") + appended);
}

// ---------------------------------------------------------------------------------------------
// the table

const COLON_C: Record<string, LintDef> = {
  "gcc-warnings": { bin: "gcc", argv: ["gcc", "-fsyntax-only", "-Wall", "-Wextra", "{entry}"] },
  "clang-tidy": { argv: ["clang-tidy", "{entry}", "--"] },
  cppcheck: { argv: ["cppcheck", "--template=gcc", "--quiet", "{entry}"] }
};

export const LANGUAGE_TABLE: Record<Language, LanguageDef> = {
  javascript: {
    id: "javascript",
    label: "JavaScript",
    exts: [".js", ".mjs", ".cjs"],
    valueFormat: "strings as-is; arrays and objects as JSON; other values with String()",
    image: "node:22-slim",
    browser: "javascript",
    vmLimit: false,
    harnessFile: "__las_harness.mjs",
    harness: (ctx) => ({ "__las_harness.mjs": ctx.target === "browser" ? jsBrowserHarness(ctx) : jsNodeHarness(ctx, false) }),
    browserProgram: jsBrowserProgram,
    toolchains: [
      {
        tool: "node",
        versionArgs: ["--version"],
        run: ["node", "--no-warnings", "--max-old-space-size={memoryMb}", "{harness}"],
        program: ["node", "--max-old-space-size={memoryMb}", "{entry}"],
        native: [["node", "--test", "{test}"]]
      }
    ],
    lint: { eslint: { argv: ["eslint", "--format", "json", "{entry}"], format: "eslint-json" } }
  },
  typescript: {
    id: "typescript",
    label: "TypeScript",
    exts: [".ts", ".mts", ".cts"],
    valueFormat: "strings as-is; arrays and objects as JSON; other values with String()",
    image: "node:22-slim",
    browser: "typescript",
    vmLimit: false,
    harnessFile: "__las_harness.mjs",
    harness: (ctx) => ({ "__las_harness.mjs": ctx.target === "browser" ? jsBrowserHarness(ctx) : jsNodeHarness(ctx, true) }),
    browserProgram: jsBrowserProgram,
    toolchains: [
      {
        // Node 22.6+ strips types itself; no TypeScript compiler is needed to run tests
        tool: "node",
        versionArgs: ["--version"],
        run: ["node", "--experimental-strip-types", "--no-warnings", "--max-old-space-size={memoryMb}", "{harness}"],
        program: ["node", "--experimental-strip-types", "--no-warnings", "--max-old-space-size={memoryMb}", "{entry}"],
        native: [["node", "--experimental-strip-types", "--no-warnings", "--test", "{test}"]]
      }
    ],
    lint: {
      eslint: { argv: ["eslint", "--format", "json", "{entry}"], format: "eslint-json" },
      tsc: { argv: ["tsc", "--noEmit", "--pretty", "false", "--strict", "--allowImportingTsExtensions", "{entry}"] }
    }
  },
  python: {
    id: "python",
    label: "Python",
    exts: [".py"],
    valueFormat: "print(value): strings as-is, lists like [1, 2], None prints nothing",
    image: "python:3.12-slim",
    browser: "python",
    vmLimit: true,
    env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
    harnessFile: "__las_harness.py",
    harness: (ctx) => ({ "__las_harness.py": pythonHarness(ctx) }),
    browserProgram: (ctx, stdin) =>
      code`import io, runpy, sys
sys.stdin = io.StringIO(${dq(stdin)})
try:
    runpy.run_path(${dq(ctx.entry)}, run_name="__main__")
except SystemExit:
    pass
`,
    toolchains: ["python3", "python"].map((tool) => ({
      tool,
      versionArgs: ["--version"],
      run: [tool, "-B", "{harness}"],
      program: [tool, "-B", "{entry}"],
      native: [[tool, "-B", "-m", "pytest", "-q", "-p", "no:cacheprovider", "{test}"]]
    })),
    lint: {
      ruff: { argv: ["ruff", "check", "--no-cache", "--output-format", "concise", "{entry}"] },
      flake8: { argv: ["flake8", "{entry}"] },
      pylint: { argv: ["pylint", "--output-format=parseable", "--score=n", "{entry}"] },
      mypy: { argv: ["mypy", "--no-error-summary", "{entry}"] }
    }
  },
  sql: {
    id: "sql",
    label: "SQL (SQLite)",
    exts: [".sql"],
    valueFormat: "rows as the sqlite3 shell prints them: columns joined by |, one row per line, NULL as empty",
    image: "python:3.12-slim",
    imageNote: "uses Python's built-in sqlite3 module through LAS's small sqlite3-shell stand-in",
    imageTool: "python3",
    browser: "sql",
    vmLimit: true,
    harnessFile: "__las_harness.sql",
    harness: (ctx) => ({ "__las_harness.sql": sqlHarness(ctx) }),
    browserProgram: (ctx, stdin) => `.bail off\n.read ${sq(ctx.entry)}\n${stdin}\n`,
    errorPattern: /^(?:Parse error|Runtime error|Error)\b.*$/m,
    // the stand-in comes first: the sqlite3 shell buffers its output when piped but prints errors at once,
    // so an error could land beside the wrong test; the stand-in prints both in order
    toolchains: [
      ...["python3", "sqlite3", "python"].map((tool): Toolchain =>
        tool === "sqlite3"
          ? {
              tool,
              versionArgs: ["--version"],
              run: ["sqlite3", "-batch", ":memory:", ".read {harness}"],
              program: ["sqlite3", "-batch", "-cmd", ".read {entry}", ":memory:"],
              native: [["sqlite3", "-bail", "-batch", "-cmd", ".read {entry}", ":memory:", ".read {test}"]]
            }
          : {
              tool,
              versionArgs: ["-c", "import sqlite3; print('sqlite ' + sqlite3.sqlite_version)"],
              run: [tool, "-B", "__las_sqlite.py", "-batch", ":memory:", ".read {harness}"],
              program: [tool, "-B", "__las_sqlite.py", "-batch", "-cmd", ".read {entry}", ":memory:"],
              native: [[tool, "-B", "__las_sqlite.py", "-bail", "-batch", "-cmd", ".read {entry}", ":memory:", ".read {test}"]],
              files: { "__las_sqlite.py": SQLITE_SHIM }
            }
      )
    ],
    lint: {}
  },
  ruby: {
    id: "ruby",
    label: "Ruby",
    exts: [".rb"],
    valueFormat: "strings as-is; other values with inspect, e.g. [1, 2] or {:a=>1}; nil prints nothing",
    image: "ruby:3.3-slim",
    browser: "ruby",
    vmLimit: true,
    harnessFile: "__las_harness.rb",
    harness: (ctx) => ({ "__las_harness.rb": rubyHarness(ctx) }),
    // $0 is set to the entry so an `if __FILE__ == $0` main block runs, as it would from the command line
    browserProgram: (ctx, stdin) => `require 'stringio'\n$stdin = StringIO.new(${sq(stdin)})\n$0 = ${sq(ctx.entry)}\nTOPLEVEL_BINDING.eval(${sq(ctx.files[ctx.entry] ?? "")}, ${sq(ctx.entry)}, 1)\n`,
    toolchains: [{ tool: "ruby", versionArgs: ["--version"], run: ["ruby", "{harness}"], program: ["ruby", "{entry}"], native: [["ruby", "-I.", "{test}"]] }],
    lint: { rubocop: { argv: ["rubocop", "--format", "emacs", "--cache", "false", "{entry}"] } }
  },
  php: {
    id: "php",
    label: "PHP",
    exts: [".php"],
    valueFormat: "strings and numbers as-is; true/false; arrays as JSON; null prints nothing",
    image: "php:8-cli",
    browser: "php",
    vmLimit: true,
    harnessFile: "__las_harness.php",
    harness: (ctx) => ({ "__las_harness.php": phpHarness(ctx) }),
    toolchains: [{ tool: "php", versionArgs: ["--version"], run: ["php", "-d", "display_errors=stderr", "{harness}"], program: ["php", "{entry}"], native: [["phpunit", "{test}"]] }],
    lint: { phpcs: { argv: ["phpcs", "--report=emacs", "{entry}"] } }
  },
  rust: {
    id: "rust",
    label: "Rust",
    exts: [".rs"],
    valueFormat: "Display when the type has it (strings as-is, numbers), otherwise Debug, e.g. [1, 2] or Some(3); () prints nothing",
    image: "rust:1-slim",
    vmLimit: true,
    env: { CARGO_NET_OFFLINE: "true" },
    harnessFile: `${MIRROR}/las_main.rs`,
    harness: rustHarness,
    toolchains: [
      {
        tool: "rustc",
        versionArgs: ["--version"],
        compile: [["rustc", "--edition", "2021", "-A", "warnings", "-o", "las_bin_h", "{harness}"]],
        run: ["./las_bin_h"],
        programCompile: [["rustc", "--edition", "2021", "-o", "las_bin_p", "{entry}"]],
        program: ["./las_bin_p"],
        native: [["cargo", "test", "--offline", "--quiet", "--test", "{testStem}"]]
      }
    ],
    lint: { clippy: { bin: "cargo", argv: ["cargo", "clippy", "--offline", "--quiet", "--message-format", "short"] } }
  },
  go: {
    id: "go",
    label: "Go",
    exts: [".go"],
    valueFormat: "fmt.Sprint of each returned value, joined by spaces, e.g. [1 2 3] or 3 <nil>; calls must return a value unless they end with ;",
    image: "golang:1-alpine",
    vmLimit: false,
    env: { GOFLAGS: "-mod=mod", GOPROXY: "off", GOTOOLCHAIN: "local", CGO_ENABLED: "0", GOMEMLIMIT: "{memoryMb}MiB" },
    harnessFile: `${MIRROR}/lasharness.go`,
    harness: goHarness,
    sources: (ctx) => Object.keys(ctx.files).filter((p) => extOf(p) === ".go" && dirOf(p) === ctx.entryDir && !p.endsWith("_test.go") && !ctx.nativePaths.includes(p)),
    toolchains: [
      {
        tool: "go",
        versionArgs: ["version"],
        compile: [["go", "build", "-o", "las_bin_h", "{mirrorSources}"]],
        run: ["./las_bin_h"],
        programCompile: [["go", "build", "-o", "las_bin_p", "{sources}"]],
        program: ["./las_bin_p"],
        native: [["go", "test", "{sources}", "{test}"]]
      }
    ],
    lint: { vet: { bin: "go", argv: ["go", "vet", "{sources}"] }, staticcheck: { argv: ["staticcheck", "{sources}"] } }
  },
  java: {
    id: "java",
    label: "Java",
    exts: [".java"],
    valueFormat: "String.valueOf(value): strings as-is, 2.0 for doubles, arrays like [1, 2]; void calls print nothing",
    image: "eclipse-temurin:21",
    vmLimit: false,
    harnessFile: `${MIRROR}/LasHarness.java`,
    harness: javaHarness,
    vars: (ctx) => {
      const { pkg } = javaInfo(ctx);
      return { harnessClass: pkg ? `${pkg}.LasHarness` : "LasHarness", entryClass: pkg ? `${pkg}.${ctx.entryStem}` : ctx.entryStem };
    },
    toolchains: [
      {
        tool: "javac",
        needs: ["java"],
        versionArgs: ["-version"],
        compile: [["javac", "-encoding", "UTF-8", "-nowarn", "-d", "las_out_h", "{mirrorSources}"]],
        run: ["java", "-Xmx{memoryMb}m", "-XX:+UseSerialGC", "-cp", "las_out_h", "{harnessClass}"],
        programCompile: [["javac", "-encoding", "UTF-8", "-d", "las_out_p", "{sources}"]],
        program: ["java", "-Xmx{memoryMb}m", "-XX:+UseSerialGC", "-cp", "las_out_p", "{entryClass}"],
        native: [
          ["javac", "-encoding", "UTF-8", "-d", "las_out_n", "{sources}", "{test}"],
          ["java", "-Xmx{memoryMb}m", "-cp", "las_out_n", "{testClass}"]
        ]
      }
    ],
    lint: { "javac-lint": { bin: "javac", argv: ["javac", "-Xlint:all", "-d", "las_out_lint", "{sources}"] } }
  },
  c: {
    id: "c",
    label: "C",
    exts: [".c"],
    valueFormat: "numbers with printf (doubles to 15 significant digits), char as a character, char* as text, bool as true/false; calls must return a value unless they end with ;",
    image: "gcc:14",
    vmLimit: true,
    harnessFile: "__las_harness.c",
    harness: (ctx) => ({ "__las_harness.c": cHarness(ctx) }),
    toolchains: ["gcc", "clang", "cc"].map((tool) => ({
      tool,
      versionArgs: ["--version"],
      compile: [[tool, "-std=gnu17", "-O0", "-g", "-o", "las_bin_h", "{harness}", "{otherSources}", "-lm"]],
      run: ["./las_bin_h"],
      programCompile: [[tool, "-std=gnu17", "-O0", "-g", "-o", "las_bin_p", "{sources}", "-lm"]],
      program: ["./las_bin_p"],
      native: [
        [tool, "-std=gnu17", "-O0", "-g", "-o", "las_bin_n", "{test}", "-lm"],
        ["./las_bin_n"]
      ]
    })),
    lint: COLON_C
  },
  cpp: {
    id: "cpp",
    label: "C++",
    exts: [".cpp", ".cc", ".cxx"],
    valueFormat: "ostream output (15 significant digits), bool as true/false, containers like [1, 2], pairs like (a, b)",
    image: "gcc:14",
    vmLimit: true,
    harnessFile: "__las_harness.cpp",
    harness: (ctx) => ({ "__las_harness.cpp": cppHarness(ctx) }),
    toolchains: ["g++", "clang++", "c++"].map((tool) => ({
      tool,
      versionArgs: ["--version"],
      compile: [[tool, "-std=c++17", "-O0", "-g", "-o", "las_bin_h", "{harness}", "{otherSources}"]],
      run: ["./las_bin_h"],
      programCompile: [[tool, "-std=c++17", "-O0", "-g", "-o", "las_bin_p", "{sources}"]],
      program: ["./las_bin_p"],
      native: [
        [tool, "-std=c++17", "-O0", "-g", "-o", "las_bin_n", "{test}"],
        ["./las_bin_n"]
      ]
    })),
    lint: { "gcc-warnings": { bin: "g++", argv: ["g++", "-std=c++17", "-fsyntax-only", "-Wall", "-Wextra", "{entry}"] }, "clang-tidy": COLON_C["clang-tidy"], cppcheck: COLON_C.cppcheck }
  },
  csharp: {
    id: "csharp",
    label: "C#",
    exts: [".cs"],
    valueFormat: "Convert.ToString with the invariant culture (True/False, 2.5), collections like [1, 2]; void calls print nothing",
    image: "mcr.microsoft.com/dotnet/sdk:8.0",
    imageNote: "Microsoft's official image on MCR (not Docker Hub); the .NET SDK is MIT",
    vmLimit: false,
    env: { DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", DOTNET_GCHeapHardLimit: "{memoryBytesHex}" },
    harnessFile: `${MIRROR}/LasHarness.cs`,
    harness: csharpHarness,
    toolchains: [
      {
        tool: "dotnet",
        versionArgs: ["--version"],
        compile: [["dotnet", "build", `${MIRROR}/las.csproj`, "-o", "las_out_h", "--nologo", "-v", "q", "-clp:NoSummary"]],
        run: ["dotnet", "las_out_h/las.dll"],
        programCompile: [["dotnet", "build", `${MIRROR}/prog/las.csproj`, "-o", "las_out_p", "--nologo", "-v", "q", "-clp:NoSummary"]],
        program: ["dotnet", "las_out_p/las.dll"],
        native: [["dotnet", "test", "--nologo"]]
      }
    ],
    lint: {}
  },
  kotlin: {
    id: "kotlin",
    label: "Kotlin",
    exts: [".kt"],
    valueFormat: "toString(): strings as-is, lists like [1, 2], arrays via contentToString; Unit prints nothing",
    image: "zenika/kotlin:1.9-jdk17",
    imageNote: "community image (no official Kotlin image on Docker Hub); check it before use",
    vmLimit: false,
    harnessFile: `${MIRROR}/LasHarness.kt`,
    harness: kotlinHarness,
    toolchains: [
      {
        tool: "kotlinc",
        needs: ["java"],
        versionArgs: ["-version"],
        compile: [["kotlinc", "{mirrorSources}", "-nowarn", "-include-runtime", "-d", "las_h.jar"]],
        run: ["java", "-Xmx{memoryMb}m", "-cp", "las_h.jar", "LasHarnessKt"],
        programCompile: [["kotlinc", "{sources}", "-include-runtime", "-d", "las_p.jar"]],
        program: ["java", "-Xmx{memoryMb}m", "-jar", "las_p.jar"],
        native: [
          ["kotlinc", "{sources}", "{test}", "-include-runtime", "-d", "las_n.jar"],
          ["java", "-cp", "las_n.jar", "{testStem}Kt"]
        ]
      }
    ],
    lint: { ktlint: { argv: ["ktlint", "{entry}"] } }
  },
  swift: {
    id: "swift",
    label: "Swift",
    exts: [".swift"],
    valueFormat: "String(describing:): strings as-is, arrays like [1, 2], optionals unwrapped (nil when empty); () prints nothing",
    image: "swift:6.0",
    vmLimit: true,
    harnessFile: `${MIRROR}/main.swift`,
    harness: swiftHarness,
    toolchains: [
      {
        tool: "swiftc",
        versionArgs: ["--version"],
        compile: [["swiftc", "-suppress-warnings", "-o", "las_bin_h", "{mirrorSources}"]],
        run: ["./las_bin_h"],
        programCompile: [["swiftc", "-o", "las_bin_p", "{sources}"]],
        program: ["./las_bin_p"],
        native: [
          ["swiftc", "-o", "las_bin_n", "{otherSources}", "{test}"],
          ["./las_bin_n"]
        ]
      }
    ],
    lint: { swiftlint: { argv: ["swiftlint", "lint", "--quiet", "{entry}"] } }
  },
  bash: {
    id: "bash",
    label: "Bash",
    exts: [".sh", ".bash"],
    valueFormat: "what the call prints; the exit status is not printed (add `; echo $?` to test it)",
    image: "bash:5",
    vmLimit: true,
    harnessFile: "__las_harness.sh",
    harness: (ctx) => ({ "__las_harness.sh": bashHarness(ctx) }),
    toolchains: [{ tool: "bash", versionArgs: ["--version"], run: ["bash", "{harness}"], program: ["bash", "{entry}"], native: [["bash", "{test}"]] }],
    lint: { shellcheck: { argv: ["shellcheck", "-f", "gcc", "{entry}"] } }
  },
  lua: {
    id: "lua",
    label: "Lua",
    exts: [".lua"],
    valueFormat: "tostring for numbers and booleans, strings as-is, tables like {1, 2, a = 3}; several results joined by spaces",
    image: "nickblah/lua:5.4",
    imageNote: "community image (no official Lua image on Docker Hub); check it before use",
    vmLimit: true,
    harnessFile: "__las_harness.lua",
    harness: (ctx) => ({ "__las_harness.lua": luaHarness(ctx) }),
    toolchains: ["lua", "lua5.4", "lua5.3", "luajit"].map((tool) => ({ tool, versionArgs: ["-v"], run: [tool, "{harness}"], program: [tool, "{entry}"], native: [[tool, "{test}"]] })),
    lint: { luacheck: { argv: ["luacheck", "--formatter", "plain", "--codes", "--no-color", "{entry}"] } }
  },
  r: {
    id: "r",
    label: "R",
    exts: [".r"],
    valueFormat: "vectors as their values joined by spaces (TRUE, 2.5, text as-is); lists and data frames as print() shows them",
    image: "r-base:4.4.1",
    vmLimit: true,
    harnessFile: "__las_harness.R",
    harness: (ctx) => ({ "__las_harness.R": rHarness(ctx) }),
    toolchains: [{ tool: "Rscript", versionArgs: ["--version"], run: ["Rscript", "--vanilla", "{harness}"], program: ["Rscript", "--vanilla", "{entry}"], native: [["Rscript", "--vanilla", "{test}"]] }],
    lint: { lintr: { bin: "Rscript", argv: ["Rscript", "--vanilla", "-e", 'lintr::lint("{entry}")'] } }
  },
  haskell: {
    id: "haskell",
    label: "Haskell",
    exts: [".hs"],
    valueFormat: "show value, except String as-is and () prints nothing",
    image: "haskell:9",
    vmLimit: false,
    harnessFile: `${MIRROR}/LasHarness.hs`,
    harness: haskellHarness,
    vars: (ctx) => ({ hsModule: haskellModule(ctx.files[ctx.entry] ?? "") ?? "Main", entryDirOrDot: ctx.entryDir || "." }),
    toolchains: [
      {
        tool: "ghc",
        versionArgs: ["--version"],
        compile: [["ghc", "-O0", "-v0", `-i${MIRROR}`, "-i{entryDirOrDot}", "-outputdir", "las_build_h", "-o", "las_bin_h", "{harness}"]],
        run: ["./las_bin_h", "+RTS", "-M{memoryMb}m", "-RTS"],
        programCompile: [["ghc", "-O0", "-v0", "-i{entryDirOrDot}", "-main-is", "{hsModule}", "-outputdir", "las_build_p", "-o", "las_bin_p", "{entry}"]],
        program: ["./las_bin_p"],
        native: [["runghc", "-i{entryDirOrDot}", "{test}"]]
      }
    ],
    lint: { hlint: { argv: ["hlint", "{entry}"] } }
  },
  elixir: {
    id: "elixir",
    label: "Elixir",
    exts: [".ex", ".exs"],
    valueFormat: "strings as-is, other values with inspect, e.g. [1, 2] or %{a: 1}; nil prints nothing",
    image: "elixir:1.17-slim",
    vmLimit: false,
    harnessFile: "__las_harness.exs",
    harness: (ctx) => ({ "__las_harness.exs": elixirHarness(ctx) }),
    toolchains: [{ tool: "elixir", versionArgs: ["--version"], run: ["elixir", "{harness}"], program: ["elixir", "{entry}"], native: [["elixir", "{test}"]] }],
    lint: {}
  },
  scala: {
    id: "scala",
    label: "Scala",
    exts: [".scala", ".sc"],
    valueFormat: "toString: strings as-is, List(1, 2), arrays like [1, 2]; Unit prints nothing",
    image: "virtuslab/scala-cli:latest",
    imageNote: "the Scala CLI maintainers' image (no official Scala image on Docker Hub)",
    vmLimit: false,
    harnessFile: `${MIRROR}/LasHarness.scala`,
    harness: scalaHarness,
    toolchains: [
      {
        tool: "scala-cli",
        versionArgs: ["version"],
        run: ["scala-cli", "run", "--server=false", "-q", "--main-class", "LasHarness", "{mirrorSources}"],
        runBuilds: true,
        program: ["scala-cli", "run", "--server=false", "-q", "{sources}"],
        native: [["scala-cli", "test", "--server=false", "-q", "{sources}", "{test}"]]
      }
    ],
    lint: {}
  },
  dart: {
    id: "dart",
    label: "Dart",
    exts: [".dart"],
    valueFormat: "toString(): strings as-is, lists like [1, 2]; null prints nothing; Futures are awaited",
    image: "dart:stable",
    vmLimit: false,
    harnessFile: "__las_harness.dart",
    harness: (ctx) => ({ "__las_harness.dart": dartHarness(ctx) }),
    toolchains: [{ tool: "dart", versionArgs: ["--version"], run: ["dart", "run", "{harness}"], runBuilds: true, program: ["dart", "run", "{entry}"], native: [["dart", "run", "{test}"]] }],
    lint: { "dart-analyze": { bin: "dart", argv: ["dart", "analyze", "{entry}"] } }
  },
  zig: {
    id: "zig",
    label: "Zig",
    exts: [".zig"],
    valueFormat: "std.fmt {any}, except strings as-is, optionals unwrapped (null when empty) and errors as error.Name (Zig 0.14 or later)",
    image: "euantorano/zig:0.14.1",
    imageNote: "community image (no official Zig image on Docker Hub); check it before use",
    vmLimit: true,
    harnessFile: `${MIRROR}/{entry}`,
    harness: zigHarness,
    toolchains: [
      {
        tool: "zig",
        versionArgs: ["version"],
        compile: [["zig", "build-exe", "-femit-bin=las_bin_h", "{harness}"]],
        run: ["./las_bin_h"],
        programCompile: [["zig", "build-exe", "-femit-bin=las_bin_p", "{entry}"]],
        program: ["./las_bin_p"],
        native: [["zig", "test", "{test}"]]
      }
    ],
    lint: { "ast-check": { bin: "zig", argv: ["zig", "ast-check", "{entry}"] } }
  }
};

export function languageDef(id: string): LanguageDef | undefined {
  return (LANGUAGE_TABLE as Record<string, LanguageDef>)[id];
}
