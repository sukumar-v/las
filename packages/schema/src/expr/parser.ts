import type { BinaryOp, Expr, MetricExpr } from "./ast.js";

export class ExprSyntaxError extends Error {
  constructor(message: string, public readonly position: number, public readonly source: string) {
    super(`${message} at ${position} in "${source}"`);
    this.name = "ExprSyntaxError";
  }
}

type Tok =
  | { t: "num"; v: number; p: number }
  | { t: "str"; v: string; p: number }
  | { t: "id"; v: string; p: number }
  | { t: "op"; v: string; p: number }
  | { t: "eof"; p: number };

const OPS = ["<=", ">=", "==", "!=", "&&", "||", "+", "-", "*", "/", "%", "<", ">", "!", "(", ")", "[", "]", ",", ".", ":", "="];

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const prev = out[out.length - 1];
    const afterValue = prev && (prev.t === "id" || prev.t === "num" || (prev.t === "op" && (prev.v === ")" || prev.v === "]")));
    if (/[0-9]/.test(c) || (c === "." && !afterValue && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ t: "num", v: Number(m[0]), p: i });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          j++;
        }
        s += src[j];
        j++;
      }
      if (j >= src.length) throw new ExprSyntaxError("unterminated string", i, src);
      out.push({ t: "str", v: s, p: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0], p: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprSyntaxError(`unexpected character "${c}"`, i, src);
    out.push({ t: "op", v: op, p: i });
    i += op.length;
  }
  out.push({ t: "eof", p: src.length });
  return out;
}

class Parser {
  private i = 0;
  constructor(private toks: Tok[], private src: string) {}

  peek(): Tok {
    return this.toks[this.i];
  }
  next(): Tok {
    return this.toks[this.i++];
  }
  isOp(v: string): boolean {
    const t = this.peek();
    return t.t === "op" && t.v === v;
  }
  isId(v: string): boolean {
    const t = this.peek();
    return t.t === "id" && t.v === v;
  }
  expectOp(v: string): void {
    if (!this.isOp(v)) throw new ExprSyntaxError(`expected "${v}"`, this.peek().p, this.src);
    this.next();
  }
  atEnd(): boolean {
    return this.peek().t === "eof";
  }

  expression(): Expr {
    return this.or();
  }
  or(): Expr {
    let left = this.and();
    while (this.isOp("||") || this.isId("or")) {
      this.next();
      left = { kind: "binary", op: "||", left, right: this.and() };
    }
    return left;
  }
  and(): Expr {
    let left = this.cmp();
    while (this.isOp("&&") || this.isId("and")) {
      this.next();
      left = { kind: "binary", op: "&&", left, right: this.cmp() };
    }
    return left;
  }
  cmp(): Expr {
    const left = this.add();
    const t = this.peek();
    if (t.t === "op" && ["<", "<=", ">", ">=", "==", "!="].includes(t.v)) {
      this.next();
      return { kind: "binary", op: t.v as BinaryOp, left, right: this.add() };
    }
    return left;
  }
  add(): Expr {
    let left = this.mul();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.next() as { v: string }).v as BinaryOp;
      left = { kind: "binary", op, left, right: this.mul() };
    }
    return left;
  }
  mul(): Expr {
    let left = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = (this.next() as { v: string }).v as BinaryOp;
      left = { kind: "binary", op, left, right: this.unary() };
    }
    return left;
  }
  unary(): Expr {
    if (this.isOp("-")) {
      this.next();
      return { kind: "unary", op: "-", operand: this.unary() };
    }
    if (this.isOp("!") || this.isId("not")) {
      this.next();
      return { kind: "unary", op: "!", operand: this.unary() };
    }
    return this.postfix();
  }
  postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.isOp(".")) {
        this.next();
        const t = this.next();
        if (t.t !== "id" && t.t !== "num") throw new ExprSyntaxError("expected property name", t.p, this.src);
        e = { kind: "member", object: e, property: String(t.v) };
      } else if (this.isOp("[")) {
        this.next();
        const index = this.expression();
        this.expectOp("]");
        e = { kind: "index", object: e, index };
      } else return e;
    }
  }
  primary(): Expr {
    const t = this.next();
    if (t.t === "num") return { kind: "num", value: t.v };
    if (t.t === "str") return { kind: "str", value: t.v };
    if (t.t === "id") {
      if (t.v === "true") return { kind: "bool", value: true };
      if (t.v === "false") return { kind: "bool", value: false };
      if (this.isOp("(")) {
        this.next();
        const args: Expr[] = [];
        const named: Record<string, Expr> = {};
        if (!this.isOp(")")) {
          for (;;) {
            const a = this.peek();
            const b = this.toks[this.i + 1];
            if (a.t === "id" && b && b.t === "op" && (b.v === ":" || b.v === "=")) {
              this.next();
              this.next();
              named[a.v] = this.expression();
            } else args.push(this.expression());
            if (this.isOp(",")) {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expectOp(")");
        return { kind: "call", fn: t.v, args, named };
      }
      return { kind: "name", name: t.v };
    }
    if (t.t === "op" && t.v === "(") {
      const e = this.expression();
      this.expectOp(")");
      return e;
    }
    if (t.t === "op" && t.v === "[") {
      const items: Expr[] = [];
      if (!this.isOp("]")) {
        for (;;) {
          items.push(this.expression());
          if (this.isOp(",")) {
            this.next();
            continue;
          }
          break;
        }
      }
      this.expectOp("]");
      return { kind: "list", items };
    }
    throw new ExprSyntaxError("unexpected token", t.p, this.src);
  }
}

/** Parses one expression. Throws ExprSyntaxError. */
export function parseExpr(src: string): Expr {
  const p = new Parser(tokenize(src), src);
  const e = p.expression();
  if (!p.atEnd()) throw new ExprSyntaxError("unexpected trailing input", p.peek().p, src);
  return e;
}

/**
 * Parses a metric expression: `<expr> [per <segment>] [at <phase>]`,
 * e.g. `min(angle(left_hip, left_knee, left_ankle)) per rep`.
 */
export function parseMetricExpr(src: string): MetricExpr {
  const p = new Parser(tokenize(src), src);
  const expr = p.expression();
  const out: MetricExpr = { expr };
  while (!p.atEnd()) {
    const t = p.next();
    if (t.t === "id" && (t.v === "per" || t.v === "at")) {
      const n = p.next();
      if (n.t !== "id") throw new ExprSyntaxError(`expected a name after "${t.v}"`, n.p, src);
      if (t.v === "per") out.per = n.v;
      else out.at = n.v;
    } else throw new ExprSyntaxError("unexpected trailing input", t.p, src);
  }
  return out;
}

/** Returns a syntax error message or null. */
export function checkExpr(src: string): string | null {
  try {
    parseExpr(src);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
