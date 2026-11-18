// Game rules and bookkeeping on top of chess.js (BSD-2). Pure logic, no UI.
import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js';

export { Chess };
export type { Color, Move, PieceSymbol, Square };

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export type EndReason =
  | 'checkmate'
  | 'stalemate'
  | 'threefold-repetition'
  | 'fifty-move-rule'
  | 'insufficient-material'
  | 'resignation'
  // Online play (SPECS §6–7):
  | 'agreement'
  | 'timeout'
  | 'timeout-vs-insufficient-material' // flag fell, but the opponent can't mate: draw
  | 'abandonment';

export type Outcome = { winner: Color | null; reason: EndReason };

/**
 * The game's outcome, or null while it continues. Repetition and the 50-move
 * rule end the game automatically for now (SPECS §2.3 wants claims at 3-fold /
 * 50 moves and automatic draws at 5-fold / 75 moves; that comes with online play).
 */
export function outcome(chess: Chess): Outcome | null {
  if (chess.isCheckmate()) return { winner: other(chess.turn()), reason: 'checkmate' };
  if (chess.isStalemate()) return { winner: null, reason: 'stalemate' };
  if (chess.isInsufficientMaterial()) return { winner: null, reason: 'insufficient-material' };
  if (chess.isThreefoldRepetition()) return { winner: null, reason: 'threefold-repetition' };
  if (chess.isDrawByFiftyMoves()) return { winner: null, reason: 'fifty-move-rule' };
  return null;
}

export function resignation(loser: Color): Outcome {
  return { winner: other(loser), reason: 'resignation' };
}

export const other = (c: Color): Color => (c === 'w' ? 'b' : 'w');

/** PGN result token for an outcome. */
export function resultToken(o: Outcome | null): '1-0' | '0-1' | '1/2-1/2' | '*' {
  if (!o) return '*';
  if (o.winner === 'w') return '1-0';
  if (o.winner === 'b') return '0-1';
  return '1/2-1/2';
}

/** Human-readable description, e.g. "White wins by checkmate". */
export function describeOutcome(o: Outcome): string {
  const reasons: Record<EndReason, string> = {
    checkmate: 'checkmate',
    stalemate: 'stalemate',
    'threefold-repetition': 'threefold repetition',
    'fifty-move-rule': 'the 50-move rule',
    'insufficient-material': 'insufficient material',
    resignation: 'resignation',
    agreement: 'agreement',
    timeout: 'timeout',
    'timeout-vs-insufficient-material': 'timeout vs insufficient material',
    abandonment: 'abandonment',
  };
  if (o.winner === null) return `Draw by ${reasons[o.reason]}`;
  return `${o.winner === 'w' ? 'White' : 'Black'} wins by ${reasons[o.reason]}`;
}

export type UciMove = { from: Square; to: Square; promotion?: PieceSymbol };

/** Parses a UCI move like "e2e4" or "e7e8q". */
export function parseUci(uci: string): UciMove {
  const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci);
  if (!m) throw new Error(`invalid UCI move: ${uci}`);
  return { from: m[1] as Square, to: m[2] as Square, ...(m[3] ? { promotion: m[3] as PieceSymbol } : {}) };
}

export function toUci(move: Pick<Move, 'from' | 'to' | 'promotion'>): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

/** Destination squares of the legal moves from `square` (empty if none / not the side to move). */
export function legalTargets(chess: Chess, square: Square): Square[] {
  return [...new Set(chess.moves({ square, verbose: true }).map((m) => m.to))];
}

/** True if moving from -> to is a legal pawn promotion (so the UI must ask for a piece). */
export function isPromotion(chess: Chess, from: Square, to: Square): boolean {
  return chess.moves({ square: from, verbose: true }).some((m) => m.to === to && m.promotion);
}

/** Makes a move if legal; returns it, or null if illegal (never throws). */
export function tryMove(chess: Chess, move: UciMove): Move | null {
  try {
    return chess.move(move);
  } catch {
    return null;
  }
}

/**
 * Takeback for a game against the CPU: undo back to the last position where it
 * was `player`'s turn with at least one of their moves undone. Returns plies undone.
 */
export function takeback(chess: Chess, player: Color): number {
  let undone = 0;
  while (chess.history().length > 0) {
    chess.undo();
    undone++;
    if (chess.turn() === player) break;
  }
  return undone;
}

/** Square of the king of the side to move, if that king is in check. */
export function checkedKingSquare(chess: Chess): Square | null {
  if (!chess.inCheck()) return null;
  const turn = chess.turn();
  for (const row of chess.board()) {
    for (const piece of row) {
      if (piece && piece.type === 'k' && piece.color === turn) return piece.square;
    }
  }
  return null;
}

export type PgnHeaders = { white: string; black: string; event?: string; date?: Date };

/** PGN text for the game, with standard headers and the result. */
export function toPgn(chess: Chess, headers: PgnHeaders, o: Outcome | null): string {
  const copy = new Chess();
  copy.loadPgn(chess.pgn());
  const d = headers.date ?? new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  copy.setHeader('Event', headers.event ?? 'Casual game');
  copy.setHeader('Site', 'Peermate');
  copy.setHeader('Date', `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`);
  copy.setHeader('White', headers.white);
  copy.setHeader('Black', headers.black);
  copy.setHeader('Result', resultToken(o));
  if (o?.reason === 'resignation') copy.setHeader('Termination', 'resignation');
  const pgn = copy.pgn();
  // chess.js only appends a result token when the position itself is terminal.
  return /(1-0|0-1|1\/2-1\/2|\*)\s*$/.test(pgn) ? pgn : `${pgn} ${resultToken(o)}`;
}
