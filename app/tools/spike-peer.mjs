#!/usr/bin/env node
// Desktop test peer on the REAL public HyperDHT.
//
//   node tools/spike-peer.mjs [room]
//
// Join the same room on the phone. Type a line to chat, /ping for RTT, /quit to exit.
import readline from 'node:readline'
import { startHost } from './host.mjs'

const room = process.argv[2] || 'lobby'
const short = (id) => id.slice(0, 8)

const host = await startHost({
  onMessage(msg) {
    switch (msg.type) {
      case 'ready':
        console.log(`peer key  ${msg.publicKey}`)
        console.log(`joining room "${room}" ...`)
        break
      case 'joined':
        console.log(`announced topic ${msg.topic.slice(0, 16)}… (waiting for peers)`)
        break
      case 'peer-joined':
        console.log(
          `+ ${short(msg.id)} ${msg.host}:${msg.port} ${msg.initiator ? 'outgoing' : 'incoming'}` +
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
})
// 'ready' arrives during startHost(), before `host` exists, so join here.
host.send({ type: 'join', room })

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  if (line === '/quit') {
    await host.stop()
    process.exit(0)
  } else if (line === '/ping') {
    host.send({ type: 'ping' })
  } else if (line.trim()) {
    host.send({ type: 'chat', text: line })
  }
})

process.on('SIGINT', async () => {
  await host.stop()
  process.exit(0)
})
