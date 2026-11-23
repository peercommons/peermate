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
import { displayNick } from './nick.ts';
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

/** `npub` comes from the opponent's signed HELLO, so it's bound to their peer key. */
export type Opponent = { key: string; nick: string; npub?: string; rating?: number; rd?: number };
export type Match = { game: GameStart; channel: ReliableChannel; opponent: Opponent };

export type MatchmakerOptions = {
  identity: Identity;
  nick: string;
  tc: string;
  /** Our rating and deviation for this time control (rounded; sent in HELLO). */
  rating?: number;
  rd?: number;
  network: PeerNetwork;
  timers?: Timers;
  onMatch: (m: Match) => void;
  onLog?: (message: string) => void;
  /** Players the user blocked: never paired, dropped on sight (SPECS §14.2). */
  isBlocked?: (peer: string) => boolean;
  /**
   * Friend challenge: pair with this one peer only. The challenger also sets
   * `invite`, so its HELLO carries the time control for the friend to accept.
   */
  only?: string;
  invite?: boolean;
  /** How long a peer may take to say HELLO (a friend deciding on an invite takes a while). */
  helloTimeoutMs?: number;
  /** The friend turned the invitation down (a DECLINE before any HELLO). */
  onDeclined?: (reason: string) => void;
};

/** A pairing handshake that hasn't finished by now is abandoned (peer vanished). */
export const PAIRING_TIMEOUT_MS = 15_000;
/** A lobby peer that hasn't said HELLO by now is dropped (e.g. a stale relay seek). */
export const HELLO_TIMEOUT_MS = 30_000;
/** A full lobby drops a peer that has been idle (HELLO, then nothing) this long. */
export const IDLE_EVICT_MS = 20_000;
/** A peer that let a pairing time out isn't considered again for this long. */
export const STALL_PENALTY_MS = 5 * 60_000;
/** DECLINE reason: paired with someone else (or stopped seeking). */
const TAKEN = 'taken';

type Hello = Extract<Message, { t: 'HELLO' }>;
type PeerState = {
  channel: ReliableChannel;
  hello: Hello | null;
  pairing: boolean;
  attempt: number;
  /** They want another time control: we'll never pair, so no goodbye either. */
  otherTc?: boolean;
  /** When their HELLO came (timers.now()). */
  helloAt?: number;
};

/** Lobby peers handled at once (each holds a channel until it pairs or leaves). */
export const MAX_LOBBY_PEERS = 64;

export class Matchmaker {
  matched: Match | null = null;
  private readonly peers = new Map<string, PeerState>();
  /**
   * Peers that don't get a lobby slot again until the given time: those wanting
   * another time control (for this search), and those that stalled a pairing
   * (for STALL_PENALTY_MS; a peer that never finishes a handshake costs every
   * challenger PAIRING_TIMEOUT_MS each time it comes back).
   */
  private readonly ignored = new Map<string, number>();
  private busy = false;
  private closed = false;
  private readonly timers: Timers;
  private readonly opts: MatchmakerOptions;

  constructor(opts: MatchmakerOptions) {
    parseTimeControl(opts.tc);
    this.opts = opts;
    this.timers = opts.timers ?? realTimers;
  }

