import assert from 'node:assert/strict';
import test from 'node:test';
import { ReliableChannel } from './channel.ts';
import { decode } from './envelope.ts';
import { deriveIdentity } from './identity.ts';
import { Matchmaker, type Match } from './matchmaker.ts';
import { LossyLink, seededRandom, VirtualTime } from './testing.ts';

const alice = deriveIdentity(new Uint8Array(32).fill(21));
const bob = deriveIdentity(new Uint8Array(32).fill(22));
const eve = deriveIdentity(new Uint8Array(32).fill(23));

/**
 * Alice challenges Bob. Bob's app isn't pairing at first: it only sees the
 * invitation (Alice's HELLO with `invite`), and starts its own matchmaker when
 * the player answers.
 */
function setup(loss = 0.1) {
  const time = new VirtualTime();
  const rnd = seededRandom(5);
  const invites: { from: string; tc: string }[] = [];
  let bobMm: Matchmaker | null = null;
  const toBob = new LossyLink(
    time,
    (w) => {
      if (bobMm) return bobMm.peerData(alice.peer.publicKey, w);
      const env = decode(w);
      if (env?.body.t === 'HELLO' && env.body.invite) invites.push({ from: env.from, tc: env.body.invite });
    },
    { loss, delayMs: [20, 200], random: rnd },
  );
  let aliceMm!: Matchmaker;
  const toAlice = new LossyLink(time, (w) => aliceMm.peerData(bob.peer.publicKey, w), { loss, delayMs: [20, 200], random: rnd });
  let aliceMatch: Match | null = null;
  let declined: string | null = null;
  aliceMm = new Matchmaker({
    identity: alice,
    nick: 'Alice',
    tc: '10+0',
    only: bob.peer.publicKey,
    invite: true,
    helloTimeoutMs: 120_000,
    timers: time,
    network: { send: (_p, w) => toBob.send(w), drop: () => undefined },
    onMatch: (m) => (aliceMatch = m),
    onDeclined: (r) => (declined = r),
  });
  return {
    time,
    invites,
    aliceMm,
    get aliceMatch() {
      return aliceMatch;
    },
    get declined() {
      return declined;
    },
    /** Bob accepts: a matchmaker for Alice only, at the offered time control. */
    accept(tc: string) {
      let match: Match | null = null;
      bobMm = new Matchmaker({
        identity: bob,
        nick: 'Bob',
        tc,
        only: alice.peer.publicKey,
        timers: time,
        network: { send: (_p, w) => toAlice.send(w), drop: () => undefined },
        onMatch: (m) => (match = m),
      });
      bobMm.peerConnected(alice.peer.publicKey);
      return () => match as Match | null;
    },
    decline() {
      const ch = new ReliableChannel({ key: bob.peer, peer: alice.peer.publicKey, send: (w) => toAlice.send(w), timers: time });
      ch.send({ t: 'DECLINE', reason: 'declined' });
    },
  };
}

test('friends: an invitation accepted after a minute becomes a game; strangers are ignored', () => {
  const s = setup();
  s.aliceMm.peerConnected(eve.peer.publicKey); // a stranger shows up: not who Alice invited
  s.aliceMm.peerConnected(bob.peer.publicKey);
  s.time.advance(60_000); // Bob thinks it over; Alice's HELLO keeps being resent
  assert.ok(s.invites.length > 0);
  assert.deepEqual(s.invites[0], { from: alice.peer.publicKey, tc: '10+0' });
  const bobMatch = s.accept(s.invites[0].tc);
  s.time.advance(20_000);
  const a = s.aliceMatch as Match | null;
  const b = bobMatch();
  assert.ok(a && b, 'both matched');
  assert.equal(a.opponent.key, bob.peer.publicKey);
  assert.equal(b.opponent.key, alice.peer.publicKey);
  assert.equal(a.game.start.gid, b.game.start.gid);
  assert.notEqual(a.game.myColor, b.game.myColor);
});

test('friends: a declined invitation ends the challenge at once', () => {
  const s = setup(0);
  s.aliceMm.peerConnected(bob.peer.publicKey);
  s.time.advance(2_000);
  s.decline();
  s.time.advance(2_000);
  assert.equal(s.declined, 'declined');
  assert.equal(s.aliceMatch, null);
});
