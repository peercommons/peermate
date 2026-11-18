// A desktop opponent for testing online play with one phone. Joins the public
// Quick Match lobby, pairs with whoever seeks the same time control, and plays
// random legal moves (captures first) after a short think.
//
//   npm run play-peer -- [timeControl]      e.g. npm run play-peer -- 5+0
//
// Runs the same worker the phone runs (p2p/worker.js) and the same core
// protocol. Ctrl-C to quit (resigns a running game first).
import { startHost } from './host.mjs'
import {
  deriveIdentity,
  fingerprint,
  GameSession,
  lobbyRoom,
  Matchmaker,
  newSeed,
  timeControlClass
} from '../../core/src/index.ts'

const tc = process.argv[2] ?? '5+0'
const identity = deriveIdentity(newSeed())
const nick = 'Desktop bot'
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

let session = null
let match = null
let mm = null

const host = await startHost({
  onMessage: (msg) => {
    switch (msg.type) {
      case 'ready':
        if (msg.publicKey === identity.peer.publicKey) onReady()
        break
      case 'joined':
        log(`in lobby ${msg.room}`)
        break
      case 'peer-joined':
        if (match?.opponent.key === msg.id) {
          log('opponent reconnected')
          match.channel.resync()
        } else {
          log(`lobby peer ${fingerprint(msg.id)} (${msg.host ?? '?'})`)
          mm?.peerConnected(msg.id)
        }
        break
      case 'msg':
        mm?.peerData(msg.from, msg.data)
        break
      case 'peer-left':
        if (match?.opponent.key === msg.id) {
          if (session?.end) break
          log('opponent connection dropped; redialing')
          host.send({ type: 'connect', peer: msg.id })
        } else mm?.peerLeft(msg.id)
        break
      case 'error':
        log('worker error:', msg.message)
        break
    }
  }
})

host.send({ type: 'init', secret: Buffer.from(identity.peer.secretKey).toString('hex') })

function onReady() {
  log(`${nick} · ID ${fingerprint(identity.peer.publicKey)} · seeking ${tc}`)
  mm = new Matchmaker({
    identity,
    nick,
    tc,
    network: {
      send: (peer, data) => host.send({ type: 'send', peer, data }),
      drop: (peer) => host.send({ type: 'drop', peer })
    },
    onLog: (m) => log(m),
    onMatch: (m) => {
      match = m
      host.send({ type: 'unseek' })
      log(`matched with ${m.opponent.nick} (${fingerprint(m.opponent.key)}); I play ${m.game.myColor === 'w' ? 'White' : 'Black'}`)
      session = new GameSession({ channel: m.channel, game: m.game, onEvent })
      session.chat({ quick: 'gl' })
      maybeMove()
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
  host.send({ type: 'seek', rooms: [lobbyRoom(timeControlClass(tc), 'any')] })
}

function onEvent(e) {
  switch (e.type) {
    case 'move':
      log(`${e.ply}. ${e.color === 'w' ? 'White' : 'Black'} ${e.san}`)
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
    await new Promise((r) => setTimeout(r, 1500))
  }
  session?.dispose()
  await host.stop()
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
