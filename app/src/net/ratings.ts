// The player's own Glicko-2 ratings, one per time-control class (SPECS §7.5).
// Computed on this device from its own online games; unofficial.
import { useSyncExternalStore } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { NEW_RATING, updateRating, type RatedOpponent, type Rating, type TimeControlClass } from '@peermate/core';

const KEY = 'ratings.v1';
const MAX_APPLIED = 500;

type Store = { byClass: Partial<Record<TimeControlClass, Rating>>; applied: string[] };

let store: Store = load();
const listeners = new Set<() => void>();

function load(): Store {
  try {
    const s = JSON.parse(Storage.getItemSync(KEY) ?? 'null');
    if (s?.byClass) return { byClass: s.byClass, applied: Array.isArray(s.applied) ? s.applied : [] };
  } catch {
    // start fresh
  }
  return { byClass: {}, applied: [] };
}

function save(next: Store) {
  store = next;
  Storage.setItemSync(KEY, JSON.stringify(next));
  for (const l of [...listeners]) l();
}

export function myRating(cls: TimeControlClass): Rating {
  return store.byClass[cls] ?? NEW_RATING;
}

/** Applies one finished game (once per game id). Returns the rating before and after. */
export function applyResult(
  gameId: string,
  cls: TimeControlClass,
  opponent: RatedOpponent,
  score: 0 | 0.5 | 1,
): { before: Rating; after: Rating } | null {
  if (store.applied.includes(gameId)) return null;
  const before = myRating(cls);
  const after = updateRating(before, [[opponent, score]]);
  save({
    byClass: { ...store.byClass, [cls]: after },
    applied: [...store.applied, gameId].slice(-MAX_APPLIED),
  });
  return { before, after };
}

export function useRatings(): Partial<Record<TimeControlClass, Rating>> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => store.byClass,
  );
}
