// Quick Match (SPECS §2.1, §6.2): find one opponent among lobby peers and start
// a game, with no server. Transport-agnostic; the app wires it to the P2P
// worker, tests to a simulated or local-testnet network.
//
//   1. On every new lobby connection, both sides send HELLO (nick, wanted tc).
//   2. Peers wanting the same time control pair up. To avoid both challenging at
//      once, the side with the lower public key challenges; the other waits.
//   3. One pairing at a time: while busy we DECLINE "busy" and the challenger
//      retries shortly. The first pairing that completes wins.
import { ReliableChannel, realTimers, type Timers } from './channel.ts';
import { PROTOCOL_VERSION, type Message } from './envelope.ts';
import type { Identity } from './identity.ts';
import { awaitChallenge, challenge, type GameStart } from './pairing.ts';
import { parseTimeControl } from './clock.ts';

export const APP_ID = 'peermate/0.1';
export const BUSY_RETRY_MS = 2000;

/** What the matchmaker needs from a transport. Peers are Ed25519 keys (hex). */
export interface PeerNetwork {
  send(peer: string, wire: string): void;
  drop(peer: string): void;
}

export type Opponent = { key: string; nick: string; rating?: number };
export type Match = { game: GameStart; channel: ReliableChannel; opponent: Opponent };

export type MatchmakerOptions = {
  identity: Identity;
  nick: string;
  tc: string;
  rating?: number;
  network: PeerNetwork;
  timers?: Timers;
  onMatch: (m: Match) => void;
  onLog?: (message: string) => void;
};

/** A pairing handshake that hasn't finished by now is abandoned (peer vanished). */
export const PAIRING_TIMEOUT_MS = 15_000;

type Hello = Extract<Message, { t: 'HELLO' }>;
type PeerState = { channel: ReliableChannel; hello: Hello | null; pairing: boolean; attempt: number };

export class Matchmaker {
  matched: Match | null = null;
  private readonly peers = new Map<string, PeerState>();
  private busy = false;
  private closed = false;
  private readonly timers: Timers;
  private readonly opts: MatchmakerOptions;

  constructor(opts: MatchmakerOptions) {
    parseTimeControl(opts.tc);
    this.opts = opts;
    this.timers = opts.timers ?? realTimers;
  }

  /** Lobby peer connected (either side may have dialed). */
  peerConnected(peer: string): void {
    if (this.closed || this.matched || peer === this.me || this.peers.has(peer)) return;
    const channel = new ReliableChannel({
      key: this.opts.identity.peer,
      peer,
      send: (wire) => this.opts.network.send(peer, wire),
      timers: this.timers,
    });
    const state: PeerState = { channel, hello: null, pairing: false, attempt: 0 };
    this.peers.set(peer, state);
    channel.onMessage((msg) => this.onLobbyMessage(peer, state, msg));
    channel.send({
      t: 'HELLO',
      app: APP_ID,
      proto: [PROTOCOL_VERSION],
      nick: this.opts.nick,
      npub: this.opts.identity.nostr.publicKey,
      rating: this.opts.rating,
      // The wanted time control rides in a CHALLENGE; HELLO stays generic.
    });
  }

  peerData(peer: string, wire: string): void {
    if (this.matched?.opponent.key === peer) this.matched.channel.receive(wire);
    else this.peers.get(peer)?.channel.receive(wire);
  }

  peerLeft(peer: string): void {
    const state = this.peers.get(peer);
    if (!state || this.matched?.opponent.key === peer) return;
    state.channel.close();
    this.peers.delete(peer);
    if (state.pairing) {
      state.pairing = false;
      this.busy = false;
    }
  }

  /** Stops seeking; drops every lobby peer except a matched opponent. */
  close(): void {
    this.closed = true;
    for (const [peer, state] of this.peers) {
      if (this.matched?.opponent.key === peer) continue;
      // Free anyone mid-handshake with us right away instead of at their timeout.
      if (state.pairing) state.channel.send({ t: 'DECLINE', reason: 'taken' });
      state.channel.close();
      this.opts.network.drop(peer);
    }
    this.peers.clear();
  }

  private get me() {
    return this.opts.identity.peer.publicKey;
  }

  private log(message: string) {
    this.opts.onLog?.(message);
  }

  private onLobbyMessage(peer: string, state: PeerState, msg: Message) {
    if (msg.t !== 'HELLO' || state.hello) return;
    if (!msg.proto.includes(PROTOCOL_VERSION)) {
      this.log(`${msg.nick}: incompatible protocol ${msg.proto.join(',')}`);
      return;
    }
    state.hello = msg;
    if (this.me < peer) this.tryChallenge(peer, state);
    else this.waitForChallenge(peer, state);
  }

  /** Still the live connection to `peer`? (Retries can outlive a reconnect.) */
  private current(peer: string, state: PeerState) {
    return !this.closed && !this.matched && this.peers.get(peer) === state;
  }

  private tryChallenge(peer: string, state: PeerState) {
    if (!this.current(peer, state)) return;
    if (this.busy) {
      this.timers.setTimeout(() => this.tryChallenge(peer, state), BUSY_RETRY_MS);
      return;
    }
    this.busy = true;
    state.pairing = true;
    this.watchdog(peer, state);
    challenge(state.channel, { tc: this.opts.tc, rated: false, me: this.me, peer }, (r) => {
      state.pairing = false;
      this.busy = false;
      if (r.ok) return this.complete(peer, state, r.game);
      this.log(`${state.hello?.nick ?? peer.slice(0, 8)} declined: ${r.reason}`);
      // Busy peers get another try; other refusals (different time control) are final.
      if (r.reason === 'busy') {
        state.channel.onMessage((msg) => this.onLobbyMessage(peer, state, msg));
        this.timers.setTimeout(() => this.tryChallenge(peer, state), BUSY_RETRY_MS);
      }
    });
  }

  private waitForChallenge(peer: string, state: PeerState) {
    awaitChallenge(
      state.channel,
      {
        me: this.me,
        decide: (c) => {
          if (this.closed || this.matched) return 'taken';
          if (c.tc !== this.opts.tc) return 'different time control';
          if (this.busy) return 'busy';
          this.busy = true;
          state.pairing = true;
          this.watchdog(peer, state);
          return null;
        },
      },
      (r) => {
        if (state.pairing) {
          state.pairing = false;
          this.busy = false;
        }
        if (r.ok) return this.complete(peer, state, r.game);
        // Stay ready for the next challenge from this peer (e.g. after "busy").
        if (this.current(peer, state)) this.waitForChallenge(peer, state);
      },
    );
  }

  /** Drops a peer whose handshake stalls, so one dead peer can't block matching. */
  private watchdog(peer: string, state: PeerState) {
    const attempt = ++state.attempt;
    this.timers.setTimeout(() => {
      // Only if this exact attempt, on this exact connection, is still pending.
      if (!state.pairing || state.attempt !== attempt || this.peers.get(peer) !== state || this.matched) return;
      this.log(`${state.hello?.nick ?? peer.slice(0, 8)}: pairing timed out`);
      this.peerLeft(peer);
      this.opts.network.drop(peer);
    }, PAIRING_TIMEOUT_MS);
  }

  private complete(peer: string, state: PeerState, game: GameStart) {
    if (this.matched) return; // can't happen: one pairing at a time
    this.matched = {
      game,
      channel: state.channel,
      opponent: { key: peer, nick: state.hello?.nick ?? 'Opponent', rating: state.hello?.rating },
    };
    this.close();
    this.opts.onMatch(this.matched);
  }
}
