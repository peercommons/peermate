// Two real P2P workers on a LOCAL HyperDHT testnet (no internet) find each other
// through a lobby topic, pair with the core Matchmaker and play a short game.
// Run: npm run test:p2p
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { startHost } from './host.mjs'
import { deriveIdentity, GameSession, Matchmaker, roomsToJoin } from '../../core/src/index.ts'

const require = createRequire(import.meta.url)
const createTestnet = require('hyperdht/testnet')

/** Wires one worker to a matchmaker, as the app does. */
async function player(swarm, seedByte, nick) {
  const identity = deriveIdentity(new Uint8Array(32).fill(seedByte))
  const p = { identity, ready: null, match: null, session: null, events: [] }
  let route = () => {}
  const host = await startHost({
    swarm,
    onMessage: (msg) => {
      if (msg.type === 'ready') p.ready = msg.publicKey
      route(msg)
    }
  })
  p.host = host
  host.send({ type: 'init', secret: Buffer.from(identity.peer.secretKey).toString('hex') })

  p.matched = new Promise((resolve) => {
    const mm = new Matchmaker({
      identity,
      nick,
      tc: '3+2',
      network: {
        send: (peer, data) => host.send({ type: 'send', peer, data }),
        drop: (peer) => host.send({ type: 'drop', peer })
      },
      onMatch: (m) => {
        host.send({ type: 'unseek' })
        p.match = m
        resolve(m)
      }
    })
    route = (msg) => {
      if (msg.type === 'peer-joined') mm.peerConnected(msg.id)
      else if (msg.type === 'msg') mm.peerData(msg.from, msg.data)
      else if (msg.type === 'peer-left') mm.peerLeft(msg.id)
    }
  })
  return p
}

const until = async (cond, ms = 15000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('two workers pair through the lobby and play over Hyperswarm', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = { bootstrap: testnet.bootstrap }
  const a = await player(swarm, 31, 'Alice')
  const b = await player(swarm, 32, 'Bob')
  t.after(async () => {
    a.session?.dispose()
    b.session?.dispose()
    await a.host.stop()
    await b.host.stop()
    await testnet.destroy()
  })

  await until(() => a.ready === a.identity.peer.publicKey && b.ready === b.identity.peer.publicKey)
  const rooms = roomsToJoin('blitz', 1500)
  a.host.send({ type: 'seek', rooms })
  b.host.send({ type: 'seek', rooms })

  const [ma, mb] = await Promise.all([a.matched, b.matched])
  assert.equal(ma.opponent.key, b.identity.peer.publicKey, 'peer key = identity key (authenticated by Noise)')
  assert.equal(ma.opponent.nick, 'Bob')
  assert.equal(ma.game.start.gid, mb.game.start.gid)

  // Sessions take over the matched channels; route worker messages to them.
  for (const p of [a, b]) {
    p.session = new GameSession({ channel: p.match.channel, game: p.match.game, onEvent: (e) => p.events.push(e) })
  }
  const white = a.session.myColor === 'w' ? a.session : b.session
  const black = white === a.session ? b.session : a.session
  for (const [mover, uci] of [[white, 'e2e4'], [black, 'e7e5'], [white, 'g1f3'], [black, 'b8c6']]) {
    assert.ok(mover.move(uci), uci)
    const ply = mover.ply
    await until(() => white.ply === ply && black.ply === ply)
  }
  assert.equal(white.chess.fen(), black.chess.fen())
  assert.ok(a.session.chat({ quick: 'gg' }))
  await until(() => b.events.some((e) => e.type === 'chat' && e.quick === 'gg'))
})
