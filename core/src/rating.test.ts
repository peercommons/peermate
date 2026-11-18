import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRating, NEW_RATING, sanitizeOpponent, updateRating } from './rating.ts';

test('glicko-2: matches the worked example in Glickman (2013)', () => {
  const r = updateRating({ r: 1500, rd: 200, vol: 0.06, games: 0 }, [
    [{ r: 1400, rd: 30 }, 1],
    [{ r: 1550, rd: 100 }, 0],
    [{ r: 1700, rd: 300 }, 0],
  ]);
  assert.ok(Math.abs(r.r - 1464.06) < 0.05, `rating ${r.r}`);
  assert.ok(Math.abs(r.rd - 151.52) < 0.05, `rd ${r.rd}`);
  assert.ok(Math.abs(r.vol - 0.05999) < 0.00001, `vol ${r.vol}`);
  assert.equal(r.games, 3);
});

test('glicko-2: a new player beating an equal moves up a lot, and becomes less uncertain', () => {
  const r = updateRating(NEW_RATING, [[{ r: 1500, rd: 350 }, 1]]);
  assert.ok(r.r > 1600 && r.r < 1700, `${r.r}`);
  assert.ok(r.rd < 350);
  const d = updateRating(NEW_RATING, [[{ r: 1500, rd: 350 }, 0.5]]);
  assert.ok(Math.abs(d.r - 1500) < 0.01);
});

test('ratings: reported values are clamped; provisional ones get a "?"', () => {
  assert.deepEqual(sanitizeOpponent(99999, -5), { r: 3500, rd: 30 });
  assert.deepEqual(sanitizeOpponent(undefined, undefined), { r: 1500, rd: 350 });
  assert.equal(formatRating({ r: 1532.4, rd: 80 }), '1532');
  assert.equal(formatRating(NEW_RATING), '1500?');
});
