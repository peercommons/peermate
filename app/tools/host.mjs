// Runs app/p2p/worker.js under Node with an in-memory IPC pair, so the same
// worker code that ships in the Bare worklet can be driven from a computer.
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const startWorker = require('../p2p/worker.js')

export async function startHost({ swarm, onMessage } = {}) {
  const toWorker = new PassThrough()
  const toHost = new PassThrough()

  // The worker sees an IPC stream it reads from (toWorker) and writes to (toHost).
  const ipc = {
    on: (event, fn) => toWorker.on(event, fn),
    write: (data) => toHost.write(data)
  }

  let pending = ''
  toHost.on('data', (data) => {
    pending += data.toString()
    let nl
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl)
      pending = pending.slice(nl + 1)
      if (line) onMessage?.(JSON.parse(line))
    }
  })

  const stop = await startWorker(ipc, null, { swarm })

  return {
    send: (msg) => toWorker.write(JSON.stringify(msg) + '\n'),
    stop
  }
}
