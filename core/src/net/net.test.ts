import assert from 'node:assert/strict';
import test from 'node:test';
import { ReliableChannel } from './channel.ts';
import { decode, encode, hashHex, seal, canonical, type Message } from './envelope.ts';
import { backupPhrase, deriveIdentity, fingerprint, seedFromPhrase, type Identity } from './identity.ts';
import { awaitChallenge, challenge, challengerColor, type GameStart, type PairingResult } from './pairing.ts';
import { GameSession, type SessionEvent } from './session.ts';
import { LossyLink, seededRandom, VirtualTime, type LinkOptions } from './testing.ts';
import { parseTimeControl, timeControlClass } from './clock.ts';

const seed = (n: number) => new Uint8Array(32).fill(n);
const alice = deriveIdentity(seed(1));
const bob = deriveIdentity(seed(2));

// ---- identity ---------------------------------------------------------------

test('identity: deterministic keys, phrase round-trip, typo rejected', () => {
  assert.deepEqual(deriveIdentity(seed(1)).peer.publicKey, alice.peer.publicKey);
  assert.notEqual(alice.peer.publicKey, bob.peer.publicKey);
  assert.match(alice.peer.publicKey, /^[0-9a-f]{64}$/);
  assert.match(alice.nostr.publicKey, /^[0-9a-f]{64}$/);

  const phrase = backupPhrase(seed(7));
  assert.equal(phrase.split(' ').length, 24);
  assert.deepEqual(seedFromPhrase(`  ${phrase.toUpperCase()} `), seed(7));
  const words = phrase.split(' ');
  words[3] = words[3] === 'abandon' ? 'ability' : 'abandon';
  assert.throws(() => seedFromPhrase(words.join(' ')));
});

test('identity: fingerprint is four stable words', () => {
  const f = fingerprint(alice.peer.publicKey);
  assert.equal(f.split('-').length, 4);
  assert.equal(fingerprint(alice.peer.publicKey), f);
  assert.notEqual(fingerprint(bob.peer.publicKey), f);
});

// ---- envelope ---------------------------------------------------------------

test('envelope: signed, tamper-evident, shape-checked', () => {
  const env = seal(alice.peer, { seq: 1, ts: 5, body: { t: 'CHAT', text: 'hi' } });
  assert.ok(decode(encode(env)));
  // Tampered body, wrong signer, wrong seq class, unknown type, junk.
  assert.equal(decode(encode({ ...env, body: { t: 'CHAT', text: 'ho' } })), null);
  assert.equal(decode(encode({ ...env, from: bob.peer.publicKey })), null);
  assert.equal(decode(encode(seal(alice.peer, { seq: 0, ts: 5, body: { t: 'CHAT', text: 'x' } }))), null);
  assert.equal(decode(encode(seal(alice.peer, { seq: 3, ts: 5, body: { t: 'ACK', seq: 1 } }))), null);
  assert.equal(decode(encode(seal(alice.peer, { seq: 1, ts: 5, body: { t: 'NOPE' } as unknown as Message }))), null);
  assert.equal(decode('{"v":1'), null);
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: undefined }] }), '{"a":[2,{"d":3}],"b":1}');
});

// ---- channel ----------------------------------------------------------------

function connect(time: VirtualTime, link: LinkOptions, a: Identity = alice, b: Identity = bob) {
  let chA!: ReliableChannel;
  let chB!: ReliableChannel;
  const ab = new LossyLink(time, (w) => chB.receive(w), link);
  const ba = new LossyLink(time, (w) => chA.receive(w), link);
  chA = new ReliableChannel({ key: a.peer, peer: b.peer.publicKey, send: ab.send, timers: time });
  chB = new ReliableChannel({ key: b.peer, peer: a.peer.publicKey, send: ba.send, timers: time });
  return { chA, chB, ab, ba };
}

