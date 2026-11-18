// CPU opponent: drives the Arasan engine (native module) over UCI. Level policy
// (depth caps, UCI_Elo, random picks) lives in @peermate/core so it's testable.
import { getLevel, parseInfoScore, pickMove, type Color, type Score } from '@peermate/core';
import ArasanEngine from '../../modules/arasan-engine';

export type EngineMove = { move: string; thinkMs: number; depth: number | null; randomPick: boolean };

let started: Promise<void> | null = null;
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<(line: string) => void>();

/** False where the engine isn't in the build: CPU play and analysis are off. */
export const engineAvailable = ArasanEngine !== null;
export const ENGINE_UNAVAILABLE = "The CPU opponent isn't available in this build";

ArasanEngine?.addListener('onLine', ({ line }) => {
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

function command(cmd: string, until: string, timeoutMs?: number) {
  const done = waitFor((l) => l.startsWith(until), timeoutMs);
  ArasanEngine!.send(cmd);
  return done;
}

/** Runs `task` after any engine work already queued (one search at a time). */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

/** Starts the engine and loads the network. The first call takes ~1 s. */
export function initEngine(): Promise<void> {
  started ??= (async () => {
    if (!ArasanEngine) throw new Error(ENGINE_UNAVAILABLE);
    const networkPath = await ArasanEngine!.start();
    await command('uci', 'uciok');
    ArasanEngine!.send(`setoption name NNUE file value ${networkPath}`);
    ArasanEngine!.send('setoption name OwnBook value false'); // book not shipped (size); SPECS §5.1
    ArasanEngine!.send('setoption name Hash value 16'); // MB
    ArasanEngine!.send('setoption name Threads value 1');
    await command('isready', 'readyok');
  })().catch((err) => {
    started = null;
    throw err;
  });
  return started;
}

/** Clears the engine's hash between games, so a stronger search can't leak into a weaker one. */
export function newEngineGame(): Promise<void> {
  return enqueue(async () => {
    await initEngine();
    ArasanEngine!.send('ucinewgame');
    await command('isready', 'readyok');
  });
}

/** Best move for `fen` at difficulty `level` (1-10). Calls are serialized. */
export function bestMove(fen: string, level: number): Promise<EngineMove> {
  return enqueue(() => think(fen, level));
}

async function think(fen: string, level: number): Promise<EngineMove> {
  await initEngine();
  const { config } = getLevel(level);

  ArasanEngine!.send(`setoption name UCI_LimitStrength value ${config.kind === 'elo'}`);
  if (config.kind === 'elo') ArasanEngine!.send(`setoption name UCI_Elo value ${config.elo}`);
  ArasanEngine!.send(`setoption name MultiPV value ${config.kind === 'weakened' ? config.multiPv : 1}`);
  await command('isready', 'readyok');
  ArasanEngine!.send(`position fen ${fen}`);

  // Latest principal-variation move per MultiPV slot (slot 1 = best).
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
  const ranked = [...candidates.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
  const { move, randomPick } = pickMove(config, best.split(' ')[1], ranked);
  return { move, thinkMs: Date.now() - t0, depth, randomPick };
}

export type PositionAnalysis = { score: Score; bestMove: string | null };

/**
 * Full-strength evaluation of `fen` for post-game review. The score is from
 * White's point of view. Calls are serialized with play.
 */
export function analyse(fen: string, movetimeMs: number): Promise<PositionAnalysis> {
  return enqueue(async () => {
    await initEngine();
    ArasanEngine!.send('setoption name UCI_LimitStrength value false');
    ArasanEngine!.send('setoption name MultiPV value 1');
    await command('isready', 'readyok');
    ArasanEngine!.send(`position fen ${fen}`);

    const sideToMove = fen.split(' ')[1] as Color;
    let score: Score | null = null;
    const collector = (line: string) => {
      if (!line.startsWith('info') || line.includes('lowerbound') || line.includes('upperbound')) return;
      score = parseInfoScore(line, sideToMove) ?? score;
    };
    listeners.add(collector);
    const best = await command(`go movetime ${movetimeMs}`, 'bestmove', 30000).finally(() =>
      listeners.delete(collector),
    );
    const bestMove = best.split(' ')[1];
    return {
      score: score ?? { kind: 'cp', value: 0 },
      bestMove: bestMove && bestMove !== '(none)' && bestMove !== '0000' ? bestMove : null,
    };
  });
}
