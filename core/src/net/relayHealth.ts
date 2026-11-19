// Relay auto-demotion (SPECS §6.4): stop using relays that keep failing, so a
// dead relay can't slow publishing or leave subscriptions half-deaf, and try
// them again later. Pure bookkeeping; the app feeds it publish results.
//
// - A relay that fails FAIL_LIMIT times in a row rests for REST_BASE_MS,
//   doubling with each rest in a row up to REST_MAX_MS.
// - When its rest ends it's used again; one more failure rests it again at
//   once (with the next, longer rest), one success clears its record.
// - At least MIN_ACTIVE relays stay in use: if too many are resting, the ones
//   whose rest ends soonest are used anyway.

export const FAIL_LIMIT = 3;
export const REST_BASE_MS = 10 * 60_000;
export const REST_MAX_MS = 6 * 3600_000;
export const MIN_ACTIVE = 3;

export type RelayRecord = {
  /** Failures in a row. */
  fails: number;
  /** Rests in a row (sets the next rest's length). */
  rests: number;
  /** Resting until (ms); 0 if in use. */
  until: number;
};

export type RelayHealthState = Record<string, RelayRecord>;

export class RelayHealth {
  private state: RelayHealthState = {};
  private listeners = new Set<() => void>();

  readonly relays: readonly string[];
  private readonly now: () => number;

  constructor(relays: readonly string[], now: () => number = Date.now) {
    this.relays = relays;
    this.now = now;
  }

  /** Restores saved records (unknown relays and malformed entries are ignored). */
  load(saved: unknown): void {
    if (!saved || typeof saved !== 'object') return;
    const next: RelayHealthState = {};
    for (const url of this.relays) {
      const r = (saved as Record<string, unknown>)[url] as Partial<RelayRecord> | undefined;
      if (r && [r.fails, r.rests, r.until].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
        next[url] = { fails: r.fails!, rests: r.rests!, until: r.until! };
      }
    }
    this.state = next;
  }

  snapshot(): RelayHealthState {
    return structuredClone(this.state);
  }

  /** Called after every change (e.g. to save, or to resubscribe). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  record(url: string, ok: boolean): void {
    if (!this.relays.includes(url)) return;
    const cur = this.state[url] ?? { fails: 0, rests: 0, until: 0 };
    let next: RelayRecord;
    if (ok) {
      if (cur.fails === 0 && cur.rests === 0 && cur.until === 0) return; // nothing to clear
      next = { fails: 0, rests: 0, until: 0 };
    } else {
      const fails = cur.fails + 1;
      if (fails < FAIL_LIMIT) {
        next = { ...cur, fails };
      } else {
        const rest = Math.min(REST_MAX_MS, REST_BASE_MS * 2 ** cur.rests);
        next = { fails, rests: cur.rests + 1, until: this.now() + rest };
      }
    }
    this.state = { ...this.state, [url]: next };
    for (const l of [...this.listeners]) l();
  }

  /** Whether a relay is resting (not counting the MIN_ACTIVE floor). */
  resting(url: string): boolean {
    return (this.state[url]?.until ?? 0) > this.now();
  }

  /** When a resting relay comes back (ms), or 0. */
  restingUntil(url: string): number {
    const u = this.state[url]?.until ?? 0;
    return u > this.now() ? u : 0;
  }

  /** The relays to use now, in their configured order. */
  active(): string[] {
    const t = this.now();
    const use = new Set(this.relays.filter((u) => (this.state[u]?.until ?? 0) <= t));
    if (use.size < MIN_ACTIVE) {
      const soonest = this.relays
        .filter((u) => !use.has(u))
        .sort((a, b) => this.state[a]!.until - this.state[b]!.until);
      for (const u of soonest) {
        if (use.size >= MIN_ACTIVE) break;
        use.add(u);
      }
    }
    return this.relays.filter((u) => use.has(u));
  }
}
