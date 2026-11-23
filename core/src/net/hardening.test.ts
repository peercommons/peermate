// Messages from a hostile peer or relay sender: they must be dropped, never
// crash us, and never let one player act as another.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ReliableChannel, SYNC_WINDOW_MS } from './channel.ts';
import { decode, encode, seal, type Envelope, type Message } from './envelope.ts';
import { deriveIdentity } from './identity.ts';
import { relayBindingOk, wireSender } from './router.ts';
import { VirtualTime } from './testing.ts';
import { displayNick, NICK_MAX } from './nick.ts';
import { Matchmaker, MAX_LOBBY_PEERS } from './matchmaker.ts';

const seed = (n: number) => new Uint8Array(32).fill(n);
const alice = deriveIdentity(seed(1));
const bob = deriveIdentity(seed(2));
const mallory = deriveIdentity(seed(3));
const GID = 'a'.repeat(32);
const OTHER_GID = 'b'.repeat(32);

const sealed = (key: typeof alice.peer, body: unknown, fields: { seq?: number; gid?: string } = {}) =>
  encode(seal(key, { seq: fields.seq ?? 0, gid: fields.gid, ts: 1_000_000, body: body as Message }));

test('decode: a type named after an Object.prototype member is dropped, not called', () => {
  for (const t of ['valueOf', 'hasOwnProperty', 'isPrototypeOf', 'toLocaleString', 'toString', 'constructor', '__proto__']) {
    const unsigned = JSON.stringify({ v: 1, seq: 0, ts: 1, from: alice.peer.publicKey, sig: 'ab'.repeat(64), body: { t } });
    assert.equal(decode(unsigned), null, `unsigned ${t}`);
    assert.equal(decode(sealed(alice.peer, { t })), null, `signed ${t}`);
  }
});

test('wireSender: the signed sender, not a "from" hidden in the body', () => {
  const wire = sealed(mallory.peer, { t: 'PING', nonce: 'x', from: alice.peer.publicKey });
  assert.ok(decode(wire), 'extra body fields are ignored, so this is a valid message');
  assert.equal(wireSender(wire), mallory.peer.publicKey);
  assert.equal(wireSender('{"body":{"from":"' + alice.peer.publicKey + '"}}'), null);
  assert.equal(wireSender('not json'), null);
  assert.equal(wireSender('null'), null);
});

test('relayBindingOk: a relayed copy cannot move a known route', () => {
  const hello = (from: typeof alice, npub: string) =>
    decode(sealed(from.peer, { t: 'HELLO', app: 'peermate', proto: [1], nick: 'A', npub }, { seq: 1 })) as Envelope;
  const ping = decode(sealed(alice.peer, { t: 'PING', nonce: 'x' })) as Envelope;
  const aliceNpub = alice.nostr.publicKey;
  const malloryNpub = mallory.nostr.publicKey;

  // Alice's route is known: Mallory forwarding her messages doesn't move it.
  assert.equal(relayBindingOk(aliceNpub, malloryNpub, ping, false), false);
  assert.equal(relayBindingOk(aliceNpub, malloryNpub, hello(alice, aliceNpub), false), false);
  // A HELLO always has to name the Nostr key it came from.
  assert.equal(relayBindingOk(undefined, malloryNpub, hello(alice, aliceNpub), false), false);
  // Genuine cases.
  assert.equal(relayBindingOk(undefined, aliceNpub, ping, false), true);
  assert.equal(relayBindingOk(aliceNpub, aliceNpub, ping, true), true);
  assert.equal(relayBindingOk('f'.repeat(64), aliceNpub, hello(alice, aliceNpub), false), true);
  // ...but never while we're playing them.
  assert.equal(relayBindingOk('f'.repeat(64), aliceNpub, hello(alice, aliceNpub), true), false);
});

test('channel: messages from another game are not delivered or acknowledged', () => {
  const time = new VirtualTime();
  const out: string[] = [];
  const got: Message[] = [];
  const ch = new ReliableChannel({ key: alice.peer, peer: bob.peer.publicKey, send: (w) => out.push(w), timers: time });
  ch.gid = GID;
  ch.onMessage((m) => got.push(m));

  ch.receive(sealed(bob.peer, { t: 'RESIGN', ply: 0 }, { seq: 1, gid: OTHER_GID }));
  assert.equal(got.length, 0);
  assert.equal(out.length, 0, 'not acknowledged either');

  ch.receive(sealed(bob.peer, { t: 'DRAW_OFFER', ply: 0 }, { seq: 1, gid: GID }));
  assert.deepEqual(got.map((m) => m.t), ['DRAW_OFFER']);
  // Handshake messages (no gid yet) still pass.
  ch.receive(sealed(bob.peer, { t: 'DECLINE', reason: 'x' }, { seq: 2 }));
  assert.deepEqual(got.map((m) => m.t), ['DRAW_OFFER', 'DECLINE']);
});

test('channel: SYNC replays at most once per window', () => {
  const time = new VirtualTime();
  const out: string[] = [];
  const ch = new ReliableChannel({ key: alice.peer, peer: bob.peer.publicKey, send: (w) => out.push(w), timers: time });
  ch.gid = GID;
  for (let i = 0; i < 5; i++) {
    const seq = ch.send({ t: 'DRAW_OFFER', ply: i });
    ch.receive(sealed(bob.peer, { t: 'ACK', seq }, { gid: GID }));
  }
  const sync = () => {
    out.length = 0;
    ch.receive(sealed(bob.peer, { t: 'SYNC', delivered: 0 }, { gid: GID }));
    return out.length;
  };
  assert.equal(sync(), 5, 'the first SYNC replays everything');
  for (let i = 0; i < 20; i++) assert.equal(sync(), 0, 'repeats inside the window are ignored');
  time.advance(SYNC_WINDOW_MS);
  assert.equal(sync(), 5, 'and served again after it');
});

test('displayNick: names from other players lose control, invisible and direction characters', () => {
  assert.equal(displayNick('Maya', 'Player'), 'Maya');
  assert.equal(displayNick('José Ñúñez', 'Player'), 'José Ñúñez');
  assert.equal(displayNick('Line\nbreak', 'Player'), 'Line break');
  assert.equal(displayNick('evil‮gnp.exe', 'Player'), 'evil gnp.exe');
  assert.equal(displayNick('zero​width', 'Player'), 'zero width');
  assert.equal(displayNick('⚠️ Peermate: you won!', 'Player'), 'Peermate you won');
  assert.equal(displayNick('x'.repeat(50), 'Player'), 'x'.repeat(NICK_MAX));
  assert.equal(displayNick('​\n ', 'Player'), 'Player');
  assert.equal(displayNick(42, 'Player'), 'Player');
});

test('matchmaker: lobby peers are capped', () => {
  const time = new VirtualTime();
  const greeted = new Set<string>();
  const mm = new Matchmaker({
    identity: alice,
    nick: 'Alice',
    tc: '5+0',
    timers: time,
    network: { send: (peer) => greeted.add(peer), drop: () => undefined },
    onMatch: () => undefined,
  });
  for (let i = 0; i < MAX_LOBBY_PEERS + 20; i++) mm.peerConnected(i.toString(16).padStart(64, '0'));
  assert.equal(greeted.size, MAX_LOBBY_PEERS);
});
