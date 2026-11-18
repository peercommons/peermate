// Wire protocol (SPECS §6.7): every message travels in a signed envelope.
//
// Encoding: JSON for v1. Messages are tiny (a move is ~250 bytes with its
// signature), JSON is easy to debug, and Nostr content is text anyway. Signatures
// cover a canonical form (sorted keys, no whitespace), so the wire encoding can
// change later without changing what is signed.
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { KeyPair } from './identity.ts';

export const PROTOCOL_VERSION = 1;
export const MAX_CHAT_LENGTH = 280;
export const MAX_WIRE_BYTES = 4096;

export type Message =
  | { t: 'HELLO'; app: string; proto: number[]; nick: string; npub: string; rating?: number }
  | { t: 'CHALLENGE'; tc: string; rated: boolean; commit: string }
  | { t: 'ACCEPT'; nonce: string }
  | { t: 'DECLINE'; reason: string }
  | { t: 'REVEAL'; nonce: string }
  | { t: 'START'; gid: string; white: string; black: string; tc: string; fen: string }
  | { t: 'MOVE'; ply: number; uci: string; clock: number; hash: string }
  | { t: 'DRAW_OFFER'; ply: number }
  | { t: 'DRAW_RESP'; ply: number; accept: boolean }
  | { t: 'RESIGN'; ply: number }
  | { t: 'ABORT'; ply: number }
  | { t: 'FLAG_CLAIM'; ply: number }
  | { t: 'FLAG_RESP'; ply: number; accept: boolean }
  | { t: 'CHAT'; text?: string; quick?: string }
  // Unreliable (not acked, not retransmitted):
  | { t: 'ACK'; seq: number }
  | { t: 'SYNC'; delivered: number }
  | { t: 'PING'; nonce: string }
  | { t: 'PONG'; nonce: string };

export type MessageType = Message['t'];

/** Control messages that are never acked or retransmitted; they carry seq 0. */
export const UNRELIABLE: ReadonlySet<MessageType> = new Set(['ACK', 'SYNC', 'PING', 'PONG']);

export type Envelope = {
  v: number;
  gid?: string;
  /** Per-sender sequence number: 1, 2, 3... for reliable messages, 0 otherwise. */
  seq: number;
  /** Sender wall clock, ms. Informational; clocks don't trust it. */
  ts: number;
  /** Sender's Ed25519 public key, hex. */
  from: string;
  body: Message;
  /** Ed25519 signature over the canonical form of all other fields, hex. */
  sig: string;
};

/** Deterministic JSON: object keys sorted, undefined fields dropped. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** BLAKE2b-256 of a string, hex. Used for commitments and the move hash chain. */
export function hashHex(text: string): string {
  return bytesToHex(blake2b(utf8ToBytes(text), { dkLen: 32 }));
}

const signedBytes = (e: Omit<Envelope, 'sig'>) =>
  utf8ToBytes(canonical({ v: e.v, gid: e.gid, seq: e.seq, ts: e.ts, from: e.from, body: e.body }));

export function seal(
  key: KeyPair,
  fields: { gid?: string; seq: number; ts: number; body: Message },
): Envelope {
  const unsigned = { v: PROTOCOL_VERSION, ...fields, ts: Math.floor(fields.ts), from: key.publicKey };
  return { ...unsigned, sig: bytesToHex(ed25519.sign(signedBytes(unsigned), key.secretKey)) };
}

export function verify(e: Envelope): boolean {
  try {
    return ed25519.verify(hexToBytes(e.sig), signedBytes(e), hexToBytes(e.from));
  } catch {
    return false;
  }
}

export const encode = (e: Envelope): string => JSON.stringify(e);

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const isInt = (n: unknown): n is number => Number.isSafeInteger(n);
const isStr = (s: unknown, max = 128): s is string => typeof s === 'string' && s.length <= max;

/** Field checks per message type; anything else in the body is ignored. */
const BODY_CHECKS: Record<MessageType, (b: Record<string, unknown>) => boolean> = {
  HELLO: (b) =>
    isStr(b.app, 32) && Array.isArray(b.proto) && b.proto.every(isInt) && isStr(b.nick, 32) && isStr(b.npub, 64) &&
    (b.rating === undefined || isInt(b.rating)),
  CHALLENGE: (b) => isStr(b.tc, 16) && typeof b.rated === 'boolean' && isStr(b.commit) && HEX64.test(b.commit),
  ACCEPT: (b) => isStr(b.nonce) && HEX64.test(b.nonce),
  DECLINE: (b) => isStr(b.reason, 64),
  REVEAL: (b) => isStr(b.nonce) && HEX64.test(b.nonce),
  START: (b) =>
    isStr(b.gid, 64) && isStr(b.white) && HEX64.test(b.white) && isStr(b.black) && HEX64.test(b.black) &&
    isStr(b.tc, 16) && isStr(b.fen, 100),
  MOVE: (b) =>
    isInt(b.ply) && b.ply >= 1 && isStr(b.uci, 5) && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(b.uci) &&
    isInt(b.clock) && isStr(b.hash) && HEX64.test(b.hash),
  DRAW_OFFER: (b) => isInt(b.ply),
  DRAW_RESP: (b) => isInt(b.ply) && typeof b.accept === 'boolean',
  RESIGN: (b) => isInt(b.ply),
  ABORT: (b) => isInt(b.ply),
  FLAG_CLAIM: (b) => isInt(b.ply),
  FLAG_RESP: (b) => isInt(b.ply) && typeof b.accept === 'boolean',
  CHAT: (b) => (b.text === undefined || isStr(b.text, MAX_CHAT_LENGTH)) && (b.quick === undefined || isStr(b.quick, 32)) &&
    (b.text !== undefined) !== (b.quick !== undefined),
  ACK: (b) => isInt(b.seq) && b.seq >= 1,
  SYNC: (b) => isInt(b.delivered) && b.delivered >= 0,
  PING: (b) => isStr(b.nonce, 32),
  PONG: (b) => isStr(b.nonce, 32),
};

/**
 * Parses and checks a wire message: shape, field types and signature. Returns
 * null for anything malformed, oversized, from an unknown protocol version,
 * of an unknown type (ignored, per §6.7) or with a bad signature.
 */
export function decode(wire: string): Envelope | null {
  if (wire.length > MAX_WIRE_BYTES) return null;
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(wire);
  } catch {
    return null;
  }
  if (!e || typeof e !== 'object') return null;
  if (e.v !== PROTOCOL_VERSION || !isInt(e.seq) || e.seq < 0 || !isInt(e.ts)) return null;
  if (!isStr(e.from) || !HEX64.test(e.from) || !isStr(e.sig, 128) || !HEX128.test(e.sig)) return null;
  if (e.gid !== undefined && !isStr(e.gid, 64)) return null;
  const body = e.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || typeof body.t !== 'string') return null;
  const check = BODY_CHECKS[body.t as MessageType];
  if (!check || !check(body)) return null;
  const reliable = !UNRELIABLE.has(body.t as MessageType);
  if (reliable !== (e.seq > 0)) return null;
  const env = e as unknown as Envelope;
  return verify(env) ? env : null;
}
