// Reliable, ordered, authenticated message channel to one peer over any
// best-effort transport (SPECS §6.6–6.7). Phase 0 showed the Nostr path loses
// ~1 in 10 messages, and transports can switch mid-game, so:
//   - every reliable message has a per-sender seq and is retransmitted with
//     exponential backoff until ACKed;
//   - the receiver re-ACKs duplicates, buffers early arrivals and delivers in
//     seq order exactly once;
//   - SYNC (sent after a reconnect or transport switch) makes the peer resend
//     everything unacked right away.
// Every envelope is signed; anything not from the bound peer is dropped.
import { decode, encode, seal, UNRELIABLE, type Envelope, type Message } from './envelope.ts';
import type { KeyPair } from './identity.ts';

/** Injectable clock and timers, so tests can run on virtual time. */
export type Timers = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const RETRANSMIT_BASE_MS = 600;
export const RETRANSMIT_MAX_MS = 8000;
const MAX_EARLY_BUFFER = 256;

export type ChannelOptions = {
  key: KeyPair;
  /** Peer's Ed25519 key (hex). If omitted, the first valid sender is bound. */
  peer?: string;
  /** Hands an encoded envelope to the transport. */
  send: (wire: string) => void;
  timers?: Timers;
};

type Pending = { wire: string; attempts: number; timer: unknown };

/** Everything needed to rebuild a channel after an app restart. */
export type ChannelSnapshot = {
  peer: string | undefined;
  gid: string | undefined;
  nextSeq: number;
  delivered: number;
  /** Reliable messages sent so far, [seq, wire] (unacked ones are resent on restore). */
  sent: [number, string][];
  acked: number[];
};

/** Sent messages kept for replay after the peer restarts (a game is a few hundred). */
const MAX_SENT_HISTORY = 2000;

export class ReliableChannel {
  peer: string | undefined;
  gid: string | undefined;
  /** Smoothed round-trip time, ms (null until measured). */
  rtt: number | null = null;
  /** When we last received any valid message from the peer (timers.now()). */
  lastHeardAt: number;

  private readonly key: KeyPair;
  private readonly transmit: (wire: string) => void;
  private readonly timers: Timers;
  private nextSeq = 1;
  private readonly outbox = new Map<number, Pending>();
  private delivered = 0;
  private readonly early = new Map<number, Envelope>();
  private readonly pings = new Map<string, number>();
  private closed = false;
  private handler: (msg: Message, env: Envelope) => void = () => undefined;
  /** Called when the peer first acknowledges one of our reliable messages. */
  onAck: ((seq: number) => void) | null = null;
  /**
   * Called after a new reliable message is queued and before it is transmitted.
   * Persist here: a restored channel must never reuse a seq for different content.
   */
  onPersist: (() => void) | null = null;
  /** Every reliable message we sent, for replay to a peer that lost state. */
  private readonly sent = new Map<number, string>();

  constructor(opts: ChannelOptions) {
    this.key = opts.key;
    this.peer = opts.peer;
    this.transmit = opts.send;
    this.timers = opts.timers ?? realTimers;
    this.lastHeardAt = this.timers.now();
  }

  /** Receives reliable messages in order, and PING/PONG-free control flow. */
  onMessage(handler: (msg: Message, env: Envelope) => void) {
    this.handler = handler;
  }

  get unacked(): number {
    return this.outbox.size;
  }

  /** Sends a message; returns its seq (0 for unreliable messages or a closed channel). */
  send(body: Message): number {
    if (this.closed) return 0;
    if (UNRELIABLE.has(body.t)) {
      this.transmit(encode(seal(this.key, { gid: this.gid, seq: 0, ts: this.timers.now(), body })));
      return 0;
    }
    const seq = this.nextSeq++;
    const wire = encode(seal(this.key, { gid: this.gid, seq, ts: this.timers.now(), body }));
    const pending: Pending = { wire, attempts: 0, timer: null };
    this.outbox.set(seq, pending);
    this.sent.set(seq, wire);
    if (this.sent.size > MAX_SENT_HISTORY) this.sent.delete(this.sent.keys().next().value!);
    this.onPersist?.();
    this.transmitPending(seq, pending);
    return seq;
  }

