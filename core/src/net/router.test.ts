import assert from 'node:assert/strict';
import test from 'node:test';
import { ReliableChannel } from './channel.ts';
import { encode, seal } from './envelope.ts';
import { deriveIdentity } from './identity.ts';
import { awaitChallenge, challenge, type PairingResult } from './pairing.ts';
import { PeerRouter, wireSender } from './router.ts';
import { GameSession, ABANDON_AFTER_MS } from './session.ts';
import { LossyLink, seededRandom, VirtualTime } from './testing.ts';

const alice = deriveIdentity(new Uint8Array(32).fill(1));
const bob = deriveIdentity(new Uint8Array(32).fill(2));

test('wireSender reads the claimed sender', () => {
  const wire = encode(seal(alice.peer, { seq: 1, ts: 1, body: { t: 'CHAT', text: 'x' } }));
  assert.equal(wireSender(wire), alice.peer.publicKey);
  assert.equal(wireSender('{}'), null);
});

/** Two players, each with a router over a fast direct link and a slow lossy relay link. */
function setup() {
  const time = new VirtualTime();
  const rnd = seededRandom(5);
  let chA!: ReliableChannel;
  let chB!: ReliableChannel;
  const direct = {
    ab: new LossyLink(time, (w) => chB.receive(w), { delayMs: [30, 60], random: rnd }),
    ba: new LossyLink(time, (w) => chA.receive(w), { delayMs: [30, 60], random: rnd }),
  };
  const relay = {
    ab: new LossyLink(time, (w) => chB.receive(w), { loss: 0.1, delayMs: [300, 900], random: rnd }),
    ba: new LossyLink(time, (w) => chA.receive(w), { loss: 0.1, delayMs: [300, 900], random: rnd }),
  };
  const counts = { direct: 0, relay: 0 };
  const rA = new PeerRouter({
    directSend: (_p, w) => (counts.direct++, direct.ab.send(w)),
    directDrop: () => undefined,
    relaySend: (_n, w) => (counts.relay++, relay.ab.send(w)),
  });
  const rB = new PeerRouter({
    directSend: (_p, w) => (counts.direct++, direct.ba.send(w)),
    directDrop: () => undefined,
    relaySend: (_n, w) => (counts.relay++, relay.ba.send(w)),
  });
  rA.relayKnown(bob.peer.publicKey, bob.nostr.publicKey);
  rB.relayKnown(alice.peer.publicKey, alice.nostr.publicKey);
  chA = new ReliableChannel({ key: alice.peer, peer: bob.peer.publicKey, send: (w) => rA.send(bob.peer.publicKey, w), timers: time });
  chB = new ReliableChannel({ key: bob.peer, peer: alice.peer.publicKey, send: (w) => rB.send(alice.peer.publicKey, w), timers: time });
  return { time, direct, relay, rA, rB, chA, chB, counts };
}

test('router: a game survives losing the direct link and moves back when it returns', () => {
  const s = setup();
  // Paired over relays only (e.g. the hole-punch failed).
  assert.equal(s.rA.route(bob.peer.publicKey), 'relay');
  let a: PairingResult | null = null;
  let b: PairingResult | null = null;
  awaitChallenge(s.chB, { me: bob.peer.publicKey, decide: () => null }, (r) => (b = r));
  challenge(s.chA, { tc: '5+0', rated: false, me: alice.peer.publicKey, peer: bob.peer.publicKey }, (r) => (a = r));
  s.time.advance(20_000);
  const ra = a as PairingResult | null;
  const rb = b as PairingResult | null;
  assert.ok(ra?.ok && rb?.ok);
  const sa = new GameSession({ channel: s.chA, game: ra.game, timers: s.time, onEvent: () => undefined });
  const sb = new GameSession({ channel: s.chB, game: rb.game, timers: s.time, onEvent: () => undefined });
  const white = sa.myColor === 'w' ? sa : sb;
  const black = white === sa ? sb : sa;
  const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6'];
  const playTo = (n: number) => {
    for (const m of moves.slice(white.ply, n)) {
      const mover = white.myTurn ? white : black;
      s.time.advance(800);
      assert.ok(mover.move(m), m);
      for (let i = 0; i < 300 && (white.ply < mover.ply || black.ply < mover.ply); i++) s.time.advance(100);
    }
  };

  playTo(2);
  // The direct connection comes up (hole-punch succeeded on a retry).
  s.rA.directUp(bob.peer.publicKey);
  s.rB.directUp(alice.peer.publicKey);
  s.chA.resync();
  s.chB.resync();
  const relayBefore = s.counts.relay;
  playTo(4);
  assert.equal(s.rA.route(bob.peer.publicKey), 'direct');
  assert.ok(s.counts.relay - relayBefore <= 2, 'traffic moved to the direct link');

  // It drops again (phone switched networks): back to relays mid-game.
  s.direct.ab.up = s.direct.ba.up = false;
  s.rA.directDown(bob.peer.publicKey);
  s.rB.directDown(alice.peer.publicKey);
  s.chA.resync();
  s.chB.resync();
  playTo(8);
  assert.equal(white.ply, 8);
  assert.equal(white.chess.fen(), black.chess.fen());
});

test('session: abandonment can be claimed after 60 s of silence, unconfirmed', () => {
  const s = setup();
  let a: PairingResult | null = null;
  let b: PairingResult | null = null;
  awaitChallenge(s.chB, { me: bob.peer.publicKey, decide: () => null }, (r) => (b = r));
  challenge(s.chA, { tc: '5+0', rated: false, me: alice.peer.publicKey, peer: bob.peer.publicKey }, (r) => (a = r));
  s.time.advance(20_000);
  const ra = a as PairingResult | null;
  const rb = b as PairingResult | null;
  assert.ok(ra?.ok && rb?.ok);
  const sa = new GameSession({ channel: s.chA, game: ra.game, timers: s.time, onEvent: () => undefined });
  new GameSession({ channel: s.chB, game: rb.game, timers: s.time, onEvent: () => undefined });
  s.time.advance(10_000);
  assert.equal(sa.canClaimAbandonment, false, 'pings keep the line alive');
  // Bob vanishes: every link to Alice goes silent.
  s.relay.ba.up = s.direct.ba.up = false;
  s.time.advance(ABANDON_AFTER_MS - 5000);
  assert.equal(sa.claimAbandonment(), false, 'not yet');
  s.time.advance(10_000);
  assert.ok(sa.claimAbandonment());
  assert.deepEqual(sa.end, { outcome: { winner: sa.myColor, reason: 'abandonment' }, unconfirmed: true });
});
