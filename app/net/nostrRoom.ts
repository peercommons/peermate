// Phase 0 spike (c): a chat room over public Nostr relays. This is the fallback
// path for when a direct P2P connection can't be made (SPECS.md §6.3, §6.6).
//
// Shared by the app and tools/spike-peer.mjs (Node runs this .ts file directly).
// Spike only: room messages are signed but NOT encrypted. Messages to a specific
// opponent will use NIP-44 encryption in Phase 2.
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

/** Provisional app-specific ephemeral kind (SPECS.md §16 Q2). */
export const ROOM_KIND = 25050;

/** Relays that delivered 5/5 ephemeral events in the Phase 0 probe (tools/nostr-probe.mjs). */
export const DEFAULT_RELAYS = [
  'wss://relay.snort.social',
  'wss://relay.damus.io',
  'wss://offchain.pub',
  'wss://nos.lol',
];

export type RoomEvent =
  | { type: 'ready'; publicKey: string }
  | { type: 'peer-joined'; id: string }
  | { type: 'chat'; from: string; text: string }
  | { type: 'rtt'; id: string; ms: number }
  | { type: 'log'; message: string };

type Payload =
  | { k: 'hello'; reply?: boolean }
  | { k: 'chat'; text: string }
  | { k: 'ping'; t: number }
  | { k: 'pong'; t: number; to: string };

export type NostrRoom = {
  publicKey: string;
  chat(text: string): void;
  ping(): void;
  close(): void;
};

export function joinNostrRoom(opts: {
  room: string;
  onEvent: (event: RoomEvent) => void;
  relays?: string[];
}): NostrRoom {
  const relays = opts.relays ?? DEFAULT_RELAYS;
  const tag = `peermate-v1-spike-${opts.room}`;
  const sk = generateSecretKey(); // throwaway per session in the spike
  const me = getPublicKey(sk);
  const pool = new SimplePool();
  const seen = new Set<string>(); // event ids: relays and replays deliver duplicates
  const peers = new Set<string>();
  const emit = opts.onEvent;

  const publish = (payload: Payload) => {
    const event = finalizeEvent(
      {
        kind: ROOM_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', tag]],
        content: JSON.stringify(payload),
      },
      sk,
    );
    Promise.allSettled(pool.publish(relays, event)).then((results) => {
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      if (ok === 0) emit({ type: 'log', message: 'publish failed on every relay' });
    });
  };

  const sub = pool.subscribeMany(
    relays,
    // `since` skips stale events that strfry relays replay for a few minutes.
    { kinds: [ROOM_KIND], '#t': [tag], since: Math.floor(Date.now() / 1000) - 5 },
    {
      onevent(event) {
        if (seen.has(event.id) || event.pubkey === me) return;
        seen.add(event.id);

        let msg: Payload;
        try {
          msg = JSON.parse(event.content);
        } catch {
          return;
        }

        const from = event.pubkey;
        if (!peers.has(from)) {
          peers.add(from);
          emit({ type: 'peer-joined', id: from });
        }

        switch (msg.k) {
          case 'hello':
            // Answer a first hello so the newcomer learns about us too.
            if (!msg.reply) publish({ k: 'hello', reply: true });
            break;
          case 'chat':
            if (typeof msg.text === 'string') emit({ type: 'chat', from, text: msg.text.slice(0, 280) });
            break;
          case 'ping':
            publish({ k: 'pong', t: msg.t, to: from });
            break;
          case 'pong':
            if (msg.to === me && typeof msg.t === 'number') emit({ type: 'rtt', id: from, ms: Date.now() - msg.t });
            break;
        }
      },
      oneose() {
        emit({ type: 'log', message: `subscribed on ${relays.length} relays` });
      },
    },
  );

  emit({ type: 'ready', publicKey: me });
  publish({ k: 'hello' });

  return {
    publicKey: me,
    chat: (text) => publish({ k: 'chat', text: text.slice(0, 280) }),
    ping: () => publish({ k: 'ping', t: Date.now() }),
    close() {
      sub.close();
      pool.destroy();
    },
  };
}
