// Relay transport over public Nostr relays (SPECS §6.3, §6.6): the fallback for
// when a direct (hole-punched) connection can't be made.
//
// Everything is an ephemeral event (relays forward, don't store):
//   seek:    tags [t, "peermate-v1-<room>"], content {v, pk, tc, nick}
//            pk = Ed25519 peer key; the event's own pubkey is our Nostr key.
//   message: tags [p, <recipient npub>], content = NIP-44(protocol wire message)
// Relays see who talks to whom and when, but not what. Delivery is best effort;
// the reliable channel above retransmits, dedupes and orders.
//
// Shared by the app and the desktop tools (Node runs this .ts file directly).
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';

/** Provisional app-specific ephemeral kind (SPECS §16 Q2). */
export const PEERMATE_KIND = 25050;

/** Relays that delivered ephemeral events reliably in the Phase 0 probe. */
export const DEFAULT_RELAYS = ['wss://relay.snort.social', 'wss://relay.damus.io', 'wss://offchain.pub', 'wss://nos.lol'];

const SEEK_REPEAT_MS = 20_000;
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
  onLog?: (message: string) => void;
};

const roomTag = (room: string) => `peermate-v1-${room}`;

export class RelayNet {
  readonly npub: string;
  private readonly sk: Uint8Array;
  private readonly relays: string[];
  private readonly pool = new SimplePool();
  private readonly seen = new Set<string>();
  private readonly keys = new Map<string, Uint8Array>();
  private readonly opts: RelayOptions;
  private inbox: { close(): void } | null = null;
  private seeking: { sub: { close(): void }; timer: ReturnType<typeof setInterval> } | null = null;
  private closed = false;

  constructor(opts: RelayOptions) {
    this.opts = opts;
    this.sk = opts.nostrSecret;
    this.npub = getPublicKey(this.sk);
    this.relays = opts.relays ?? DEFAULT_RELAYS;
    this.inbox = this.pool.subscribeMany(
      this.relays,
      { kinds: [PEERMATE_KIND], '#p': [this.npub], since: Math.floor(Date.now() / 1000) - 10 },
      { onevent: (e) => this.onDirect(e) },
    );
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
    this.opts.onMessage(e.pubkey, wire);
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
    const sub = this.pool.subscribeMany(
      this.relays,
      { kinds: [PEERMATE_KIND], '#t': tags, since: Math.floor(Date.now() / 1000) - SEEK_MAX_AGE_S },
      {
        onevent: (e) => {
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
    this.inbox?.close();
    this.pool.destroy();
  }
}