  /**
   * Lobby peer connected (either side may have dialed), or reached over another
   * transport. A peer we already know keeps its channel and handshake: only a
   * resync, so a transport switch mid-pairing can't restart it.
   */
  peerConnected(peer: string): void {
    if (this.closed || this.matched || peer === this.me) return;
    if (this.opts.only && peer !== this.opts.only) return;
    if (this.opts.isBlocked?.(peer)) {
      this.log(`${peer.slice(0, 8)}: blocked, dropping`);
      this.opts.network.drop(peer);
      return;
    }
    const known = this.peers.get(peer);
    if (known) {
      known.channel.resync();
      return;
    }
    const until = this.ignored.get(peer);
    if (until !== undefined && this.timers.now() < until) return;
    // A channel per lobby peer; peers are cheap to make, so cap them. When full,
    // make room by dropping the longest-idle one: it said HELLO a while ago and
    // nothing came of it (a player who never challenges would hold its slot forever).
    if (this.peers.size >= MAX_LOBBY_PEERS) {
      const now = this.timers.now();
      const idle = [...this.peers].find(
        ([key, s]) => !s.pairing && s.helloAt !== undefined && now - s.helloAt > IDLE_EVICT_MS && this.matched?.opponent.key !== key,
      );
      if (!idle) {
        this.log(`${peer.slice(0, 8)}: lobby full, ignoring`);
        return;
      }
      this.log(`${idle[1].hello?.nick ?? idle[0].slice(0, 8)}: idle, making room`);
      this.ignore(idle[0], IDLE_EVICT_MS * 3);
      this.peerLeft(idle[0]);
    }
    const channel = new ReliableChannel({
      key: this.opts.identity.peer,
      peer,
      send: (wire) => this.opts.network.send(peer, wire),
      timers: this.timers,
    });
    const state: PeerState = { channel, hello: null, pairing: false, attempt: 0 };
    this.peers.set(peer, state);
    channel.onMessage((msg) => this.onLobbyMessage(peer, state, msg));
    this.timers.setTimeout(() => {
      if (state.hello || this.peers.get(peer) !== state || this.matched) return;
      this.log(`${peer.slice(0, 8)}: no hello, dropping`);
      this.peerLeft(peer);
      this.opts.network.drop(peer);
    }, this.opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    channel.send({
      t: 'HELLO',
      app: APP_ID,
      proto: [PROTOCOL_VERSION],
      nick: this.opts.nick,
      npub: this.opts.identity.nostr.publicKey,
      rating: this.opts.rating,
      rd: this.opts.rd,
      invite: this.opts.invite ? this.opts.tc : undefined,
      // The wanted time control rides in a CHALLENGE; HELLO stays generic.
    });
  }

  peerData(peer: string, wire: string): void {
    if (this.matched?.opponent.key === peer) this.matched.channel.receive(wire);
    else this.peers.get(peer)?.channel.receive(wire);
  }

  /** The peer is unreachable on every transport (not just one link lost). */
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
      // Tell everyone who might still challenge us that we're gone: anyone mid-
      // handshake, and anyone who said HELLO (else their challenge would wait out
      // PAIRING_TIMEOUT_MS on a player who left).
      if (state.pairing || (state.hello && !state.otherTc)) state.channel.send({ t: 'DECLINE', reason: TAKEN });
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
    if (msg.t === 'DECLINE' && !state.hello && this.opts.only === peer) {
      this.log(`${peer.slice(0, 8)}: invitation declined (${msg.reason})`);
      this.close();
      this.opts.onDeclined?.(msg.reason);
      return;
    }
    // A lobby peer that just paired with someone else.
    if (msg.t === 'DECLINE' && msg.reason === TAKEN && state.hello) {
      this.log(`${state.hello.nick}: paired elsewhere`);
      this.peerLeft(peer);
      return;
    }
    if (msg.t !== 'HELLO' || state.hello) return;
    if (!msg.proto.includes(PROTOCOL_VERSION)) {
      this.log(`${msg.nick}: incompatible protocol ${msg.proto.join(',')}`);
      return;
    }
    state.hello = msg;
    state.helloAt = this.timers.now();
    if (this.me < peer) this.tryChallenge(peer, state);
    else this.waitForChallenge(peer, state);
  }

  /** They want another time control: free their lobby slot for good. */
  private notOurTc(peer: string, state: PeerState) {
    state.otherTc = true;
    if (this.peers.get(peer) !== state) return;
    this.ignore(peer, Infinity);
    this.peerLeft(peer);
  }

  private ignore(peer: string, ms: number) {
    this.ignored.delete(peer); // re-insert: the oldest entry goes first when full
    this.ignored.set(peer, this.timers.now() + ms);
    if (this.ignored.size > 1024) this.ignored.delete(this.ignored.keys().next().value!);
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
      if (r.reason === TAKEN) return this.peerLeft(peer);
      if (r.reason === 'different time control') return this.notOurTc(peer, state);
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
          if (c.tc !== this.opts.tc) {
            this.timers.setTimeout(() => this.notOurTc(peer, state), 5000); // once our DECLINE has arrived
            return 'different time control';
          }
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
        if (r.reason === TAKEN) return this.peerLeft(peer);
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
      this.ignore(peer, STALL_PENALTY_MS);
      this.peerLeft(peer);
      this.opts.network.drop(peer);
    }, PAIRING_TIMEOUT_MS);
  }

  private complete(peer: string, state: PeerState, game: GameStart) {
    if (this.matched) return; // can't happen: one pairing at a time
    this.matched = {
      game,
      channel: state.channel,
      opponent: { key: peer, nick: displayNick(state.hello?.nick, 'Opponent'), npub: state.hello?.npub, rating: state.hello?.rating, rd: state.hello?.rd },
    };
    this.close();
    this.opts.onMatch(this.matched);
  }
}
