// The player's identity on this device (SPECS §6.1). The seed is the only
// secret: it lives in secure storage (Android Keystore-wrapped / iOS Keychain,
// this device only) and is shown to the player only as the backup phrase.
import * as SecureStore from 'expo-secure-store';
import Storage from 'expo-sqlite/kv-store';
import {
  backupPhrase,
  deriveIdentity,
  fingerprint,
  fromHex as hexToBytes,
  newSeed,
  seedFromPhrase,
  toHex as bytesToHex,
  type Identity,
} from '@peermate/core';

const SEED_KEY = 'peermate.seed.v1';
const PROFILE_KEY = 'profile.v1';
const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export type Profile = { nick: string };
export type Me = { identity: Identity; profile: Profile; fingerprint: string };

let cached: Promise<Me> | null = null;

/** Loads this device's identity, creating one on first use. */
export function loadMe(): Promise<Me> {
  cached ??= (async () => {
    let hex = await SecureStore.getItemAsync(SEED_KEY, SECURE_OPTS);
    if (!hex) {
      hex = bytesToHex(newSeed());
      await SecureStore.setItemAsync(SEED_KEY, hex, SECURE_OPTS);
    }
    const identity = deriveIdentity(hexToBytes(hex));
    const fp = fingerprint(identity.peer.publicKey);
    const profile = await loadProfile(fp);
    return { identity, profile, fingerprint: fp };
  })().catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}

async function loadProfile(fp: string): Promise<Profile> {
  try {
    const raw = await Storage.getItem(PROFILE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Profile>;
      if (typeof p.nick === 'string' && p.nick.trim()) return { nick: p.nick };
    }
  } catch {
    // fall through to the default
  }
  const word = fp.split('-')[0];
  return { nick: `${word[0].toUpperCase()}${word.slice(1)} player` };
}

export const NICK_MAX = 20;

/** Letters, digits, spaces and a few separators; 2-20 characters. */
export function cleanNick(nick: string): string | null {
  const n = nick.trim().replace(/\s+/g, ' ');
  if (n.length < 2 || n.length > NICK_MAX) return null;
  return /^[\p{L}\p{N} ._-]+$/u.test(n) ? n : null;
}

export async function setNick(nick: string): Promise<Me> {
  const clean = cleanNick(nick);
  if (!clean) throw new Error('Use 2–20 letters, digits, spaces, dots, dashes or underscores');
  const me = await loadMe();
  await Storage.setItem(PROFILE_KEY, JSON.stringify({ nick: clean }));
  me.profile = { nick: clean };
  return me;
}

export async function getBackupPhrase(): Promise<string> {
  const hex = await SecureStore.getItemAsync(SEED_KEY, SECURE_OPTS);
  if (!hex) throw new Error('No identity on this device yet');
  return backupPhrase(hexToBytes(hex));
}

/** Replaces this device's identity with the one in `phrase`. */
export async function restoreFromPhrase(phrase: string): Promise<Me> {
  const seed = seedFromPhrase(phrase);
  await SecureStore.setItemAsync(SEED_KEY, bytesToHex(seed), SECURE_OPTS);
  cached = null;
  return loadMe();
}
