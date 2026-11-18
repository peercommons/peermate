// Time controls and the receiver-side clock rules (SPECS §2.2, §7.3).
import type { Chess, Color } from '../game.ts';

export type TimeControl = { initialMs: number; incrementMs: number };

/** "3+2" = 3 minutes plus 2 seconds per move. Fractions allowed ("0.5+0"). */
export function parseTimeControl(tc: string): TimeControl {
  const m = /^(\d+(?:\.\d+)?)\+(\d+)$/.exec(tc);
  if (!m) throw new Error(`bad time control: ${tc}`);
  const initialMs = Math.round(Number(m[1]) * 60_000);
  const incrementMs = Number(m[2]) * 1000;
  if (initialMs <= 0 || initialMs > 3 * 3_600_000 || incrementMs > 180_000) throw new Error(`bad time control: ${tc}`);
  return { initialMs, incrementMs };
}

/**
 * Lobby class for a time control (SPECS §6.2), by expected game length
 * (initial + 40 moves of increment), the usual convention.
 */
export function timeControlClass(tc: string): 'bullet' | 'blitz' | 'rapid' | 'classical' {
  const { initialMs, incrementMs } = parseTimeControl(tc);
  const seconds = (initialMs + 40 * incrementMs) / 1000;
  if (seconds < 180) return 'bullet';
  if (seconds < 480) return 'blitz';
  if (seconds < 1500) return 'rapid';
  return 'classical';
}

/** Lag compensation credited back to the mover: half the RTT, at most 1 s. */
export const lagCredit = (rttMs: number | null): number => Math.min(1000, Math.round((rttMs ?? 0) / 2));

/**
 * Retransmitted moves arrive late, and the receiver can only time a turn from its
 * own end, so it must allow for delivery delays before calling a report false.
 * This allowance is also the most a dishonest client can quietly gain per move.
 */
export const DELIVERY_ALLOWANCE_MS = 2500;

/** How far a reported clock may exceed our own measurement before we overrule it. */
export const clockTolerance = (rttMs: number | null): number => Math.max(500, rttMs ?? 0) + DELIVERY_ALLOWANCE_MS;

/**
 * Whether `color` has any way to checkmate (so a flag fall is a loss for the
 * other side, not a draw). Conservative: a lone king or king + one minor can't.
 */
export function canMate(chess: Chess, color: Color): boolean {
  let minors = 0;
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p || p.color !== color || p.type === 'k') continue;
      if (p.type === 'p' || p.type === 'r' || p.type === 'q') return true;
      minors++;
    }
  }
  return minors >= 2;
}
