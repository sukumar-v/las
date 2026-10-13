import type { Expr } from "./ast.js";
import { isPoints, isSeries, mean, series, toArray, toNumber, truthy, type Series, type Value } from "./value.js";

export type ExprFn = (args: Value[], named: Record<string, Value>, env: Env) => Value;

export interface Env {
  /** Resolve a bare name. Return undefined for unknown names. */
  get(name: string): Value | undefined;
  fns: Record<string, ExprFn>;
}

export class ExprRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprRuntimeError";
  }
}

function lift2(a: Value, b: Value, f: (x: number, y: number) => number): Value {
  if (isSeries(a) || isSeries(b)) {
    const sa = isSeries(a) ? a : null;
    const sb = isSeries(b) ? b : null;
    const n = sa && sb ? Math.min(sa.values.length, sb.values.length) : (sa ?? sb)!.values.length;
    const out = new Float64Array(n);
    const na = sa ? null : toNumber(a);
    const nb = sb ? null : toNumber(b);
    for (let i = 0; i < n; i++) out[i] = f(sa ? sa.values[i] : na!, sb ? sb.values[i] : nb!);
    const conf = sa?.conf && sb?.conf ? Float64Array.from(sa.conf.slice(0, n), (c, i) => Math.min(c, sb.conf![i])) : (sa?.conf ?? sb?.conf)?.slice(0, n);
    const s: Series = { kind: "series", values: out };
    if (conf) s.conf = conf;
    const t = sa?.t ?? sb?.t;
    if (t) s.t = t.slice(0, n);
    return s;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a : null;
    const ab = Array.isArray(b) ? b : null;
    const n = aa && ab ? Math.min(aa.length, ab.length) : (aa ?? ab)!.length;
    const out: Value[] = [];
    for (let i = 0; i < n; i++) out.push(f(toNumber(aa ? aa[i] : a), toNumber(ab ? ab[i] : b)));
    return out;
  }
  if (typeof a === "string" || typeof b === "string") {
    // string comparison / concatenation handled by caller
    return f(toNumber(a), toNumber(b));
  }
  return f(toNumber(a), toNumber(b));
}

const CMP: Record<string, (x: number, y: number) => number> = {
  "<": (x, y) => (x < y ? 1 : 0),
  "<=": (x, y) => (x <= y ? 1 : 0),
  ">": (x, y) => (x > y ? 1 : 0),
  ">=": (x, y) => (x >= y ? 1 : 0),
  "==": (x, y) => (x === y ? 1 : 0),
  "!=": (x, y) => (x !== y ? 1 : 0)
};

function compareStrings(op: string, a: string, b: string): boolean {
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "==":
      return a === b;
    case "!=":
      return a !== b;
  }
  return false;
}

