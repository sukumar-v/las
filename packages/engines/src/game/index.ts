/**
 * Game engine: moves checked by the rules, and judged by an external engine when one ran.
 *
 * Chess rules come from chess.js. Evaluation comes from `evidence.engineEvals`, produced by a UCI
 * engine the learner installed (see `uci.ts`, node only). Nothing is bundled. When there are no
 * evaluations, the check falls back to tactics puzzles from `spec.fallback_items`, labeled
 * `precision: "reduced"`. Other games (go, anything else) are checked with puzzles only.
 *
 * Plies are numbered from 1 in the list of analyzed moves. Centipawn numbers are from the mover's
 * side; a move's loss is how much worse it was than the engine's best (never below 0, mate scores capped).
 */
import { Chess } from "chess.js";
import type { Analysis, GameSpec, MetricValue } from "@las/schema";
import type { AnalyzeContext, GameEvidence } from "../types.js";
import { evalCondition, evalCriteria, finish, metric, metricVars, version } from "../common/analysis.js";
import { positionKey, resolveMove, START_FEN } from "./chess-util.js";

/** Loss thresholds in centipawns. */
const BLUNDER_CP = 300;
const MISTAKE_CP = 100;
const INACCURACY_CP = 50;
/** Mate scores are capped here so a "mate in 3" versus "mate in 5" isn't a huge loss. */
const CP_CAP = 1000;

const cap = (cp: number) => Math.max(-CP_CAP, Math.min(CP_CAP, cp));

interface PlyInfo {
  ply: number;
  white: boolean;
  fenBefore: string;
  san: string;
  uci: string;
}

type Puzzle = NonNullable<GameSpec["fallback_items"]>[number];