test('channel: exactly-once, in-order delivery over a lossy, reordering, duplicating link', () => {
  const time = new VirtualTime();
  const { chA, chB } = connect(time, { loss: 0.3, duplicate: 0.15, delayMs: [10, 400], random: seededRandom(42) });
  const gotA: string[] = [];
  const gotB: string[] = [];
  chA.onMessage((m) => m.t === 'CHAT' && gotA.push(m.text!));
  chB.onMessage((m) => m.t === 'CHAT' && gotB.push(m.text!));
  for (let i = 0; i < 40; i++) {
    chA.send({ t: 'CHAT', text: `a${i}` });
    chB.send({ t: 'CHAT', text: `b${i}` });
    time.advance(37);
  }
  time.advance(120_000);
  assert.deepEqual(gotB, Array.from({ length: 40 }, (_, i) => `a${i}`));
  assert.deepEqual(gotA, Array.from({ length: 40 }, (_, i) => `b${i}`));
  assert.equal(chA.unacked, 0);
  assert.equal(chB.unacked, 0);
});

test('channel: an outage heals after resync, and strangers are ignored', () => {
  const time = new VirtualTime();
  const { chA, chB, ab, ba } = connect(time, { delayMs: [30, 30] });
  const got: string[] = [];
  chB.onMessage((m) => m.t === 'CHAT' && got.push(m.text!));
  ab.up = ba.up = false;
  chA.send({ t: 'CHAT', text: 'during outage' });
  time.advance(60_000); // retransmits back off to 8 s
  assert.deepEqual(got, []);
  ab.up = ba.up = true;
  chB.resync(); // e.g. after switching transport
  time.advance(200);
  assert.deepEqual(got, ['during outage']);

  // A third party's validly signed message is dropped.
  const eve = deriveIdentity(seed(9));
  chB.receive(encode(seal(eve.peer, { seq: 2, ts: 1, body: { t: 'CHAT', text: 'spoof' } })));
  time.advance(100);
  assert.deepEqual(got, ['during outage']);
});

test('channel: measures round-trip time', () => {
  const time = new VirtualTime();
  const { chA } = connect(time, { delayMs: [50, 50] });
  chA.ping();
  time.advance(500);
  assert.equal(chA.rtt, 100);
});

// ---- pairing ----------------------------------------------------------------

function pair(time: VirtualTime, link: LinkOptions, tc = '3+2', decide: () => string | null = () => null) {
  const { chA, chB, ab, ba } = connect(time, link);
  let a: PairingResult | null = null;
  let b: PairingResult | null = null;
  awaitChallenge(chB, { me: bob.peer.publicKey, decide }, (r) => (b = r));
  challenge(chA, { tc, rated: false, me: alice.peer.publicKey, peer: bob.peer.publicKey }, (r) => (a = r));
  time.advance(30_000);
  return { a: a as PairingResult | null, b: b as PairingResult | null, chA, chB, ab, ba };
}

test('pairing: both sides agree on game id and opposite colours', () => {
  const time = new VirtualTime();
  const { a, b } = pair(time, { loss: 0.2, delayMs: [20, 300], random: seededRandom(7) });
  assert.ok(a?.ok && b?.ok);
  assert.equal(a.game.start.gid, b.game.start.gid);
  assert.notEqual(a.game.myColor, b.game.myColor);
  assert.equal(a.game.opponent, bob.peer.publicKey);
  assert.equal(b.game.opponent, alice.peer.publicKey);
});

test('pairing: the coin flip uses both nonces', () => {
  const colors = new Set<string>();
  for (let i = 0; i < 16; i++) colors.add(challengerColor(hashHex(`a${i}`), hashHex('b')));
  assert.deepEqual([...colors].sort(), ['b', 'w']);
});

test('pairing: decline is reported to both sides', () => {
  const time = new VirtualTime();
  const { a, b } = pair(time, { delayMs: [20, 20] }, '3+2', () => 'busy');
  assert.deepEqual(a, { ok: false, reason: 'busy' });
  assert.deepEqual(b, { ok: false, reason: 'declined: busy' });
});

// ---- game session -------------------------------------------------------------

function startGame(link: LinkOptions = { delayMs: [40, 40] }, tc = '3+2') {
  const time = new VirtualTime();
  const p = pair(time, link, tc);
  assert.ok(p.a?.ok && p.b?.ok);
  const events = { a: [] as SessionEvent[], b: [] as SessionEvent[] };
  const sa = new GameSession({ channel: p.chA, game: p.a.game, timers: time, onEvent: (e) => events.a.push(e) });
  const sb = new GameSession({ channel: p.chB, game: p.b.game, timers: time, onEvent: (e) => events.b.push(e) });
  const white = sa.myColor === 'w' ? sa : sb;
  const black = white === sa ? sb : sa;
  return { time, sa, sb, white, black, events, ...p };
}

