// Player identity (SPECS §6.1). One 32-byte seed, backed up as a 24-word phrase,
// derives both keys:
//   HKDF(seed, "peermate/v1/ed25519")   -> Ed25519: signs game messages; HyperDHT key
//   HKDF(seed, "peermate/v1/secp256k1") -> secp256k1: Nostr identity (x-only pubkey)
// Nothing here touches storage; the app keeps the seed in secure storage.
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export type KeyPair = { publicKey: string; secretKey: Uint8Array };

export type Identity = {
  /** Ed25519, hex. Signs every protocol message; also the HyperDHT key. */
  peer: KeyPair;
  /** secp256k1 x-only public key, hex (the npub's payload). */
  nostr: KeyPair;
};

export const SEED_BYTES = 32;

/** A fresh random seed (needs crypto.getRandomValues; the app polyfills it). */
export function newSeed(): Uint8Array {
  return randomBytes(SEED_BYTES);
}

function derive(seed: Uint8Array, label: string): Uint8Array {
  if (seed.length !== SEED_BYTES) throw new RangeError('seed must be 32 bytes');
  return hkdf(sha256, seed, undefined, utf8ToBytes(label), 32);
}

export function deriveIdentity(seed: Uint8Array): Identity {
  const edSecret = derive(seed, 'peermate/v1/ed25519');
  // A secp256k1 secret must be in [1, n-1]; an HKDF output misses that with
  // probability ~2^-128, but re-derive deterministically just in case.
  let nostrSecret = derive(seed, 'peermate/v1/secp256k1');
  for (let i = 1; !secp256k1.utils.isValidSecretKey(nostrSecret); i++) {
    nostrSecret = derive(seed, `peermate/v1/secp256k1/${i}`);
  }
  return {
    peer: { publicKey: bytesToHex(ed25519.getPublicKey(edSecret)), secretKey: edSecret },
    nostr: { publicKey: bytesToHex(schnorr.getPublicKey(nostrSecret)), secretKey: nostrSecret },
  };
}

/** The seed as a 24-word BIP-39 phrase (the seed is the entropy). */
export function backupPhrase(seed: Uint8Array): string {
  return entropyToMnemonic(seed, wordlist);
}

/** Inverse of backupPhrase; throws on a mistyped phrase (the checksum catches most typos). */
export function seedFromPhrase(phrase: string): Uint8Array {
  const normalized = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  if (!validateMnemonic(normalized, wordlist)) throw new Error('Backup phrase is not valid');
  const seed = mnemonicToEntropy(normalized, wordlist);
  if (seed.length !== SEED_BYTES) throw new Error('Backup phrase must be 24 words');
  return seed;
}

/**
 * Four words that identify a public key, e.g. "orbit-candle-mango-ripple", so
 * players can tell two people with the same nickname apart (44 bits).
 */
export function fingerprint(publicKeyHex: string): string {
  const h = sha256(concatBytes(utf8ToBytes('peermate/v1/fingerprint'), hexToBytes(publicKeyHex)));
  let bits = 0n;
  for (const byte of h.slice(0, 6)) bits = (bits << 8n) | BigInt(byte);
  bits >>= 4n; // 48 -> 44 bits
  const words: string[] = [];
  for (let i = 3; i >= 0; i--) words.push(wordlist[Number((bits >> BigInt(i * 11)) & 2047n)]);
  return words.join('-');
}
