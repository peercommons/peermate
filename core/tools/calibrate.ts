// Level calibration (SPECS §12.3). Plays Peermate's CPU levels against each
// other and against Stockfish at fixed UCI_Elo anchors, then fits a rating for
// every level by maximum likelihood with the anchors held fixed.
//
//   node core/tools/calibrate.ts [--games 20] [--concurrency 4] [--out file.json]
//
// Needs the desktop Arasan build (native/build/macos-arm64, see README) and a
// `stockfish` binary on PATH. Stockfish is a local measuring stick only; it is
// never shipped. Levels are driven exactly as app/src/engine/arasan.ts does,
// with movetime scaled by PHONE_SPEED so a desktop search matches the phone's.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Chess } from 'chess.js';
import { getLevel, pickMove, type LevelConfig } from '../src/levels.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ARASAN_DIR = join(ROOT, 'native/build/macos-arm64');

const { values: opts } = parseArgs({
  options: {
    games: { type: 'string', default: '20' },
    concurrency: { type: 'string', default: '4' },
    out: { type: 'string', default: join(ROOT, 'native/build/calibration.json') },
    'phone-speed': { type: 'string', default: '0.41' }, // Galaxy A56 nps / this machine's nps
    only: { type: 'string' }, // e.g. "L4-SF1320" to run a single pairing
    // Candidate table: JSON array of LevelConfig, index 0 = level 1. Default: core LEVELS.
    levels: { type: 'string' },
    // "standard" (neighbours + Stockfish anchors) or "neighbours" (adjacent levels only).
    pairings: { type: 'string', default: 'standard' },
  },
});
const GAMES = Number(opts.games);
const PHONE_SPEED = Number(opts['phone-speed']);
const CANDIDATES: LevelConfig[] | null = opts.levels ? JSON.parse(readFileSync(opts.levels, 'utf8')) : null;
const configFor = (level: number): LevelConfig => CANDIDATES?.[level - 1] ?? getLevel(level).config;

// Balanced, varied openings (2-4 moves); each is played once with each colour.
const OPENINGS = [
  'e2e4 e7e5 g1f3 b8c6',
  'e2e4 c7c5 g1f3 d7d6',
  'd2d4 d7d5 c2c4 e7e6',
  'd2d4 g8f6 c2c4 g7g6',
  'e2e4 e7e6 d2d4 d7d5',
  'c2c4 e7e5 b1c3 g8f6',
  'e2e4 c7c6 d2d4 d7d5',
  'g1f3 d7d5 g2g3 g8f6',
  'd2d4 g8f6 c2c4 e7e6',
  'e2e4 d7d6 d2d4 g8f6',
  'e2e4 e7e5 f1c4 g8f6',
  'd2d4 d7d5 c1f4 g8f6',
];

class Uci {
  private proc: ChildProcessWithoutNullStreams;
  private buf = '';
  private listeners = new Set<(line: string) => void>();

  constructor(cmd: string, cwd?: string) {
    this.proc = spawn(cmd, [], { cwd });
    this.proc.stdout.on('data', (d: Buffer) => {
      this.buf += d.toString();
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        for (const l of [...this.listeners]) l(line);
      }
    });
  }
  send(cmd: string) {
    this.proc.stdin.write(cmd + '\n');
  }
  on(l: (line: string) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  until(prefix: string, ms = 120000): Promise<string> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        off();
        reject(new Error(`timeout waiting for ${prefix}`));
      }, ms);
      const off = this.on((line) => {
        if (!line.startsWith(prefix)) return;
        clearTimeout(t);
        off();
        resolve(line);
      });
    });
  }
  async cmd(c: string, until: string) {
    const p = this.until(until);
    this.send(c);
    return p;
  }
  quit() {
    this.send('quit');
    setTimeout(() => this.proc.kill(), 500);
  }
}

interface Player {
  name: string;
  init(): Promise<void>;
  newGame(): Promise<void>;
  move(fen: string): Promise<string>;
  quit(): void;
}

