/** Small chess helpers over chess.js (the rules provider): turn a move written any way into one canonical form. */
import { Chess } from "chess.js";

export interface ResolvedMove {
  uci: string;
  san: string;
  fenAfter: string;
}

const UCI_MOVE = /^([a-h][1-8])([a-h][1-8])([qrbnQRBN])?$/;

/** Play `text` (SAN or UCI) from `fen` on a copy of the position. Returns null when it isn't a legal move there. */
export function resolveMove(fen: string, text: string): ResolvedMove | null {
  try {
    const c = new Chess(fen);
    const t = text.trim();
    const u = UCI_MOVE.exec(t);
    const m = u ? c.move({ from: u[1], to: u[2], ...(u[3] ? { promotion: u[3].toLowerCase() } : {}) }) : c.move(t);
    return { uci: m.from + m.to + (m.promotion ?? ""), san: m.san, fenAfter: c.fen() };
  } catch {
    return null;
  }
}

/** The first four FEN fields: pieces, side to move, castling, en passant. Move counters don't matter for "same position". */
export function positionKey(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 4).join(" ");
}

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
