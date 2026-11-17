import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARASAN_CP_SCALE,
  formatScore,
  normalize,
  judgeMove,
  parseInfoScore,
  reviewGame,
  summarize,
  terminalScore,
  winChance,
  type Score,
} from './analysis.ts';

const cp = (value: number): Score => ({ kind: 'cp', value });

test('parseInfoScore converts to White point of view', () => {
  const line = 'info depth 12 score cp 34 nodes 1000 pv e2e4';
  assert.deepEqual(parseInfoScore(line, 'w'), cp(34));
  assert.deepEqual(parseInfoScore(line, 'b'), cp(-34));
  assert.deepEqual(parseInfoScore('info depth 9 score mate -3 pv a1a2', 'w'), { kind: 'mate', value: -3 });
  assert.deepEqual(parseInfoScore('info depth 9 score mate -3 pv a1a2', 'b'), { kind: 'mate', value: 3 });
  assert.equal(parseInfoScore('info string hello', 'w'), null);
});

test('winChance is symmetric, bounded, and mates are certain', () => {
  assert.equal(winChance(cp(0)), 0);
  assert.ok(Math.abs(winChance(cp(200)) + winChance(cp(-200))) < 1e-12);
  assert.ok(winChance(cp(5000)) < 1 && winChance(cp(5000)) > 0.95);
  assert.equal(winChance({ kind: 'mate', value: 2 }), 1);
  assert.equal(winChance({ kind: 'mate', value: -2 }), -1);
});

test('judgeMove flags blunders for the side that moved', () => {
  // White hangs a queen: +0.3 -> -6.0 from White's point of view.
  assert.equal(judgeMove(cp(30), cp(-600), 'w').judgment, 'blunder');
  // Same swing is GOOD for Black when Black moved.
  assert.equal(judgeMove(cp(30), cp(-600), 'b').judgment, null);
  // Small drop: nothing.
  assert.equal(judgeMove(cp(30), cp(10), 'w').judgment, null);
  // Missing a forced mate is a blunder.
  assert.equal(judgeMove({ kind: 'mate', value: 2 }, cp(50), 'w').judgment, 'blunder');
});

test('a won position stays won: small losses there are not punished', () => {
  // +9 -> +7 for White barely changes the win chance.
  assert.equal(judgeMove(cp(900), cp(700), 'w').judgment, null);
});

test('formatScore', () => {
  assert.equal(formatScore(cp(34)), '+0.34');
  assert.equal(formatScore(cp(-120)), '-1.20');
  assert.equal(formatScore({ kind: 'mate', value: 3 }), '#3');
  assert.equal(formatScore({ kind: 'mate', value: -2 }), '#-2');
  assert.equal(formatScore(terminalScore('b', true)), '#');
  assert.equal(formatScore(terminalScore('w', false)), '+0.00');
});

test('terminalScore: the side to move is the one mated', () => {
  assert.equal(winChance(terminalScore('w', true)), -1);
  assert.equal(winChance(terminalScore('b', true)), 1);
});

test('reviewGame alternates movers and summarize counts per side', () => {
  // ply 0 W: +0.20 -> +0.30, ply 1 B: -> +0.25, ply 2 W: -> -5.00 (blunder), ply 3 B: -> -4.80
  const evals = [cp(20), cp(30), cp(25), cp(-500), cp(-480)];
  const reviews = reviewGame(evals, 1);
  assert.deepEqual(reviews.map((r) => r.color), ['w', 'b', 'w', 'b']);
  assert.equal(reviews[2].judgment, 'blunder'); // White's 2nd move: +0.25 -> -5.00
  const s = summarize(reviews);
  assert.equal(s.w.blunder, 1);
  assert.equal(s.b.blunder + s.b.mistake + s.b.inaccuracy, 0);
});

test('normalize scales centipawns but leaves mates alone', () => {
  assert.deepEqual(normalize(cp(200), 0.5), cp(100));
  assert.deepEqual(normalize({ kind: 'mate', value: 3 }, 0.5), { kind: 'mate', value: 3 });
  assert.deepEqual(normalize(terminalScore('w', true), 0.5), terminalScore('w', true));
});

test('with Arasan scaling, 1.f3 is an inaccuracy, not a blunder', () => {
  // Arasan's own evals at 250 ms: start +0.67, after 1.f3 -1.35.
  const [r] = reviewGame([cp(67), cp(-135)], ARASAN_CP_SCALE);
  assert.equal(r.judgment, 'inaccuracy');
  // Unscaled, the same swing would be over-judged.
  assert.equal(reviewGame([cp(67), cp(-135)], 1)[0].judgment, 'blunder');
});
