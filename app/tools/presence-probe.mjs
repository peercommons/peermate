// QA for presence and chat traffic (SPECS §6.5): a desktop "friend" that logs
// every presence note and private message a phone sends it, with the gap since
// the previous one, so the cadence can be checked against the rules in
// src/net/online.ts.
//
//   node tools/presence-probe.mjs [--mode silent|online] [--minutes N] [--say TEXT]
//
// --mode silent: never announces itself, so the phone should see it offline and
//   write to it only on start, on a status change, and every ~5 min.
// --mode online: behaves like a friend with the app open (announce on start,
//   answer once when the phone appears, keep-alive every 45 s). The phone should
//   show it online and keep-alive every 45 s, without answering each note.
// --say TEXT: sends the phone one private message at start (chat delivery).
//
// The identity is fixed, so the phone only needs to add it once (QR code in
// /tmp/peermate-qa-friend.png, or the printed link).
import { writeFileSync } from 'node:fs'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import QRCode from 'qrcode'
import { NodeWebSocket } from './ws.mjs'
import { RelayNet } from '../src/net/relay.ts'
import { deriveIdentity, fingerprint } from '../../core/src/index.ts'

useWebSocketImplementation(NodeWebSocket)

const args = process.argv.slice(2)
const option = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
const mode = option('--mode') ?? 'silent'
const minutes = Number(option('--minutes') ?? 12)
const say = option('--say')

const NICK = 'QA friend'
const id = deriveIdentity(new Uint8Array(32).fill(0x5a)) // fixed: added once on the phone
const link = `peermate://p/${id.peer.publicKey}?n=${id.nostr.publicKey}&nick=${encodeURIComponent(NICK)}`
await QRCode.toFile('/tmp/peermate-qa-friend.png', link, { width: 480, margin: 2 })

const t0 = Date.now()
const stamp = () => {
  const s = Math.round((Date.now() - t0) / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
const log = (...a) => console.log(stamp(), ...a)

log(`${NICK} · ID ${fingerprint(id.peer.publicKey)} · mode ${mode} · ${minutes} min`)
log(`add on the phone: QR /tmp/peermate-qa-friend.png, or ${link}`)

let phone = null // the npub that writes to us (the phone under test)
let last = null
let heardAt = 0
const counts = { presence: 0, dm: 0, other: 0 }

const relay = new RelayNet({
  nostrSecret: id.nostr.secretKey,
  onMessage: () => counts.other++,
  onPresence: (npub, status) => {
    const now = Date.now()
    counts.presence++
    const gap = last ? `${Math.round((now - last) / 1000)} s after the previous` : 'first'
    last = now
    const appeared = now - heardAt > 150_000
    heardAt = now
    phone ??= npub
    log(`presence ${status.padEnd(7)} from ${npub.slice(0, 8)} (${gap})`)
    if (mode === 'online' && appeared && status !== 'away') {
      relay.sendPresence(npub, 'online')
      log('  answered (it just appeared)')
    }
  },
})
relay.receiveDMs(Math.floor(Date.now() / 1000), (dm) => {
  counts.dm++
  phone ??= dm.from
  log(`message from ${dm.from.slice(0, 8)}: ${JSON.stringify(dm.text)}`)
})

if (mode === 'online') {
  // Keep-alive like the app, once we know who the phone is.
  setInterval(() => {
    if (phone && Date.now() - heardAt < 300_000) relay.sendPresence(phone, 'online')
  }, 45_000)
}
if (say) {
  const target = option('--to')
  if (!target) log('--say needs --to <phone npub> (printed when the phone first writes to us)')
  else {
    const r = await relay.sendDM(target, say)
    log(`message to ${target.slice(0, 8)}: ${r.ok ? 'sent' : 'FAILED'}`)
  }
}

setTimeout(() => {
  log(`done: ${counts.presence} presence note(s), ${counts.dm} message(s) received`)
  process.exit(0)
}, minutes * 60_000)
