// A desktop opponent for testing online play with one phone. Seeks on the
// public Quick Match lobby (Hyperswarm and Nostr relays, like the app), pairs
// with whoever wants the same time control, and plays random legal moves
// (captures first) after a short think.
//
//   npm run play-peer -- [timeControl] [--relay-only] [--room NAME] [--think MS] [--max-plies N] [--nick NAME]
//
// --relay-only skips Hyperswarm entirely, to test the relay fallback as if
// hole-punching had failed. --room seeks in a private room instead of the public
// lobby (the soak test runs each game in its own). --think sets the average think
// time; --max-plies offers a draw (which the opponent bot accepts) after that
// many plies. --seed HEX (32 bytes) keeps the same identity across runs. When the game ends it prints one `RESULT {json}` line and exits.
// --rematch N stays for up to N rematches with the same opponent: it accepts theirs,
// or with --ask-rematch asks for one itself (the app shows "wants a rematch").
// Ctrl-C quits (aborts or resigns a running game).
import { useWebSocketImplementation } from 'nostr-tools/pool'
import { NodeWebSocket } from './ws.mjs'
import { startHost } from './host.mjs'
import { RelayNet } from '../src/net/relay.ts'
import {
  decode,
  deriveIdentity,
  fingerprint,
  GameSession,
  HELLO_TIMEOUT_MS,
  lobbyRoom,
  Matchmaker,
  newSeed,
  PeerRouter,
  relayBindingOk,
  timeControlClass,
  wireSender
} from '../../core/src/index.ts'

useWebSocketImplementation(NodeWebSocket)

const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const relayOnly = args.includes('--relay-only')
const room = option('--room')
const thinkMs = Number(option('--think') ?? 2000)
const maxPlies = Number(option('--max-plies') ?? Infinity)
const seedHex = option('--seed') // 64 hex chars: a fixed identity across runs (e.g. to test blocking)
const rematchOpt = option('--rematch')
let rematches = Number(rematchOpt ?? 0)
const askRematch = args.includes('--ask-rematch')
const valued = new Set(['--room', '--think', '--max-plies', '--seed', '--nick', '--rematch'].flatMap((n) => [option(n)]))
const tc = args.find((a) => !a.startsWith('--') && !valued.has(a)) ?? '5+0'
const identity = deriveIdentity(seedHex ? Buffer.from(seedHex, 'hex') : newSeed())
const nick = option('--nick') ?? (relayOnly ? 'Relay bot' : 'Desktop bot')
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const rooms = [room ?? lobbyRoom(timeControlClass(tc), 'any')]

let session = null
let match = null
let mm = null
let host = null
let directSince = 0
let leftGid = null // the game we last left: its late messages are dropped (online.ts deliver)
const fromLeftGame = (wire) => leftGid !== null && wire.includes(`"gid":"${leftGid}"`)

// A relay peer is told to the matchmaker once per HELLO_TIMEOUT_MS, like the app
// (online.ts relayPeerSeen): peerConnected() on a known peer resyncs, and doing it
// on every relay message set off a resync storm (each handshake message 5-7 times).
const relayPeers = new Map()
function relayPeerSeen(peer) {
  const told = relayPeers.get(peer)
  if (!mm || (told !== undefined && Date.now() - told < HELLO_TIMEOUT_MS)) return
  relayPeers.set(peer, Date.now())
  mm.peerConnected(peer)
}

const relay = new RelayNet({
  nostrSecret: identity.nostr.secretKey,
  peerKey: identity.peer.publicKey,
  onLog: (m) => log('relay:', m),
  onSeek: (seek) => {
    if (match || seek.tc !== tc) return
    if (!router.npubOf(seek.peer)) router.relayKnown(seek.peer, seek.npub)
    log(`relay seek from ${seek.nick} (${fingerprint(seek.peer)})`)
    host?.send({ type: 'connect', peer: seek.peer })
    relayPeerSeen(seek.peer)
  },
  onMessage: (npub, wire) => {
    const peer = wireSender(wire)
    const env = peer && decode(wire)
    if (!env) return
    if (relayBindingOk(router.npubOf(peer), npub, env, match?.opponent.key === peer)) router.relayKnown(peer, npub)
    if (fromLeftGame(wire)) return
    if (match?.opponent.key !== peer) relayPeerSeen(peer)
    mm?.peerData(peer, wire)
  }
})

