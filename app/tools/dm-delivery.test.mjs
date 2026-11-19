// Unit test: the private-message delivery bookkeeping (src/net/relay.ts DMDelivery).
//   node --test tools/dm-delivery.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dmDelivery, DEFAULT_RELAYS, DM_CHECK_EVERY_MS } from '../src/net/relay.ts'

const [a, b, c, d] = DEFAULT_RELAYS

test('a relay that accepts but does not deliver is left out of private messages, then back once it passes', () => {
  dmDelivery.update([[a, true], [b, false], [c, null]], 1_000)
  assert.deepEqual(dmDelivery.usable([a, b, c]), [a, c]) // c unreachable: no verdict, kept
  dmDelivery.update([[b, true]], 2_000)
  assert.deepEqual(dmDelivery.usable([a, b, c]), [a, b, c])
})

test('at least 2 relays always remain for private messages', () => {
  dmDelivery.update([[a, false], [b, false], [c, true], [d, false]], 3_000)
  assert.deepEqual(dmDelivery.usable([a, b, c, d]), [a, b, c, d]) // only c would be left: use all
  assert.deepEqual(dmDelivery.usable([a, b, c, d, DEFAULT_RELAYS[4]]), [c, DEFAULT_RELAYS[4]])
})

test('due every DM_CHECK_EVERY_MS; saved state round-trips; unknown relays are dropped on load', () => {
  dmDelivery.update([[a, false]], 10_000)
  assert.equal(dmDelivery.due(10_000 + DM_CHECK_EVERY_MS - 1), false)
  assert.equal(dmDelivery.due(10_000 + DM_CHECK_EVERY_MS), true)
  dmDelivery.load({ bad: [b, 'wss://not.a.default'], at: 42 })
  assert.deepEqual(dmDelivery.snapshot(), { bad: [b], at: 42 })
  dmDelivery.load(null) // malformed: ignored
  assert.deepEqual(dmDelivery.snapshot(), { bad: [b], at: 42 })
})