/** A Peermate CPU level, driven like the app's engine/arasan.ts. */
function peermate(level: number): Player {
  const e = new Uci(join(ARASAN_DIR, 'arasanx-64-neon'), ARASAN_DIR);
  const config = configFor(level);
  return {
    name: `L${level}`,
    async init() {
      await e.cmd('uci', 'uciok');
      e.send('setoption name OwnBook value false');
      e.send('setoption name Hash value 16');
      e.send('setoption name Threads value 1');
      e.send(`setoption name UCI_LimitStrength value ${config.kind === 'elo'}`);
      if (config.kind === 'elo') e.send(`setoption name UCI_Elo value ${config.elo}`);
      e.send(`setoption name MultiPV value ${config.kind === 'weakened' ? config.multiPv : 1}`);
      await e.cmd('isready', 'readyok');
    },
    async newGame() {
      e.send('ucinewgame');
      await e.cmd('isready', 'readyok');
    },
    async move(fen) {
      e.send(`position fen ${fen}`);
      const candidates = new Map<number, string>();
      const off = e.on((line) => {
        if (!line.startsWith('info') || !line.includes(' pv ')) return;
        const slot = Number(line.match(/\bmultipv (\d+)/)?.[1] ?? 1);
        const pv = line.match(/ pv (\S+)/)?.[1];
        if (pv) candidates.set(slot, pv);
      });
      const go =
        config.kind === 'weakened'
          ? `go depth ${config.depth}`
          : `go movetime ${Math.round(config.movetimeMs * PHONE_SPEED)}`;
      const best = await e.cmd(go, 'bestmove').finally(off);
      const ranked = [...candidates.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
      return pickMove(config, best.split(' ')[1], ranked).move;
    },
    quit: () => e.quit(),
  };
}

/** Stockfish limited to a UCI_Elo anchor (1320-3190). */
function stockfish(elo: number): Player {
  const e = new Uci('stockfish');
  return {
    name: `SF${elo}`,
    async init() {
      await e.cmd('uci', 'uciok');
      e.send('setoption name Threads value 1');
      e.send('setoption name Hash value 16');
      e.send('setoption name UCI_LimitStrength value true');
      e.send(`setoption name UCI_Elo value ${elo}`);
      await e.cmd('isready', 'readyok');
    },
    async newGame() {
      e.send('ucinewgame');
      await e.cmd('isready', 'readyok');
    },
    async move(fen) {
      e.send(`position fen ${fen}`);
      return (await e.cmd('go movetime 300', 'bestmove')).split(' ')[1];
    },
    quit: () => e.quit(),
  };
}

const make = (name: string): Player =>
  name.startsWith('SF') ? stockfish(Number(name.slice(2))) : peermate(Number(name.slice(1)));

/** Plays one game; returns White's score (1, 0.5, 0) and the positions seen. */
async function playGame(white: Player, black: Player, opening: string) {
  const chess = new Chess();
  for (const m of opening.split(' ')) chess.move({ from: m.slice(0, 2), to: m.slice(2, 4) });
  await white.newGame();
  await black.newGame();
  const fens: string[] = [];
  while (!chess.isGameOver() && chess.history().length < 300) {
    const fen = chess.fen();
    fens.push(fen);
    const mover = chess.turn() === 'w' ? white : black;
    const uci = await mover.move(fen).catch((err: Error) => {
      throw new Error(`${mover.name}: ${err.message} in ${fen} after ${chess.history().join(' ')}`);
    });
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      throw new Error(`${mover.name} played illegal ${uci} in ${fen}`);
    }
  }
  let score = 0.5;
  if (chess.isCheckmate()) score = chess.turn() === 'w' ? 0 : 1;
  return { score, plies: chess.history().length, fens };
}

type Result = { white: string; black: string; score: number; plies: number };

