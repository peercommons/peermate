import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Chess,
  checkedKingSquare,
  describeOutcome,
  isPromotion,
  legalTargets,
  outcome,
  parseUci,
  resignation,
  takeback,
  toPgn,
  toUci,
  tryMove,
} from './game.ts';
import { LEVELS, getLevel, humanizedDelayMs, pickMove } from './levels.ts';

const play = (chess: Chess, ...uci: string[]) => {
  for (const m of uci) assert.ok(tryMove(chess, parseUci(m)), `illegal: ${m}`);
};

test('parseUci / toUci round-trip, including promotion', () => {
  assert.deepEqual(parseUci('e2e4'), { from: 'e2', to: 'e4' });
  assert.deepEqual(parseUci('e7e8q'), { from: 'e7', to: 'e8', promotion: 'q' });
  assert.equal(toUci(parseUci('a7a8n')), 'a7a8n');
  assert.throws(() => parseUci('e9e4'));
  assert.throws(() => parseUci('e2'));
});

test("fool's mate is checkmate, Black wins", () => {
  const chess = new Chess();
  play(chess, 'f2f3', 'e7e5', 'g2g4', 'd8h4');
  assert.deepEqual(outcome(chess), { winner: 'b', reason: 'checkmate' });
  assert.equal(describeOutcome(outcome(chess)!), 'Black wins by checkmate');
  assert.equal(checkedKingSquare(chess), 'e1');
});

test('stalemate is a draw', () => {
  const chess = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.deepEqual(outcome(chess), { winner: null, reason: 'stalemate' });
});

test('insufficient material is a draw', () => {
  const chess = new Chess('8/8/4k3/8/8/4K3/8/8 w - - 0 1');
  assert.deepEqual(outcome(chess), { winner: null, reason: 'insufficient-material' });
});

test('threefold repetition is detected', () => {
  const chess = new Chess();
  play(chess, 'g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8');
  assert.equal(outcome(chess)?.reason, 'threefold-repetition');
});

test('illegal moves are rejected without throwing', () => {
  const chess = new Chess();
  assert.equal(tryMove(chess, parseUci('e2e5')), null);
  assert.equal(tryMove(chess, parseUci('e7e5')), null); // not Black's turn
  assert.equal(chess.history().length, 0);
});

test('castling and en passant are legal targets', () => {
  const chess = new Chess('r3k2r/8/8/3pP3/8/8/8/R3K2R w KQkq d6 0 1');
  assert.ok(legalTargets(chess, 'e1').includes('g1'));
  assert.ok(legalTargets(chess, 'e1').includes('c1'));
  assert.ok(legalTargets(chess, 'e5').includes('d6'));
});

test('promotion is detected and applied', () => {
  const chess = new Chess('8/4P3/8/8/8/8/k7/4K3 w - - 0 1');
  assert.ok(isPromotion(chess, 'e7', 'e8'));
  assert.ok(!isPromotion(chess, 'e1', 'd1'));
  assert.equal(tryMove(chess, parseUci('e7e8n'))?.san, 'e8=N');
});

test('takeback vs CPU returns to the player to move', () => {
  const chess = new Chess();
  play(chess, 'e2e4', 'e7e5', 'g1f3', 'b8c6');
  assert.equal(takeback(chess, 'w'), 2);
  assert.equal(chess.turn(), 'w');
  assert.equal(chess.history().length, 2);
  // Player is Black and it's White's (CPU's) turn after Black moved: undo one ply... then to Black.
  const c2 = new Chess();
  play(c2, 'e2e4', 'e7e5');
  assert.equal(takeback(c2, 'b'), 1);
  assert.equal(c2.turn(), 'b');
});

test('PGN includes headers and the result, including resignation', () => {
  const chess = new Chess();
  play(chess, 'e2e4', 'e7e5');
  const pgn = toPgn(chess, { white: 'You', black: 'CPU level 3', date: new Date(2026, 10, 17) }, resignation('w'));
  assert.match(pgn, /\[White "You"\]/);
  assert.match(pgn, /\[Date "2026\.11\.17"\]/);
  assert.match(pgn, /\[Result "0-1"\]/);
  assert.match(pgn, /1\. e4 e5 0-1\s*$/);
});

test('levels are 1-10 and in order', () => {
  assert.deepEqual(LEVELS.map((l) => l.level), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.throws(() => getLevel(11), RangeError);
});

test('pickMove only randomizes weakened levels, within the pool', () => {
  const ranked = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  assert.deepEqual(pickMove(getLevel(10).config, 'a', ranked, () => 0), { move: 'a', randomPick: false });
  // Level 9 searches deeper but never randomizes.
  assert.equal(pickMove(getLevel(9).config, 'a', ranked, () => 0).randomPick, false);
  // Level 1, random() = 0: below randomChance, picks first of bottom half.
  assert.deepEqual(pickMove(getLevel(1).config, 'a', ranked, () => 0), { move: 'e', randomPick: true });
  // random() above randomChance: best move.
  assert.deepEqual(pickMove(getLevel(1).config, 'a', ranked, () => 0.99), { move: 'a', randomPick: false });
  // Single candidate: nothing to randomize.
  assert.equal(pickMove(getLevel(1).config, 'a', ['a'], () => 0).randomPick, false);
});

test('humanized delay tops weak levels up to at least 0.5 s', () => {
  assert.equal(humanizedDelayMs(1, 10, () => 0), 540);
  assert.equal(humanizedDelayMs(9, 300, () => 0), 650);
  assert.equal(humanizedDelayMs(10, 1000, () => 0), 0);
});
