// Lobby room names (SPECS.md §6.2). The P2P worker hashes these with BLAKE2b-256
// to get the Hyperswarm topic.

export const TIME_CONTROL_CLASSES = ['bullet', 'blitz', 'rapid', 'classical'] as const;
export type TimeControlClass = (typeof TIME_CONTROL_CLASSES)[number];

export const BAND_WIDTH = 200;

/** 200-point rating band containing `rating`, e.g. 1450 -> "1400-1599". */
export function ratingBand(rating: number): string {
  if (!Number.isFinite(rating) || rating < 0) throw new RangeError(`invalid rating: ${rating}`);
  const low = Math.floor(rating / BAND_WIDTH) * BAND_WIDTH;
  return `${low}-${low + BAND_WIDTH - 1}`;
}

/** Room for a time-control class and band ("any" matches every rating). */
export function lobbyRoom(tc: TimeControlClass, band: string): string {
  return `lobby/${tc}/${band}`;
}

/** Rooms a seeking player joins: their own band plus the class-wide "any" room. */
export function roomsToJoin(tc: TimeControlClass, rating: number): string[] {
  return [lobbyRoom(tc, ratingBand(rating)), lobbyRoom(tc, 'any')];
}

/** Adjacent bands, looked up (not announced) after 15 s without a match. */
export function adjacentRooms(tc: TimeControlClass, rating: number): string[] {
  const low = Math.floor(rating / BAND_WIDTH) * BAND_WIDTH;
  return [low - BAND_WIDTH, low + BAND_WIDTH]
    .filter((r) => r >= 0)
    .map((r) => lobbyRoom(tc, ratingBand(r)));
}