async function runPairing(a: string, b: string, games: number): Promise<{ results: Result[]; fens: string[] }> {
  const pa = make(a);
  const pb = make(b);
  await Promise.all([pa.init(), pb.init()]);
  const results: Result[] = [];
  const fens: string[] = [];
  try {
    for (let i = 0; i < games; i++) {
      const opening = OPENINGS[Math.floor(i / 2) % OPENINGS.length];
      const [w, bl] = i % 2 === 0 ? [pa, pb] : [pb, pa];
      const g = await playGame(w, bl, opening);
      results.push({ white: w.name, black: bl.name, score: g.score, plies: g.plies });
      // Sample a few middlegame positions per game for the score-scale fit.
      fens.push(...g.fens.filter((_, k) => k >= 10 && k % 12 === 0).slice(0, 4));
    }
  } finally {
    pa.quit();
    pb.quit();
  }
  return { results, fens };
}

/** Maximum-likelihood ratings (Bradley-Terry on the Elo scale) with anchors fixed. */
function fitRatings(results: Result[], anchors: Record<string, number>) {
  const names = [...new Set(results.flatMap((r) => [r.white, r.black]))];
  const rating: Record<string, number> = {};
  for (const n of names) rating[n] = anchors[n] ?? 1200;
  const expected = (ra: number, rb: number) => 1 / (1 + 10 ** ((rb - ra) / 400));
  // Weak prior (one draw vs a 1200 phantom) keeps 100%/0% scores finite.
  for (let iter = 0; iter < 5000; iter++) {
    let moved = 0;
    for (const n of names) {
      if (n in anchors) continue;
      let grad = 0.5 - expected(rating[n], 1200);
      let hess = 0.25;
      for (const r of results) {
        if (r.white !== n && r.black !== n) continue;
        const opp = r.white === n ? r.black : r.white;
        const s = r.white === n ? r.score : 1 - r.score;
        const e = expected(rating[n], rating[opp]);
        grad += s - e;
        hess += e * (1 - e);
      }
      const step = Math.max(-200, Math.min(200, (400 / Math.LN10) * (grad / hess)));
      rating[n] += step;
      moved = Math.max(moved, Math.abs(step));
    }
    if (moved < 0.01) break;
  }
  return rating;
}

// Neighbouring levels, plus each level against the Stockfish anchor nearest its target.
const PAIRINGS: [string, string][] = [
  ['L1', 'L2'], ['L2', 'L3'], ['L3', 'L4'], ['L4', 'L5'], ['L5', 'L6'],
  ['L6', 'L7'], ['L7', 'L8'], ['L8', 'L9'], ['L9', 'L10'],
  ['L3', 'SF1320'], ['L4', 'SF1320'], ['L5', 'SF1320'], ['L6', 'SF1500'],
  ['L7', 'SF1700'], ['L8', 'SF2000'], ['L9', 'SF2300'], ['L10', 'SF2700'], ['L10', 'SF3190'],
];

async function main() {
  const base =
    opts.pairings === 'neighbours'
      ? PAIRINGS.filter(([a, b]) => !a.startsWith('SF') && !b.startsWith('SF'))
      : PAIRINGS;
  const pairings = opts.only ? base.filter(([a, b]) => `${a}-${b}` === opts.only) : base;
  const all: Result[] = [];
  const fens: string[] = [];
  const queue = [...pairings];
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: Number(opts.concurrency) }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const { results, fens: f } = await runPairing(p[0], p[1], GAMES);
        all.push(...results);
        fens.push(...f);
        const score = results.reduce((s, r) => s + (r.white === p[0] ? r.score : 1 - r.score), 0);
        console.log(`${p[0]} vs ${p[1]}: ${score}/${results.length}  (${Math.round((Date.now() - t0) / 1000)} s)`);
      }
    }),
  );

  const anchors: Record<string, number> = {};
  for (const r of all) for (const n of [r.white, r.black]) if (n.startsWith('SF')) anchors[n] = Number(n.slice(2));
  const ratings = fitRatings(all, anchors);
  console.log('\nFitted ratings (Stockfish UCI_Elo scale):');
  for (let l = 1; l <= 10; l++) if (ratings[`L${l}`] != null) console.log(`  L${l}: ${Math.round(ratings[`L${l}`])}`);
  writeFileSync(opts.out!, JSON.stringify({ phoneSpeed: PHONE_SPEED, results: all, ratings, fens }, null, 1));
  console.log(`\nWrote ${opts.out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
