import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveIdentity, type Identity } from './identity.ts';
import { Matchmaker, type Match } from './matchmaker.ts';
import { GameSession } from './session.ts';
import { LossyLink, seededRandom, VirtualTime, type LinkOptions } from './testing.ts';

type Player = { id: Identity; mm: Matchmaker; match: Match | null; dropped: Set<string> };

/** Everyone in `tcs` joins one lobby; every pair connects (like a small swarm). */
/** `blocks`: [i, j] pairs where player i has blocked player j. */
function lobby(tcs: string[], link: LinkOptions = { delayMs: [20, 120] }, seed = 1, blocks: [number, number][] = []) {
  const time = new VirtualTime();
  const rnd = seededRandom(seed);
  const players: Player[] = [];
  const byKey = new Map<string, Player>();
  const links = new Map<string, LossyLink>();

  // Like a swarm: a dropped connection closes on both ends, and lobby peers
  // reconnect a moment later.
  const down = new Set<string>();
  const disconnect = (x: string, y: string) => {
    const k = [x, y].sort().join();
    if (down.has(k)) return;
    down.add(k);
    for (const [from, to] of [[x, y], [y, x]]) {
      const l = links.get(`${from}>${to}`);
      if (l) l.up = false;
      byKey.get(from)?.mm.peerLeft(to);
    }
    time.setTimeout(() => {
      down.delete(k);
      for (const [from, to] of [[x, y], [y, x]]) {
        const l = links.get(`${from}>${to}`);
        if (l) l.up = true;
        byKey.get(from)?.mm.peerConnected(to);
      }
    }, 1000);
  };

  tcs.forEach((tc, i) => {
    const id = deriveIdentity(new Uint8Array(32).fill(10 + i));
    const p: Player = { id, mm: null as unknown as Matchmaker, match: null, dropped: new Set() };
    p.mm = new Matchmaker({
      identity: id,
      nick: `P${i}`,
      tc,
      timers: time,
      network: {
        send: (peer, wire) => links.get(`${id.peer.publicKey}>${peer}`)?.send(wire),
        drop: (peer) => {
          p.dropped.add(peer);
          disconnect(id.peer.publicKey, peer);
        },
      },
      onMatch: (m) => (p.match = m),
      isBlocked: (peer) => blocks.some(([x, y]) => x === i && players[y]?.id.peer.publicKey === peer),
      onLog: process.env.MMLOG ? (m) => console.log(time.now(), `P${i}`, m) : undefined,
    });
    players.push(p);
    byKey.set(id.peer.publicKey, p);
  });

  for (const a of players) {
    for (const b of players) {
      if (a === b) continue;
      const from = a.id.peer.publicKey;
      const to = b.id.peer.publicKey;
      links.set(`${from}>${to}`, new LossyLink(time, (w) => b.mm.peerData(from, w), { ...link, random: rnd }));
    }
  }
  // Connections come up in a random order.
  const pairs: [Player, Player][] = [];
  for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) pairs.push([players[i], players[j]]);
  pairs.sort(() => rnd() - 0.5);
  for (const [a, b] of pairs) {
    a.mm.peerConnected(b.id.peer.publicKey);
    b.mm.peerConnected(a.id.peer.publicKey);
  }
  time.advance(60_000);
  return { time, players, byKey };
}

function checkPairs(players: Player[], byKey: Map<string, Player>) {
  for (const p of players.filter((x) => x.match)) {
    const opp = byKey.get(p.match!.opponent.key)!;
    assert.ok(opp.match, 'opponent matched too');
    assert.equal(opp.match!.opponent.key, p.id.peer.publicKey, 'matched with each other');
    assert.equal(opp.match!.game.start.gid, p.match!.game.start.gid);
    assert.notEqual(opp.match!.game.myColor, p.match!.game.myColor);
  }
}

test('matchmaker: two players pair and can play', () => {
  const { time, players, byKey } = lobby(['3+2', '3+2']);
  checkPairs(players, byKey);
  const [a, b] = players;
  assert.ok(a.match && b.match);
  assert.equal(a.match.opponent.nick, 'P1');
  const sa = new GameSession({ channel: a.match.channel, game: a.match.game, timers: time, onEvent: () => undefined });
  const sb = new GameSession({ channel: b.match.channel, game: b.match.game, timers: time, onEvent: () => undefined });
  const white = sa.myColor === 'w' ? sa : sb;
  const black = white === sa ? sb : sa;
  assert.ok(white.move('e2e4'));
  time.advance(1000);
  assert.ok(black.move('c7c5'));
  time.advance(1000);
  assert.equal(white.chess.fen(), black.chess.fen());
});

test('matchmaker: six players form three games, nobody in two', () => {
  for (let seed = 1; seed <= Number(process.env.SEEDS ?? 10); seed++) {
    const { players, byKey } = lobby(Array(6).fill('5+0'), { loss: 0.1, delayMs: [20, 300] }, seed);
    checkPairs(players, byKey);
    assert.equal(players.filter((p) => p.match).length, 6, `seed ${seed}`);
  }
});

test('matchmaker: odd one out keeps waiting; different time controls never pair', () => {
  let r = lobby(['3+2', '3+2', '3+2']);
  checkPairs(r.players, r.byKey);
  assert.equal(r.players.filter((p) => p.match).length, 2);

  r = lobby(['3+2', '10+0']);
  assert.equal(r.players.filter((p) => p.match).length, 0);
});

test('matchmaker: a blocked player is never paired, even if they are the only one around', () => {
  // P0 blocked P1 (one side is enough). P2 joins too, so P0 can still find a game.
  let r = lobby(['5+0', '5+0'], undefined, 1, [[0, 1]]);
  assert.equal(r.players.filter((p) => p.match).length, 0);

  r = lobby(['5+0', '5+0', '5+0'], undefined, 1, [[0, 1]]);
  checkPairs(r.players, r.byKey);
  const [p0, p1, p2] = r.players;
  assert.notEqual(p0.match?.opponent.key, p1.id.peer.publicKey);
  assert.notEqual(p1.match?.opponent.key, p0.id.peer.publicKey);
  assert.ok(p2.match, 'the unblocked player found a game');
});

test('matchmaker: a peer that vanishes mid-handshake does not block matching', () => {
  const time = new VirtualTime();
  const me = deriveIdentity(new Uint8Array(32).fill(1));
  const ghost = deriveIdentity(new Uint8Array(32).fill(2));
  const dropped: string[] = [];
  const mm = new Matchmaker({
    identity: me,
    nick: 'me',
    tc: '3+2',
    timers: time,
    network: { send: () => undefined, drop: (p) => dropped.push(p) },
    onMatch: () => undefined,
  });
  // The ghost connects and says hello, then goes silent.
  mm.peerConnected(ghost.peer.publicKey);
  const { ReliableChannel } = require_channel();
  const ch = new ReliableChannel({ key: ghost.peer, peer: me.peer.publicKey, send: (w: string) => mm.peerData(ghost.peer.publicKey, w), timers: time });
  ch.send({ t: 'HELLO', app: 'x', proto: [1], nick: 'ghost', npub: ghost.nostr.publicKey });
  if (me.peer.publicKey > ghost.peer.publicKey) ch.send({ t: 'CHALLENGE', tc: '3+2', rated: false, commit: 'a'.repeat(64) });
  time.advance(20_000);
  assert.deepEqual(dropped, [ghost.peer.publicKey]);
});

// Local import helper (keeps the test's imports at the top tidy).
import { ReliableChannel as RC } from './channel.ts';
function require_channel() {
  return { ReliableChannel: RC };
}
