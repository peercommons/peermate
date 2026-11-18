// Private messages with friends (SPECS §2.4, NIP-17), kept on this device.
// Relays store the encrypted copies; this is the readable history.
import { useSyncExternalStore } from 'react';
import Storage from 'expo-sqlite/kv-store';

const KEY = 'messages.v1';
const MAX_PER_FRIEND = 300;
export const MESSAGE_MAX = 1000;

export type Message = {
  id: string;
  from: 'me' | 'them';
  text: string;
  at: number;
  /** Ours only: did a relay take it? */
  status?: 'sending' | 'sent' | 'failed';
};

type Store = {
  /** By friend peer key, oldest first. */
  threads: Record<string, Message[]>;
  /** By friend peer key: when the thread was last opened. */
  readAt: Record<string, number>;
  /** Unix seconds: newest message time we've fetched up to. */
  syncedTo: number;
};

let store: Store = load();
const listeners = new Set<() => void>();

function load(): Store {
  try {
    const s = JSON.parse(Storage.getItemSync(KEY) ?? 'null');
    if (s && typeof s === 'object' && s.threads) return { threads: s.threads, readAt: s.readAt ?? {}, syncedTo: s.syncedTo ?? 0 };
  } catch {
    // start fresh
  }
  return { threads: {}, readAt: {}, syncedTo: 0 };
}

function save(next: Store) {
  store = next;
  Storage.setItemSync(KEY, JSON.stringify(next));
  for (const l of [...listeners]) l();
}

export function syncedTo(): number {
  return store.syncedTo;
}

/** Adds a message (ignores one we already have), keeping the thread in time order. */
export function addMessage(friend: string, m: Message): void {
  const thread = store.threads[friend] ?? [];
  if (thread.some((x) => x.id === m.id)) return;
  const next = [...thread, m].sort((a, b) => a.at - b.at).slice(-MAX_PER_FRIEND);
  const syncedS = m.from === 'them' ? Math.max(store.syncedTo, Math.floor(m.at / 1000)) : store.syncedTo;
  save({ ...store, threads: { ...store.threads, [friend]: next }, syncedTo: syncedS });
}

export function setStatus(friend: string, id: string, status: Message['status']): void {
  const thread = store.threads[friend];
  if (!thread) return;
  save({ ...store, threads: { ...store.threads, [friend]: thread.map((m) => (m.id === id ? { ...m, status } : m)) } });
}

export function markRead(friend: string): void {
  // At least the newest message's time: a sender's clock can run ahead of ours.
  const newest = (store.threads[friend] ?? []).reduce((t, m) => Math.max(t, m.at), 0);
  const at = Math.max(Date.now(), newest);
  if ((store.readAt[friend] ?? 0) >= at) return;
  save({ ...store, readAt: { ...store.readAt, [friend]: at } });
}

export function unreadCount(s: Store, friend: string): number {
  const since = s.readAt[friend] ?? 0;
  return (s.threads[friend] ?? []).filter((m) => m.from === 'them' && m.at > since).length;
}

export function deleteThread(friend: string): void {
  const threads = { ...store.threads };
  delete threads[friend];
  save({ ...store, threads });
}

function useStore(): Store {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => store,
  );
}

export function useThread(friend: string): Message[] {
  return useStore().threads[friend] ?? EMPTY;
}

/** Unread messages per friend key. */
export function useUnread(): Record<string, number> {
  const s = useStore();
  const out: Record<string, number> = {};
  for (const key of Object.keys(s.threads)) {
    const n = unreadCount(s, key);
    if (n) out[key] = n;
  }
  return out;
}

const EMPTY: Message[] = [];
