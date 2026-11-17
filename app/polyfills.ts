// Must be imported before anything that generates keys (nostr-tools / @noble).
// Hermes may not provide crypto.getRandomValues; expo-crypto's is a native CSPRNG.
import { getRandomValues } from 'expo-crypto';

const g = globalThis as { crypto?: { getRandomValues?: unknown } };
if (typeof g.crypto?.getRandomValues !== 'function') {
  g.crypto = { ...(g.crypto ?? {}), getRandomValues };
}
