// Friends (SPECS §2.4): players you can challenge directly. Local to this
// device; each entry has both keys, the peer key (HyperDHT, direct) and the
// Nostr key (relay fallback).
//
// Share link: peermate://p/<peerKey>?n=<nostrKey>&nick=<name>
import { useSyncExternalStore } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { displayNick, fingerprint } from '@peermate/core';
import { unblock } from './blocklist';
import { forgetChallenges } from './challenges';
import { deleteThread } from './messages';

const KEY = 'friends.v1';
const HEX64 = /^[0-9a-f]{64}$/;

export type Friend = { key: string; npub: string; nick: string; fingerprint: string; addedAt: number };

let list: Friend[] = load();
const listeners = new Set<() => void>();

function load(): Friend[] {
  try {
    const parsed = JSON.parse(Storage.getItemSync(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((f) => HEX64.test(f?.key) && HEX64.test(f?.npub)) : [];
  } catch {
    return [];
  }
}

function save(next: Friend[]) {
  list = next;
  Storage.setItemSync(KEY, JSON.stringify(next));
  for (const l of [...listeners]) l();
}

export function friends(): Friend[] {
  return list;
}

export function getFriend(key: string): Friend | undefined {
  return list.find((f) => f.key === key);
}

export function friendByNpub(npub: string): Friend | undefined {
  return list.find((f) => f.npub === npub);
}

export function isFriend(key: string): boolean {
  return list.some((f) => f.key === key);
}

/** Adds or updates a friend. Adding someone also unblocks them. */
export function addFriend(key: string, npub: string, nick: string): void {
  if (!HEX64.test(key) || !HEX64.test(npub)) return;
  unblock(key);
  const name = displayNick(nick, 'Friend');
  const existing = getFriend(key);
  if (existing) {
    save(list.map((f) => (f.key === key ? { ...f, npub, nick: name } : f)));
  } else {
    save([...list, { key, npub, nick: name, fingerprint: fingerprint(key), addedAt: Date.now() }]);
  }
}

/**
 * Keeps a friend's Nostr key and name current (from their signed HELLO). A new
 * name that another friend already has is not taken (their messages and
 * notifications would show under that friend's name).
 */
export function refreshFriend(key: string, npub: string, nick: string): void {
  const f = getFriend(key);
  if (!f) return;
  let name = displayNick(nick, f.nick);
  const taken = (n: string) => list.some((o) => o.key !== key && o.nick.toLowerCase() === n.toLowerCase());
  if (taken(name)) name = f.nick;
  if (f.npub !== npub || f.nick !== name) addFriend(key, npub, name);
}

export function removeFriend(key: string): void {
  save(list.filter((f) => f.key !== key));
  deleteThread(key); // their messages go too
  forgetChallenges(key);
}

export function useFriends(): Friend[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => list,
  );
}

export function friendLink(key: string, npub: string, nick: string): string {
  return `peermate://p/${key}?n=${npub}&nick=${encodeURIComponent(nick)}`;
}

/** Parses a friend link (or its parts, from a deep link's route params). */
export function parseFriendLink(text: string): { key: string; npub: string; nick: string } | null {
  const m = /peermate:\/\/p\/([0-9a-f]{64})\?([^\s]*)/i.exec(text.trim());
  if (!m) return null;
  const params = new URLSearchParams(m[2]);
  return parseFriendParams(m[1].toLowerCase(), params.get('n'), params.get('nick'));
}

export function parseFriendParams(key: unknown, npub: unknown, nick: unknown): { key: string; npub: string; nick: string } | null {
  if (typeof key !== 'string' || typeof npub !== 'string') return null;
  const k = key.toLowerCase();
  const n = npub.toLowerCase();
  if (!HEX64.test(k) || !HEX64.test(n)) return null;
  return { key: k, npub: n, nick: displayNick(nick, 'Friend') };
}
