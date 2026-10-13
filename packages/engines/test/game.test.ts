import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";
import { AnalysisSchema, GameSpecSchema } from "@las/schema";
import { analyzeGame } from "../src/game/index.js";
import { evaluateGame, gtpEngine, parseSearch, uciEngine } from "../src/game/uci.js";

const here = dirname(fileURLToPath(import.meta.url));

const chessSpec = GameSpecSchema.parse({ game: "chess", engine: "uci", pass: "blunders == 0" });
const GAME = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"];
// one engine evaluation per ply: best move, best score, score of the move played (centipawns, mover's side)
const EVALS = [
  { ply: 1, best: "e2e4", bestCp: 30, playedCp: 30 },
  { ply: 2, best: "c7c5", bestCp: 20, playedCp: 15 }, // loss 5
  { ply: 3, best: "Nf3", bestCp: 25, playedCp: 25 }, // best written in SAN
  { ply: 4, best: "g8f6", bestCp: 25, playedCp: -90 }, // loss 115: a mistake
  { ply: 5, best: "f1c4", bestCp: 30, playedCp: -280 }, // loss 310: a blunder
  { ply: 6, best: "g8f6", bestCp: 10, playedCp: -45 } // loss 55: an inaccuracy
];

describe("chess with engine evaluations", () => {
  const a = analyzeGame(chessSpec, { moves: GAME, engineEvals: EVALS });

  it("counts legal moves, agreement, eval loss and the three kinds of slip", () => {
    expect(AnalysisSchema.safeParse(a).success).toBe(true);
    expect(a.precision).toBe("full");
    expect(a.fallbackFor).toBeUndefined();
    expect(a.metrics.legal_moves.value).toBe(6);
    expect(a.metrics.agreement.value).toBeCloseTo(2 / 6);
    expect(a.metrics.mean_eval_loss_cp.value).toBeCloseTo((0 + 5 + 0 + 115 + 310 + 55) / 6);
    expect(a.metrics.mean_eval_loss_cp.per).toEqual([0, 5, 0, 115, 310, 55]);
    expect(a.metrics.blunders.value).toBe(1);
    expect(a.metrics.mistakes.value).toBe(1);
    expect(a.metrics.inaccuracies.value).toBe(1);
    expect(a.criteria.pass).toBe(false);
  });

  it("marks the slips by ply and cites the move in each mistake", () => {
    expect(a.markers.map((m) => m.t)).toEqual([4, 5, 6]);
    expect(a.markers[1].label).toContain("blunder: Bb5");
    expect(a.markers[1].label).toContain("best Bc4");
    expect(a.mistakes.map((m) => [m.id, m.severity, m.evidence])).toEqual([
      ["blunder", 3, { kind: "move", ply: 5 }],
      ["mistake", 2, { kind: "move", ply: 4 }]
    ]);
    expect(a.mistakes[0].at).toEqual([5]);
  });

  it("counts only the learner's side", () => {
    const white = analyzeGame(GameSpecSchema.parse({ ...chessSpec, side: "white" }), { moves: GAME, engineEvals: EVALS });
    expect(white.metrics.moves_evaluated.value).toBe(3);
    expect(white.metrics.agreement.value).toBeCloseTo(2 / 3);
    expect(white.metrics.blunders.value).toBe(1);
    expect(white.metrics.mistakes.value).toBe(0);
    const black = analyzeGame(GameSpecSchema.parse({ ...chessSpec, side: "black" }), { moves: GAME, engineEvals: EVALS });
    expect(black.metrics.blunders.value).toBe(0);
    expect(black.metrics.mistakes.value).toBe(1);
  });

  it("accepts UCI moves and a starting FEN, and caps mate-sized scores", () => {
    const fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
    const r = analyzeGame(GameSpecSchema.parse({ game: "chess", position: fen }), { moves: ["f1b5"], engineEvals: [{ ply: 1, best: "f1c4", bestCp: 9990, playedCp: 900 }] });
    expect(r.metrics.legal_moves.value).toBe(1);
    // 9990 is capped to 1000, so the loss is 100, not 9090
    expect(r.metrics.mean_eval_loss_cp.value).toBe(100);
    expect(r.metrics.mistakes.value).toBe(1);
  });

  it("praises a game that mostly matches the engine", () => {
    const good = analyzeGame(chessSpec, { moves: ["e4", "e5"], engineEvals: [{ ply: 1, best: "e4", bestCp: 20, playedCp: 20 }, { ply: 2, best: "e7e5", bestCp: 20, playedCp: 20 }] });
    expect(good.praise?.metric).toBe("agreement");
    expect(good.criteria.pass).toBe(true);
    expect(good.mistakes).toEqual([]);
  });
});

