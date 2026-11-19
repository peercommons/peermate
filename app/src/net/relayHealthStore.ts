// Keeps relay health (auto-demotion, SPECS §6.4) across app runs, so a relay
// found dead isn't retried on every launch. Imported for its side effect by
// everything that opens relay connections in the app.
import Storage from 'expo-sqlite/kv-store';
import { dmDelivery, relayHealth } from './relay';

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

// The private-message delivery check's result (relay.ts DMDelivery), so a relay
// that swallows messages stays excluded across launches until it's rechecked.
const DM_KEY = 'relayDM.v2'; // v1 could hold a run that reached no relay
try {
  dmDelivery.load(JSON.parse(Storage.getItemSync(DM_KEY) ?? 'null'));
} catch {
  // start fresh
}
dmDelivery.onChange(() => {
  try {
    Storage.setItemSync(DM_KEY, JSON.stringify(dmDelivery.snapshot()));
  } catch {
    // not fatal: the next check finds them again
  }
});