/** Plays alternating moves, waiting for each to arrive. */
function play(g: ReturnType<typeof startGame>, uci: string[], thinkMs = 1000) {
  for (const m of uci) {
    const mover = g.white.myTurn ? g.white : g.black;
    g.time.advance(thinkMs);
    assert.ok(mover.move(m), `move ${m} refused`);
    const target = mover.ply;
    for (let i = 0; i < 600 && (g.white.ply < target || g.black.ply < target); i++) g.time.advance(100);
    assert.equal(g.white.ply, target);
    assert.equal(g.black.ply, target);
  }
}

test('session: a game to checkmate over a bad link; both sides agree', () => {
  const g = startGame({ loss: 0.25, duplicate: 0.1, delayMs: [30, 500], random: seededRandom(3) });
  play(g, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
  for (const s of [g.sa, g.sb]) {
    assert.deepEqual(s.end?.outcome, { winner: 'b', reason: 'checkmate' });
  }
  assert.equal(g.sa.chess.fen(), g.sb.chess.fen());
});

test('session: own moves only on own turn, and only legal ones', () => {
  const g = startGame();
  assert.equal(g.black.move('e7e5'), false);
  assert.equal(g.white.move('e2e5'), false);
  assert.equal(g.white.move('e2e4'), true);
  assert.equal(g.white.move('d2d4'), false);
});

test('session: an illegal or forged move from a modified client ends the game', () => {
  const g = startGame();
  const whiteChannel = g.white === g.sa ? g.chA : g.chB;
  // Bypass the session: send a move with a made-up hash.
  whiteChannel.send({ t: 'MOVE', ply: 1, uci: 'e2e4', clock: 180_000, hash: 'f'.repeat(64) });
  g.time.advance(500);
  assert.equal(g.black.end?.violation, 'hash chain mismatch');
  assert.deepEqual(g.black.end?.outcome, { winner: 'b', reason: 'abandonment' });
  assert.equal(g.black.ply, 0, 'forged move rolled back');
});

test('session: resign, abort and draw agreement', () => {
  let g = startGame();
  g.white.resign();
  g.time.advance(500);
  assert.deepEqual(g.black.end?.outcome, { winner: 'b', reason: 'resignation' });

  g = startGame();
  play(g, ['e2e4']);
  assert.ok(g.black.abort());
  g.time.advance(500);
  assert.equal(g.white.end?.aborted, true);

  g = startGame();
  play(g, ['e2e4', 'e7e5']);
  assert.equal(g.white.offerDraw(), false, 'not on own turn');
  assert.ok(g.black.offerDraw());
  g.time.advance(500);
  assert.ok(g.white.opponentOfferedDraw);
  g.white.respondDraw(true);
  g.time.advance(500);
  for (const s of [g.white, g.black]) assert.deepEqual(s.end?.outcome, { winner: null, reason: 'agreement' });
  assert.equal(g.white.abort(), false);
});

test('session: clocks run after both first moves, with increment', () => {
  const g = startGame({ delayMs: [40, 40] }, '1+2');
  play(g, ['e2e4', 'e7e5'], 5000); // not timed yet
  assert.deepEqual(g.white.remaining, { w: 60_000, b: 60_000 }); // first moves are free
  assert.ok(g.white.clocks().w < 60_000, "white's clock is now running");
  play(g, ['g1f3'], 10_000); // white used 10 s (+ the 40 ms the reply took), gets +2 s
  const w = g.white.remaining.w;
  assert.ok(w <= 52_000 && w >= 51_900, `white clock ${w}`);
  assert.equal(g.black.remaining.w, w, 'black accepts an honest report');
});

test('session: an inflated clock report is overruled', () => {
  const g = startGame({ delayMs: [40, 40] }, '1+0');
  play(g, ['e2e4', 'e7e5']);
  // White thinks 20 s but claims to still have the full minute.
  g.time.advance(20_000);
  const whiteChannel = g.white === g.sa ? g.chA : g.chB;
  const fen = (() => {
    const c = g.white.chess;
    c.move('g1f3');
    const f = c.fen();
    c.undo();
    return f;
  })();
  const prev = (g.white as unknown as { hash: string }).hash;
  const hash = hashHex(`${prev}|3|g1f3|${fen}|60000`);
  whiteChannel.send({ t: 'MOVE', ply: 3, uci: 'g1f3', clock: 60_000, hash });
  g.time.advance(500);
  assert.equal(g.black.discrepancies, 1);
  assert.ok(g.black.remaining.w < 41_000, `black's view of white: ${g.black.remaining.w}`);
});

test('session: flag claim when the opponent runs out of time', () => {
  const g = startGame({ delayMs: [40, 40] }, '0.5+0');
  play(g, ['e2e4', 'e7e5', 'g1f3']);
  assert.equal(g.white.claimFlag(), false, 'black still has time');
  g.time.advance(31_000);
  assert.equal(g.black.move('b8c6'), false, 'black is out of time');
  assert.ok(g.white.claimFlag());
  g.time.advance(500);
  for (const s of [g.white, g.black]) assert.deepEqual(s.end?.outcome, { winner: 'w', reason: 'timeout' });
});

test('session: chat, quick chat and its rate limit', () => {
  const g = startGame();
  const got = () => g.events.b.filter((e) => e.type === 'chat' && e.from === 'opponent');
  assert.ok(g.sa.chat({ quick: 'gl' }));
  assert.ok(g.sa.chat({ text: '  have fun ' }));
  assert.equal(g.sa.chat({ text: 'x'.repeat(281) }), false);
  for (let i = 0; i < 3; i++) g.sa.chat({ text: `m${i}` });
  assert.equal(g.sa.chat({ text: 'one too many' }), false);
  g.time.advance(1000);
  assert.deepEqual(
    got().map((e) => (e.type === 'chat' ? (e.text ?? e.quick) : '')),
    ['gl', 'have fun', 'm0', 'm1', 'm2'],
  );
});

test('time control parsing', () => {
  assert.deepEqual(parseTimeControl('3+2'), { initialMs: 180_000, incrementMs: 2000 });
  assert.deepEqual(parseTimeControl('0.5+0'), { initialMs: 30_000, incrementMs: 0 });
  assert.throws(() => parseTimeControl('3'));
  assert.throws(() => parseTimeControl('0+0'));
  assert.equal(timeControlClass('1+0'), 'bullet');
  assert.equal(timeControlClass('3+2'), 'blitz');
  assert.equal(timeControlClass('10+0'), 'rapid');
  assert.equal(timeControlClass('15+10'), 'rapid');
  assert.equal(timeControlClass('30+20'), 'classical');
});

// Keep the type import used.
export type { GameStart };

/** Plays 30 random 60-ply games over a lossy link; returns clock overrule stats. */
function randomGames(loss: number, maxDelay: number) {
  let overruled = 0;
  let moves = 0;
  for (let s = 1; s <= 30; s++) {
    const rnd = seededRandom(1000 + s);
    const g = startGame({ loss, duplicate: 0.2, delayMs: [10, maxDelay], random: rnd }, '30+0');
    for (let i = 0; i < 60 && !g.white.end && !g.black.end; i++) {
      const mover = g.white.myTurn ? g.white : g.black;
      const moves = mover.chess.moves({ verbose: true });
      const m = moves[Math.floor(rnd() * moves.length)];
      play(g, [m.from + m.to + (m.promotion ?? '')], 200);
    }
    g.time.advance(120_000);
    assert.equal(g.white.chess.fen(), g.black.chess.fen(), `seed ${s}`);
    const hash = (x: GameSession) => (x as unknown as { hash: string }).hash;
    assert.equal(hash(g.white), hash(g.black), `seed ${s}`);
    assert.deepEqual(g.white.end?.outcome ?? null, g.black.end?.outcome ?? null, `seed ${s}`);
    overruled += g.white.discrepancies + g.black.discrepancies;
    moves += g.white.ply;
  }
  return { overruled, moves };
}

test('session: random games over a 20%-loss link: in sync, honest clocks kept', () => {
  const { overruled, moves } = randomGames(0.2, 600);
  assert.ok(overruled / moves < 0.01, `overruled ${overruled} of ${moves} moves`);
});

test('session: random games over a 40%-loss link stay in sync', () => {
  randomGames(0.4, 800);
});
