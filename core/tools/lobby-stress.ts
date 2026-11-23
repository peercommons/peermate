// Lobby stress test: hundreds of players looking for a game at once, run
// through the real Matchmaker (pairing, signatures, retransmits) on virtual
// time, so a few minutes of lobby take seconds.
//
//   node core/tools/lobby-stress.ts [--players 500] [--spread 60] [--sybils 0]
//                                   [--loss 0.02] [--seed 1] [--minutes 5]
//
// The network is modelled on the app's two transports (SPECS §6):
// - Direct (Hyperswarm): a newcomer links to up to 24 players already in its
//   class's rooms (each side holds at most 24, as app/p2p/worker.js sets).
// - Relays (Nostr): every searching player publishes a seek every 20 s; everyone
//   in the class's "any" room sees it and, for the same time control, tells the
//   matchmaker about the sender at most once per HELLO_TIMEOUT_MS (as
//   online.ts relayPeerSeen does).
// Messages take 50-800 ms and `--loss` of them vanish. Players arrive spread
// over `--spread` seconds and stop seeking once paired.
//
// `--sybils N` adds N fake players at the most popular time control: they seek
// and say HELLO like anyone (holding lobby slots) but never accept a game.
import { parseArgs } from 'node:util';
import { deriveIdentity, type Identity } from '../src/net/identity.ts';
import { APP_ID, HELLO_TIMEOUT_MS, Matchmaker, MAX_LOBBY_PEERS, type Match } from '../src/net/matchmaker.ts';
import { ReliableChannel } from '../src/net/channel.ts';
import { PROTOCOL_VERSION } from '../src/net/envelope.ts';
import { timeControlClass } from '../src/net/clock.ts';
import { seededRandom, VirtualTime } from '../src/net/testing.ts';

const { values } = parseArgs({
  options: {
    players: { type: 'string', default: '500' },
    spread: { type: 'string', default: '60' },
    sybils: { type: 'string', default: '0' },
    loss: { type: 'string', default: '0.02' },
    seed: { type: 'string', default: '1' },
    minutes: { type: 'string', default: '5' },
  },
});
const N = Number(values.players);
const SPREAD_MS = Number(values.spread) * 1000;
const SYBILS = Number(values.sybils);
const LOSS = Number(values.loss);
const END_MS = Number(values.minutes) * 60_000;
const rnd = seededRandom(Number(values.seed));

// Time controls by popularity (blitz-heavy, like most chess sites).
const TCS: [string, number][] = [['1+0', 0.1], ['3+0', 0.2], ['3+2', 0.15], ['5+0', 0.25], ['10+0', 0.2], ['15+10', 0.1]];
const pickTc = () => {
  let x = rnd();
  for (const [tc, w] of TCS) if ((x -= w) < 0) return tc;
  return TCS[0][0];
};
const DIRECT_MAX = 24;
const SEEK_EVERY_MS = 20_000;

const time = new VirtualTime();
const t0 = time.now();
let messages = 0;
let lobbyFull = 0;

type Node = {
  i: number;
  key: string;
  id: Identity;
  tc: string;
  cls: string;
  arrivedAt: number;
  pairedAt: number | null;
  match: Match | null;
  searching: boolean;
  direct: Set<string>;
  told: Map<string, number>;
  deliver: (from: string, wire: string) => void;
  connect: (peer: string) => void;
  sybil: boolean;
};
const nodes = new Map<string, Node>();
const byClass = new Map<string, Node[]>();

function send(from: string, to: string, wire: string) {
  messages++;
  if (rnd() < LOSS) return;
  time.setTimeout(() => nodes.get(to)?.deliver(from, wire), 50 + rnd() * 750);
}