describe("illegal moves", () => {
  it("stops at the first illegal move with a quality issue and the count before it", () => {
    const a = analyzeGame(chessSpec, { moves: ["e4", "e5", "Ke3", "Nc6"], engineEvals: EVALS });
    expect(a.quality.ok).toBe(false);
    expect(a.quality.issues[0]).toContain("move 3 (Ke3)");
    expect(a.quality.reRecord).toContain("move 3");
    expect(a.metrics.legal_moves.value).toBe(2);
    expect(a.metrics.agreement).toBeUndefined();
  });

  it("rejects a bad starting position", () => {
    const a = analyzeGame(GameSpecSchema.parse({ game: "chess", position: "not a fen" }), { moves: ["e4"] });
    expect(a.quality.ok).toBe(false);
  });
});

describe("fallback tactics puzzles", () => {
  // each position is a real mate in one
  const items = [
    { position: "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4", best: "Qxf7#", prompt: "Find the mate" },
    { position: "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1", best: "Ra8#", prompt: "Find the mate" }
  ];
  const spec = GameSpecSchema.parse({ game: "chess", fallback_items: items, pass: "puzzles_solved >= 2" });

  it("positions are what they claim: the best moves mate", () => {
    for (const it of items) {
      const c = new Chess(it.position);
      c.move(it.best);
      expect(c.isCheckmate()).toBe(true);
    }
  });

  it("scores puzzles, comparing SAN and UCI through the rules, and says there is no engine", () => {
    const a = analyzeGame(spec, { moves: [], puzzleAnswers: [{ position: items[0].position, answer: "h5f7" }, { position: items[1].position, answer: "Rb1" }] });
    expect(a.precision).toBe("reduced");
    expect(a.fallbackFor).toBe("game");
    expect(a.quality.ok).toBe(true);
    expect(a.quality.issues.join(" ")).toContain("no engine");
    expect(a.metrics.puzzles_solved.value).toBe(1);
    expect(a.metrics.puzzles_total.value).toBe(2);
    expect(a.metrics.legal_moves).toBeUndefined();
    expect(a.criteria.pass).toBe(false);
    expect((a.overlay as any).items.map((i: any) => i.solved)).toEqual([true, false]);
    const both = analyzeGame(spec, { moves: [], puzzleAnswers: [{ position: items[0].position, answer: "Qxf7" }, { position: items[1].position, answer: "a1a8" }] });
    expect(both.metrics.puzzles_solved.value).toBe(2);
    expect(both.criteria.pass).toBe(true);
  });

  it("matches a position even when only the move counters differ, and counts unanswered puzzles as unsolved", () => {
    const a = analyzeGame(spec, { moves: [], puzzleAnswers: [{ position: items[0].position.replace(" 4 4", " 0 1"), answer: "Qxf7#" }] });
    expect(a.metrics.puzzles_solved.value).toBe(1);
    expect(a.metrics.puzzles_total.value).toBe(2);
  });

  it("still checks the rules of the game when moves were given but no engine ran", () => {
    const a = analyzeGame(spec, { moves: GAME });
    expect(a.metrics.legal_moves.value).toBe(6);
    expect(a.precision).toBe("reduced");
  });

  it("says so when there are no puzzles either", () => {
    const a = analyzeGame(GameSpecSchema.parse({ game: "chess" }), { moves: GAME });
    expect(a.quality.issues.join(" ")).toContain("no tactics puzzles");
    expect(a.metrics.puzzles_total).toBeUndefined();
  });

  it("go and other games use puzzles only, even if evaluations are supplied", () => {
    const go = GameSpecSchema.parse({ game: "go", fallback_items: [{ position: "(;GM[1]SZ[9])", best: "D4", prompt: "Where?" }, { position: "(;GM[1]SZ[9];B[ee])", best: "C3", prompt: "Where?" }] });
    const a = analyzeGame(go, { moves: ["D4"], engineEvals: EVALS, puzzleAnswers: [{ position: "(;GM[1]SZ[9])", answer: " d4 " }] });
    expect(a.metrics.puzzles_solved.value).toBe(1);
    expect(a.metrics.puzzles_total.value).toBe(2);
    expect(a.metrics.agreement).toBeUndefined();
    expect(a.metrics.legal_moves).toBeUndefined();
    expect(a.precision).toBe("reduced");
    expect(a.quality.issues[0]).toContain("go");
    const other = analyzeGame(GameSpecSchema.parse({ game: "other", fallback_items: [{ position: "p1", best: "x", prompt: "?" }] }), { moves: [], puzzleAnswers: [{ position: "p1", answer: "x" }] });
    expect(other.metrics.puzzles_solved.value).toBe(1);
  });
});

