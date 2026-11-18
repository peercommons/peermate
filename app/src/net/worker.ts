// The app's handle on the P2P worker (Hyperswarm in a Bare worklet, p2p/worker.js).
// One worker per app run, started on first use and initialised with the
// player's key. Commands and events are newline-delimited JSON.
import b4a from 'b4a';
import p2p from 'expo-bare-kit/workers/p2p/worker';
import { toHex } from '@peermate/core';
import { loadMe } from './profile';

export type WorkerEvent =
  | { type: 'ready'; publicKey: string }
  | { type: 'joined'; room: string; topic: string }
  | { type: 'peer-joined'; id: string; host?: string | null; port?: number | null; initiator?: boolean }
  | { type: 'msg'; from: string; data: string }
  | { type: 'peer-left'; id: string }
  | { type: 'log' | 'error'; message: string };

export type WorkerCommand =
  | { type: 'seek'; rooms: string[] }
  | { type: 'unseek' }
  | { type: 'connect'; peer: string }
  | { type: 'send'; peer: string; data: string }
  | { type: 'drop'; peer: string };

export type P2PWorker = {
  readonly publicKey: string;
  send(cmd: WorkerCommand): void;
  /** Subscribes to worker events; returns an unsubscribe function. */
  on(listener: (e: WorkerEvent) => void): () => void;
};

let started: Promise<P2PWorker> | null = null;

export function getWorker(): Promise<P2PWorker> {
  started ??= start().catch((err) => {
    started = null;
    throw err;
  });
  return started;
}

async function start(): Promise<P2PWorker> {
  const me = await loadMe();
  const { ipc } = await p2p.start();
  const listeners = new Set<(e: WorkerEvent) => void>();
  const write = (msg: object) => ipc.write(b4a.from(JSON.stringify(msg) + '\n'));

  let pending = '';
  ipc.on('data', (data) => {
    pending += b4a.toString(data as Uint8Array);
    let nl;
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (!line) continue;
      let event: WorkerEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      for (const l of [...listeners]) l(event);
    }
  });

  const handle = {
    publicKey: '',
    send: write,
    on(listener: (e: WorkerEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  // Switch the worker from its throwaway key to the player's key.
  await initWith(me.identity.peer.publicKey, toHex(me.identity.peer.secretKey));
  current = { init: initWith };
  return handle;

  async function initWith(expected: string, secretHex: string) {
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('P2P worker did not start')), 20000);
      const listener = (e: WorkerEvent) => {
        if (e.type === 'ready' && e.publicKey === expected) {
          clearTimeout(timer);
          listeners.delete(listener);
          resolve();
        } else if (e.type === 'error') {
          clearTimeout(timer);
          listeners.delete(listener);
          reject(new Error(e.message));
        }
      };
      listeners.add(listener);
    });
    write({ type: 'init', secret: secretHex });
    await ready;
    handle.publicKey = expected;
  }
}

let current: { init: (publicKey: string, secretHex: string) => Promise<void> } | null = null;

/** After the identity changed (restored from a phrase): re-key a running worker. */
export async function rekeyWorker(): Promise<void> {
  if (!started || !current) return;
  await started;
  const me = await loadMe();
  await current.init(me.identity.peer.publicKey, toHex(me.identity.peer.secretKey));
}
