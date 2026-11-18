// Transport selection per peer (SPECS §6.6). Direct (Hyperswarm, hole-punched)
// when a connection is up; otherwise the relay path (Nostr) if we know the
// peer's Nostr key. The reliable channel above makes switching seamless: after
// any switch the app calls channel.resync() and both sides replay what's missing.
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
 */
export function wireSender(wire: string): string | null {
  const m = /"from":"([0-9a-f]{64})"/.exec(wire);
  return m ? m[1] : null;
}