export function evaluate(e: Expr, env: Env): Value {
  switch (e.kind) {
    case "num":
    case "str":
    case "bool":
      return e.value;
    case "list":
      return e.items.map((i) => evaluate(i, env));
    case "name": {
      const v = env.get(e.name);
      if (v === undefined) throw new ExprRuntimeError(`unknown name "${e.name}"`);
      return v;
    }
    case "member": {
      const o = evaluate(e.object, env);
      if (isPoints(o)) {
        const p = e.property;
        if (p === "x" || p === "y" || p === "z") {
          const arr = o[p];
          if (!arr) throw new ExprRuntimeError(`point has no ${p}`);
          return series(arr, o.conf, o.t);
        }
        if (p === "conf" || p === "confidence") return series(o.conf ?? new Float64Array(o.x.length).fill(1), undefined, o.t);
        throw new ExprRuntimeError(`unknown point property "${p}"`);
      }
      if (isSeries(o)) {
        if (e.property === "conf" || e.property === "confidence") return series(o.conf ?? new Float64Array(o.values.length).fill(1));
        if (e.property === "t") return series(o.t ?? Float64Array.from(o.values, (_, i) => i));
        throw new ExprRuntimeError(`unknown series property "${e.property}"`);
      }
      if (Array.isArray(o)) {
        if (e.property === "length") return o.length;
        const idx = Number(e.property);
        if (Number.isInteger(idx)) return o[idx] ?? null;
        throw new ExprRuntimeError(`unknown list property "${e.property}"`);
      }
      if (typeof o === "object" && o !== null) {
        if (!Object.hasOwn(o, e.property)) throw new ExprRuntimeError(`unknown property "${e.property}"`);
        const v = (o as Record<string, Value>)[e.property];
        if (v === undefined) throw new ExprRuntimeError(`unknown property "${e.property}"`);
        return v;
      }
      if (typeof o === "string" && e.property === "length") return o.length;
      throw new ExprRuntimeError(`cannot read "${e.property}" of ${typeof o}`);
    }
    case "index": {
      const o = evaluate(e.object, env);
      const i = evaluate(e.index, env);
      if (Array.isArray(o)) return o[toNumber(i)] ?? null;
      if (isSeries(o)) return o.values[toNumber(i)] ?? NaN;
      if (typeof o === "object" && o !== null && typeof i === "string") return Object.hasOwn(o, i) ? ((o as Record<string, Value>)[i] ?? null) : null;
      throw new ExprRuntimeError("cannot index this value");
    }
    case "unary": {
      const v = evaluate(e.operand, env);
      if (e.op === "-") return lift2(0, v, (_, y) => -y);
      if (isSeries(v)) return lift2(v, 0, (x) => (x ? 0 : 1));
      return !truthy(v);
    }
    case "binary": {
      if (e.op === "&&") {
        const l = evaluate(e.left, env);
        if (isSeries(l)) return lift2(l, evaluate(e.right, env), (x, y) => (x && y ? 1 : 0));
        if (!truthy(l)) return false;
        const r = evaluate(e.right, env);
        return isSeries(r) ? r : truthy(r);
      }
      if (e.op === "||") {
        const l = evaluate(e.left, env);
        if (isSeries(l)) return lift2(l, evaluate(e.right, env), (x, y) => (x || y ? 1 : 0));
        if (truthy(l)) return true;
        const r = evaluate(e.right, env);
        return isSeries(r) ? r : truthy(r);
      }
      const l = evaluate(e.left, env);
      const r = evaluate(e.right, env);
      switch (e.op) {
        case "+":
          if (typeof l === "string" || typeof r === "string") return String(l) + String(r);
          return lift2(l, r, (x, y) => x + y);
        case "-":
          return lift2(l, r, (x, y) => x - y);
        case "*":
          return lift2(l, r, (x, y) => x * y);
        case "/":
          return lift2(l, r, (x, y) => x / y);
        case "%":
          return lift2(l, r, (x, y) => x % y);
        default: {
          if (typeof l === "string" && typeof r === "string") return compareStrings(e.op, l, r);
          if (typeof l === "string" || typeof r === "string") {
            const ls = String(l);
            const rs = String(r);
            if (Number.isNaN(Number(ls)) || Number.isNaN(Number(rs))) return compareStrings(e.op, ls, rs);
          }
          const out = lift2(l, r, CMP[e.op]);
          return typeof out === "number" ? out === 1 : out;
        }
      }
    }
    case "call": {
      const fn = env.fns[e.fn];
      if (!fn) throw new ExprRuntimeError(`unknown function "${e.fn}"`);
      const args = e.args.map((a) => evaluate(a, env));
      const named: Record<string, Value> = {};
      for (const [k, v] of Object.entries(e.named)) named[k] = evaluate(v, env);
      return fn(args, named, env);
    }
  }
}

/** Reduce a value to a scalar, applying `f` over series or lists. */
function reduce(v: Value, f: (a: number[]) => number): number {
  return f(toArray(v).filter((x) => !Number.isNaN(x)));
}

