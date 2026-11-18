// Test helpers: virtual time and a lossy, reordering in-memory link. Used by the
// unit tests; also handy for simulating games in tools.
import type { Timers } from './channel.ts';

export class VirtualTime implements Timers {
  private t = 1_000_000;
  private seq = 0;
  private queue: { at: number; id: number; fn: () => void }[] = [];

  now = () => this.t;

  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.queue.push({ at: this.t + Math.max(0, ms), id, fn });
    return id;
  };

  clearTimeout = (h: unknown) => {
    this.queue = this.queue.filter((x) => x.id !== h);
  };

  /** Runs everything due up to now + ms, in time order. */
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.queue[0];
      if (!next || next.at > end) break;
      this.queue.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

/** Deterministic PRNG (mulberry32) so lossy-link tests are repeatable. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type LinkOptions = {
  /** Probability a message is lost. */
  loss?: number;
  /** Probability a message is delivered twice. */
  duplicate?: number;
  /** One-way delay range, ms (random within it, so messages reorder). */
  delayMs?: [number, number];
  random?: () => number;
};

/** A one-way pipe with loss, duplication and random delay. `up` toggles an outage. */
export class LossyLink {
  up = true;
  sent = 0;
  private readonly time: VirtualTime;
  private readonly deliver: (wire: string) => void;
  private readonly opts: LinkOptions;
  constructor(time: VirtualTime, deliver: (wire: string) => void, opts: LinkOptions = {}) {
    this.time = time;
    this.deliver = deliver;
    this.opts = opts;
  }

  send = (wire: string) => {
    this.sent++;
    const r = this.opts.random ?? Math.random;
    if (!this.up || r() < (this.opts.loss ?? 0)) return;
    const copies = r() < (this.opts.duplicate ?? 0) ? 2 : 1;
    const [lo, hi] = this.opts.delayMs ?? [20, 20];
    for (let i = 0; i < copies; i++) {
      this.time.setTimeout(() => this.deliver(wire), Math.round(lo + r() * (hi - lo)));
    }
  };
}
