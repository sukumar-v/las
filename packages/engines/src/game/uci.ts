/**
 * Node-only adapters for engines the learner installed themselves, spoken to as a separate process
 * over a standard text protocol: UCI for chess, GTP for go. LAS never bundles or links an engine
 * (many are GPL); when none is installed the game engine falls back to tactics puzzles.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Chess } from "chess.js";
import type { GameEvidence } from "../types.js";
import { resolveMove, START_FEN } from "./chess-util.js";

export interface EngineOptions {
  /** command-line arguments for the engine binary */
  args?: string[];
  /** give up on one command after this long (default 30000 ms) */
  timeoutMs?: number;
}

/** Centipawns standing in for "mate": the nearer the mate, the bigger the number. */
const MATE_CP = 10000;

/** A child process whose output is read line by line, with one waiter at a time. */
class LineProcess {
  private proc: ChildProcessWithoutNullStreams;
  private waiter: { match: (line: string) => boolean; resolve: (lines: string[]) => void; reject: (e: Error) => void; lines: string[]; timer: NodeJS.Timeout } | null = null;
  private buffered: string[] = [];
  private failure: Error | null = null;
  readonly closed: Promise<void>;

  constructor(binaryPath: string, private timeoutMs: number, args: string[]) {
    this.proc = spawn(binaryPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.closed = new Promise((res) => this.proc.once("close", () => res()));
    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.onLine(line));
    this.proc.stderr.on("data", () => {});
    this.proc.stdin.on("error", () => {});
    this.proc.on("error", (e) => this.fail(new Error(`could not start engine "${binaryPath}": ${e.message}`)));
    this.proc.on("close", () => this.fail(new Error("the engine exited")));
  }