describe("drift", () => {
  it("fixed input gives the same metrics as the stored fixture", () => {
    const a = analyzeGame(chessSpec, { moves: GAME, engineEvals: EVALS });
    const got = { metrics: Object.fromEntries(Object.entries(a.metrics).map(([k, m]) => [k, Math.round(m.value * 1e6) / 1e6])), mistakes: a.mistakes.map((m) => ({ id: m.id, severity: m.severity, at: m.at })), markers: a.markers, criteria: a.criteria };
    const path = join(here, "fixtures/game/expected.json");
    if (process.env.UPDATE_FIXTURES || !existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(got, null, 2) + "\n");
    }
    expect(got).toEqual(JSON.parse(readFileSync(path, "utf8")));
  });
});

// ---- UCI and GTP adapters, against a tiny fake engine that speaks the protocol ----

/** A UCI engine in a few lines of node: answers from a table of FEN -> { best, score }, or hangs when told to. */
const FAKE_UCI = `
const fs = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let fen = "";
rl.on("line", (line) => {
  if (line === "uci") console.log("id name Fake\\nuciok");
  else if (line === "isready") console.log("readyok");
  else if (line.startsWith("position fen ")) fen = line.slice(13);
  else if (line.startsWith("go depth ")) {
    if (cfg.hang) return;
    const e = cfg.table[fen] || { best: "e2e4", score: "cp 0" };
    const depth = line.split(" ")[2];
    console.log("info depth 1 score cp 5 pv e2e4");
    console.log("info depth " + depth + " seldepth 9 score " + e.score + " nodes 1000 pv " + e.best + " d7d5");
    console.log("bestmove " + e.best + " ponder d7d5");
  } else if (line === "quit") process.exit(0);
});
`;

