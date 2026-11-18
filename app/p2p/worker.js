// Peermate P2P worker: Hyperswarm/HyperDHT (SPECS §6.2, §6.4).
//
// Runs inside a Bare worklet on the phone (stowed by expo-bare-kit); on a
// computer, tools/host.mjs runs the same file under Node (tests, desktop peer).
// It only moves bytes: identity, matchmaking and the game protocol live in
// @peermate/core on the host side.
//
// Host <-> worker messages are newline-delimited JSON over the IPC stream.
//
// Host -> worker:
//   { type: 'init', secret }        use the player's Ed25519 key (32-byte secret, hex);
//                                   listens on it so known peers can dial us
//   { type: 'seek', rooms: [..] }   join lobby topics (announce + look up)
//   { type: 'unseek' }              leave all lobby topics
//   { type: 'connect', peer }       dial a known peer by public key (hex)
//   { type: 'send', peer, data }    send one protocol message (string) to a peer
//   { type: 'drop', peer }          close a peer connection and stop dialing it
//   Phase 0 spike commands (dev screen, tools/spike-peer.mjs):
//   { type: 'join', room } · { type: 'leave' } · { type: 'chat', text } · { type: 'ping' }
//
// Worker -> host:
//   { type: 'ready', publicKey }    (again after each init)
//   { type: 'joined', room, topic }
//   { type: 'peer-joined', id, host, port, initiator, connectMs }
//   { type: 'msg', from, data }     one protocol message from a peer
//   { type: 'peer-left', id }
//   { type: 'chat', from, text } · { type: 'rtt', id, ms }   (spike)
//   { type: 'log', message } / { type: 'error', message }

const Hyperswarm = require('hyperswarm')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const SPIKE_PREFIX = 'peermate/v1/spike/'
const ROOM_PREFIX = 'peermate/v1/'
const MAX_FRAME = 8192

// Spec §6.2: topic = BLAKE2b-256(prefix + name). hypercore-crypto's hash() is BLAKE2b-256.
function topicFor(room) {
  return crypto.hash(b4a.from(SPIKE_PREFIX + room))
}

function roomTopic(room) {
  return crypto.hash(b4a.from(ROOM_PREFIX + room))
}

// Splits a byte stream into JSON messages, one per line.
function lineReader(onMessage, maxLine = MAX_FRAME * 2) {
  let pending = ''
  return (data) => {
    pending += b4a.toString(data)
    if (pending.length > maxLine && pending.indexOf('\n') === -1) pending = '' // oversized junk
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
  const peers = new Map() // public key hex -> connection
  const lobby = new Map() // room -> discovery
  let swarm = null
  let spikeDiscovery = null
  let joinedAt = 0

  const send = (msg) => ipc.write(encode(msg))
  const log = (message) => send({ type: 'log', message })

  function onConnection(conn) {
    const id = b4a.toString(conn.remotePublicKey, 'hex')
    const previous = peers.get(id)
    peers.set(id, conn)
    if (previous && previous !== conn) previous.destroy()

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
        if (msg.k === 'msg' && typeof msg.d === 'string' && msg.d.length <= MAX_FRAME) {
          send({ type: 'msg', from: id, data: msg.d })
        } else if (msg.k === 'chat' && typeof msg.text === 'string') {
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
      if (peers.get(id) !== conn) return // replaced by a newer connection
      peers.delete(id)
      send({ type: 'peer-left', id })
    })
  }

  async function createSwarm(keyPair) {
    if (swarm) {
      const old = swarm
      swarm = null
      lobby.clear()
      spikeDiscovery = null
      peers.clear()
      await old.destroy()
    }
    swarm = new Hyperswarm({ ...opts.swarm, ...(keyPair ? { keyPair } : {}), maxPeers: 24 })
    swarm.on('connection', onConnection)
    if (keyPair) await swarm.listen() // reachable by key (friends, reconnects)
    send({ type: 'ready', publicKey: b4a.toString(swarm.keyPair.publicKey, 'hex') })
  }

  async function leaveSpike() {
    if (!spikeDiscovery) return
    const current = spikeDiscovery
    spikeDiscovery = null
    await current.destroy()
  }

  async function handle(msg) {
    switch (msg.type) {
      case 'init': {
        if (typeof msg.secret !== 'string' || !/^[0-9a-f]{64}$/.test(msg.secret)) throw new Error('bad secret')
        await createSwarm(crypto.keyPair(b4a.from(msg.secret, 'hex')))
        break
      }
      case 'seek': {
        joinedAt = Date.now()
        const rooms = Array.isArray(msg.rooms) ? msg.rooms.map(String).slice(0, 8) : []
        for (const room of rooms) {
          if (lobby.has(room)) continue
          const topic = roomTopic(room)
          const discovery = swarm.join(topic, { server: true, client: true })
          lobby.set(room, discovery)
          discovery.flushed().then(() => send({ type: 'joined', room, topic: b4a.toString(topic, 'hex') }))
        }
        break
      }
      case 'unseek': {
        const all = [...lobby.values()]
        lobby.clear()
        await Promise.all(all.map((d) => d.destroy()))
        break
      }
      case 'connect':
        swarm.joinPeer(b4a.from(String(msg.peer), 'hex'))
        break
      case 'send': {
        const conn = peers.get(msg.peer)
        if (conn && typeof msg.data === 'string') conn.write(encode({ k: 'msg', d: msg.data }))
        break
      }
      case 'drop': {
        const key = b4a.from(String(msg.peer), 'hex')
        swarm.leavePeer(key)
        peers.get(msg.peer)?.destroy()
        break
      }

      // Phase 0 spike commands.
      case 'join': {
        await leaveSpike()
        const room = String(msg.room || 'lobby')
        const topic = topicFor(room)
        joinedAt = Date.now()
        spikeDiscovery = swarm.join(topic, { server: true, client: true })
        await spikeDiscovery.flushed() // fully announced to the DHT
        send({ type: 'joined', room, topic: b4a.toString(topic, 'hex') })
        break
      }
      case 'leave':
        await leaveSpike()
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

  // Commands run one at a time, in order (init must finish before a seek).
  let queue = Promise.resolve()
  ipc.on(
    'data',
    lineReader((msg) => {
      queue = queue
        .then(() => handle(msg))
        .catch((err) => send({ type: 'error', message: err.message }))
    }, Infinity)
  )

  // Start with a throwaway key; 'init' switches to the player's key.
  await createSwarm(null)
  if (typeof ready === 'function') ready()

  return async function stop() {
    if (swarm) await swarm.destroy()
  }
}

module.exports.topicFor = topicFor
module.exports.roomTopic = roomTopic
