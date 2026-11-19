// Relay transport over public Nostr relays (SPECS §6.3, §6.6): the fallback for
// when a direct (hole-punched) connection can't be made.
//
// Everything is an ephemeral event (relays forward, don't store):
//   seek:    tags [t, "peermate-v1-<room>"], content {v, pk, tc, nick}
//            pk = Ed25519 peer key; the event's own pubkey is our Nostr key.
//   message: tags [p, <recipient npub>], content = NIP-44(protocol wire message,
//            or "P:<online|playing|away>" for presence, sent to friends only)
// Relays see who talks to whom and when, but not what. Delivery is best effort;
// the reliable channel above retransmits, dedupes and orders.
//
// Shared by the app and the desktop tools (Node runs this .ts file directly).
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import * as nip17 from 'nostr-tools/nip17';
import * as nip59 from 'nostr-tools/nip59';

/** Provisional app-specific ephemeral kind (SPECS §16 Q2). */
export const PEERMATE_KIND = 25050;

/**
 * Relays in use. The first five passed the phone relay check on 2026-11-19
 * (relays.tsx); damus and nos.lol failed it from the test network that day, but
 * worked in the Phase 0 probe, so they stay as extras. A dead relay costs little:
 * publishes don't wait for every relay.
 */
export const DEFAULT_RELAYS = [
  'wss://relay.snort.social',
  'wss://relay.primal.net',
  'wss://relay.nostr.net',
  'wss://nostr.bitcoiner.social',
  'wss://offchain.pub',
  'wss://relay.damus.io',
  'wss://nos.lol',
];

const SEEK_REPEAT_MS = 20_000;
const RESUBSCRIBE_MIN_MS = 2_000;
const RESUBSCRIBE_MAX_MS = 30_000;
/**
 * A subscription that hasn't echoed one of our own events for this long is
 * presumed dead and reopened on fresh connections. nostr-tools can leave a
 * subscription open but deaf when a background reconnect hangs.
 */
const STALE_SUBSCRIPTION_MS = 60_000;
const HEALTH_CHECK_MS = 15_000;
/** Our inbox gets a tiny event from ourselves this often, as a liveness probe. */
const PROBE_MS = 20_000;
/** Seeks older than this are ignored (strfry relays replay ephemeral events for minutes). */
const SEEK_MAX_AGE_S = 45;
const MAX_SEEN = 2000;

export type Seek = { room: string; peer: string; npub: string; tc: string; nick: string };

export type RelayOptions = {
  nostrSecret: Uint8Array;
  peerKey: string;
  relays?: string[];
  /** A protocol message for us, from Nostr key `npub`. */
  onMessage: (npub: string, wire: string) => void;
  onSeek?: (seek: Seek) => void;
  /** A presence note from Nostr key `npub` (SPECS §6.5): only friends are sent these. */
  onPresence?: (npub: string, status: PresenceStatus) => void;
  onLog?: (message: string) => void;
};

export type PresenceStatus = 'online' | 'playing' | 'away';
const PRESENCE_PREFIX = 'P:';
const PRESENCE = new Set<string>(['online', 'playing', 'away']);

const roomTag = (room: string) => `peermate-v1-${room}`;

/** The id the recipient will see for our message (the rumor's event id). */
export function rumorId(sk: Uint8Array, npub: string, text: string, createdAt: number): string {
  const rumor = nip59.createRumor({ kind: 14, content: text, tags: [['p', npub]], created_at: createdAt }, sk);
  return rumor.id;
}

/**
 * One-off fetch of our private messages since `sinceS` (for the background
 * check): connect, collect for up to `maxWaitMs`, disconnect.
 */
export async function fetchDMsOnce(
  nostrSecret: Uint8Array,
  sinceS: number,
  maxWaitMs = 15_000,
  relays = DEFAULT_RELAYS,
): Promise<{ id: string; from: string; text: string; at: number }[]> {
  const me = getPublicKey(nostrSecret);
  const pool = new SimplePool();
  pool.automaticallyAuth = () => async (event) => finalizeEvent(event, nostrSecret);
  try {
    const events = await pool.querySync(
      relays,
      { kinds: [1059], '#p': [me], since: Math.max(1, sinceS - 2 * 24 * 3600 - 600) },
      { maxWait: maxWaitMs },
    );
    const out = new Map<string, { id: string; from: string; text: string; at: number }>();
    for (const e of events) {
      try {
        const r = nip17.unwrapEvent(e as never, nostrSecret) as { id: string; pubkey: string; kind: number; content: string; created_at: number };
        if (r.kind === 14 && typeof r.content === 'string') out.set(r.id, { id: r.id, from: r.pubkey, text: r.content, at: r.created_at * 1000 });
      } catch {
        // not for us, or forged
      }
    }
    return [...out.values()].sort((a, b) => a.at - b.at);
  } finally {
    pool.destroy();
  }
}

