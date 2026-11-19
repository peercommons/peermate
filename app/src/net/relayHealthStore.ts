// Keeps relay health (auto-demotion, SPECS §6.4) across app runs, so a relay
// found dead isn't retried on every launch. Imported for its side effect by
// everything that opens relay connections in the app.
import Storage from 'expo-sqlite/kv-store';
import { relayHealth } from './relay';

const KEY = 'relayHealth.v1';

try {
  relayHealth.load(JSON.parse(Storage.getItemSync(KEY) ?? 'null'));
} catch {
  // start fresh
}

let timer: ReturnType<typeof setTimeout> | null = null;
relayHealth.onChange(() => {
  timer ??= setTimeout(() => {
    timer = null;
    try {
      Storage.setItemSync(KEY, JSON.stringify(relayHealth.snapshot()));
    } catch {
      // not fatal: we'd just relearn which relays are down
    }
  }, 5_000);
});
