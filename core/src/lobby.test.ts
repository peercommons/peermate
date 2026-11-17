import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjacentRooms, ratingBand, roomsToJoin } from './lobby.ts';

test('ratingBand buckets by 200 points', () => {
  assert.equal(ratingBand(0), '0-199');
  assert.equal(ratingBand(1450), '1400-1599');
  assert.equal(ratingBand(1599), '1400-1599');
  assert.equal(ratingBand(1600), '1600-1799');
});

test('ratingBand rejects invalid ratings', () => {
  assert.throws(() => ratingBand(-1), RangeError);
  assert.throws(() => ratingBand(Number.NaN), RangeError);
});

test('roomsToJoin includes own band and the any room', () => {
  assert.deepEqual(roomsToJoin('blitz', 1450), ['lobby/blitz/1400-1599', 'lobby/blitz/any']);
});

test('adjacentRooms skips negative bands', () => {
  assert.deepEqual(adjacentRooms('rapid', 100), ['lobby/rapid/200-399']);
  assert.deepEqual(adjacentRooms('rapid', 1450), ['lobby/rapid/1200-1399', 'lobby/rapid/1600-1799']);
});