export class RelayNet {
  readonly npub: string;
  private readonly sk: Uint8Array;
  private readonly relays: string[];
  private readonly pool: SimplePool;
  private readonly seen = new Set<string>();
  private readonly keys = new Map<string, Uint8Array>();
  private readonly opts: RelayOptions;
  private inbox: { close(): void } | null = null;
  private seeking: { sub: { close(): void }; timer: ReturnType<typeof setInterval> } | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(opts: RelayOptions) {
    this.opts = opts;
    this.sk = opts.nostrSecret;
    this.npub = getPublicKey(this.sk);
    // Ping idle connections and reconnect dropped ones (subscriptions included).
    // Answer AUTH challenges (NIP-42): relays release stored private messages
    // (kind 1059) only to their authenticated recipient.
    this.pool = new SimplePool({ enablePing: true, enableReconnect: true });
    this.pool.automaticallyAuth = () => async (event) => finalizeEvent(event, this.sk);
    this.relays = opts.relays ?? DEFAULT_RELAYS;
    this.inbox = this.resilient(
      'inbox',
      () => ({ kinds: [PEERMATE_KIND], '#p': [this.npub], since: Math.floor(Date.now() / 1000) - 10 }),
      (e) => this.onDirect(e),
    );
    const probe = () => this.publish([['p', this.npub]], nip44.encrypt('probe', this.conversationKey(this.npub)));
    probe();
    this.probeTimer = setInterval(probe, PROBE_MS);
  }

  /**
   * A subscription that comes back if every relay drops it. nostr-tools gives up
   * on a relay whose first connection fails (e.g. offline at that moment), which
   * would leave us deaf while our publishes still go out.
   */
  private resilient(
    name: string,
    filter: () => Record<string, unknown>,
    onevent: (e: { id: string; pubkey: string; content: string; tags: string[][]; created_at: number; kind: number; sig: string }) => void,
    /** Watch for our own events echoing back (subscriptions that see some of ours). */
    health = true,
  ): { close(): void } {
    let stopped = false;
    let delay = RESUBSCRIBE_MIN_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sub: { close(): void } | null = null;
    let generation = 0; // which open() is current; an older subscription's close is ignored
    // Our own events (inbox probes, our seeks) come back on a live subscription.
    let lastOwn = Date.now();
    const healthTimer = setInterval(() => {
      if (!health || stopped || this.closed || Date.now() - lastOwn < STALE_SUBSCRIPTION_MS) return;
      this.opts.onLog?.(`relay ${name} subscription deaf for ${Math.round((Date.now() - lastOwn) / 1000)} s; reconnecting`);
      lastOwn = Date.now();
      const old = sub;
      sub = null;
      generation++; // its close must not schedule a second reopen
      old?.close();
      this.pool.close(this.relays); // fresh connections: a hung reconnect never recovers
      if (timer) clearTimeout(timer);
      open();
    }, HEALTH_CHECK_MS);
    const open = () => {
      if (stopped || this.closed) return;
      const opened = Date.now();
      const mine = ++generation;
      sub = this.pool.subscribeMany(this.relays, filter() as never, {
        onevent: (e) => {
          delay = RESUBSCRIBE_MIN_MS;
          if (e.pubkey === this.npub) lastOwn = Date.now();
          onevent(e);
        },
        onclose: () => {
          if (stopped || this.closed || generation !== mine) return; // replaced by a newer one
          // Back off only if it failed quickly (couldn't connect at all).
          delay = Date.now() - opened > 60_000 ? RESUBSCRIBE_MIN_MS : Math.min(RESUBSCRIBE_MAX_MS, delay * 2);
          this.opts.onLog?.(`relay subscription closed; retrying in ${Math.round(delay / 1000)} s`);
          timer = setTimeout(open, delay);
        },
      });
    };
    open();
    return {
      close: () => {
        stopped = true;
        clearInterval(healthTimer);
        if (timer) clearTimeout(timer);
        sub?.close();
      },
    };
  }

