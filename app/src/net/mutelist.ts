// The block list as a Nostr mute list (NIP-51, kind 10000), so it follows the
// user's key to another device (SPECS §2.4, §14.2).
//
// Every entry is private: the content is NIP-44-encrypted to our own key, and
// there are no public tags, so relays and other users can't see whom we block.
// Entries are ["peermate", <peer key>, <nick>, <blocked at ms>], followed by
// ["p", <nostr key>] when we know it (the standard NIP-51 item).
//
// Sync is last-writer-wins on the whole list: a newer list on the relays
// replaces ours, and a newer local change gets published.
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { fingerprint } from '@peermate/core';
import {
  blocked,
  blocklistMeta,
  markPublished,
  replaceFromRemote,
  setBlocklistChangeHook,
  type BlockedPlayer,
} from './blocklist';
import { loadMe } from './profile';
import { publishTracked, relayHealth } from './relay';

export const MUTE_LIST_KIND = 10000;
const HEX64 = /^[0-9a-f]{64}$/;

export function encodeMuteList(list: BlockedPlayer[]): string[][] {
  const tags: string[][] = [];
  for (const b of list) {
    tags.push(['peermate', b.key, b.nick, String(b.at)]);
    if (b.npub) tags.push(['p', b.npub]);
  }
  return tags;
}

export function decodeMuteList(tags: unknown): BlockedPlayer[] {
  if (!Array.isArray(tags)) return [];
  const out: BlockedPlayer[] = [];
  for (const t of tags) {
    if (!Array.isArray(t)) continue;
    if (t[0] === 'peermate' && typeof t[1] === 'string' && HEX64.test(t[1]) && !out.some((b) => b.key === t[1])) {
      const at = Number(t[3]);
      out.push({
        key: t[1],
        nick: typeof t[2] === 'string' && t[2] ? t[2].slice(0, 32) : 'Player',
        fingerprint: fingerprint(t[1]),
        at: Number.isFinite(at) ? at : 0,
      });
    } else if (t[0] === 'p' && typeof t[1] === 'string' && HEX64.test(t[1]) && out.length > 0) {
      out[out.length - 1].npub ??= t[1]; // belongs to the entry before it
    }
  }
  return out;
}

let running: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Starts syncing: now, and shortly after every block or unblock. */
export function startMuteListSync(log: (...a: unknown[]) => void = () => undefined): void {
  setBlocklistChangeHook(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void syncMuteList(log), 2_000); // a burst of changes, one publish
  });
  void syncMuteList(log);
}

/** One sync round (overlapping calls are folded into one more round). */
export function syncMuteList(log: (...a: unknown[]) => void = () => undefined): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await syncOnce(log);
      } while (again);
    } catch (err) {
      log('mute list sync failed:', String(err));
    } finally {
      running = null;
    }
  })();
  return running;
}

async function syncOnce(log: (...a: unknown[]) => void) {
  const me = await loadMe();
  const sk = me.identity.nostr.secretKey;
  const pk = getPublicKey(sk);
  const key = nip44.getConversationKey(sk, pk);
  const pool = new SimplePool();
  pool.automaticallyAuth = () => async (event) => finalizeEvent(event, sk); // NIP-42 relays
  try {
    const relays = relayHealth.active();
    const events = await pool.querySync(relays, { kinds: [MUTE_LIST_KIND], authors: [pk] }, { maxWait: 8_000 });
    const latest = events.reduce<(typeof events)[number] | null>((a, e) => (!a || e.created_at > a.created_at ? e : a), null);
    const local = blocklistMeta();
    const remoteAt = latest ? latest.created_at * 1000 : 0;
    const dirty = local.changedAt > local.published;
    // A copy we haven't seen (another device wrote it) wins, unless our unpublished change is newer.
    if (latest && remoteAt > local.remoteAt && (!dirty || remoteAt > local.changedAt)) {
      let tags: unknown = [];
      try {
        tags = latest.content ? JSON.parse(nip44.decrypt(latest.content, key)) : [];
      } catch {
        log('mute list: unreadable copy on relays, ignored');
        tags = null;
      }
      if (tags !== null) {
        const list = decodeMuteList(tags);
        replaceFromRemote(list, remoteAt);
        log('mute list: took', list.length, 'from relays');
        return;
      }
    }
    if (!dirty && (latest || local.changedAt === 0)) return; // up to date, or never blocked anyone
    const changedAt = local.changedAt;
    const list = blocked();
    const event = finalizeEvent(
      {
        kind: MUTE_LIST_KIND,
        // Strictly newer than what the relays hold, so it replaces it.
        created_at: Math.max(Math.floor(Date.now() / 1000), latest ? latest.created_at + 1 : 0),
        tags: [],
        content: nip44.encrypt(JSON.stringify(encodeMuteList(list)), key),
      },
      sk,
    );
    const ok = await publishTracked(pool, relays, event);
    if (ok) {
      markPublished(changedAt, event.created_at * 1000);
      log('mute list: published', list.length);
    } else {
      log('mute list: publish failed everywhere');
    }
  } finally {
    pool.destroy();
  }
}
