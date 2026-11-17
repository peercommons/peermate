// Peermate P2P worker (Phase 0, spike (a)).
//
// Runs Hyperswarm/HyperDHT. On the phone it runs inside a Bare worklet
// (stowed by expo-bare-kit). On a computer, tools/spike-peer.mjs runs the
// same file under Node so a single phone can be tested against a desktop peer.
//
// Host <-> worker messages are newline-delimited JSON over the IPC stream.
//
// Host -> worker:
//   { type: 'join', room }        join the lobby topic for `room`
//   { type: 'leave' }             leave the current topic
//   { type: 'chat', text }        send text to every connected peer
//   { type: 'ping' }              measure RTT to every connected peer
//
// Worker -> host:
//   { type: 'ready', publicKey }
//   { type: 'joined', room, topic }               topic announced to the DHT
//   { type: 'peer-joined', id, host, port, initiator, connectMs }
//   { type: 'peer-left', id }
//   { type: 'chat', from, text }
//   { type: 'rtt', id, ms }
//   { type: 'log', message } / { type: 'error', message }

const Hyperswarm = require('hyperswarm')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const TOPIC_PREFIX = 'peermate/v1/spike/'

// Spec §6.2: topic = BLAKE2b-256(prefix + name). hypercore-crypto's hash() is BLAKE2b-256.
function topicFor(room) {
  return crypto.hash(b4a.from(TOPIC_PREFIX + room))
}

// Splits a byte stream into JSON messages, one per line.
function lineReader(onMessage) {
  let pending = ''
  return (data) => {
    pending += b4a.toString(data)
    let nl
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl)
      pending = pending.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue // ignore malformed input from a peer or host
      }
      onMessage(msg)
    }
  }
}

const encode = (msg) => b4a.from(JSON.stringify(msg) + '\n')

module.exports = async function start(ipc, ready, opts = {}) {
  // opts.swarm lets the Node test harness point at a local testnet (bootstrap nodes).
  const swarm = new Hyperswarm(opts.swarm)
  const peers = new Map() // id -> connection
  let discovery = null
  let joinedAt = 0

  const send = (msg) => ipc.write(encode(msg))
  const log = (message) => send({ type: 'log', message })

  swarm.on('connection', (conn, info) => {
    const id = b4a.toString(conn.remotePublicKey, 'hex')
    peers.set(id, conn)

    send({
      type: 'peer-joined',
      id,
      host: conn.rawStream?.remoteHost ?? null,
      port: conn.rawStream?.remotePort ?? null,
      initiator: Boolean(conn.isInitiator),
      connectMs: joinedAt ? Date.now() - joinedAt : null
    })

    conn.on(
      'data',
      lineReader((msg) => {
        if (msg.k === 'chat' && typeof msg.text === 'string') {
          send({ type: 'chat', from: id, text: msg.text.slice(0, 280) })
        } else if (msg.k === 'ping') {
          conn.write(encode({ k: 'pong', t: msg.t }))
        } else if (msg.k === 'pong' && typeof msg.t === 'number') {
          send({ type: 'rtt', id, ms: Date.now() - msg.t })
        }
      })
    )

    conn.on('error', (err) => log(`connection ${id.slice(0, 8)} error: ${err.message}`))
    conn.on('close', () => {
      if (peers.get(id) === conn) peers.delete(id)
      send({ type: 'peer-left', id })
    })
  })

  async function leave() {
    if (!discovery) return
    const current = discovery
    discovery = null
    await current.destroy()
  }

  async function handle(msg) {
    switch (msg.type) {
      case 'join': {
        await leave()
        const room = String(msg.room || 'lobby')
        const topic = topicFor(room)
        joinedAt = Date.now()
        discovery = swarm.join(topic, { server: true, client: true })
        await discovery.flushed() // fully announced to the DHT
        send({ type: 'joined', room, topic: b4a.toString(topic, 'hex') })
        break
      }
      case 'leave':
        await leave()
        log('left topic')
        break
      case 'chat': {
        const out = encode({ k: 'chat', text: String(msg.text).slice(0, 280) })
        for (const conn of peers.values()) conn.write(out)
        break
      }
      case 'ping': {
        const out = encode({ k: 'ping', t: Date.now() })
        for (const conn of peers.values()) conn.write(out)
        break
      }
      default:
        log(`unknown command: ${msg.type}`)
    }
  }

  ipc.on(
    'data',
    lineReader((msg) => {
      handle(msg).catch((err) => send({ type: 'error', message: err.message }))
    })
  )

  send({ type: 'ready', publicKey: b4a.toString(swarm.keyPair.publicKey, 'hex') })
  if (typeof ready === 'function') ready()

  return async function stop() {
    await swarm.destroy()
  }
}

module.exports.topicFor = topicFor
