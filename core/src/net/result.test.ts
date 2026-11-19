import assert from 'node:assert/strict';
import test from 'node:test';
import { encode, seal, type Message } from './envelope.ts';
import { deriveIdentity, type Identity } from './identity.ts';
import { checkCosigned, checkRatingChain, resultFromTags, RESULT_TAG, type CosignedResult, type ResultBody } from './result.ts';
import { updateRating } from '../rating.ts';

const id = (n: number): Identity => deriveIdentity(new Uint8Array(32).fill(n));
const alice = id(1);
const bob = id(2);
const carol = id(3);

let seq = 1;
let clock = 1_000_000;
function result(who: Identity, gid: string, body: Partial<ResultBody> & Pick<ResultBody, 'color'>): string {
  const full: Message = {
    t: 'RESULT',
    winner: 'w',
    reason: 'checkmate',
    hash: 'ab'.repeat(32),
    plies: 40,
    npub: who.nostr.publicKey,
    cls: 'blitz',
    ...body,
  };
  return encode(seal(who.peer, { gid, seq: seq++, ts: (clock += 1000), body: full }));
}

test('a matching pair from two players checks out', () => {
  const r = checkCosigned(result(alice, 'g1', { color: 'w' }), result(bob, 'g1', { color: 'b' }));
  assert.ok(r);
  assert.equal(r.white.key, alice.peer.publicKey);
  assert.equal(r.black.npub, bob.nostr.publicKey);
  assert.equal(r.winner, 'w');
});

test('rejects: same signer twice, same colour, different game, different outcome, forged', () => {
  assert.equal(checkCosigned(result(alice, 'g1', { color: 'w' }), result(alice, 'g1', { color: 'b' })), null);
  assert.equal(checkCosigned(result(alice, 'g1', { color: 'w' }), result(bob, 'g1', { color: 'w' })), null);
  assert.equal(checkCosigned(result(alice, 'g1', { color: 'w' }), result(bob, 'g2', { color: 'b' })), null);
  assert.equal(checkCosigned(result(alice, 'g1', { color: 'w' }), result(bob, 'g1', { color: 'b', winner: 'draw' })), null);
  const forged = JSON.parse(result(bob, 'g1', { color: 'b' }));
  forged.body.winner = 'b';
  assert.equal(checkCosigned(result(alice, 'g1', { color: 'w', winner: 'b' }), JSON.stringify(forged)), null);
});

test('resultFromTags reads the two result tags', () => {
  const tags = [
    ['t', 'peermate'],
    [RESULT_TAG, result(alice, 'g1', { color: 'w' })],
    [RESULT_TAG, result(bob, 'g1', { color: 'b' })],
  ];
  assert.ok(resultFromTags(tags));
  assert.equal(resultFromTags(tags.slice(0, 2)), null);
});

/** Alice plays a series of rated games; returns the co-signed results and her final rating. */
function series(outcomes: ('w' | 'b' | 'draw')[]) {
  let me = { r: 1500, rd: 350, vol: 0.06, games: 0 };
  const games: CosignedResult[] = [];
  outcomes.forEach((winner, i) => {
    const before = { r: Math.round(me.r), rd: Math.round(me.rd), vol: me.vol };
    const opp = { r: 1600, rd: 200, vol: 0.06 };
    const gid = `s${i}`;
    const g = checkCosigned(
      result(alice, gid, { color: 'w', winner, ...before }),
      result(i % 2 ? carol : bob, gid, { color: 'b', winner, ...opp }),
    );
    assert.ok(g);
    games.push(g);
    const score = winner === 'draw' ? 0.5 : winner === 'w' ? 1 : 0;
    me = updateRating(me, [[{ r: opp.r, rd: opp.rd }, score]]); // as the app does, unrounded
  });
  return { games, rating: { r: Math.round(me.r), rd: Math.round(me.rd) } };
}

test('an honest chain verifies, in any order', () => {
  const { games, rating } = series(['w', 'b', 'draw', 'w', 'w']);
  const check = checkRatingChain(alice.nostr.publicKey, 'blitz', [...games].reverse(), rating);
  assert.deepEqual(check, { status: 'verified', games: 5 });
});

test('a missing game or an inflated rating is caught', () => {
  const { games, rating } = series(['w', 'b', 'b', 'w']);
  const gap = checkRatingChain(alice.nostr.publicKey, 'blitz', games.filter((_, i) => i !== 1), rating);
  assert.equal(gap.status, 'unverified');
  const inflated = checkRatingChain(alice.nostr.publicKey, 'blitz', games, { r: rating.r + 100, rd: rating.rd });
  assert.equal(inflated.status, 'unverified');
});

test('nothing published for the class: none', () => {
  const { games } = series(['w']);
  assert.deepEqual(checkRatingChain(alice.nostr.publicKey, 'rapid', games), { status: 'none' });
});
