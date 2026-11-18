// Refits ARASAN_CP_SCALE (SPECS §5.1a): scores the same positions with Arasan
// and Stockfish at full strength and fits stockfish_cp ≈ k · arasan_cp.
// Stockfish's centipawns are normalized (100 cp ≈ 50% win chance from a pawn up),
// which is what the win-chance curve in analysis.ts assumes.
//
//   node core/tools/cp-scale.ts [calibration.json] [--movetime 300]
//
// Positions come from the calibration run's sampled FENs.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ARASAN_DIR = join(ROOT, 'native/build/macos-arm64');
const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: { movetime: { type: 'string', default: '300' }, max: { type: 'string', default: '300' } },
});
const fens: string[] = JSON.parse(readFileSync(positionals[0] ?? join(ROOT, 'native/build/calibration.json'), 'utf8')).fens;

function engine(cmd: string, cwd?: string, setup: string[] = []) {
  const proc = spawn(cmd, [], { cwd });
  let buf = '';
  let waiter: ((line: string) => void) | null = null;
  proc.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      waiter?.(line);
    }
  });
  const send = (c: string) => proc.stdin.write(c + '\n');
  const until = (pred: (l: string) => boolean, onLine?: (l: string) => void) =>
    new Promise<string>((resolve) => {
      waiter = (l) => {
        onLine?.(l);
        if (pred(l)) {
          waiter = null;
          resolve(l);
        }
      };
    });
  return {
    async init() {
      send('uci');
      await until((l) => l === 'uciok');
      for (const s of ['setoption name Threads value 1', 'setoption name Hash value 64', ...setup]) send(s);
      send('isready');
      await until((l) => l === 'readyok');
    },
    /** Score in cp from the side to move, or null for mate scores. */
    async score(fen: string): Promise<number | null> {
      send('ucinewgame');
      send(`position fen ${fen}`);
      let cp: number | null = null;
      send(`go movetime ${opts.movetime}`);
      await until(
        (l) => l.startsWith('bestmove'),
        (l) => {
          if (!l.startsWith('info') || l.includes('bound')) return;
          const m = l.match(/score (cp|mate) (-?\d+)/);
          if (m) cp = m[1] === 'cp' ? Number(m[2]) : null;
        },
      );
      return cp;
    },
    quit: () => send('quit'),
  };
}

const arasan = engine(join(ARASAN_DIR, 'arasanx-64-neon'), ARASAN_DIR, ['setoption name OwnBook value false']);
const sf = engine('stockfish');
await Promise.all([arasan.init(), sf.init()]);

const pairs: [number, number][] = [];
for (const fen of fens.slice(0, Number(opts.max))) {
  const [a, s] = await Promise.all([arasan.score(fen), sf.score(fen)]);
  // The judging curve matters most in roughly balanced to clearly winning positions.
  if (a != null && s != null && Math.abs(a) <= 800 && Math.abs(s) <= 600) pairs.push([a, s]);
}
arasan.quit();
sf.quit();

// Least squares through the origin, then a robust check: median of ratios.
const k = pairs.reduce((n, [a, s]) => n + a * s, 0) / pairs.reduce((n, [a]) => n + a * a, 0);
const ratios = pairs.filter(([a]) => Math.abs(a) >= 50).map(([a, s]) => s / a).sort((x, y) => x - y);
const median = ratios[Math.floor(ratios.length / 2)];
const mean = (xs: number[]) => xs.reduce((n, x) => n + x, 0) / xs.length;
const ma = mean(pairs.map((p) => p[0]));
const ms = mean(pairs.map((p) => p[1]));
const r =
  pairs.reduce((n, [a, s]) => n + (a - ma) * (s - ms), 0) /
  Math.sqrt(pairs.reduce((n, [a]) => n + (a - ma) ** 2, 0) * pairs.reduce((n, [, s]) => n + (s - ms) ** 2, 0));
console.log(`positions used: ${pairs.length} of ${Math.min(fens.length, Number(opts.max))}`);
console.log(`least-squares k: ${k.toFixed(3)}   median ratio: ${median.toFixed(3)}   correlation: ${r.toFixed(3)}`);
