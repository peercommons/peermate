// Co-signed game results and their NIP-64 publishing (SPECS §7.5).
//
// Every decided online game whose RESULT both sides signed is kept here. It's
// published (kind 64: PGN content, both signed RESULTs as tags) only if the
// player said yes, asked once after their first such game, changeable in
// Settings. Published games let opponents spot-check the player's rating.
import { useSyncExternalStore } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent } from 'nostr-tools/pure';
import { checkRatingChain, GAME_KIND, GAME_TOPIC, RESULT_TAG, resultFromTags, type RatingCheck } from '@peermate/core';
import { loadMe } from './profile';
import { publishTracked, relayHealth } from './relay';
import './relayHealthStore';

const KEY = 'results.v1';
const PREF_KEY = 'publishGames.v1';
const MAX_KEPT = 200;

export type StoredResult = {
  gid: string;
  cls: string;
  /** Our signed RESULT envelope and theirs. */
  mine: string;
  theirs: string;
  pgn: string;
  at: number;
  published: boolean;
};

/** null: not asked yet. */
export type PublishPref = 'yes' | 'no' | null;

let results: StoredResult[] = load();
let pref: PublishPref = loadPref();
const listeners = new Set<() => void>();

function load(): StoredResult[] {
  try {
    const v = JSON.parse(Storage.getItemSync(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((r) => typeof r?.gid === 'string') : [];
  } catch {
    return [];
  }
}

function loadPref(): PublishPref {
  const v = Storage.getItemSync(PREF_KEY);
  return v === 'yes' || v === 'no' ? v : null;
}

function save(next: StoredResult[]) {
  results = next.slice(-MAX_KEPT);
  Storage.setItemSync(KEY, JSON.stringify(results));
  for (const l of [...listeners]) l();
}

export function publishPref(): PublishPref {
  return pref;
}

export function setPublishPref(next: 'yes' | 'no', log: (...a: unknown[]) => void = () => undefined): void {
  pref = next;
  Storage.setItemSync(PREF_KEY, next);
  for (const l of [...listeners]) l();
  if (next === 'yes') void publishPending(log);
}

export function usePublishPref(): PublishPref {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pref,
  );
}

/** Keeps a co-signed result; publishes it if the player said yes. */
export function addResult(r: Omit<StoredResult, 'published'>, log: (...a: unknown[]) => void = () => undefined): void {
  if (results.some((x) => x.gid === r.gid)) return;
  save([...results, { ...r, published: false }]);
  if (pref === 'yes') void publishPending(log);
}

let publishing: Promise<void> | null = null;

/** Publishes every kept result not yet on the relays (one run at a time). */
export function publishPending(log: (...a: unknown[]) => void = () => undefined): Promise<void> {
  if (pref !== 'yes') return Promise.resolve();
  publishing ??= (async () => {
    try {
      const todo = results.filter((r) => !r.published);
      if (todo.length === 0) return;
      const me = await loadMe();
      const pool = new SimplePool();
      try {
        for (const r of todo) {
          const event = finalizeEvent(
            {
              kind: GAME_KIND,
              created_at: Math.floor(r.at / 1000),
              tags: [
                ['t', GAME_TOPIC],
                [RESULT_TAG, r.mine],
                [RESULT_TAG, r.theirs],
                ['alt', 'Chess game (PGN) played on Peermate'],
              ],
              content: r.pgn,
            },
            me.identity.nostr.secretKey,
          );
          const ok = await publishTracked(pool, relayHealth.active(), event);
          log('game publish', r.gid.slice(0, 8), ok ? 'ok' : 'failed');
          if (ok) save(results.map((x) => (x.gid === r.gid ? { ...x, published: true } : x)));
        }
      } finally {
        pool.destroy();
      }
    } catch (err) {
      log('game publish error:', String(err));
    } finally {
      publishing = null;
    }
  })();
  return publishing;
}

/**
 * Spot-checks a player's rating from their published games (SPECS §7.5):
 * signatures, the Glicko-2 chain, and their advertised rating.
 */
export async function spotCheckRating(
  npub: string,
  cls: string,
  advertised: { r: number; rd: number },
): Promise<RatingCheck> {
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(
      relayHealth.active(),
      { kinds: [GAME_KIND], authors: [npub], '#t': [GAME_TOPIC], limit: 50 },
      { maxWait: 6_000 },
    );
    const games = events.map((e) => resultFromTags(e.tags)).filter((g) => g !== null);
    return checkRatingChain(npub, cls, games, advertised);
  } finally {
    pool.destroy();
  }
}
