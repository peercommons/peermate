// CPU difficulty levels (SPECS.md §5.2). Engine-agnostic: the app's engine driver
// turns a LevelConfig into UCI commands and uses pickMove() on the results.

export type LevelConfig =
  | { kind: 'weakened'; depth: number; multiPv: number; randomChance: number; pickFrom: 'top' | 'bottom-half' }
  | { kind: 'elo'; elo: number; movetimeMs: number }
  | { kind: 'full'; movetimeMs: number };

export type Level = { level: number; label: string; blurb: string; config: LevelConfig };

// Calibrated by self-play (core/tools/calibrate.ts, SPECS §12.3): every level beats
// the one below it; typical steps are 100-350 Elo, wider at the top. Arasan's own
// UCI_Elo limiter turned out far weaker than its labels below ~2000 (1000-1650 lost
// to a depth-1 search), so every level except 10 uses depth caps plus occasional
// random picks among the engine's top candidates. Absolute human Elo isn't known
// yet, so the app describes levels in words rather than numbers.
export const LEVELS: readonly Level[] = [
  { level: 1, label: 'Newcomer', blurb: 'Just learning the moves', config: { kind: 'weakened', depth: 1, multiPv: 8, randomChance: 0.4, pickFrom: 'bottom-half' } },
  { level: 2, label: 'Beginner', blurb: 'Knows the rules, misses threats', config: { kind: 'weakened', depth: 1, multiPv: 8, randomChance: 0.3, pickFrom: 'top' } },
  { level: 3, label: 'Novice', blurb: 'Sees simple captures', config: { kind: 'weakened', depth: 2, multiPv: 6, randomChance: 0.25, pickFrom: 'top' } },
  { level: 4, label: 'Casual', blurb: 'Plays sensible moves, still blunders', config: { kind: 'weakened', depth: 3, multiPv: 5, randomChance: 0.2, pickFrom: 'top' } },
  { level: 5, label: 'Club', blurb: 'Rarely hangs pieces', config: { kind: 'weakened', depth: 3, multiPv: 4, randomChance: 0.1, pickFrom: 'top' } },
  { level: 6, label: 'Intermediate', blurb: 'Spots short tactics', config: { kind: 'weakened', depth: 4, multiPv: 4, randomChance: 0.1, pickFrom: 'top' } },
  { level: 7, label: 'Advanced', blurb: 'Solid and tactical', config: { kind: 'weakened', depth: 5, multiPv: 3, randomChance: 0.03, pickFrom: 'top' } },
  { level: 8, label: 'Expert', blurb: 'Punishes most mistakes', config: { kind: 'weakened', depth: 6, multiPv: 2, randomChance: 0.02, pickFrom: 'top' } },
  { level: 9, label: 'Master', blurb: 'Very hard to beat', config: { kind: 'weakened', depth: 8, multiPv: 1, randomChance: 0, pickFrom: 'top' } },
  { level: 10, label: 'Grandmaster', blurb: 'Full engine strength', config: { kind: 'full', movetimeMs: 1000 } },
];

export function getLevel(level: number): Level {
  const found = LEVELS.find((l) => l.level === level);
  if (!found) throw new RangeError(`unknown level ${level}`);
  return found;
}

/**
 * Chooses the move to play. `ranked` are the engine's candidate moves, best
 * first (MultiPV order); `best` is its bestmove. `random` is injectable for tests.
 */
export function pickMove(
  config: LevelConfig,
  best: string,
  ranked: string[],
  random: () => number = Math.random,
): { move: string; randomPick: boolean } {
  if (config.kind !== 'weakened' || ranked.length < 2 || random() >= config.randomChance) {
    return { move: best, randomPick: false };
  }
  const pool = config.pickFrom === 'bottom-half' ? ranked.slice(Math.floor(ranked.length / 2)) : ranked;
  return { move: pool[Math.floor(random() * pool.length)], randomPick: true };
}

/**
 * Extra pause before the CPU's move is shown, so weak levels don't reply instantly
 * (SPECS §5.2 "humanized think time"). `elapsedMs` is how long the engine took.
 */
export function humanizedDelayMs(level: number, elapsedMs: number, random: () => number = Math.random): number {
  // Depth-capped levels (1-9) answer in milliseconds: aim for 0.55-1.8 s total,
  // a little longer at higher levels. Level 10 already thinks ~1 s.
  const target = level <= 9 ? 500 + level * 50 + random() * 800 : 300 + random() * 400;
  return Math.max(0, Math.round(target - elapsedMs));
}