const FAKE_GTP = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const [cmd] = line.split(" ");
  if (cmd === "name") console.log("= FakeGo\\n");
  else if (cmd === "version") console.log("= 1.2\\n");
  else if (cmd === "boardsize") console.log(line.endsWith(" 9") ? "=\\n" : "? unacceptable size\\n");
  else if (cmd === "reg_genmove") console.log("= D4\\n");
  else if (cmd === "quit") { console.log("=\\n"); process.exit(0); }
  else console.log("? unknown command\\n");
});
`;

function withFake(script: string, config: unknown, run: (dir: string, scriptPath: string, cfgPath: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "las-engine-"));
    try {
      const scriptPath = join(dir, "fake.cjs");
      const cfgPath = join(dir, "cfg.json");
      writeFileSync(scriptPath, script);
      writeFileSync(cfgPath, JSON.stringify(config));
      await run(dir, scriptPath, cfgPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("UCI adapter", () => {
  it("reads the last score and best move from info and bestmove lines", () => {
    expect(parseSearch(["info depth 1 score cp 5 pv e2e4", "info depth 8 score cp -34 pv d2d4", "bestmove d2d4 ponder d7d5"])).toEqual({ best: "d2d4", cp: -34 });
    expect(parseSearch(["info depth 5 score mate 3 pv a1a8", "bestmove a1a8"]).cp).toBe(9997);
    expect(parseSearch(["info depth 5 score mate -2 pv a1a8", "bestmove a1a8"]).cp).toBe(-9998);
    // lower bounds and secondary lines are not the answer
    expect(parseSearch(["info depth 9 score cp 40 pv e2e4", "info depth 9 score cp 90 lowerbound", "info depth 9 multipv 2 score cp 10 pv d2d4", "bestmove e2e4"]).cp).toBe(40);
    expect(parseSearch(["bestmove (none)"])).toEqual({ best: "", cp: 0 });
  });

  const start = new Chess().fen();
  const c1 = new Chess();
  c1.move("e4");
  const afterE4 = c1.fen();
  const c2 = new Chess(afterE4);
  c2.move("e5");
  const afterE5 = c2.fen();

  it(
    "talks UCI to a fake engine process",
    withFake(FAKE_UCI, { table: { [start]: { best: "g1f3", score: "cp 30" }, [afterE4]: { best: "e7e5", score: "cp 25" }, [afterE5]: { best: "g1f3", score: "cp 40" } } }, async (_d, script, cfg) => {
      const engine = uciEngine(process.execPath, { args: [script, cfg], timeoutMs: 5000 });
      try {
        expect(await engine.evaluate(start, 10)).toEqual({ best: "g1f3", cp: 30 });
        // two searches queued at once still come back in order
        const [x, y] = await Promise.all([engine.evaluate(afterE4, 8), engine.evaluate(afterE5, 8)]);
        expect(x).toEqual({ best: "e7e5", cp: 25 });
        expect(y).toEqual({ best: "g1f3", cp: 40 });
      } finally {
        await engine.quit();
      }
    })
  );

  it(
    "evaluateGame steps the positions and scores each played move from the mover's side",
    withFake(FAKE_UCI, { table: { [start]: { best: "g1f3", score: "cp 30" }, [afterE4]: { best: "e7e5", score: "cp 25" }, [afterE5]: { best: "g1f3", score: "cp 40" } } }, async (_d, script, cfg) => {
      const engine = uciEngine(process.execPath, { args: [script, cfg], timeoutMs: 5000 });
      try {
        const evals = await evaluateGame(engine, ["e4", "e5"], undefined, 6);
        expect(evals).toEqual([
          { ply: 1, best: "g1f3", bestCp: 30, playedCp: -25 },
          { ply: 2, best: "e7e5", bestCp: 25, playedCp: 25 }
        ]);
        // and the result feeds the game engine directly
        const a = analyzeGame(chessSpec, { moves: ["e4", "e5"], engineEvals: evals });
        expect(a.metrics.inaccuracies.value).toBe(1);
        expect(a.metrics.agreement.value).toBeCloseTo(0.5);
      } finally {
        await engine.quit();
      }
    })
  );

  it("evaluateGame does not search a finished game's last position, and scores mate as a win", async () => {
    const asked: string[] = [];
    const stub = {
      evaluate: async (fen: string) => {
        asked.push(fen);
        return { best: "a7a6", cp: 100 };
      }
    };
    const evals = await evaluateGame(stub, ["f3", "e5", "g4", "Qh4#"], undefined, 4);
    expect(asked).toHaveLength(4);
    expect(evals).toHaveLength(4);
    expect(evals[3]).toMatchObject({ ply: 4, playedCp: 10000 });
  });

  it("evaluateGame refuses an illegal move before searching", async () => {
    const stub = { evaluate: async () => ({ best: "", cp: 0 }) };
    await expect(evaluateGame(stub, ["e4", "e4"], undefined, 4)).rejects.toThrow("illegal move");
  });

  it(
    "gives up when the engine never answers",
    withFake(FAKE_UCI, { hang: true, table: {} }, async (_d, script, cfg) => {
      const engine = uciEngine(process.execPath, { args: [script, cfg], timeoutMs: 400 });
      await expect(engine.evaluate(start, 5)).rejects.toThrow("did not answer");
      await engine.quit();
    })
  );

  it("reports a missing binary as an error, not a crash", async () => {
    const engine = uciEngine("/definitely/not/an/engine", { timeoutMs: 2000 });
    await expect(engine.evaluate(start, 5)).rejects.toThrow();
    await engine.quit();
  });
});

describe("GTP adapter", () => {
  it(
    "asks name, version, board size and a best move",
    withFake(FAKE_GTP, {}, async (_d, script) => {
      const go = gtpEngine(process.execPath, { args: [script], timeoutMs: 5000 });
      try {
        expect(await go.name()).toBe("FakeGo");
        expect(await go.version()).toBe("1.2");
        await go.boardsize(9);
        expect(await go.bestMove("b")).toBe("D4");
        await expect(go.boardsize(5)).rejects.toThrow("unacceptable size");
        await expect(go.command("nonsense")).rejects.toThrow("unknown command");
      } finally {
        await go.quit();
      }
    })
  );
});