  private transmitPending(seq: number, p: Pending) {
    this.transmit(p.wire);
    const delay = Math.min(RETRANSMIT_MAX_MS, RETRANSMIT_BASE_MS * 2 ** p.attempts);
    p.attempts++;
    p.timer = this.timers.setTimeout(() => {
      if (!this.closed && this.outbox.get(seq) === p) this.transmitPending(seq, p);
    }, delay);
  }

  /** Feed every message the transport delivers. */
  receive(wire: string): void {
    if (this.closed) return;
    const env = decode(wire);
    if (!env) return;
    if (env.from === this.key.publicKey) return; // our own echo (e.g. a relay)
    if (this.peer === undefined) this.peer = env.from;
    if (env.from !== this.peer) return;
    this.lastHeardAt = this.timers.now();

    const body = env.body;
    switch (body.t) {
      case 'ACK': {
        const p = this.outbox.get(body.seq);
        if (p) {
          this.timers.clearTimeout(p.timer);
          this.outbox.delete(body.seq);
          this.onAck?.(body.seq);
        }
        return;
      }
      case 'SYNC':
        // The peer may have restarted from an older save: replay everything after
        // what it says it has, even messages it acknowledged before.
        for (const [seq, wire] of this.sent) {
          if (seq > body.delivered && !this.outbox.has(seq)) this.transmit(wire);
        }
        this.resendAll();
        return;
      case 'PING':
        this.send({ t: 'PONG', nonce: body.nonce });
        return;
      case 'PONG': {
        const sent = this.pings.get(body.nonce);
        if (sent === undefined) return;
        this.pings.delete(body.nonce);
        const sample = this.timers.now() - sent;
        this.rtt = this.rtt === null ? sample : Math.round(0.8 * this.rtt + 0.2 * sample);
        return;
      }
    }

    // Reliable message: always (re-)ACK, then deliver in order exactly once.
    this.send({ t: 'ACK', seq: env.seq });
    if (env.seq <= this.delivered || this.early.has(env.seq)) return;
    if (env.seq !== this.delivered + 1) {
      if (this.early.size < MAX_EARLY_BUFFER) this.early.set(env.seq, env);
      return;
    }
    this.deliver(env);
    for (let next = this.early.get(this.delivered + 1); next; next = this.early.get(this.delivered + 1)) {
      this.early.delete(next.seq);
      this.deliver(next);
    }
  }

  private deliver(env: Envelope) {
    this.delivered = env.seq;
    this.handler(env.body, env);
  }

  /** Measures RTT; call periodically while connected. */
  ping(): void {
    const nonce = Math.random().toString(36).slice(2, 12);
    this.pings.set(nonce, this.timers.now());
    if (this.pings.size > 8) this.pings.delete(this.pings.keys().next().value!);
    this.send({ t: 'PING', nonce });
  }

  /** After a reconnect or transport switch: ask the peer to resend, and resend ours. */
  resync(): void {
    this.send({ t: 'SYNC', delivered: this.delivered });
    this.resendAll();
  }

  private resendAll() {
    for (const [seq, p] of this.outbox) {
      this.timers.clearTimeout(p.timer);
      p.attempts = 0;
      this.transmitPending(seq, p);
    }
  }

  snapshot(): ChannelSnapshot {
    return {
      peer: this.peer,
      gid: this.gid,
      nextSeq: this.nextSeq,
      delivered: this.delivered,
      sent: [...this.sent],
      acked: [...this.sent.keys()].filter((seq) => !this.outbox.has(seq)),
    };
  }

  /** Rebuilds a channel saved with snapshot(); call resync() once the transport is up. */
  static restore(opts: ChannelOptions, snap: ChannelSnapshot): ReliableChannel {
    const ch = new ReliableChannel({ ...opts, peer: snap.peer });
    ch.gid = snap.gid;
    ch.nextSeq = snap.nextSeq;
    ch.delivered = snap.delivered;
    const acked = new Set(snap.acked);
    for (const [seq, wire] of snap.sent) {
      ch.sent.set(seq, wire);
      if (!acked.has(seq)) ch.outbox.set(seq, { wire, attempts: 0, timer: null });
    }
    return ch;
  }

  close(): void {
    this.closed = true;
    for (const p of this.outbox.values()) this.timers.clearTimeout(p.timer);
  }
}
