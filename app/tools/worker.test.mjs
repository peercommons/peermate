// Two copies of the P2P worker find each other on a LOCAL HyperDHT testnet
// (no internet), then exchange chat and ping/pong. Run: npm run test:p2p
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { startHost } from './host.mjs'

const require = createRequire(import.meta.url)
const createTestnet = require('hyperdht/testnet')

function waitFor(events, predicate, ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for event')), ms)
    events.waiters.push((msg) => {
      if (!predicate(msg)) return false
      clearTimeout(timer)
      resolve(msg)
      return true
    })
    for (const msg of events.seen) if (events.waiters.at(-1)(msg)) events.waiters.pop()
  })
}

function recorder() {
  const events = { seen: [], waiters: [] }
  events.onMessage = (msg) => {
    events.seen.push(msg)
    events.waiters = events.waiters.filter((w) => !w(msg))
  }
  return events
}

test('two workers discover each other, chat, and ping', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = { bootstrap: testnet.bootstrap }

  const a = recorder()
  const b = recorder()
  const hostA = await startHost({ swarm, onMessage: a.onMessage })
  const hostB = await startHost({ swarm, onMessage: b.onMessage })

  t.after(async () => {
    await hostA.stop()
    await hostB.stop()
    await testnet.destroy()
  })

  const readyA = await waitFor(a, (m) => m.type === 'ready')
  const readyB = await waitFor(b, (m) => m.type === 'ready')
  assert.notEqual(readyA.publicKey, readyB.publicKey)

  hostA.send({ type: 'join', room: 'test-room' })
  hostB.send({ type: 'join', room: 'test-room' })

  const joinedA = await waitFor(a, (m) => m.type === 'joined')
  const joinedB = await waitFor(b, (m) => m.type === 'joined')
  assert.equal(joinedA.topic, joinedB.topic, 'same room must map to same topic')

  const peerOfA = await waitFor(a, (m) => m.type === 'peer-joined')
  await waitFor(b, (m) => m.type === 'peer-joined')
  assert.equal(peerOfA.id, readyB.publicKey, 'A is connected to B by its public key')

  hostA.send({ type: 'chat', text: 'e4' })
  const chat = await waitFor(b, (m) => m.type === 'chat')
  assert.equal(chat.text, 'e4')
  assert.equal(chat.from, readyA.publicKey)

  hostB.send({ type: 'ping' })
  const rtt = await waitFor(b, (m) => m.type === 'rtt')
  assert.ok(rtt.ms >= 0)
})

test('different rooms map to different topics', () => {
  const { topicFor } = require('../p2p/worker.js')
  assert.notDeepEqual(topicFor('blitz'), topicFor('rapid'))
  assert.deepEqual(topicFor('blitz'), topicFor('blitz'))
})