const router = new PeerRouter({
  directSend: (peer, data) => host?.send({ type: 'send', peer, data }),
  directDrop: (peer) => host?.send({ type: 'drop', peer }),
  relaySend: (npub, wire) => relay.send(npub, wire)
})

let routeSwitches = 0
function routeNote() {
  if (!match) return
  routeSwitches++
  log(`opponent route: ${router.route(match.opponent.key) ?? 'none'}`)
}

if (!relayOnly) {
  host = await startHost({
    onMessage: (msg) => {
      switch (msg.type) {
        case 'ready':
          if (msg.publicKey === identity.peer.publicKey) host.send({ type: 'seek', rooms })
          break
        case 'joined':
          log(`in Hyperswarm lobby ${msg.room}`)
          break
        case 'peer-joined':
          router.directUp(msg.id)
          if (match?.opponent.key === msg.id) {
            directSince = Date.now()
            match.channel.resync()
            routeNote()
          } else {
            log(`direct lobby peer ${fingerprint(msg.id)} (${msg.host ?? '?'})`)
            mm?.peerConnected(msg.id)
          }
          break
        case 'msg':
          if (!fromLeftGame(msg.data)) mm?.peerData(msg.from, msg.data)
          break
        case 'peer-left':
          router.directDown(msg.id)
          if (match?.opponent.key === msg.id) {
            if (session?.end) break
            host.send({ type: 'connect', peer: msg.id })
            match.channel.resync()
            routeNote()
          } else if (router.route(msg.id) == null) mm?.peerLeft(msg.id) // still reachable by relay: keep the handshake
          break
        case 'error':
          log('worker error:', msg.message)
          break
      }
    }
  })
  host.send({ type: 'init', secret: Buffer.from(identity.peer.secretKey).toString('hex') })
}

log(`${nick} · ID ${fingerprint(identity.peer.publicKey)} · seeking ${tc}${relayOnly ? ' (relays only)' : ''}`)
// Paste into the app's Friends screen to add this bot; it accepts a challenge at its time control.
log(`friend link: peermate://p/${identity.peer.publicKey}?n=${identity.nostr.publicKey}&nick=${encodeURIComponent(nick)}`)
const onMatch = (m) => {
    match = m
    host?.send({ type: 'unseek' })
    relay.unseek()
    if (router.route(m.opponent.key) !== 'direct') host?.send({ type: 'connect', peer: m.opponent.key })
    log(`matched with ${m.opponent.nick} (${fingerprint(m.opponent.key)}); I play ${m.game.myColor === 'w' ? 'White' : 'Black'}`)
    routeNote()
    session = new GameSession({ channel: m.channel, game: m.game, onEvent })
    const s = session // this game's (a rematch replaces the global)
    drawOffered = false
    session.chat({ quick: 'gl' })
    maybeMove()
    // A direct link the opponent has gone quiet on (e.g. a suspended iPhone) is
    // presumed dead: use the relays and re-dial, as the app does.
    const linkWatch = setInterval(() => {
      if (s.end) return clearInterval(linkWatch)
      const peer = m.opponent.key
      if (router.route(peer) !== 'direct') return
      if (s.silenceMs() < 12_000 || Date.now() - directSince < 12_000) return
      log(`direct link silent for ${Math.round(s.silenceMs() / 1000)} s; switching to relays`)
      router.directDown(peer)
      host?.send({ type: 'drop', peer })
      host?.send({ type: 'connect', peer })
      m.channel.resync()
      routeNote()
    }, 2000)
    // Claim a win on time once the opponent's clock runs out (as the app does).
    const flagWatch = setInterval(() => {
      if (s.end) return clearInterval(flagWatch)
      const them = s.myColor === 'w' ? 'b' : 'w'
      if (!s.myTurn && s.clocksRunning && s.clocks()[them] <= 0 && s.claimFlag()) {
        log('opponent is out of time; claiming the win')
      }
    }, 250)
}
mm = new Matchmaker({ identity, nick, tc, network: router, onLog: (m) => log(m), onMatch })
relay.seek(rooms, { tc, nick })