/** Normalize a puzzle answer so SAN and UCI spellings compare equal. Other games compare text. */
function sameAnswer(game: GameSpec["game"], position: string, a: string, b: string): boolean {
  if (game === "chess") {
    const ra = resolveMove(position, a);
    const rb = resolveMove(position, b);
    if (ra && rb) return ra.uci === rb.uci;
  }
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function puzzleScore(spec: GameSpec, answers: GameEvidence["puzzleAnswers"]): { solved: number; total: number; per: boolean[] } {
  const items: Puzzle[] = spec.fallback_items ?? [];
  const per = items.map((it) => {
    const key = spec.game === "chess" ? positionKey(it.position) : it.position.trim();
    const given = (answers ?? []).find((a) => (spec.game === "chess" ? positionKey(a.position) : a.position.trim()) === key);
    return !!given && sameAnswer(spec.game, it.position, given.answer, it.best);
  });
  return { solved: per.filter(Boolean).length, total: items.length, per };
}

export function analyzeGame(spec: GameSpec, evidence: GameEvidence, ctx?: AnalyzeContext): Analysis {
  const v = version("game", ctx?.specId, ctx?.modelVersion);
  const issues: string[] = [];
  const metrics: Record<string, MetricValue> = {};
  const markers: Analysis["markers"] = [];
  const mistakes: Analysis["mistakes"] = [];
  let praise: Analysis["praise"];
  let overlay: unknown;
  let precision: "full" | "reduced" = "full";
  let fallback = false;

  const moves = evidence.moves.length ? evidence.moves : spec.moves ?? [];
  const plies: PlyInfo[] = [];

  // 1. rules: every move has to be legal, or nothing else is trusted
  if (spec.game === "chess" && moves.length) {
    let fen = spec.position ?? START_FEN;
    try {
      new Chess(fen);
    } catch {
      return finish({ engine: "game", quality: { ok: false, issues: [`the starting position is not a valid FEN: ${fen}`], reRecord: "Set up the position again." }, metrics: {}, markers: [], mistakes: [], criteria: {}, keyFrames: [], version: v, precision: "full" });
    }
    for (let i = 0; i < moves.length; i++) {
      const r = resolveMove(fen, moves[i]);
      if (!r) {
        metrics.legal_moves = metric(i, "moves");
        return finish({
          engine: "game",
          quality: { ok: false, issues: [`move ${i + 1} (${moves[i]}) is not legal in this position`], reRecord: `Enter the game again from move ${i + 1}; "${moves[i]}" is not legal there.` },
          metrics,
          markers: [],
          mistakes: [],
          criteria: {},
          keyFrames: [],
          version: v,
          precision: "full"
        });
      }
      plies.push({ ply: i + 1, white: fen.split(" ")[1] === "w", fenBefore: fen, san: r.san, uci: r.uci });
      fen = r.fenAfter;
    }
    metrics.legal_moves = metric(moves.length, "moves");
  }

  // 2. engine evaluations, when an external engine ran
  const evals = spec.game === "chess" ? evidence.engineEvals ?? [] : [];
  const mine = (p: PlyInfo) => spec.side === "both" || (spec.side === "white") === p.white;
  if (evals.length && plies.length) {
    const rows: { p: PlyInfo; best: string; loss: number; same: boolean }[] = [];
    for (const e of evals) {
      const p = plies.find((x) => x.ply === e.ply);
      if (!p || !mine(p)) continue;
      const best = resolveMove(p.fenBefore, e.best);
      const same = !!best && best.uci === p.uci;
      rows.push({ p, best: best?.uci ?? e.best, loss: same ? 0 : Math.max(0, cap(e.bestCp) - cap(e.playedCp)), same });
    }
    if (rows.length) {
      const blunders = rows.filter((r) => r.loss >= BLUNDER_CP);
      const bad = rows.filter((r) => r.loss >= MISTAKE_CP && r.loss < BLUNDER_CP);
      const inacc = rows.filter((r) => r.loss >= INACCURACY_CP && r.loss < MISTAKE_CP);
      metrics.agreement = metric(rows.filter((r) => r.same).length / rows.length, "0..1");
      metrics.mean_eval_loss_cp = metric(rows.reduce((s, r) => s + r.loss, 0) / rows.length, "cp", 1, rows.map((r) => r.loss));
      metrics.blunders = metric(blunders.length, "moves");
      metrics.mistakes = metric(bad.length, "moves");
      metrics.inaccuracies = metric(inacc.length, "moves");
      metrics.moves_evaluated = metric(rows.length, "moves");
      for (const r of rows) {
        if (r.loss < INACCURACY_CP) continue;
        const kind = r.loss >= BLUNDER_CP ? "blunder" : r.loss >= MISTAKE_CP ? "mistake" : "inaccuracy";
        markers.push({ t: r.p.ply, label: `${kind}: ${r.p.san}, best ${resolveMove(r.p.fenBefore, r.best)?.san ?? r.best}`, role: "attention" });
        if (kind !== "inaccuracy") {
          mistakes.push({ id: kind, severity: kind === "blunder" ? 3 : 2, confidence: 0.9, at: [r.p.ply], evidence: { kind: "move", ply: r.p.ply } });
        }
      }
      mistakes.sort((a, b) => b.severity - a.severity || a.at[0] - b.at[0]);
      if ((metrics.agreement.value ?? 0) >= 0.6) praise = { metric: "agreement", label: "Moves matching the engine" };
      overlay = { kind: "game", game: "chess", plies: rows.map((r) => ({ ply: r.p.ply, san: r.p.san, uci: r.p.uci, best: r.best, loss: r.loss })) };
    }
  }

  // 3. fallback: no evaluations, so tactics puzzles stand in
  if (!metrics.agreement) {
    fallback = true;
    precision = "reduced";
    issues.push(spec.game === "chess" ? "no engine evaluation is available, so this checks tactics puzzles instead of your game" : `no engine is available for ${spec.game === "go" ? "go" : "this game"}, so this checks puzzles only`);
    const items = spec.fallback_items ?? [];
    if (items.length) {
      const { solved, total, per } = puzzleScore(spec, evidence.puzzleAnswers);
      metrics.puzzles_solved = metric(solved, "puzzles");
      metrics.puzzles_total = metric(total, "puzzles");
      overlay = { kind: "puzzles", items: items.map((it, i) => ({ position: it.position, prompt: it.prompt, solved: per[i] })) };
      if (solved > 0 && solved / total >= 0.5) praise = { metric: "puzzles_solved", label: "Tactics you spotted" };
    } else {
      issues.push("there are no tactics puzzles to fall back on");
    }
  }

  const vars = metricVars(metrics);
  const criteria: Record<string, boolean> = {};
  const passed = evalCondition(spec.pass, vars);
  if (passed !== null) criteria.pass = passed;
  Object.assign(criteria, evalCriteria((ctx as { criteria?: Record<string, string> } | undefined)?.criteria ?? {}, vars));

  return finish({
    engine: "game",
    quality: { ok: true, issues },
    metrics,
    markers,
    mistakes,
    criteria,
    ...(praise ? { praise } : {}),
    keyFrames: [],
    ...(overlay !== undefined ? { overlay } : {}),
    version: v,
    ...(fallback ? { fallbackFor: "game" as const } : {}),
    precision
  });
}
