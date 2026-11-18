// Relay check (Dev tools): how each Nostr relay does from this phone right now.
import { useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { appLog } from '../../modules/peermate-log';
import { DEFAULT_RELAYS } from '../net/relay';
import { CANDIDATE_RELAYS, checkRelays, type RelayResult } from '../net/relaycheck';
import { ui } from '../theme';

const COLOR: Record<RelayResult['verdict'], string> = {
  ok: '#2e7d32',
  rejected: '#b3261e',
  'no-echo': '#e07b24',
  'no-connect': '#b3261e',
  error: '#b3261e',
};

const host = (url: string) => url.replace('wss://', '');

function line(r: RelayResult): string {
  const t = r.verdict === 'ok' ? `round trip ${r.echoMs} ms (connect ${r.connectMs} ms)` : r.verdict;
  return `${host(r.url)}: ${t}${r.note && r.verdict !== 'ok' ? ` — ${r.note}` : ''}`;
}

export default function RelayCheckScreen() {
  const [results, setResults] = useState<Record<string, RelayResult>>({});
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setResults({});
    appLog('relaycheck', 'start');
    const all = await checkRelays(CANDIDATE_RELAYS, (r) => {
      appLog('relaycheck', line(r));
      setResults((prev) => ({ ...prev, [r.url]: r }));
    });
    const ok = all.filter((r) => r.verdict === 'ok').length;
    appLog('relaycheck', 'done', ok, 'of', all.length, 'ok');
    setRunning(false);
  };

  const share = () => {
    const text = CANDIDATE_RELAYS.map((u) => (results[u] ? line(results[u]) : `${host(u)}: not checked`)).join('\n');
    void Share.share({ message: `Peermate relay check\n${text}` });
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.root}>
      <Text style={styles.subtle}>
        Connects to each relay, publishes a test message from a new throwaway key, and times how long it takes to
        come back. Run it on Wi‑Fi and on mobile data. Relays marked "in use" are the ones the app uses now.
      </Text>
      <Pressable
        disabled={running}
        onPress={run}
        style={({ pressed }) => [styles.button, (pressed || running) && { opacity: 0.6 }]}
        accessibilityRole="button"
      >
        <Text style={styles.buttonText}>{running ? 'Checking…' : 'Check relays'}</Text>
      </Pressable>
      {CANDIDATE_RELAYS.map((u) => {
        const r = results[u];
        return (
          <View key={u} style={styles.card}>
            <Text style={styles.name}>
              {host(u)}
              {DEFAULT_RELAYS.includes(u) ? <Text style={styles.inUse}>  in use</Text> : null}
            </Text>
            {r ? (
              <Text style={{ color: COLOR[r.verdict] }}>
                {r.verdict === 'ok'
                  ? `OK · round trip ${r.echoMs} ms · connect ${r.connectMs} ms`
                  : `${r.verdict}${r.note ? ` · ${r.note}` : ''}`}
              </Text>
            ) : (
              <Text style={styles.subtle}>{running ? 'checking…' : '—'}</Text>
            )}
          </View>
        );
      })}
      {Object.keys(results).length > 0 && !running && (
        <Pressable onPress={share} style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.7 }]}>
          <Text style={styles.secondaryText}>Share results</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: 16, gap: 10 },
  subtle: { color: ui.subtle },
  button: { backgroundColor: ui.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  buttonText: { color: ui.accentText, fontWeight: '700' },
  secondary: { borderWidth: 1, borderColor: ui.accent, borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  secondaryText: { color: ui.accent, fontWeight: '700' },
  card: {
    backgroundColor: ui.card,
    borderRadius: 10,
    padding: 12,
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ui.border,
  },
  name: { fontWeight: '700', color: ui.text },
  inUse: { color: ui.accent, fontSize: 12, fontWeight: '600' },
});