function makeNode(i: number, tc: string, sybil: boolean): Node {
  const seed = new Uint8Array(32);
  new DataView(seed.buffer).setUint32(0, i + 1);
  const id = deriveIdentity(seed);
  const node: Node = {
    i, key: id.peer.publicKey, id, tc, cls: timeControlClass(tc), arrivedAt: 0, pairedAt: null, match: null,
    searching: false, direct: new Set(), told: new Map(), sybil,
    deliver: () => undefined, connect: () => undefined,
  };
  if (sybil) {
    // Says HELLO to anyone, then ignores everything (holds the slot, never pairs).
    const chans = new Map<string, ReliableChannel>();
    const chan = (peer: string) => {
      let c = chans.get(peer);
      if (!c) {
        c = new ReliableChannel({ key: id.peer, peer, send: (w) => send(node.key, peer, w), timers: time });
        chans.set(peer, c);
        c.send({ t: 'HELLO', app: APP_ID, proto: [PROTOCOL_VERSION], nick: `Sybil${i}`, npub: id.nostr.publicKey });
      }
      return c;
    };
    node.deliver = (from, wire) => chan(from).receive(wire);
    node.connect = (peer) => void chan(peer);
  } else {
    const mm = new Matchmaker({
      identity: id,
      nick: `P${i}`,
      tc,
      timers: time,
      network: { send: (peer, wire) => send(node.key, peer, wire), drop: (peer) => node.direct.delete(peer) },
      onMatch: (m) => {
        node.match = m;
        node.pairedAt = time.now();
        node.searching = false;
      },
      onLog: (m) => {
        if (m.includes('lobby full')) lobbyFull++;
      },
    });
    node.deliver = (from, wire) => mm.peerData(from, wire);
    node.connect = (peer) => mm.peerConnected(peer);
  }
  return node;
}

function arrive(node: Node) {
  node.arrivedAt = time.now();
  node.searching = true;
  const peers = byClass.get(node.cls) ?? [];
  byClass.set(node.cls, peers);
  // Direct links to some of the players already searching in this class.
  const candidates = peers.filter((p) => p.searching && p.direct.size < DIRECT_MAX);
  candidates.sort(() => rnd() - 0.5);
  for (const p of candidates.slice(0, DIRECT_MAX)) {
    node.direct.add(p.key);
    p.direct.add(node.key);
    p.connect(node.key);
    node.connect(p.key);
  }
  peers.push(node);
  const seek = () => {
    if (!node.searching) return;
    for (const p of byClass.get(node.cls)!) {
      if (p === node || !p.searching || p.tc !== node.tc) continue;
      messages++;
      const told = p.told.get(node.key);
      if (told !== undefined && time.now() - told < HELLO_TIMEOUT_MS) continue;
      p.told.set(node.key, time.now());
      time.setTimeout(() => p.searching && p.connect(node.key), 300 + rnd() * 1500);
    }
    time.setTimeout(seek, SEEK_EVERY_MS);
  };
  seek();
}

const started = Date.now();
for (let i = 0; i < N; i++) {
  const node = makeNode(i, pickTc(), false);
  nodes.set(node.key, node);
  time.setTimeout(() => arrive(node), rnd() * SPREAD_MS);
}
const popular = TCS.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
for (let j = 0; j < SYBILS; j++) {
  const node = makeNode(N + j, popular, true);
  nodes.set(node.key, node);
  time.setTimeout(() => arrive(node), 0); // already there when real players arrive
}
for (let at = 0; at < END_MS; at += 5000) time.advance(5000);

// ---- report -----------------------------------------------------------------
const real = [...nodes.values()].filter((n) => !n.sybil);
const paired = real.filter((n) => n.match);
const waits = paired.map((n) => (n.pairedAt! - n.arrivedAt) / 1000).sort((a, b) => a - b);
const pct = (q: number) => (waits.length ? waits[Math.min(waits.length - 1, Math.floor(q * waits.length))].toFixed(1) : '-');
let wrong = 0;
for (const n of paired) {
  const opp = nodes.get(n.match!.opponent.key)!;
  if (opp.match?.opponent.key !== n.key || opp.match.game.start.gid !== n.match!.game.start.gid || opp.tc !== n.tc) wrong++;
}
console.log(`players ${N}, arriving over ${SPREAD_MS / 1000} s, sybils ${SYBILS}, loss ${LOSS * 100}%, ${END_MS / 60_000} min simulated`);
for (const [tc] of TCS) {
  const group = real.filter((n) => n.tc === tc);
  const p = group.filter((n) => n.match).length;
  console.log(`  ${tc.padEnd(6)} ${String(group.length).padStart(4)} players, ${String(p).padStart(4)} paired, ${group.length - p} waiting`);
}
console.log(`paired ${paired.length}/${N}; waiting ${N - paired.length} (at most one per time control can be odd one out)`);
console.log(`time to pair: median ${pct(0.5)} s, 90% ${pct(0.9)} s, 99% ${pct(0.99)} s, worst ${waits.at(-1)?.toFixed(1) ?? '-'} s`);
console.log(`mismatched pairs ${wrong}; "lobby full" (cap ${MAX_LOBBY_PEERS}) ${lobbyFull} times`);
console.log(`messages ${messages} (${(messages / N).toFixed(0)} per player); ran in ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exit(wrong ? 1 : 0);