/** Domain-neutral functions available to every spec. */
export const STANDARD_FUNCTIONS: Record<string, ExprFn> = {
  min: (a) => (a.length === 1 ? reduce(a[0], (x) => (x.length ? Math.min(...x) : NaN)) : Math.min(...a.map(toNumber))),
  max: (a) => (a.length === 1 ? reduce(a[0], (x) => (x.length ? Math.max(...x) : NaN)) : Math.max(...a.map(toNumber))),
  mean: (a) => reduce(a.length === 1 ? a[0] : a, mean),
  avg: (a) => reduce(a.length === 1 ? a[0] : a, mean),
  median: (a) =>
    reduce(a.length === 1 ? a[0] : a, (x) => {
      if (!x.length) return NaN;
      const s = [...x].sort((p, q) => p - q);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }),
  std: (a) =>
    reduce(a.length === 1 ? a[0] : a, (x) => {
      if (x.length < 2) return 0;
      const m = mean(x);
      return Math.sqrt(x.reduce((t, v) => t + (v - m) ** 2, 0) / (x.length - 1));
    }),
  sum: (a) => reduce(a.length === 1 ? a[0] : a, (x) => x.reduce((t, v) => t + v, 0)),
  count: (a) => (a.length === 1 ? (isSeries(a[0]) ? a[0].values.length : Array.isArray(a[0]) ? a[0].length : 1) : a.length),
  len: (a) => (typeof a[0] === "string" ? a[0].length : isSeries(a[0]) ? a[0].values.length : Array.isArray(a[0]) ? a[0].length : 0),
  /** share of truthy / non-zero samples */
  share: (a) => reduce(a[0], (x) => (x.length ? x.filter((v) => v !== 0).length / x.length : NaN)),
  any: (a) => toArray(a[0]).some((v) => v !== 0 && !Number.isNaN(v)),
  all: (a) => {
    const x = toArray(a[0]);
    return x.length > 0 && x.every((v) => v !== 0 && !Number.isNaN(v));
  },
  first: (a) => {
    const x = toArray(a[0]);
    return x.length ? x[0] : NaN;
  },
  last: (a) => {
    const x = toArray(a[0]);
    return x.length ? x[x.length - 1] : NaN;
  },
  range: (a) => reduce(a[0], (x) => (x.length ? Math.max(...x) - Math.min(...x) : NaN)),
  abs: (a) => lift2(a[0], 0, (x) => Math.abs(x)),
  round: (a) => {
    const d = a[1] === undefined ? 0 : toNumber(a[1]);
    const k = 10 ** d;
    return lift2(a[0], 0, (x) => Math.round(x * k) / k);
  },
  floor: (a) => lift2(a[0], 0, (x) => Math.floor(x)),
  ceil: (a) => lift2(a[0], 0, (x) => Math.ceil(x)),
  sqrt: (a) => lift2(a[0], 0, (x) => Math.sqrt(x)),
  pow: (a) => lift2(a[0], a[1], (x, y) => x ** y),
  log: (a) => lift2(a[0], 0, (x) => Math.log(x)),
  exp: (a) => lift2(a[0], 0, (x) => Math.exp(x)),
  sin: (a) => lift2(a[0], 0, (x) => Math.sin(x)),
  cos: (a) => lift2(a[0], 0, (x) => Math.cos(x)),
  clamp: (a) => lift2(lift2(a[0], a[1], (x, lo) => Math.max(x, lo)), a[2], (x, hi) => Math.min(x, hi)),
  if: (a) => (truthy(a[0]) ? a[1] : a[2] ?? null),
  contains: (a) => {
    const list = a[0];
    if (typeof list === "string") return list.includes(String(a[1]));
    return Array.isArray(list) ? list.some((x) => x === a[1]) : false;
  },
  /** elements of a list/series that satisfy a per-element predicate given as the result of a lifted comparison */
  where: (a) => {
    const x = toArray(a[0]);
    const m = toArray(a[1]);
    return x.filter((_, i) => m[i] !== 0);
  },
  /** delta between consecutive samples */
  diff: (a) => {
    const x = toArray(a[0]);
    return series(x.slice(1).map((v, i) => v - x[i]));
  },
  /** absolute difference */
  absdiff: (a) => lift2(a[0], a[1], (x, y) => Math.abs(x - y)),
  /** distinct count in a list of values */
  distinct: (a) => (Array.isArray(a[0]) ? new Set(a[0].map((v) => JSON.stringify(v))).size : 1),
  /** fraction of items in a list equal to a value */
  shareof: (a) => {
    const list = Array.isArray(a[0]) ? a[0] : toArray(a[0]);
    return list.length ? list.filter((v) => v === a[1]).length / list.length : NaN;
  },
  number: (a) => toNumber(a[0]),
  string: (a) => String(a[0])
};

export const STANDARD_FUNCTION_NAMES = Object.keys(STANDARD_FUNCTIONS);

/** Convenience: evaluate with plain variables and the standard functions (plus extras). */
export function evalWith(e: Expr, vars: Record<string, Value>, extraFns: Record<string, ExprFn> = {}): Value {
  const fns = { ...STANDARD_FUNCTIONS, ...extraFns };
  const env: Env = {
    get: (n) => vars[n],
    fns
  };
  return evaluate(e, env);
}
