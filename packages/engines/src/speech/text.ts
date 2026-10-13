/**
 * Comparing what was said with what was meant, in any language. Text is normalized (Unicode
 * NFKC, lower case where the script has case, punctuation and symbols removed) and split into
 * tokens: words for scripts written with spaces, single characters for scripts written without
 * them (Han, kana, Thai, Lao, Khmer, Myanmar, Tibetan), so "我想喝水" compares character by
 * character. Similarity is one minus the token edit distance over the longer length.
 */

/** Scripts written without spaces between words: compared character by character. */
const NO_SPACE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;

export function isNoSpaceScript(ch: string): boolean {
  return NO_SPACE.test(ch);
}

export function normalizeSpeechText(text: string, lang?: string): string {
  let s = (text ?? "").normalize("NFKC");
  try {
    s = s.toLocaleLowerCase(lang || undefined);
  } catch {
    s = s.toLowerCase();
  }
  return s
    .replace(/['’ʼ]/g, "") // apostrophes join, so "don't" stays one word
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokens to compare: words, with no-space-script characters split out one by one. */
export function speechTokens(text: string, lang?: string): string[] {
  const out: string[] = [];
  for (const chunk of normalizeSpeechText(text, lang).split(" ")) {
    if (!chunk) continue;
    if (!NO_SPACE.test(chunk)) {
      out.push(chunk);
      continue;
    }
    let run = "";
    for (const ch of chunk) {
      if (NO_SPACE.test(ch)) {
        if (run) out.push(run);
        run = "";
        out.push(ch);
      } else run += ch;
    }
    if (run) out.push(run);
  }
  return out;
}

const stripMarks = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "");

export type TokenOp = { op: "ok" | "near" | "sub" | "del" | "ins"; t?: number; h?: number };

/**
 * Levenshtein alignment of target tokens with heard tokens. A token that differs only by
 * diacritics costs half a substitution ("near"), so a dropped accent counts less than a wrong
 * word. Returns the edit script and the distance.
 */
export function alignTokens(target: string[], heard: string[]): { ops: TokenOp[]; distance: number } {
  const n = target.length;
  const m = heard.length;
  const D = Array.from({ length: n + 1 }, (_, i) => new Float64Array(m + 1).fill(0).map((_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  const sub = (a: string, b: string) => (a === b ? 0 : stripMarks(a) === stripMarks(b) ? 0.5 : 1);
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + sub(target[i - 1], heard[j - 1]));
  const ops: TokenOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + sub(target[i - 1], heard[j - 1])) {
      const c = sub(target[i - 1], heard[j - 1]);
      ops.push({ op: c === 0 ? "ok" : c < 1 ? "near" : "sub", t: i - 1, h: j - 1 });
      i--;
      j--;
    } else if (i > 0 && D[i][j] === D[i - 1][j] + 1) {
      ops.push({ op: "del", t: i - 1 });
      i--;
    } else {
      ops.push({ op: "ins", h: j - 1 });
      j--;
    }
  }
  return { ops: ops.reverse(), distance: D[n][m] };
}

/** 1 for the same words, 0 for nothing in common; any language. */
export function textSimilarity(a: string, b: string, lang?: string): number {
  const ta = speechTokens(a, lang);
  const tb = speechTokens(b, lang);
  const len = Math.max(ta.length, tb.length);
  if (!len) return 1;
  return Math.max(0, 1 - alignTokens(ta, tb).distance / len);
}
