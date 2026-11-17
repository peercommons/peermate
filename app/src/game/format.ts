import type { Outcome } from '@peermate/core';
import { describeOutcome } from '@peermate/core';
import { outcomeOf, type GameRecord } from '../storage/games';

/** "1. e4 e5  2. Nf3 Nc6 ..." */
export function formatMoves(san: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < san.length; i += 2) {
    parts.push(`${i / 2 + 1}. ${san[i]}${san[i + 1] ? ` ${san[i + 1]}` : ''}`);
  }
  return parts.join('  ');
}

/** "Black wins by checkmate", or "Unfinished". */
export function describeRecordResult(record: GameRecord): string {
  const o: Outcome | null = outcomeOf(record);
  return o ? describeOutcome(o) : 'Unfinished';
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
