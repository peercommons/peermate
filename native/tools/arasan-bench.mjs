#!/usr/bin/env node
// Phase 0, spike (d): benchmark Arasan on an Android device over adb.
//
//   node native/tools/arasan-bench.mjs [deviceDir]
//
// Expects the engine and network already pushed to deviceDir
// (default /data/local/tmp/arasan). Measures search speed, memory, how long
// depth-capped searches take, and how UCI_Elo changes the chosen moves.
import { spawn } from 'node:child_process';

const DIR = process.argv[2] || '/data/local/tmp/arasan';

// Middlegame test positions (FEN) with varied character.
const POSITIONS = [
  'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', // opening
  'r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N2N2/PP2BPPP/R2QKB1R w KQ - 0 8', // QGD-like
  'r2q1rk1/1b2bppp/p2ppn2/1p6/3NP3/1BN1B3/PPP2PPP/R2Q1RK1 w - - 0 11', // Sicilian
  '2r2rk1/pp1q1ppp/2n1pn2/3p4/3P4/2PBPN2/P2Q1PPP/R4RK1 w - - 0 15', // quiet
  'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', // symmetric
  '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', // simple endgame
];

class Engine {
  constructor() {
    this.proc = spawn('adb', ['shell', `cd ${DIR} && exec ./arasan`]);
    this.buf = '';
    this.waiters = [];
    this.lines = [];
    this.proc.stdout.on('data', (d) => {
      this.buf += d.toString();
      let nl;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        this.lines.push(line);
        this.waiters = this.waiters.filter((w) => !w(line));
      }
    });
  }
  send(cmd) {
    this.proc.stdin.write(cmd + '\n');
  }
  until(prefix, ms = 60000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${prefix}`)), ms);
      this.waiters.push((line) => {
        if (!line.startsWith(prefix)) return false;
        clearTimeout(t);
        resolve(line);
        return true;
      });
    });
  }
  async ready() {
    this.send('isready');
    await this.until('readyok');
  }
  async go(fen, goArgs) {
    this.send(`position fen ${fen}`);
    this.lines = [];
    const t0 = performance.now();
    this.send(`go ${goArgs}`);
    const best = await this.until('bestmove');
    const ms = Math.round(performance.now() - t0);
    const info = this.lines.filter((l) => l.startsWith('info') && l.includes(' nodes ')).at(-1) ?? '';
    const num = (key) => Number(info.match(new RegExp(`\\b${key} (\\d+)`))?.[1] ?? NaN);
    return { move: best.split(' ')[1], ms, depth: num('depth'), nodes: num('nodes'), nps: num('nps') };
  }
  quit() {
    this.send('quit');
    this.proc.stdin.end();
  }
}

const adbOut = (cmd) =>
  new Promise((resolve) => {
    const p = spawn('adb', ['shell', cmd]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out.trim()));
  });

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const engine = new Engine();
engine.send('uci');
await engine.until('uciok');
engine.send('setoption name OwnBook value false');
engine.send('setoption name Hash value 16');
engine.send('setoption name Threads value 1');
await engine.ready();

console.log(`device: ${await adbOut('getprop ro.product.model')} (Android ${await adbOut('getprop ro.build.version.release')}, ${await adbOut('getprop ro.product.cpu.abi')})\n`);

// 1. Full-strength speed at 1 s per move.
const speed = [];
for (const fen of POSITIONS) speed.push(await engine.go(fen, 'movetime 1000'));
const pid = await adbOut('pidof arasan');
const rss = await adbOut(`grep VmHWM /proc/${pid}/status`);
console.log('Full strength, movetime 1000 ms, 1 thread, 16 MB hash');
console.log(`  median nps ${median(speed.map((s) => s.nps)).toLocaleString()}, median depth ${median(speed.map((s) => s.depth))}`);
console.log(`  peak memory ${rss.replace(/\s+/g, ' ')}\n`);

// 2. Depth-capped searches (for the weakest levels).
console.log('Depth-capped search time (median over positions)');
for (const depth of [1, 2, 3, 4, 6]) {
  const runs = [];
  for (const fen of POSITIONS) runs.push(await engine.go(fen, `depth ${depth}`));
  console.log(`  depth ${depth}: ${median(runs.map((r) => r.ms))} ms`);
}

// 3. UCI_Elo: time used and how often the chosen move differs from full strength.
const reference = [];
engine.send('setoption name UCI_LimitStrength value false');
await engine.ready();
for (const fen of POSITIONS) reference.push((await engine.go(fen, 'movetime 1000')).move);

console.log('\nUCI_Elo (go movetime 1000; 3 tries per position)');
console.log('  elo   median ms   moves differing from full strength');
engine.send('setoption name UCI_LimitStrength value true');
for (const elo of [1000, 1200, 1400, 1650, 1950, 2300]) {
  engine.send(`setoption name UCI_Elo value ${elo}`);
  await engine.ready();
  const times = [];
  let differ = 0;
  let total = 0;
  for (const [i, fen] of POSITIONS.entries()) {
    for (let k = 0; k < 3; k++) {
      const r = await engine.go(fen, 'movetime 1000');
      times.push(r.ms);
      total++;
      if (r.move !== reference[i]) differ++;
    }
  }
  console.log(`  ${String(elo).padEnd(5)} ${String(median(times)).padStart(9)}   ${differ}/${total}`);
}

engine.quit();
process.exit(0);
