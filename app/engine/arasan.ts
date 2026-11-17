// CPU opponent: drives Arasan over UCI and implements the difficulty levels
// (SPECS.md §5.2). Phase 0 spike: moves to core/ + a proper EngineService in Phase 1.
import ArasanEngine from '../modules/arasan-engine';

type LevelConfig =
  | { kind: 'weakened'; depth: number; multiPv: number; randomChance: number; pickFrom: 'top' | 'bottom-half' }
  | { kind: 'elo'; elo: number; movetimeMs: number }
  | { kind: 'full'; movetimeMs: number };

// Arasan's UCI_Elo floor is 1000 and it has no "Strength" option over UCI, so the
// sub-1000 levels cap depth and sometimes play a random candidate move instead.
export const LEVELS: Record<number, LevelConfig> = {
  1: { kind: 'weakened', depth: 1, multiPv: 8, randomChance: 0.4, pickFrom: 'bottom-half' },
  2: { kind: 'weakened', depth: 2, multiPv: 8, randomChance: 0.25, pickFrom: 'top' },
  3: { kind: 'weakened', depth: 3, multiPv: 5, randomChance: 0.15, pickFrom: 'top' },
  4: { kind: 'elo', elo: 1000, movetimeMs: 1000 },
  5: { kind: 'elo', elo: 1200, movetimeMs: 1000 },
  6: { kind: 'elo', elo: 1400, movetimeMs: 1000 },
  7: { kind: 'elo', elo: 1650, movetimeMs: 1000 },
  8: { kind: 'elo', elo: 1950, movetimeMs: 1000 },
  9: { kind: 'elo', elo: 2300, movetimeMs: 1000 },
  10: { kind: 'full', movetimeMs: 1000 },
};

export type EngineMove = { move: string; thinkMs: number; depth: number | null; randomPick: boolean };

let started: Promise<void> | null = null;
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<(line: string) => void>();

ArasanEngine.addListener('onLine', ({ line }) => {
  for (const listener of [...listeners]) listener(line);
});

function waitFor(predicate: (line: string) => boolean, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error('engine timed out'));
    }, timeoutMs);
    const listener = (line: string) => {
      if (!predicate(line)) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(line);
    };
    listeners.add(listener);
  });
}

async function command(cmd: string, until: string, timeoutMs?: number) {
  const done = waitFor((l) => l.startsWith(until), timeoutMs);
  ArasanEngine.send(cmd);
  return done;
}

/** Starts the engine and loads the network (first call takes ~1 s for the copy + load). */
export function initEngine(): Promise<void> {
  started ??= (async () => {
    const networkPath = await ArasanEngine.start();
    await command('uci', 'uciok');
    ArasanEngine.send(`setoption name NNUE file value ${networkPath}`);
    ArasanEngine.send('setoption name OwnBook value false'); // book not shipped (size); see SPECS §5.1
    ArasanEngine.send('setoption name Hash value 16');
    ArasanEngine.send('setoption name Threads value 1');
    await command('isready', 'readyok');
  })().catch((err) => {
    started = null;
    throw err;
  });
  return started;
}

/** Best move for `fen` at difficulty `level` (1-10). Calls are serialized. */
export function bestMove(fen: string, level: number): Promise<EngineMove> {
  const run = queue.then(() => think(fen, level));
  queue = run.catch(() => undefined);
  return run;
}

async function think(fen: string, level: number): Promise<EngineMove> {
  await initEngine();
  const config = LEVELS[level];
  if (!config) throw new Error(`unknown level ${level}`);

  const limit = config.kind === 'elo';
  ArasanEngine.send(`setoption name UCI_LimitStrength value ${limit}`);
  if (config.kind === 'elo') ArasanEngine.send(`setoption name UCI_Elo value ${config.elo}`);
  ArasanEngine.send(`setoption name MultiPV value ${config.kind === 'weakened' ? config.multiPv : 1}`);
  await command('isready', 'readyok');
  ArasanEngine.send(`position fen ${fen}`);

  // Collect the latest principal variation per MultiPV slot while searching.
  const candidates = new Map<number, string>();
  let depth: number | null = null;
  const collector = (line: string) => {
    if (!line.startsWith('info') || !line.includes(' pv ')) return;
    const slot = Number(line.match(/\bmultipv (\d+)/)?.[1] ?? 1);
    const pvMove = line.match(/ pv (\S+)/)?.[1];
    const d = line.match(/\bdepth (\d+)/)?.[1];
    if (pvMove) candidates.set(slot, pvMove);
    if (d) depth = Number(d);
  };
  listeners.add(collector);

  const t0 = Date.now();
  const go = config.kind === 'weakened' ? `go depth ${config.depth}` : `go movetime ${config.movetimeMs}`;
  const best = await command(go, 'bestmove', 60000).finally(() => listeners.delete(collector));
  const thinkMs = Date.now() - t0;
  let move = best.split(' ')[1];

  let randomPick = false;
  if (config.kind === 'weakened' && candidates.size > 1 && Math.random() < config.randomChance) {
    const ranked = [...candidates.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
    const pool = config.pickFrom === 'bottom-half' ? ranked.slice(Math.floor(ranked.length / 2)) : ranked;
    move = pool[Math.floor(Math.random() * pool.length)];
    randomPick = true;
  }
  return { move, thinkMs, depth, randomPick };
}
