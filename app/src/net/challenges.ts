// Offline challenges (SPECS §2.4): a challenge to a friend whose app isn't open
// travels as a private message (NIP-17), which relays keep. Their app (open, or
// the background check) notifies them; answering sends a live challenge back.
// A game still needs both apps open at once: there's no server to hold one.
import Storage from 'expo-sqlite/kv-store';
import { parseTimeControl } from '@peermate/core';

const KEY = 'challenges.v1';
const PREFIX = '♟ Challenge: ';
/** How long an offline challenge (ours or theirs) stays answerable. */
export const CHALLENGE_TTL_MS = 24 * 3600 * 1000;

type Pending = { tc: string; at: number };
type Store = {
  /** Friends' offline challenges to us, by friend key. */
  incoming: Record<string, Pending>;
  /** Ours to friends, by friend key: their live challenge back is the answer. */
  outgoing: Record<string, Pending>;
};

let store: Store = load();

function load(): Store {
  try {
    const s = JSON.parse(Storage.getItemSync(KEY) ?? 'null');
    if (s && typeof s === 'object') return { incoming: s.incoming ?? {}, outgoing: s.outgoing ?? {} };
  } catch {
    // start fresh
  }
  return { incoming: {}, outgoing: {} };
}

function save(next: Store) {
  store = next;
  Storage.setItemSync(KEY, JSON.stringify(next));
}

const fresh = (p: Pending | undefined, now: number): p is Pending => !!p && now - p.at < CHALLENGE_TTL_MS;

/** The message text for a challenge. Older builds show it as a chat line, which still reads fine. */
export function challengeText(tc: string): string {
  return PREFIX + tc;
}

/** The time control, if this message is a challenge. */
export function parseChallenge(text: string): string | null {
  if (!text.startsWith(PREFIX)) return null;
  const tc = text.slice(PREFIX.length).trim();
  if (tc.length > 16) return null;
  try {
    parseTimeControl(tc);
    return tc;
  } catch {
    return null;
  }
}

/** Records a friend's offline challenge. False if it has expired or a newer one is already here. */
export function addIncoming(friend: string, tc: string, at: number, now = Date.now()): boolean {
  if (!fresh({ tc, at }, now)) return false;
  const cur = store.incoming[friend];
  if (cur && cur.at >= at) return false;
  save({ ...store, incoming: { ...store.incoming, [friend]: { tc, at } } });
  return true;
}

/** The newest unanswered offline challenge from a friend, if any. */
export function nextIncoming(now = Date.now()): ({ key: string } & Pending) | null {
  let best: ({ key: string } & Pending) | null = null;
  for (const [key, p] of Object.entries(store.incoming)) {
    if (fresh(p, now) && (!best || p.at > best.at)) best = { key, ...p };
  }
  return best;
}

export function clearIncoming(friend: string): void {
  if (!store.incoming[friend]) return;
  const { [friend]: _gone, ...incoming } = store.incoming;
  save({ ...store, incoming });
}

export function noteOutgoing(friend: string, tc: string, now = Date.now()): void {
  save({ ...store, outgoing: { ...store.outgoing, [friend]: { tc, at: now } } });
}

/** Whether we offline-challenged this friend to `tc` recently (so their challenge is an answer). */
export function isAnswer(friend: string, tc: string, now = Date.now()): boolean {
  const p = store.outgoing[friend];
  return fresh(p, now) && p.tc === tc;
}

export function clearOutgoing(friend: string): void {
  if (!store.outgoing[friend]) return;
  const { [friend]: _gone, ...outgoing } = store.outgoing;
  save({ ...store, outgoing });
}

/** Forgets everything about a friend (removed or blocked). */
export function forgetChallenges(friend: string): void {
  clearIncoming(friend);
  clearOutgoing(friend);
}
