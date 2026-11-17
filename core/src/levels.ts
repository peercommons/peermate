// CPU difficulty levels (SPECS.md §5.2). Engine-agnostic: the app's engine driver
// turns a LevelConfig into UCI commands and uses pickMove() on the results.

export type LevelConfig =
  | { kind: 'weakened'; depth: number; multiPv: number; randomChance: number; pickFrom: 'top' | 'bottom-half' }
  | { kind: 'elo'; elo: number; movetimeMs: number }
  | { kind: 'full'; movetimeMs: number };

export type Level = { level: number; label: string; targetElo: string; config: LevelConfig };

// Arasan's UCI_Elo floor is 1000 and it exposes no "Strength" option over UCI, so
// levels below 1000 cap the depth and sometimes play a random candidate move.
// Target Elos are provisional until game-based calibration (SPECS §12.3).
export const LEVELS: readonly Level[] = [
  { level: 1, label: 'Newcomer', targetElo: '~400', config: { kind: 'weakened', depth: 1, multiPv: 8, randomChance: 0.4, pickFrom: 'bottom-half' } },
  { level: 2, label: 'Beginner', targetElo: '~600', config: { kind: 'weakened', depth: 2, multiPv: 8, randomChance: 0.25, pickFrom: 'top' } },
  { level: 3, label: 'Novice', targetElo: '~800', config: { kind: 'weakened', depth: 3, multiPv: 5, randomChance: 0.15, pickFrom: 'top' } },
  { level: 4, label: 'Casual', targetElo: '~1000', config: { kind: 'elo', elo: 1000, movetimeMs: 1000 } },
  { level: 5, label: 'Club', targetElo: '~1200', config: { kind: 'elo', elo: 1200, movetimeMs: 1000 } },
  { level: 6, label: 'Intermediate', targetElo: '~1400', config: { kind: 'elo', elo: 1400, movetimeMs: 1000 } },
  { level: 7, label: 'Advanced', targetElo: '~1650', config: { kind: 'elo', elo: 1650, movetimeMs: 1000 } },
  { level: 8, label: 'Expert', targetElo: '~1950', config: { kind: 'elo', elo: 1950, movetimeMs: 1000 } },
  { level: 9, label: 'Master', targetElo: '~2300', config: { kind: 'elo', elo: 2300, movetimeMs: 1000 } },
  { level: 10, label: 'Grandmaster', targetElo: '2800+', config: { kind: 'full', movetimeMs: 1000 } },
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
  // Levels 1-3 search for a few ms: aim for 0.5-1.5 s total. Stronger levels already think ~1 s.
  const target = level <= 3 ? 500 + random() * 1000 : 300 + random() * 400;
  return Math.max(0, Math.round(target - elapsedMs));
}