  private fail(e: Error) {
    this.failure ??= e;
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      const w = this.waiter;
      this.waiter = null;
      w.reject(this.failure);
    }
  }

  private onLine(line: string) {
    if (this.waiter) {
      this.waiter.lines.push(line);
      if (this.waiter.match(line)) {
        clearTimeout(this.waiter.timer);
        const w = this.waiter;
        this.waiter = null;
        w.resolve(w.lines);
      }
    } else {
      this.buffered.push(line);
    }
  }

  send(cmd: string) {
    if (!this.failure && this.proc.stdin.writable) this.proc.stdin.write(cmd + "\n");
  }

  /** Collect lines until one matches. Rejects on timeout (the engine is killed) or when the engine dies. */
  waitFor(match: (line: string) => boolean, what: string): Promise<string[]> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const lines: string[] = [];
      const timer = setTimeout(() => {
        this.waiter = null;
        this.kill();
        reject(new Error(`the engine did not answer (${what}) within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.waiter = { match, resolve, reject, lines, timer };
      // lines that arrived before anyone asked
      const early = this.buffered.splice(0);
      for (const l of early) {
        if (!this.waiter) break;
        this.onLine(l);
      }
    });
  }

  kill() {
    this.proc.kill();
  }

  /** Ask politely, then make sure the process is gone. */
  async quit(cmd: string): Promise<void> {
    this.send(cmd);
    const t = setTimeout(() => this.kill(), 500);
    await this.closed;
    clearTimeout(t);
  }
}

export interface UciEngine {
  /** Search `fen` to `depth`. `cp` is from the side to move; `best` is the engine's move in UCI form. */
  evaluate(fen: string, depth: number): Promise<{ best: string; cp: number }>;
  quit(): Promise<void>;
}

/** Start a UCI engine (the learner's own install, e.g. a Stockfish binary). The handshake runs on first use. */
export function uciEngine(binaryPath: string, opts: EngineOptions = {}): UciEngine {
  const p = new LineProcess(binaryPath, opts.timeoutMs ?? 30000, opts.args ?? []);
  let ready: Promise<void> | null = null;
  const handshake = () =>
    (ready ??= (async () => {
      p.send("uci");
      await p.waitFor((l) => l.trim() === "uciok", "uci");
      p.send("isready");
      await p.waitFor((l) => l.trim() === "readyok", "isready");
    })());
  // one search at a time
  let chain: Promise<unknown> = Promise.resolve();
  return {
    evaluate(fen, depth) {
      const run = async () => {
        await handshake();
        p.send(`position fen ${fen}`);
        p.send(`go depth ${Math.max(1, Math.floor(depth))}`);
        const lines = await p.waitFor((l) => l.startsWith("bestmove"), `go depth ${depth}`);
        return parseSearch(lines);
      };
      const next = chain.then(run, run);
      chain = next.catch(() => {});
      return next;
    },
    quit: () => p.quit("quit")
  };
}

/** Read the last main-line score from `info` lines, and the move from `bestmove`. Exported for tests. */
export function parseSearch(lines: string[]): { best: string; cp: number } {
  let cp = 0;
  for (const line of lines) {
    if (!line.startsWith("info ")) continue;
    if (/\bmultipv\s+([2-9]|\d\d+)\b/.test(line)) continue;
    if (/\b(lowerbound|upperbound)\b/.test(line)) continue;
    const m = /\bscore\s+(cp|mate)\s+(-?\d+)/.exec(line);
    if (!m) continue;
    const n = Number(m[2]);
    cp = m[1] === "cp" ? n : n > 0 ? MATE_CP - n : -MATE_CP - n;
  }
  const bm = lines.find((l) => l.startsWith("bestmove"));
  const best = bm?.split(/\s+/)[1] ?? "";
  return { best: best === "(none)" || best === "0000" ? "" : best, cp };
}

/**
 * Evaluate every ply of a game: for each, the engine's best move and score, and the score of the
 * move actually played, all from the mover's side. One search per position, so n moves cost n + 1 searches.
 */
export async function evaluateGame(engine: Pick<UciEngine, "evaluate">, moves: string[], startFen: string = START_FEN, depth = 12): Promise<NonNullable<GameEvidence["engineEvals"]>> {
  // walk the game first so an illegal move fails before any searching
  const fens = [startFen];
  const played: string[] = [];
  for (const m of moves) {
    const r = resolveMove(fens[fens.length - 1], m);
    if (!r) throw new Error(`illegal move "${m}" at ply ${played.length + 1}`);
    played.push(r.uci);
    fens.push(r.fenAfter);
  }
  const searched: ({ best: string; cp: number } | "mate" | "draw")[] = [];
  for (const fen of fens) {
    const c = new Chess(fen);
    if (c.isCheckmate()) searched.push("mate");
    else if (c.isGameOver()) searched.push("draw");
    else searched.push(await engine.evaluate(fen, depth));
  }
  const out: NonNullable<GameEvidence["engineEvals"]> = [];
  for (let i = 0; i < played.length; i++) {
    const before = searched[i];
    if (typeof before === "string") break;
    const after = searched[i + 1];
    let playedCp: number;
    if (before.best === played[i]) playedCp = before.cp;
    else if (after === "mate") playedCp = MATE_CP;
    else if (after === "draw") playedCp = 0;
    else playedCp = -after.cp;
    out.push({ ply: i + 1, best: before.best, bestCp: before.cp, playedCp });
  }
  return out;
}

export interface GtpEngine {
  /** send any GTP command; resolves with the text after `= ` */
  command(cmd: string): Promise<string>;
  name(): Promise<string>;
  version(): Promise<string>;
  boardsize(n: number): Promise<void>;
  /** the engine's best move for `color` without playing it (`reg_genmove`) */
  bestMove(color: "b" | "w"): Promise<string>;
  quit(): Promise<void>;
}

/** Start a GTP engine for go (the learner's own install). Kept minimal: name, version, board size and a best move. */
export function gtpEngine(binaryPath: string, opts: EngineOptions = {}): GtpEngine {
  const p = new LineProcess(binaryPath, opts.timeoutMs ?? 30000, opts.args ?? []);
  // one command at a time
  let chain: Promise<unknown> = Promise.resolve();
  const command = (cmd: string): Promise<string> => {
    const run = async () => {
      // a reply starts with "=" (ok) or "?" (error) and ends with a blank line
      let started = false;
      p.send(cmd);
      const lines = await p.waitFor((l) => {
        if (!started) {
          started = l.startsWith("=") || l.startsWith("?");
          return false;
        }
        return l.trim() === "";
      }, cmd);
      const first = lines.find((l) => l.startsWith("=") || l.startsWith("?")) ?? "";
      const body = [first.slice(1).trim(), ...lines.slice(lines.indexOf(first) + 1)].join("\n").trim();
      if (first.startsWith("?")) throw new Error(`the engine refused "${cmd}": ${body}`);
      return body;
    };
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
  };
  return {
    command,
    name: () => command("name"),
    version: () => command("version"),
    boardsize: async (n) => {
      await command(`boardsize ${n}`);
    },
    bestMove: (color) => command(`reg_genmove ${color}`),
    quit: () => p.quit("quit")
  };
}
