// Post-game analysis maths (SPECS §2.5): engine scores, win chances and move
// judgments. Pure: the app's engine driver supplies the raw scores.
import type { Color } from 'chess.js';

/** Engine evaluation from WHITE's point of view, in the engine's own centipawns. */
export type Score = { kind: 'cp'; value: number } | { kind: 'mate'; value: number };

/** Score for a finished position: checkmate (side to move is mated) or a draw. */
export function terminalScore(sideToMove: Color, checkmate: boolean): Score {
  if (!checkmate) return { kind: 'cp', value: 0 };
  return { kind: 'cp', value: sideToMove === 'w' ? -MATED_CP : MATED_CP };
}
const MATED_CP = 100000;

/**
 * Parses the score in a UCI "info" line ("score cp 34", "score mate -3") and
 * converts it to White's point of view. Returns null if the line has no score.
 */
export function parseInfoScore(line: string, sideToMove: Color): Score | null {
  const m = /\bscore (cp|mate) (-?\d+)/.exec(line);
  if (!m) return null;
  const value = Number(m[2]) * (sideToMove === 'w' ? 1 : -1);
  return { kind: m[1] as 'cp' | 'mate', value };
}

/**
 * Engines use different centipawn scales. The win-chance curve below assumes
 * "normalized" centipawns, where +1.00 means roughly a 50% chance to win.
 * Multiply an engine's raw cp by its scale to get there.
 *
 * Arasan: 0.48, fitted by core/tools/cp-scale.ts on 101 positions from the
 * calibration games scored by both Arasan v26.1 and Stockfish 19 (median
 * ratio 0.481, least squares 0.509, correlation 0.98; SPECS §5.1a).
 */
export const ARASAN_CP_SCALE = 0.48;

/** Score in normalized centipawns (mates and on-board checkmates unchanged). */
export function normalize(s: Score, cpScale: number): Score {
  if (s.kind === 'mate' || Math.abs(s.value) >= MATED_CP) return s;
  return { kind: 'cp', value: Math.round(s.value * cpScale) };
}

/**
 * Win chance for White in [-1, 1] (+1 = White winning) for a NORMALIZED score.
 * Logistic curve over centipawns; mates count as certain wins.
 */
export function winChance(s: Score): number {
  if (s.kind === 'mate') return s.value > 0 ? 1 : s.value < 0 ? -1 : 0;
  if (Math.abs(s.value) >= MATED_CP) return Math.sign(s.value); // checkmate on the board
  const cp = Math.max(-1000, Math.min(1000, s.value));
  return 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
}

export type Judgment = 'inaccuracy' | 'mistake' | 'blunder';

export const JUDGMENT_SYMBOL: Record<Judgment, string> = {
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
};

/**
 * Judges one move by how much win chance the mover gave away, comparing the
 * NORMALIZED evaluations before and after it (both from White's point of view).
 */
export function judgeMove(before: Score, after: Score, mover: Color): { drop: number; judgment: Judgment | null } {
  const sign = mover === 'w' ? 1 : -1;
  const drop = Math.max(0, sign * (winChance(before) - winChance(after)));
  // Thresholds on the [-1, 1] scale (a drop of 0.3 is a 15-point win-percentage swing).
  const judgment: Judgment | null = drop >= 0.3 ? 'blunder' : drop >= 0.2 ? 'mistake' : drop >= 0.1 ? 'inaccuracy' : null;
  return { drop, judgment };
}

/** "+0.34", "-1.20", "#3" (White mates in 3), "#-2", or "#" for a finished mate. */
export function formatScore(s: Score): string {
  if (s.kind === 'mate') return s.value === 0 ? '#' : s.value > 0 ? `#${s.value}` : `#-${-s.value}`;
  if (Math.abs(s.value) >= MATED_CP) return '#';
  const pawns = s.value / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

export type MoveReview = { ply: number; color: Color; drop: number; judgment: Judgment | null };

/**
 * Judgments for every move, given raw engine evals of all positions: evals[i] is
 * the position before ply i, evals[n] the final one (length = plies + 1).
 */
export function reviewGame(evals: Score[], cpScale: number, firstMover: Color = 'w'): MoveReview[] {
  const out: MoveReview[] = [];
  const norm = evals.map((e) => normalize(e, cpScale));
  for (let i = 0; i + 1 < norm.length; i++) {
    const color: Color = i % 2 === 0 ? firstMover : firstMover === 'w' ? 'b' : 'w';
    out.push({ ply: i, color, ...judgeMove(norm[i], norm[i + 1], color) });
  }
  return out;
}

/** Counts of each judgment per side. */
export function summarize(reviews: MoveReview[]): Record<Color, Record<Judgment, number>> {
  const zero = () => ({ inaccuracy: 0, mistake: 0, blunder: 0 });
  const result = { w: zero(), b: zero() };
  for (const r of reviews) if (r.judgment) result[r.color][r.judgment]++;
  return result;
}
