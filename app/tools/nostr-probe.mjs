#!/usr/bin/env node
// Phase 0, spike (c): which public Nostr relays work for Peermate's fallback path?
//
//   node tools/nostr-probe.mjs [rounds] [relay ...]
//
// Per relay: read NIP-11 limits, then publish EPHEMERAL events (kinds 20000-29999,
// which relays forward but don't store) on one connection and time their arrival
// on a second connection. Finally checks whether a fresh query still returns them:
// strfry relays keep ephemeral events briefly (default 5 min) instead of dropping
// them at once, so clients must dedupe replays. Uses throwaway keys.
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';
import { NodeWebSocket } from './ws.mjs';

useWebSocketImplementation(NodeWebSocket);

// Provisional app-specific ephemeral kind (SPECS.md §16 Q2).
const KIND = 25050;
const CANDIDATES = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://relay.snort.social',
  'wss://nostr.mom',
  'wss://offchain.pub',
  'wss://relay.nostr.net',
  'wss://nostr.oxtr.dev',
  'wss://relay.nostr.bg',
  'wss://relay.0xchat.com',
  'wss://nostr-pub.wellorder.net',
];

const args = process.argv.slice(2);
const rounds = Number(args[0]) > 0 ? Number(args.shift()) : 5;
const relays = args.length ? args : CANDIDATES;

const withTimeout = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timeout`)), ms)),
  ]);
// nostr-tools rejects with plain strings as well as Errors.
const errMsg = (err) => String(err?.message ?? err).slice(0, 60);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)]);
};

async function nip11(url) {
  try {
    const res = await fetch(url.replace(/^ws/, 'http'), {
      headers: { Accept: 'application/nostr+json' },
      signal: AbortSignal.timeout(5000),
    });
    const info = await res.json();
    return { software: info.software?.split('/').pop() ?? '?', limitation: info.limitation ?? {} };
  } catch {
    return { software: 'n/a', limitation: {} };
  }
}

async function probe(url) {
  const result = { url, ...(await nip11(url)), delivered: 0, rounds, latencies: [], stored: null, error: null };
  const sk = generateSecretKey();
  const tag = `peermate-probe-${Math.random().toString(36).slice(2)}`;
  const filter = { kinds: [KIND], '#t': [tag] };
  let sub, pub;

  try {
    const t0 = performance.now();
    sub = await withTimeout(Relay.connect(url), 8000, 'connect');
    result.connectMs = Math.round(performance.now() - t0);
    pub = await withTimeout(Relay.connect(url), 8000, 'connect');

    const waiting = new Map(); // event id -> resolve
    await new Promise((resolve) => {
      sub.subscribe([filter], {
        onevent: (ev) => waiting.get(ev.id)?.(),
        oneose: resolve,
      });
      setTimeout(resolve, 3000); // some relays never send EOSE for ephemeral-only filters
    });

    for (let i = 0; i < rounds; i++) {
      const ev = finalizeEvent(
        { kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [['t', tag]], content: `probe ${i}` },
        sk,
      );
      const arrived = new Promise((resolve) => waiting.set(ev.id, resolve));
      const sent = performance.now();
      try {
        await withTimeout(pub.publish(ev), 5000, 'publish');
        await withTimeout(arrived, 5000, 'delivery');
        result.latencies.push(performance.now() - sent);
        result.delivered++;
      } catch (err) {
        result.error = errMsg(err);
      }
    }

    // Does a fresh query replay them? (strfry keeps ephemeral events for a few minutes.)
    const fresh = await withTimeout(Relay.connect(url), 8000, 'connect');
    result.stored = await new Promise((resolve) => {
      let count = 0;
      fresh.subscribe([{ ...filter, since: 0 }], {
        onevent: () => count++,
        oneose: () => resolve(count),
      });
      setTimeout(() => resolve(count), 4000);
    });
    fresh.close();
  } catch (err) {
    result.error = errMsg(err);
  } finally {
    sub?.close();
    pub?.close();
  }
  return result;
}

console.log(`Probing ${relays.length} relays, ${rounds} ephemeral events each (kind ${KIND})...\n`);
const results = await Promise.all(relays.map(probe));

const rows = results
  .map((r) => ({
    relay: r.url.replace('wss://', ''),
    software: r.software,
    'connect ms': r.connectMs ?? '-',
    delivered: `${r.delivered}/${r.rounds}`,
    'median ms': median(r.latencies) ?? '-',
    'max ms': r.latencies.length ? Math.round(Math.max(...r.latencies)) : '-',
    replayed: r.stored ?? '-',
    'pow/auth/paid': [
      r.limitation.min_pow_difficulty ? `pow${r.limitation.min_pow_difficulty}` : '',
      r.limitation.auth_required ? 'auth' : '',
      r.limitation.payment_required ? 'paid' : '',
    ]
      .filter(Boolean)
      .join(',') || '-',
    error: r.error ?? '',
  }))
  .sort((a, b) => (Number(a['median ms']) || 1e9) - (Number(b['median ms']) || 1e9));
console.table(rows);

const usable = results.filter((r) => r.delivered === r.rounds);
console.log(`\nUsable (all events delivered): ${usable.length}/${results.length}`);
console.log('replayed > 0: relay returns recent ephemeral events to new subscribers; dedupe by (gameId, seq).');
process.exit(0);
