// Players the user blocked (SPECS §14.2): never paired again; their free-text
// chat is never shown anyway. Mirrored to the relays as an encrypted Nostr mute
// list (NIP-51, see mutelist.ts) so it follows the user's key to other devices.
import { useSyncExternalStore } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { fingerprint } from '@peermate/core';

const KEY = 'blocked.v1';
const META_KEY = 'blocked.meta.v1';

export type BlockedPlayer = { key: string; nick: string; fingerprint: string; at: number; npub?: string };

/**
 * changedAt: the last change on this device (ms). published: the changedAt that
 * last reached the relays. remoteAt: the newest relay copy we wrote or took (ms).
 */
type Meta = { changedAt: number; published: number; remoteAt: number };

let list: BlockedPlayer[] = load();
let meta: Meta = loadMeta();
const listeners = new Set<() => void>();
let onLocalChange: (() => void) | null = null;

function loadMeta(): Meta {
  try {
    const m = JSON.parse(Storage.getItemSync(META_KEY) ?? 'null');
    if (m && typeof m.changedAt === 'number') return { changedAt: m.changedAt, published: m.published ?? 0, remoteAt: m.remoteAt ?? 0 };
  } catch {
    // start fresh
  }
  return { changedAt: 0, published: 0, remoteAt: 0 };
}

function saveMeta(next: Meta) {
  meta = next;
  Storage.setItemSync(META_KEY, JSON.stringify(next));
}

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

/** A change made on this device: remember when, and let the mute-list sync publish it. */
function changed(next: BlockedPlayer[]) {
  save(next);
  saveMeta({ ...meta, changedAt: Math.max(Date.now(), meta.changedAt + 1) });
  onLocalChange?.();
}

export function blocked(): BlockedPlayer[] {
  return list;
}

export function blocklistMeta(): Meta {
  return meta;
}

/** Called after every change made on this device (the mute-list sync). */
export function setBlocklistChangeHook(fn: (() => void) | null): void {
  onLocalChange = fn;
}

/** Replaces the list with the version from the relays (no republish). */
export function replaceFromRemote(next: BlockedPlayer[], remoteAtMs: number): void {
  save(next);
  saveMeta({ changedAt: remoteAtMs, published: remoteAtMs, remoteAt: remoteAtMs });
}

/** The version changed at `changedAt` is now on the relays, as an event from `remoteAtMs`. */
export function markPublished(changedAt: number, remoteAtMs: number): void {
  saveMeta({ ...meta, published: Math.max(meta.published, changedAt), remoteAt: Math.max(meta.remoteAt, remoteAtMs) });
}

export function isBlocked(key: string): boolean {
  return list.some((b) => b.key === key);
}

export function block(key: string, nick: string, npub?: string): void {
  if (isBlocked(key)) return;
  changed([{ key, nick, fingerprint: fingerprint(key), at: Date.now(), ...(npub ? { npub } : {}) }, ...list]);
}

export function unblock(key: string): void {
  if (!isBlocked(key)) return;
  changed(list.filter((b) => b.key !== key));
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
