// Transport selection per peer (SPECS §6.6). Direct (Hyperswarm, hole-punched)
// when a connection is up; otherwise the relay path (Nostr) if we know the
// peer's Nostr key. The reliable channel above makes switching seamless: after
// any switch the app calls channel.resync() and both sides replay what's missing.
import type { Envelope } from './envelope.ts';
import type { PeerNetwork } from './matchmaker.ts';

export type Route = 'direct' | 'relay';

export type RouterLinks = {
  directSend(peer: string, wire: string): void;
  directDrop(peer: string): void;
  relaySend(npub: string, wire: string): void;
};

export class PeerRouter implements PeerNetwork {
  private readonly direct = new Set<string>();
  private readonly npubs = new Map<string, string>();
  private readonly links: RouterLinks;

  constructor(links: RouterLinks) {
    this.links = links;
  }

  route(peer: string): Route | null {
    if (this.direct.has(peer)) return 'direct';
    return this.npubs.has(peer) ? 'relay' : null;
  }

  /** A direct connection to `peer` opened. Returns the route before. */
  directUp(peer: string): Route | null {
    const before = this.route(peer);
    this.direct.add(peer);
    return before;
  }

  directDown(peer: string): Route | null {
    const before = this.route(peer);
    this.direct.delete(peer);
    return before;
  }

  /** We learned how to reach `peer` through relays. */
  relayKnown(peer: string, npub: string): void {
    this.npubs.set(peer, npub);
  }

  npubOf(peer: string): string | undefined {
    return this.npubs.get(peer);
  }

  send(peer: string, wire: string): void {
    if (this.direct.has(peer)) this.links.directSend(peer, wire);
    else {
      const npub = this.npubs.get(peer);
      if (npub) this.links.relaySend(npub, wire);
    }
  }

  drop(peer: string): void {
    this.links.directDrop(peer);
    this.direct.delete(peer);
    this.npubs.delete(peer);
  }
}

/**
 * The sender's Ed25519 key from a wire message, without verifying it (the
 * channel verifies). Lets a transport attribute an unsolicited message.
 *
 * The envelope's own top-level `from` (the key its signature is checked
 * against), never a "from" found elsewhere in the text: a sender could put
 * someone else's key inside the body.
 */
export function wireSender(wire: string): string | null {
  try {
    const e = JSON.parse(wire) as unknown;
    if (!e || typeof e !== 'object') return null;
    const from = (e as { from?: unknown }).from;
    return typeof from === 'string' && /^[0-9a-f]{64}$/.test(from) ? from : null;
  } catch {
    return null;
  }
}

/**
 * Whether a verified message `env` that came through the relays from Nostr key
 * `npub` may set the relay route of its sender (`env.from`), whose route is
 * `known` now. A signed message proves who wrote it, not who forwarded it: anyone
 * can relay a copy of a message they received. So a route is only set where none
 * exists, and only moved on the sender's own signed HELLO naming this Nostr key,
 * never while we're playing them.
 */
export function relayBindingOk(known: string | undefined, npub: string, env: Envelope, opponent: boolean): boolean {
  if (known === npub) return true;
  const body = env.body;
  if (body.t === 'HELLO' && body.npub !== npub) return false;
  if (known === undefined) return true;
  return body.t === 'HELLO' && !opponent;
}
