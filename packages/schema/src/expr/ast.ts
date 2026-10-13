/**
 * AST for the LAS expression language.
 *
 * Specs are data, not code: an expression is a tree of literals, names, member
 * accesses, calls and operators that runs on a small set of built-in functions
 * supplied by the engine. There is no assignment, no loops and no access to the host.
 */
export type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "name"; name: string }
  | { kind: "member"; object: Expr; property: string }
  | { kind: "index"; object: Expr; index: Expr }
  | { kind: "list"; items: Expr[] }
  | { kind: "call"; fn: string; args: Expr[]; named: Record<string, Expr> }
  | { kind: "unary"; op: "-" | "!"; operand: Expr }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr };

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||";

/** A metric expression: an expression plus optional `per <segment>` and `at <phase>` clauses. */
export interface MetricExpr {
  expr: Expr;
  per?: string;
  at?: string;
}

/** Walks the tree, calling `fn` on every node. */
export function walk(e: Expr, fn: (node: Expr) => void): void {
  fn(e);
  switch (e.kind) {
    case "member":
      walk(e.object, fn);
      break;
    case "index":
      walk(e.object, fn);
      walk(e.index, fn);
      break;
    case "list":
      e.items.forEach((i) => walk(i, fn));
      break;
    case "call":
      e.args.forEach((a) => walk(a, fn));
      Object.values(e.named).forEach((a) => walk(a, fn));
      break;
    case "unary":
      walk(e.operand, fn);
      break;
    case "binary":
      walk(e.left, fn);
      walk(e.right, fn);
      break;
  }
}

/** Names referenced by an expression (bare identifiers, not call names). */
export function referencedNames(e: Expr): Set<string> {
  const out = new Set<string>();
  walk(e, (n) => {
    if (n.kind === "name") out.add(n.name);
  });
  return out;
}

/** Function names called by an expression. */
export function calledFunctions(e: Expr): Set<string> {
  const out = new Set<string>();
  walk(e, (n) => {
    if (n.kind === "call") out.add(n.fn);
  });
  return out;
}

/** Root names of dotted paths, e.g. `left_hip.y` -> `left_hip`. */
export function rootNames(e: Expr): Set<string> {
  const out = new Set<string>();
  walk(e, (n) => {
    if (n.kind === "name") out.add(n.name);
    if (n.kind === "member") {
      let o: Expr = n;
      while (o.kind === "member") o = o.object;
      if (o.kind === "name") out.add(o.name);
    }
  });
  return out;
}

/** Full dotted paths rooted at a name, e.g. `left_hand.index_tip`, `baseline.torso`. */
export function dottedNames(e: Expr): Set<string> {
  const out = new Set<string>();
  const path = (n: Expr): string | null => {
    if (n.kind === "name") return n.name;
    if (n.kind === "member") {
      const p = path(n.object);
      return p === null ? null : `${p}.${n.property}`;
    }
    return null;
  };
  walk(e, (n) => {
    if (n.kind === "name" || n.kind === "member") {
      const p = path(n);
      if (p) out.add(p);
    }
  });
  return out;
}
