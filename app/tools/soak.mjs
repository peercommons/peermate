// Soak test for online play (SPECS §16 Phase 2 exit: 100 games, < 2% failed).
// Plays many bot-vs-bot games over the real public networks (HyperDHT and Nostr
// relays), each pair in its own private room, cycling through conditions:
//   direct  both bots on Hyperswarm + relays
//   relay   both bots on relays only
//   freeze  like direct, but one bot is frozen (SIGSTOP) for 20-40 s mid-game,
//           as a suspended iPhone would be
// A game passes when both bots report the same result and final position, and
// the result isn't an unconfirmed (one-sided) claim.
//
//   node tools/soak.mjs [--games 100] [--concurrency 4] [--tc 15+10] [--out DIR]
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const GAMES = Number(option('--games', 100))
const CONCURRENCY = Number(option('--concurrency', 4))
const TC = option('--tc', '15+10')
const RUN = Date.now().toString(36)
const OUT = option('--out', join('soak-results', RUN))
const SCENARIOS = ['direct', 'relay', 'freeze']
const MATCH_TIMEOUT_MS = 180_000
const GAME_TIMEOUT_MS = 20 * 60_000

mkdirSync(OUT, { recursive: true })
const stamp = () => new Date().toISOString().slice(11, 19)

function startBot(index, side, scenario) {
  const argv = [
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    'tools/play-peer.mjs',
    TC,
    '--room',
    `soak-${RUN}-${index}`,
    '--think',
    '400',
    '--max-plies',
    '120'
  ]
  if (scenario === 'relay') argv.push('--relay-only')
  const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
  const bot = { side, child, log: '', result: null, matchedAt: null, exited: null }
  const onData = (d) => {
    const text = d.toString()
    bot.log += text
    for (const line of text.split('\n')) {
      if (line.startsWith('RESULT ')) bot.result = JSON.parse(line.slice(7))
      if (!bot.matchedAt && line.includes(' matched with ')) bot.matchedAt = Date.now()
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  bot.done = new Promise((resolve) => child.on('exit', (code, signal) => resolve((bot.exited = { code, signal }))))
  return bot
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function playGame(index) {
  const scenario = SCENARIOS[index % SCENARIOS.length]
  const started = Date.now()
  const a = startBot(index, 'a', scenario)
  await sleep(500)
  const b = startBot(index, 'b', scenario)
  const bots = [a, b]
  const kill = () => bots.forEach((x) => x.exited || x.child.kill('SIGKILL'))
  let failure = null
  let frozenMs = 0

  // Wait for the pairing.
  while (!(a.matchedAt && b.matchedAt)) {
    if (Date.now() - started > MATCH_TIMEOUT_MS) failure = 'no match'
    if (a.exited || b.exited) failure = 'bot exited before matching'
    if (failure) break
    await sleep(250)
  }
  const matchMs = failure ? null : Math.max(a.matchedAt, b.matchedAt) - started

  if (!failure && scenario === 'freeze') {
    await sleep(10_000 + Math.random() * 15_000)
    const victim = Math.random() < 0.5 ? a : b
    if (!victim.exited) {
      frozenMs = 20_000 + Math.round(Math.random() * 20_000)
      victim.child.kill('SIGSTOP')
      await sleep(frozenMs)
      victim.child.kill('SIGCONT')
    }
  }

  if (!failure) {
    const deadline = started + GAME_TIMEOUT_MS
    while (!(a.exited && b.exited) && Date.now() < deadline) await sleep(500)
    if (!(a.exited && b.exited)) failure = 'game timeout'
  }
  kill()
  await Promise.all(bots.map((x) => x.done))

  if (!failure) {
    const [ra, rb] = [a.result, b.result]
    if (!ra || !rb) failure = 'missing result'
    else if (ra.end.unconfirmed || rb.end.unconfirmed) failure = 'unconfirmed result'
    else if (JSON.stringify(ra.end.outcome ?? null) !== JSON.stringify(rb.end.outcome ?? null))
      failure = 'results disagree'
    else if (Boolean(ra.end.aborted) !== Boolean(rb.end.aborted)) failure = 'abort disagreement'
    else if (ra.fen !== rb.fen) failure = 'positions disagree'
  }

  const record = {
    index,
    scenario,
    ok: !failure,
    failure,
    matchMs,
    durationMs: Date.now() - started,
    frozenMs,
    ply: a.result?.ply ?? null,
    outcome: a.result?.end ?? null,
    routeSwitches: [a.result?.routeSwitches ?? null, b.result?.routeSwitches ?? null]
  }
  if (failure) {
    writeFileSync(join(OUT, `game-${index}-a.log`), a.log)
    writeFileSync(join(OUT, `game-${index}-b.log`), b.log)
  }
  return record
}

const results = []
let next = 0
async function worker() {
  while (next < GAMES) {
    const i = next++
    const r = await playGame(i)
    results.push(r)
    const reason = r.outcome?.outcome?.reason ?? (r.outcome?.aborted ? 'aborted' : '-')
    console.log(
      `${stamp()} game ${String(i).padStart(3)} ${r.scenario.padEnd(6)} ${r.ok ? 'ok  ' : 'FAIL'} ` +
        `${r.failure ?? reason} · ${r.ply ?? '?'} plies · match ${r.matchMs == null ? '-' : (r.matchMs / 1000).toFixed(1) + ' s'}` +
        ` · ${(r.durationMs / 1000).toFixed(0)} s${r.frozenMs ? ` · frozen ${(r.frozenMs / 1000).toFixed(0)} s` : ''}`
    )
    writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  }
}

console.log(`${stamp()} soak ${RUN}: ${GAMES} games, ${CONCURRENCY} at a time, ${TC}; results in ${OUT}`)
await Promise.all(Array.from({ length: CONCURRENCY }, worker))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length} games, ${failed.length} failed (${((100 * failed.length) / results.length).toFixed(1)}%)`)
for (const s of SCENARIOS) {
  const rs = results.filter((r) => r.scenario === s)
  const ms = rs.filter((r) => r.matchMs != null).map((r) => r.matchMs).sort((x, y) => x - y)
  const median = ms.length ? (ms[Math.floor(ms.length / 2)] / 1000).toFixed(1) + ' s' : '-'
  console.log(`  ${s.padEnd(6)} ${rs.length - rs.filter((r) => !r.ok).length}/${rs.length} ok · median match ${median}`)
}
for (const f of failed) console.log(`  FAIL game ${f.index} (${f.scenario}): ${f.failure}`)
process.exit(failed.length ? 1 : 0)
