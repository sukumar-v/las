/** A small line-based unified diff: common prefix/suffix trimmed, LCS on the middle, hunks with context. */

type Op = { t: " " | "-" | "+"; s: string };

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffOps(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const ops: Op[] = a.slice(0, pre).map((s) => ({ t: " ", s }));
  const n = am.length;
  const m = bm.length;
  if ((n + 1) * (m + 1) > 25_000_000) {
    // pathological input: report a wholesale replacement rather than allocate a huge table
    for (const s of am) ops.push({ t: "-", s });
    for (const s of bm) ops.push({ t: "+", s });
  } else {
    // lcs[i][j] = length of the LCS of am[i..] and bm[j..]
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = am[i] === bm[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        ops.push({ t: " ", s: am[i] });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) ops.push({ t: "-", s: am[i++] });
      else ops.push({ t: "+", s: bm[j++] });
    }
    while (i < n) ops.push({ t: "-", s: am[i++] });
    while (j < m) ops.push({ t: "+", s: bm[j++] });
  }
  for (const s of a.slice(a.length - suf)) ops.push({ t: " ", s });
  return ops;
}

/** Unified diff of two texts, or "" when they are the same. A missing old text diffs against an empty file. */
export function unifiedDiff(oldText: string | undefined, newText: string, label: string, context = 3): string {
  const a = splitLines(oldText ?? "");
  const b = splitLines(newText);
  const ops = diffOps(a, b);
  const changed = ops.map((o, i) => (o.t === " " ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return "";
  const head = [oldText === undefined ? "--- /dev/null" : `--- ${label}`, `+++ ${label}`];
  // group changes whose context windows touch
  const groups: [number, number][] = [];
  for (const i of changed) {
    const lo = Math.max(0, i - context);
    const hi = Math.min(ops.length - 1, i + context);
    const last = groups[groups.length - 1];
    if (last && lo <= last[1] + 1) last[1] = hi;
    else groups.push([lo, hi]);
  }
  // 1-based line numbers of each op in the old and new file
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let ao = 1;
  let bo = 1;
  for (const o of ops) {
    oldNo.push(ao);
    newNo.push(bo);
    if (o.t !== "+") ao++;
    if (o.t !== "-") bo++;
  }
  const out = [...head];
  for (const [lo, hi] of groups) {
    const slice = ops.slice(lo, hi + 1);
    const oldLen = slice.filter((o) => o.t !== "+").length;
    const newLen = slice.filter((o) => o.t !== "-").length;
    const oldStart = oldLen === 0 ? oldNo[lo] - 1 : oldNo[lo];
    const newStart = newLen === 0 ? newNo[lo] - 1 : newNo[lo];
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);
    for (const o of slice) out.push(o.t + o.s);
  }
  return out.join("\n") + "\n";
}
