// Co-signed results and verifiable ratings (SPECS §7.5).
//
// When a game is decided, each side sends a signed RESULT. The two envelopes
// together prove both players agreed on the outcome; a player may publish them
// as a NIP-64 event (kind 64, PGN content), one tag per envelope. Anyone can
// then spot-check a rating: fetch the player's published games, check every
// pair of signatures, and check that each game's "rating before" follows from
// the previous one's result under Glicko-2.
import { decode, type Envelope, type Message } from './envelope.ts';
import { updateRating, type Rating } from '../rating.ts';

export type ResultBody = Extract<Message, { t: 'RESULT' }>;

/** NIP-64 chess game. */
export const GAME_KIND = 64;
/** Tag holding one signed RESULT envelope (two per event). */
export const RESULT_TAG = 'peermate-result';
/** Topic tag on every Peermate game event. */
export const GAME_TOPIC = 'peermate';

export type ResultSide = {
  key: string;
  npub: string;
  /** Rating for `cls` before the game, if it was rated for this side. */
  before?: { r: number; rd: number; vol: number };
};

export type CosignedResult = {
  gid: string;
  winner: 'w' | 'b' | 'draw';
  reason: string;
  hash: string;
  plies: number;
  cls: string;
  white: ResultSide;
  black: ResultSide;
  /** When it was signed (the later of the two signatures, sender clocks, ms). */
  at: number;
};

function side(env: Envelope, b: ResultBody): ResultSide {
  const before = b.r !== undefined && b.rd !== undefined && b.vol !== undefined ? { r: b.r, rd: b.rd, vol: b.vol } : undefined;
  return { key: env.from, npub: b.npub, ...(before ? { before } : {}) };
}

/**
 * Checks two signed RESULT envelopes: valid signatures, one per colour from two
 * different keys, the same game and the same outcome. Null if anything's off.
 */
export function checkCosigned(wireA: string, wireB: string): CosignedResult | null {
  const a = decode(wireA);
  const b = decode(wireB);
  if (!a || !b || a.body.t !== 'RESULT' || b.body.t !== 'RESULT') return null;
  if (!a.gid || a.gid !== b.gid || a.from === b.from) return null;
  const ra = a.body;
  const rb = b.body;
  if (ra.color === rb.color) return null;
  if (ra.winner !== rb.winner || ra.reason !== rb.reason || ra.hash !== rb.hash || ra.plies !== rb.plies || ra.cls !== rb.cls) {
    return null;
  }
  const [w, wb, k, kb] = ra.color === 'w' ? [a, ra, b, rb] : [b, rb, a, ra];
  return {
    gid: a.gid,
    winner: ra.winner,
    reason: ra.reason,
    hash: ra.hash,
    plies: ra.plies,
    cls: ra.cls,
    white: side(w, wb),
    black: side(k, kb),
    at: Math.max(a.ts, b.ts),
  };
}

/** The co-signed result in a published game event's tags, if valid. */
export function resultFromTags(tags: string[][]): CosignedResult | null {
  const wires = tags.filter((t) => t[0] === RESULT_TAG && typeof t[1] === 'string').map((t) => t[1]);
  return wires.length === 2 ? checkCosigned(wires[0], wires[1]) : null;
}

export type RatingCheck =
  /** Every published game chains, and the latest matches the advertised rating. */
  | { status: 'verified'; games: number }
  /** Something doesn't add up (a gap, a changed number, a different latest rating). */
  | { status: 'unverified'; games: number; why: string }
  /** Nothing published for this class. */
  | { status: 'none' };

/** Rounding (ints in RESULT/HELLO) and float differences between devices. */
const TOLERANCE = 2;

const close = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;

/**
 * Spot-checks `npub`'s rating for `cls` from their published games (any order,
 * duplicates fine): consecutive games must chain under Glicko-2, and the newest
 * game's resulting rating must match `advertised` (what they sent in HELLO).
 */
export function checkRatingChain(
  npub: string,
  cls: string,
  results: CosignedResult[],
  advertised?: { r: number; rd: number },
): RatingCheck {
  const byGid = new Map<string, CosignedResult>();
  for (const g of results) if (g.cls === cls && (g.white.npub === npub || g.black.npub === npub)) byGid.set(g.gid, g);
  const games = [...byGid.values()].sort((a, b) => a.at - b.at);
  if (games.length === 0) return { status: 'none' };

  let after: Rating | null = null;
  for (const [i, g] of games.entries()) {
    const color = g.white.npub === npub ? 'w' : 'b';
    const me = color === 'w' ? g.white : g.black;
    const opp = color === 'w' ? g.black : g.white;
    if (!me.before) return { status: 'unverified', games: games.length, why: `game ${i + 1} wasn't rated for them` };
    if (after && (!close(after.r, me.before.r) || !close(after.rd, me.before.rd))) {
      return { status: 'unverified', games: games.length, why: `game ${i + 1} doesn't follow from game ${i}` };
    }
    // An opponent without a rating counts as a new player (as the app rates it).
    const oppRating = opp.before ?? { r: 1500, rd: 350 };
    const score = g.winner === 'draw' ? 0.5 : g.winner === color ? 1 : 0;
    after = updateRating({ ...me.before, games: 0 }, [[{ r: oppRating.r, rd: oppRating.rd }, score]]);
  }
  if (advertised && after && (!close(after.r, advertised.r) || !close(after.rd, advertised.rd))) {
    return { status: 'unverified', games: games.length, why: 'their current rating differs from their last published game' };
  }
  return { status: 'verified', games: games.length };
}