  private firstSighting(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value!);
    return true;
  }

  private conversationKey(npub: string): Uint8Array {
    let k = this.keys.get(npub);
    if (!k) {
      k = nip44.getConversationKey(this.sk, npub);
      this.keys.set(npub, k);
    }
    return k;
  }

  private publish(tags: string[][], content: string) {
    if (this.closed) return;
    const event = finalizeEvent(
      { kind: PEERMATE_KIND, created_at: Math.floor(Date.now() / 1000), tags, content },
      this.sk,
    );
    Promise.allSettled(this.pool.publish(this.relays, event)).then((results) => {
      if (!results.some((r) => r.status === 'fulfilled')) this.opts.onLog?.('relay publish failed everywhere');
    });
  }

  private onDirect(e: { id: string; pubkey: string; content: string; tags: string[][] }) {
    if (e.pubkey === this.npub || !this.firstSighting(e.id)) return;
    let wire: string;
    try {
      wire = nip44.decrypt(e.content, this.conversationKey(e.pubkey));
    } catch {
      return; // not for us, or garbage
    }
    if (wire.startsWith(PRESENCE_PREFIX)) {
      const status = wire.slice(PRESENCE_PREFIX.length);
      if (PRESENCE.has(status)) this.opts.onPresence?.(e.pubkey, status as PresenceStatus);
      return;
    }
    this.opts.onMessage(e.pubkey, wire);
  }

  /** The id our private message will have (the same on a retry with the same `createdAt`). */
  dmId(npub: string, text: string, createdAt: number): string {
    return rumorId(this.sk, npub, text, createdAt);
  }

  /**
   * Sends a private message (NIP-17: a kind-14 rumor, sealed and gift-wrapped,
   * stored by relays). Resolves with the message id once at least one relay took it.
   */
  async sendDM(npub: string, text: string, createdAt = Math.floor(Date.now() / 1000)): Promise<{ id: string; ok: boolean }> {
    const wrap = nip17.wrapEvent(this.sk, { publicKey: npub }, text, undefined, undefined, createdAt);
    const id = rumorId(this.sk, npub, text, createdAt);
    if (this.closed) return { id, ok: false };
    // Sent once any relay has it (a dead relay would otherwise hold this until its timeout).
    const ok = await Promise.any(this.pool.publish(this.relays, wrap)).then(
      () => true,
      () => false,
    );
    return { id, ok };
  }

  /**
   * Private messages to us since `sinceS` (unix seconds). Gift wraps carry a
   * randomised timestamp up to 2 days in the past (NIP-59), hence the margin.
   */
  receiveDMs(sinceS: number, onDM: (dm: { id: string; from: string; text: string; at: number }) => void): { close(): void } {
    const seen = new Set<string>();
    return this.resilient(
      'messages',
      () => ({ kinds: [1059], '#p': [this.npub], since: Math.max(1, sinceS - 2 * 24 * 3600 - 600) }),
      (e) => {
        let rumor: { id: string; pubkey: string; kind: number; content: string; created_at: number };
        try {
          rumor = nip17.unwrapEvent(e as never, this.sk) as never;
        } catch {
          return; // not for us, forged, or garbage
        }
        if (rumor.kind !== 14 || seen.has(rumor.id) || typeof rumor.content !== 'string') return;
        seen.add(rumor.id);
        onDM({ id: rumor.id, from: rumor.pubkey, text: rumor.content, at: rumor.created_at * 1000 });
      },
      false, // stored events, none of them ours: no echo to watch for
    );
  }

  /** Tells one friend we're around (encrypted to them; relays see only that we sent something). */
  sendPresence(npub: string, status: PresenceStatus): void {
    this.send(npub, PRESENCE_PREFIX + status);
  }

  /** Sends one protocol message to `npub`, encrypted. */
  send(npub: string, wire: string): void {
    this.publish([['p', npub]], nip44.encrypt(wire, this.conversationKey(npub)));
  }

  /** Announces a seek in `rooms` every 20 s and reports others' seeks. */
  seek(rooms: string[], info: { tc: string; nick: string }): void {
    this.unseek();
    const tags = rooms.map(roomTag);
    const announce = () => {
      for (const t of tags) {
        this.publish(
          [
            ['t', t],
            ['expiration', String(Math.floor(Date.now() / 1000) + SEEK_MAX_AGE_S)],
          ],
          JSON.stringify({ v: 1, pk: this.opts.peerKey, tc: info.tc, nick: info.nick }),
        );
      }
    };
    const sub = this.resilient(
      'seek',
      () => ({ kinds: [PEERMATE_KIND], '#t': tags, since: Math.floor(Date.now() / 1000) - SEEK_MAX_AGE_S }),
      (e) => {
        if (e.pubkey === this.npub || !this.firstSighting(e.id)) return;
        if (Date.now() / 1000 - e.created_at > SEEK_MAX_AGE_S) return;
        let c: { v?: number; pk?: unknown; tc?: unknown; nick?: unknown };
        try {
          c = JSON.parse(e.content);
        } catch {
          return;
        }
        if (c.v !== 1 || typeof c.pk !== 'string' || !/^[0-9a-f]{64}$/.test(c.pk)) return;
        if (typeof c.tc !== 'string' || typeof c.nick !== 'string') return;
        const tag = e.tags.find((t) => t[0] === 't')?.[1] ?? '';
        const room = tag.startsWith('peermate-v1-') ? tag.slice('peermate-v1-'.length) : tag;
        this.opts.onSeek?.({ room, peer: c.pk, npub: e.pubkey, tc: c.tc, nick: c.nick.slice(0, 32) });
      },
    );
    announce();
    this.seeking = { sub, timer: setInterval(announce, SEEK_REPEAT_MS) };
  }

  unseek(): void {
    if (!this.seeking) return;
    this.seeking.sub.close();
    clearInterval(this.seeking.timer);
    this.seeking = null;
  }

  close(): void {
    this.unseek();
    this.closed = true;
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.inbox?.close();
    this.pool.destroy();
  }
}
