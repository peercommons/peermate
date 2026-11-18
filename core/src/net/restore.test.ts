import assert from 'node:assert/strict';
import test from 'node:test';
import { ReliableChannel, type ChannelSnapshot } from './channel.ts';
import { deriveIdentity } from './identity.ts';
import { awaitChallenge, challenge, type PairingResult } from './pairing.ts';
import { GameSession, type SessionSnapshot } from './session.ts';
import { LossyLink, seededRandom, VirtualTime } from './testing.ts';

const alice = deriveIdentity(new Uint8Array(32).fill(1));
const bob = deriveIdentity(new Uint8Array(32).fill(2));

test('restore: a player restarts from a stale save mid-game and the game carries on', () => {
  const time = new VirtualTime();
  const rnd = seededRandom(9);
  let chA!: ReliableChannel;
  let chB!: ReliableChannel;
  const ab = new LossyLink(time, (w) => chB.receive(w), { loss: 0.1, delayMs: [20, 200], random: rnd });
  const ba = new LossyLink(time, (w) => chA.receive(w), { loss: 0.1, delayMs: [20, 200], random: rnd });
  chA = new ReliableChannel({ key: alice.peer, peer: bob.peer.publicKey, send: ab.send, timers: time });
  chB = new ReliableChannel({ key: bob.peer, peer: alice.peer.publicKey, send: ba.send, timers: time });

  let a: PairingResult | null = null;
  let b: PairingResult | null = null;
  awaitChallenge(chB, { me: bob.peer.publicKey, decide: () => null }, (r) => (b = r));
  challenge(chA, { tc: '10+0', rated: false, me: alice.peer.publicKey, peer: bob.peer.publicKey }, (r) => (a = r));
  time.advance(10_000);
  const ra = a as PairingResult | null;
  const rb = b as PairingResult | null;
  assert.ok(ra?.ok && rb?.ok);

  let sa = new GameSession({ channel: chA, game: ra.game, timers: time, onEvent: () => undefined });
  const sb = new GameSession({ channel: chB, game: rb.game, timers: time, onEvent: () => undefined });

  // Alice saves only when she sends (the minimum the app guarantees): her save
  // is always behind on moves she received.
  let saved: { ch: ChannelSnapshot; s: SessionSnapshot } | null = null;
  const save = () => (saved = { ch: chA.snapshot(), s: sa.snapshot() });
  chA.onPersist = save;
  save();

  const aliceIs = sa.myColor;
  const mover = () => (sa.chess.turn() === aliceIs ? sa : sb);
  const step = (uci: string) => {
    const m = mover();
    time.advance(500);
    assert.ok(m.move(uci), uci);
    for (let i = 0; i < 200 && (sa.ply < m.ply || sb.ply < m.ply); i++) time.advance(100);
  };

  const opening = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6'];
  for (const m of opening.slice(0, 4)) step(m);

  // Bob moves; Alice receives and ACKs it, then crashes before saving.
  const bobMove = sb.chess.turn() === sb.myColor ? opening[4] : null;
  if (bobMove) step(bobMove);
  const staleSave = saved!;
  chA.close();
  sa.dispose();
  ab.up = ba.up = false;

  // While Alice is gone, Bob plays on if it's his turn (into the void).
  if (sb.myTurn) {
    time.advance(1000);
    assert.ok(sb.move(sb.chess.moves({ verbose: true }).map((m) => m.from + m.to)[0]));
  }
  time.advance(20_000);

  // Alice restarts from the stale save.
  chA = ReliableChannel.restore({ key: alice.peer, send: ab.send, timers: time }, staleSave.ch);
  chA.onPersist = save;
  sa = GameSession.restore({ channel: chA, snapshot: staleSave.s, timers: time, onEvent: () => undefined });
  ab.up = ba.up = true;
  chA.resync();
  time.advance(5000);

  assert.equal(sa.ply, sb.ply, 'Alice caught up on everything Bob sent');
  assert.equal(sa.chess.fen(), sb.chess.fen());

  // And the game carries on normally.
  for (let i = 0; i < 6 && !sa.end; i++) {
    const m = mover();
    step(m.chess.moves({ verbose: true }).map((x) => x.from + x.to + (x.promotion ?? ''))[0]);
  }
  assert.equal(sa.chess.fen(), sb.chess.fen());
  // Clocks may disagree after the outage: the side to move's clock kept running
  // in the opponent's view (SPECS §6.9), and the opponent's measurement rules.
});
