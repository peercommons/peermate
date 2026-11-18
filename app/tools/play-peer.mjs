// A desktop opponent for testing online play with one phone. Seeks on the
// public Quick Match lobby (Hyperswarm and Nostr relays, like the app), pairs
// with whoever wants the same time control, and plays random legal moves
// (captures first) after a short think.
//
//   npm run play-peer -- [timeControl] [--relay-only]
//
// --relay-only skips Hyperswarm entirely, to test the relay fallback as if
// hole-punching had failed. Ctrl-C quits (aborts or resigns a running game).
import { useWebSocketImplementation } from 'nostr-tools/pool'
import { NodeWebSocket } from './ws.mjs'
import { startHost } from './host.mjs'
import { RelayNet } from '../src/net/relay.ts'
import {
  decode,
  deriveIdentity,
  fingerprint,
  GameSession,
  lobbyRoom,
  Matchmaker,
  newSeed,
  PeerRouter,
  timeControlClass,
  wireSender
} from '../../core/src/index.ts'

useWebSocketImplementation(NodeWebSocket)

const args = process.argv.slice(2)
const relayOnly = args.includes('--relay-only')
const tc = args.find((a) => !a.startsWith('--')) ?? '5+0'
const identity = deriveIdentity(newSeed())
const nick = relayOnly ? 'Relay bot' : 'Desktop bot'
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const rooms = [lobbyRoom(timeControlClass(tc), 'any')]

let session = null
let match = null
let mm = null
let host = null
let directSince = 0

const relay = new RelayNet({
  nostrSecret: identity.nostr.secretKey,
  peerKey: identity.peer.publicKey,
  onLog: (m) => log('relay:', m),
  onSeek: (seek) => {
    if (match || seek.tc !== tc) return
    if (!router.npubOf(seek.peer)) router.relayKnown(seek.peer, seek.npub)
    log(`relay seek from ${seek.nick} (${fingerprint(seek.peer)})`)
    host?.send({ type: 'connect', peer: seek.peer })
    mm?.peerConnected(seek.peer)
  },
  onMessage: (npub, wire) => {
    const peer = wireSender(wire)
    if (!peer || !decode(wire)) return
    router.relayKnown(peer, npub)
    if (match?.opponent.key !== peer) mm?.peerConnected(peer)
    mm?.peerData(peer, wire)
  }
})

const router = new PeerRouter({
  directSend: (peer, data) => host?.send({ type: 'send', peer, data }),
  directDrop: (peer) => host?.send({ type: 'drop', peer }),
  relaySend: (npub, wire) => relay.send(npub, wire)
})

function routeNote() {
  if (match) log(`opponent route: ${router.route(match.opponent.key) ?? 'none'}`)
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
          mm?.peerData(msg.from, msg.data)
          break
        case 'peer-left':
          router.directDown(msg.id)
          if (match?.opponent.key === msg.id) {
            if (session?.end) break
            host.send({ type: 'connect', peer: msg.id })
            match.channel.resync()
            routeNote()
          } else mm?.peerLeft(msg.id)
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
mm = new Matchmaker({
  identity,
  nick,
  tc,
  network: router,
  onLog: (m) => log(m),
  onMatch: (m) => {
    match = m
    host?.send({ type: 'unseek' })
    relay.unseek()
    if (router.route(m.opponent.key) !== 'direct') host?.send({ type: 'connect', peer: m.opponent.key })
    log(`matched with ${m.opponent.nick} (${fingerprint(m.opponent.key)}); I play ${m.game.myColor === 'w' ? 'White' : 'Black'}`)
    routeNote()
    session = new GameSession({ channel: m.channel, game: m.game, onEvent })
    session.chat({ quick: 'gl' })
    maybeMove()
    // A direct link the opponent has gone quiet on (e.g. a suspended iPhone) is
    // presumed dead: use the relays and re-dial, as the app does.
    const linkWatch = setInterval(() => {
      if (session.end) return clearInterval(linkWatch)
      const peer = m.opponent.key
      if (router.route(peer) !== 'direct') return
      if (session.silenceMs() < 12_000 || Date.now() - directSince < 12_000) return
      log(`direct link silent for ${Math.round(session.silenceMs() / 1000)} s; switching to relays`)
      router.directDown(peer)
      host?.send({ type: 'drop', peer })
      host?.send({ type: 'connect', peer })
      m.channel.resync()
      routeNote()
    }, 2000)
    // Claim a win on time once the opponent's clock runs out (as the app does).
    const flagWatch = setInterval(() => {
      if (session.end) return clearInterval(flagWatch)
      const them = session.myColor === 'w' ? 'b' : 'w'
      if (!session.myTurn && session.clocksRunning && session.clocks()[them] <= 0 && session.claimFlag()) {
        log('opponent is out of time; claiming the win')
      }
    }, 250)
  }
})
relay.seek(rooms, { tc, nick })

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
      session.chat({ quick: 'gg' })
      setTimeout(() => shutdown(0), 3000)
      break
  }
}

function maybeMove() {
  if (!session?.myTurn) return
  setTimeout(() => {
    if (!session.myTurn) return
    const moves = session.chess.moves({ verbose: true })
    const captures = moves.filter((m) => m.captured)
    const pool = captures.length && Math.random() < 0.7 ? captures : moves
    const m = pool[Math.floor(Math.random() * pool.length)]
    if (!session.move(m.from + m.to + (m.promotion ?? ''))) log('my move was refused (out of time?)')
  }, 1000 + Math.random() * 2000)
}

async function shutdown(code) {
  if (session && !session.end) {
    session.canAbort ? session.abort() : session.resign()
    await new Promise((r) => setTimeout(r, 2500))
  }
  session?.dispose()
  relay.close()
  await host?.stop()
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
