// Pure helpers for tools/check-licenses.mjs: SPDX-expression parsing and the allowlist decision.
// Kept free of I/O so it can be unit tested (packages/cli/test/licenses.test.ts).

/** Result ranks: ok < warn < fail. */
const RANK = { ok: 0, warn: 1, fail: 2 };
const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);

/** Splits an SPDX-ish expression into tokens: "(", ")", AND, OR, WITH and license ids. */
export function tokenize(expr) {
  const tokens = [];
  for (const m of String(expr).matchAll(/\(|\)|[^\s()]+/g)) {
    const t = m[0];
    const up = t.toUpperCase();
    tokens.push(up === "AND" || up === "OR" || up === "WITH" ? up : t);
  }
  return tokens;
}

/**
 * Parses an SPDX expression into a tree: { id } | { op: "AND" | "OR", args: [...] }.
 * "X WITH exception" is treated as X. AND binds tighter than OR. Throws on malformed input.
 */
export function parseExpression(expr) {
  const tokens = tokenize(expr);
  let i = 0;
  const parseOr = () => {
    const args = [parseAnd()];
    while (tokens[i] === "OR") {
      i++;
      args.push(parseAnd());
    }
    return args.length === 1 ? args[0] : { op: "OR", args };
  };
  const parseAnd = () => {
    const args = [parseAtom()];
    while (tokens[i] === "AND") {
      i++;
      args.push(parseAtom());
    }
    return args.length === 1 ? args[0] : { op: "AND", args };
  };
  const parseAtom = () => {
    const t = tokens[i++];
    if (t === undefined) throw new Error(`unexpected end of license expression "${expr}"`);
    if (t === "(") {
      const inner = parseOr();
      if (tokens[i++] !== ")") throw new Error(`missing ")" in license expression "${expr}"`);
      return inner;
    }
    if (t === ")" || t === "AND" || t === "OR" || t === "WITH") throw new Error(`unexpected "${t}" in license expression "${expr}"`);
    if (tokens[i] === "WITH") i += 2;
    return { id: t.replace(/\+$/, "") };
  };
  if (!tokens.length) throw new Error("empty license expression");
  const tree = parseOr();
  if (i < tokens.length) throw new Error(`unexpected "${tokens[i]}" in license expression "${expr}"`);
  return tree;
}

/**
 * Decides one license expression against { allowed, allowedWithCare }.
 * OR: the best alternative wins. AND: every part must pass, the worst result counts.
 * Returns { status: "ok" | "warn" | "fail", bad: [ids that block it], care: [ids needing care] }.
 */
export function evaluateLicense(expr, policy) {
  if (expr === undefined || expr === null || String(expr).trim() === "") return { status: "fail", bad: ["(none declared)"], care: [] };
  let tree;
  try {
    tree = parseExpression(expr);
  } catch {
    return { status: "fail", bad: [String(expr)], care: [] };
  }
  const allowed = new Set((policy.allowed ?? []).map((s) => s.toLowerCase()));
  const care = new Set((policy.allowedWithCare ?? []).map((s) => s.toLowerCase()));
  const walk = (node) => {
    if (node.id !== undefined) {
      const k = node.id.toLowerCase();
      if (allowed.has(k)) return { status: "ok", bad: [], care: [] };
      if (care.has(k)) return { status: "warn", bad: [], care: [node.id] };
      return { status: "fail", bad: [node.id], care: [] };
    }
    const parts = node.args.map(walk);
    if (node.op === "OR") return parts.reduce((a, b) => (RANK[b.status] < RANK[a.status] ? b : a));
    return parts.reduce((a, b) => ({ status: worst(a.status, b.status), bad: [...a.bad, ...b.bad], care: [...a.care, ...b.care] }), { status: "ok", bad: [], care: [] });
  };
  return walk(tree);
}

/** The license a package.json declares, as one expression string (handles the old object and array forms). */
export function licenseOfManifest(pkg) {
  const one = (l) => (typeof l === "string" ? l : l && typeof l === "object" ? l.type : undefined);
  if (pkg.license !== undefined) return one(pkg.license);
  if (Array.isArray(pkg.licenses)) {
    const parts = pkg.licenses.map(one).filter(Boolean);
    return parts.length ? `(${parts.join(" OR ")})` : undefined;
  }
  return undefined;
}

/**
 * Flattens `pnpm licenses list --json` output to [{ name, version, license }].
 * Accepts the object keyed by license (name + versions[]) or a plain array of entries.
 */
export function flattenPnpmLicenses(json) {
  const out = [];
  const push = (entry, license) => {
    const versions = entry.versions ?? (entry.version ? [entry.version] : ["?"]);
    for (const version of versions) out.push({ name: entry.name, version, license: entry.license ?? license });
  };
  if (Array.isArray(json)) for (const e of json) push(e, undefined);
  else for (const [license, list] of Object.entries(json ?? {})) for (const e of Array.isArray(list) ? list : []) push(e, license);
  return out;
}

/** Applies the policy to a package list. Returns { offenders, warnings, excepted }. */
export function checkPackages(packages, policy) {
  const exceptions = policy.exceptions ?? {};
  const offenders = [];
  const warnings = [];
  const excepted = [];
  const seen = new Set();
  for (const p of packages) {
    const key = `${p.name}@${p.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = evaluateLicense(p.license, policy);
    if (r.status === "ok") continue;
    if (exceptions[key]) {
      excepted.push({ ...p, reason: exceptions[key] });
      continue;
    }
    (r.status === "warn" ? warnings : offenders).push({ ...p, bad: r.bad, care: r.care });
  }
  return { offenders, warnings, excepted };
}
