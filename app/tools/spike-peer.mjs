#!/usr/bin/env node
// Desktop test peer.
//
//   node tools/spike-peer.mjs [room]           direct P2P over the public HyperDHT
//   node tools/spike-peer.mjs --nostr [room]   relayed over public Nostr relays
//
// Join the same room (and mode) on the phone. Type a line to chat, /ping for
// round-trip time, /quit to exit.
import readline from 'node:readline'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import { NodeWebSocket } from './ws.mjs'
import { startHost } from './host.mjs'
import { joinNostrRoom } from '../net/nostrRoom.ts'

const args = process.argv.slice(2)
const nostr = args.includes('--nostr')
const room = args.find((a) => !a.startsWith('--')) || 'lobby'
const short = (id) => id.slice(0, 8)

function print(msg) {
  switch (msg.type) {
    case 'ready':
      console.log(`peer key  ${msg.publicKey}`)
      console.log(`joining room "${room}" via ${nostr ? 'Nostr relays' : 'HyperDHT'} ...`)
      break
    case 'joined':
      console.log(`announced topic ${msg.topic.slice(0, 16)}… (waiting for peers)`)
      break
    case 'peer-joined':
      console.log(
        `+ ${short(msg.id)}` +
          (msg.host ? ` ${msg.host}:${msg.port} ${msg.initiator ? 'outgoing' : 'incoming'}` : ' (via relay)') +
          (msg.connectMs != null ? ` after ${msg.connectMs} ms` : '')
      )
      break
    case 'peer-left':
      console.log(`- ${short(msg.id)} left`)
      break
    case 'chat':
      console.log(`${short(msg.from)}> ${msg.text}`)
      break
    case 'rtt':
      console.log(`rtt ${short(msg.id)} ${msg.ms} ms`)
      break
    default:
      console.log(`[${msg.type}] ${msg.message ?? ''}`)
  }
}

let session
if (nostr) {
  useWebSocketImplementation(NodeWebSocket)
  const nostrRoom = joinNostrRoom({ room, onEvent: print })
  session = {
    chat: (text) => nostrRoom.chat(text),
    ping: () => nostrRoom.ping(),
    stop: async () => nostrRoom.close()
  }
} else {
  const host = await startHost({ onMessage: print })
  // 'ready' arrives during startHost(), before `host` exists, so join here.
  host.send({ type: 'join', room })
  session = {
    chat: (text) => host.send({ type: 'chat', text }),
    ping: () => host.send({ type: 'ping' }),
    stop: () => host.stop()
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  if (line === '/quit') {
    await session.stop()
    process.exit(0)
  } else if (line === '/ping') {
    session.ping()
  } else if (line.trim()) {
    session.chat(line)
  }
})

process.on('SIGINT', async () => {
  await session.stop()
  process.exit(0)
})