/** After a game: pair with the same opponent again (theirs or our rematch challenge). */
async function rematch() {
  const until = Date.now() + 30_000
  while (match.channel.unacked > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 250))
  const opp = match.opponent
  leftGid = match.game.start.gid
  session.dispose()
  match.channel.close()
  match = session = null
  log(askRematch ? `asking ${opp.nick} for a rematch` : `waiting for ${opp.nick} to ask for a rematch`)
  if (opp.npub) router.relayKnown(opp.key, opp.npub)
  mm = new Matchmaker({
    identity,
    nick,
    tc,
    network: router,
    only: opp.key,
    invite: askRematch,
    helloTimeoutMs: 10 * 60_000,
    onLog: (m) => log(m),
    onMatch,
    onDeclined: (reason) => {
      log(`rematch declined (${reason})`)
      shutdown(0)
    }
  })
  host?.send({ type: 'connect', peer: opp.key })
  mm.peerConnected(opp.key)
}

function onEvent(e) {
  switch (e.type) {
    case 'move':
      log(`${e.ply}. ${e.color === 'w' ? 'White' : 'Black'} ${e.san}  [${router.route(match.opponent.key)}]`)
      maybeMove()
      break
    case 'chat':
      if (e.from === 'opponent') log(`chat: ${e.text ?? e.quick}`)
      break
    case 'drawOffered':
      log('draw offered; accepting')
      session.respondDraw(true)
      break
    case 'ended':
      log('game over:', JSON.stringify(e.end))
      console.log(
        'RESULT ' +
          JSON.stringify({ end: e.end, ply: session.ply, fen: session.chess.fen(), color: session.myColor, routeSwitches })
      )
      session.chat({ quick: 'gg' })
      if (rematches-- > 0) {
        setTimeout(() => void rematch(), 500)
        break
      }
      // shutdown() waits for the acknowledgements, so the next seek can start soon.
      setTimeout(() => shutdown(0), 500)
      break
  }
}

let drawOffered = false
function maybeMove() {
  if (!session?.myTurn) return
  setTimeout(() => {
    if (!session?.myTurn) return
    const moves = session.chess.moves({ verbose: true })
    const captures = moves.filter((m) => m.captured)
    const pool = captures.length && Math.random() < 0.7 ? captures : moves
    const m = pool[Math.floor(Math.random() * pool.length)]
    if (!session.move(m.from + m.to + (m.promotion ?? ''))) log('my move was refused (out of time?)')
    else if (session.ply >= maxPlies && !drawOffered && session.offerDraw()) drawOffered = true
  }, thinkMs * (0.5 + Math.random()))
}

async function shutdown(code) {
  if (session && !session.end) {
    session.canAbort ? session.abort() : session.resign()
    await new Promise((r) => setTimeout(r, 2500))
  }
  // Don't leave before the last messages (final move, draw acceptance, resignation)
  // are acknowledged, or the opponent's game never ends (as the app does).
  const until = Date.now() + 30_000
  while (match && match.channel.unacked > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 250))
  if (match?.channel.unacked) log(`leaving with ${match.channel.unacked} unacknowledged message(s)`)
  session?.dispose()
  relay.close()
  await host?.stop()
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
