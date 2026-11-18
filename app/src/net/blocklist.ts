// Players the user blocked (SPECS §14.2): never paired again; their free-text
// chat is never shown anyway. Local to this device for now; publishing it as a
// Nostr mute list (NIP-51) comes with friends in Phase 3.
import { useSyncExternalStore } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { fingerprint } from '@peermate/core';

const KEY = 'blocked.v1';

export type BlockedPlayer = { key: string; nick: string; fingerprint: string; at: number };

let list: BlockedPlayer[] = load();
const listeners = new Set<() => void>();

function load(): BlockedPlayer[] {
  try {
    const parsed = JSON.parse(Storage.getItemSync(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((b) => typeof b?.key === 'string') : [];
  } catch {
    return [];
  }
}

function save(next: BlockedPlayer[]) {
  list = next;
  Storage.setItemSync(KEY, JSON.stringify(next));
  for (const l of [...listeners]) l();
}

export function isBlocked(key: string): boolean {
  return list.some((b) => b.key === key);
}

export function block(key: string, nick: string): void {
  if (isBlocked(key)) return;
  save([{ key, nick, fingerprint: fingerprint(key), at: Date.now() }, ...list]);
}

export function unblock(key: string): void {
  save(list.filter((b) => b.key !== key));
}

export function useBlocked(): BlockedPlayer[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => list,
  );
}
