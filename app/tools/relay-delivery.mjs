// QA: which relays deliver Peermate's notes (kind 25050, ephemeral, p-tagged)
// and private messages (kind 1059, stored) from one client to another, each
// relay on its own. Two fresh identities; no phone needed.
//
//   node tools/relay-delivery.mjs [wss://relay ...]     (default: the app's DEFAULT_RELAYS)
import { useWebSocketImplementation } from 'nostr-tools/pool'
import { NodeWebSocket } from './ws.mjs'
import { DEFAULT_RELAYS, RelayNet } from '../src/net/relay.ts'
import { deriveIdentity, newSeed } from '../../core/src/index.ts'

useWebSocketImplementation(NodeWebSocket)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const quiet = { onMessage() {}, onLog() {} }
const origWarn = console.warn
const authErrors = new Map()

const urls = process.argv.slice(2).filter((a) => a.startsWith('wss://'))
for (const url of urls.length ? urls : DEFAULT_RELAYS) {
  const a = deriveIdentity(newSeed()), b = deriveIdentity(newSeed())
  let note = false, dm = false
  console.warn = (...x) => { const m = x.join(' '); if (m.includes('auth')) authErrors.set(url, m.slice(0, 90)) }
  const rb = new RelayNet({ ...quiet, nostrSecret: b.nostr.secretKey, relays: [url], onPresence: () => (note = true) })
  const sub = rb.receiveDMs(Math.floor(Date.now() / 1000), () => (dm = true))
  const ra = new RelayNet({ ...quiet, nostrSecret: a.nostr.secretKey, relays: [url] })
  await sleep(3000)
  ra.sendPresence(b.nostr.publicKey, 'online')
  const sent = await ra.sendDM(b.nostr.publicKey, 'delivery test')
  await sleep(6000)
  console.warn = origWarn
  console.log(`${url.padEnd(34)} note ${note ? 'delivered' : 'LOST     '}  message ${dm ? 'delivered' : sent.ok ? 'LOST (relay accepted it)' : 'rejected by relay'}${authErrors.has(url) ? '  [auth: ' + authErrors.get(url) + ']' : ''}`)
  sub.close(); ra.close(); rb.close()
}
process.exit(0)
