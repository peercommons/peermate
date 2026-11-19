// Relay check (field diagnostics): from the phone itself, how each relay does
// at what Peermate needs — connect, accept an ephemeral event (kind 25050) from
// a brand-new key, and deliver it back to a subscriber.
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { DEFAULT_RELAYS, PEERMATE_KIND } from './relay';

/** The relays in use, plus candidates to compare them against. */
export const CANDIDATE_RELAYS = [
  ...DEFAULT_RELAYS,
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.nostr.net',
  'wss://nostr.bitcoiner.social',
  'wss://nostr.oxtr.dev',
  'wss://relay.nostr.band',
  'wss://nostr-pub.wellorder.net',
  'wss://nostr.fmt.wiz.biz',
].filter((u, i, all) => all.indexOf(u) === i); // in-use relays may also be candidates

export type RelayResult = {
  url: string;
  /** ok: the event came back. rejected: the relay refused it. */
  verdict: 'ok' | 'rejected' | 'no-echo' | 'no-connect' | 'error';
  connectMs?: number;
  echoMs?: number;
  note?: string;
};

export function checkRelay(url: string, timeoutMs = 10_000): Promise<RelayResult> {
  return new Promise((resolve) => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const t0 = Date.now();
    let connectMs: number | undefined;
    let sentAt = 0;
    let accepted = false;
    let note: string | undefined;
    let ws: WebSocket;
    let finished = false;
    const finish = (r: Omit<RelayResult, 'url' | 'connectMs'>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve({ url, connectMs, ...r, note: r.note ?? note });
    };
    const timer = setTimeout(() => {
      if (connectMs === undefined) finish({ verdict: 'no-connect', note: `nothing in ${timeoutMs / 1000} s` });
      else finish({ verdict: 'no-echo', note: accepted ? 'accepted but never delivered' : 'no answer to publish' });
    }, timeoutMs);
    try {
      ws = new WebSocket(url);
    } catch (err) {
      finish({ verdict: 'error', note: String(err) });
      return;
    }
    ws.onopen = () => {
      connectMs = Date.now() - t0;
      const since = Math.floor(Date.now() / 1000) - 5;
      ws.send(JSON.stringify(['REQ', 'check', { kinds: [PEERMATE_KIND], '#p': [pk], since }]));
      setTimeout(() => {
        const ev = finalizeEvent(
          { kind: PEERMATE_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['p', pk]], content: 'relay check' },
          sk,
        );
        sentAt = Date.now();
        ws.send(JSON.stringify(['EVENT', ev]));
      }, 300);
    };
    ws.onerror = (e) => {
      if (connectMs === undefined) finish({ verdict: 'no-connect', note: (e as { message?: string }).message ?? 'connection failed' });
    };
    ws.onclose = (e) => {
      if (connectMs === undefined) finish({ verdict: 'no-connect', note: `closed (${e.code})` });
    };
    ws.onmessage = (m) => {
      let d: unknown[];
      try {
        d = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (d[0] === 'OK') {
        accepted = d[2] === true;
        if (!accepted) finish({ verdict: 'rejected', note: String(d[3] ?? '') });
      } else if (d[0] === 'EVENT') {
        finish({ verdict: 'ok', echoMs: Date.now() - sentAt });
      } else if (d[0] === 'NOTICE' || d[0] === 'CLOSED' || d[0] === 'AUTH') {
        note = `${d[0]} ${String(d[d.length - 1]).slice(0, 80)}`;
      }
    };
  });
}

/** Checks every relay at once; `onResult` reports each as it finishes. */
export async function checkRelays(urls: string[], onResult: (r: RelayResult) => void): Promise<RelayResult[]> {
  return Promise.all(
    urls.map((u) =>
      checkRelay(u).then((r) => {
        onResult(r);
        return r;
      }),
    ),
  );
}
