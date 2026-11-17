// Phase 0 spikes (a) + (c): talk to peers directly (Hyperswarm in a Bare worklet)
// or through public Nostr relays (the fallback path).
// This screen is throwaway test UI, not the real app.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import b4a from 'b4a';
import p2p from 'expo-bare-kit/workers/p2p/worker';
import { joinNostrRoom, type NostrRoom } from './net/nostrRoom';

type WorkerMsg =
  | { type: 'ready'; publicKey: string }
  | { type: 'joined'; room: string; topic: string }
  | { type: 'peer-joined'; id: string; host?: string | null; port?: number | null; initiator?: boolean; connectMs?: number | null }
  | { type: 'peer-left'; id: string }
  | { type: 'chat'; from: string; text: string }
  | { type: 'rtt'; id: string; ms: number }
  | { type: 'log' | 'error'; message: string };

type Peer = { id: string; addr: string; connectMs: number | null; rtt?: number };
type Mode = 'p2p' | 'nostr';

const short = (id: string) => id.slice(0, 8);
const time = () => new Date().toLocaleTimeString();

export default function App() {
  const sendRef = useRef<((msg: object) => void) | null>(null);
  const nostrRef = useRef<NostrRoom | null>(null);
  const [mode, setMode] = useState<Mode>('p2p');
  const [status, setStatus] = useState('starting worker…');
  const [myKey, setMyKey] = useState('');
  const [room, setRoom] = useState('lobby');
  const [joined, setJoined] = useState<string | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [lines, setLines] = useState<string[]>([]);
  const [draft, setDraft] = useState('');

  const addLine = useCallback((line: string) => {
    setLines((prev) => [`${time()}  ${line}`, ...prev].slice(0, 200));
  }, []);

  const onMessage = useCallback(
    (msg: WorkerMsg) => {
      switch (msg.type) {
        case 'ready':
          setMyKey(msg.publicKey);
          setStatus('worker ready');
          break;
        case 'joined':
          setJoined(msg.room);
          setStatus(`announced in "${msg.room}", waiting for peers`);
          addLine(`joined "${msg.room}" (topic ${msg.topic.slice(0, 12)}…)`);
          break;
        case 'peer-joined': {
          const addr = msg.host ? `${msg.host}:${msg.port}` : 'via relays';
          setPeers((prev) => [
            ...prev.filter((p) => p.id !== msg.id),
            { id: msg.id, addr, connectMs: msg.connectMs ?? null },
          ]);
          addLine(
            `+ ${short(msg.id)} ${addr}` +
              (msg.host ? ` ${msg.initiator ? 'out' : 'in'}` : '') +
              (msg.connectMs != null ? ` (${msg.connectMs} ms)` : ''),
          );
          break;
        }
        case 'peer-left':
          setPeers((prev) => prev.filter((p) => p.id !== msg.id));
          addLine(`- ${short(msg.id)} left`);
          break;
        case 'chat':
          addLine(`${short(msg.from)}> ${msg.text}`);
          break;
        case 'rtt':
          setPeers((prev) => prev.map((p) => (p.id === msg.id ? { ...p, rtt: msg.ms } : p)));
          addLine(`rtt ${short(msg.id)} ${msg.ms} ms`);
          break;
        case 'log':
        case 'error':
          addLine(`[${msg.type}] ${msg.message}`);
          break;
      }
    },
    [addLine],
  );

  useEffect(() => {
    let cancelled = false;
    let stop: (() => unknown) | undefined;

    (async () => {
      try {
        const { ipc } = await p2p.start();
        if (cancelled) {
          ipc.destroy();
          return;
        }
        stop = () => ipc.destroy();
        sendRef.current = (msg) => ipc.write(b4a.from(JSON.stringify(msg) + '\n'));

        let pending = '';
        ipc.on('data', (data) => {
          pending += b4a.toString(data as Uint8Array);
          let nl;
          while ((nl = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, nl);
            pending = pending.slice(nl + 1);
            if (line) onMessage(JSON.parse(line));
          }
        });
        ipc.on('error', (err: Error) => setStatus(`worker error: ${err.message}`));
      } catch (err) {
        setStatus(`failed to start worker: ${(err as Error).message}`);
      }
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [onMessage]);

  const send = (msg: object) => sendRef.current?.(msg);

  useEffect(() => () => nostrRef.current?.close(), []);

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    if (mode === 'p2p') send({ type: 'leave' });
    nostrRef.current?.close();
    nostrRef.current = null;
    setPeers([]);
    setJoined(null);
    setMode(next);
    setStatus(next === 'p2p' ? 'direct P2P mode' : 'Nostr relay mode');
  };

  const join = () => {
    if (mode === 'p2p') return send({ type: 'join', room });
    nostrRef.current?.close();
    setPeers([]);
    const joinedAt = Date.now();
    nostrRef.current = joinNostrRoom({
      room,
      onEvent: (event) => {
        if (event.type === 'ready') {
          setJoined(room);
          setStatus(`listening in "${room}" via Nostr relays`);
          addLine(`joined "${room}" via Nostr as ${short(event.publicKey)}`);
        } else if (event.type === 'peer-joined') {
          onMessage({ ...event, connectMs: Date.now() - joinedAt });
        } else {
          onMessage(event);
        }
      },
    });
  };

  const chat = (text: string) =>
    mode === 'p2p' ? send({ type: 'chat', text }) : nostrRef.current?.chat(text);
  const ping = () => (mode === 'p2p' ? send({ type: 'ping' }) : nostrRef.current?.ping());

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="auto" />
      <Text style={styles.title}>Peermate · P2P spike</Text>
      <Text style={styles.meta}>{status}</Text>
      <Text style={styles.meta} selectable>
        me: {myKey ? short(myKey) : '…'}
      </Text>

      <View style={styles.row}>
        <Button label="Direct P2P" onPress={() => switchMode('p2p')} selected={mode === 'p2p'} />
        <Button label="Nostr relays" onPress={() => switchMode('nostr')} selected={mode === 'nostr'} />
      </View>

      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={room}
          onChangeText={setRoom}
          autoCapitalize="none"
          placeholder="room"
        />
        <Button label={joined ? 'Rejoin' : 'Join'} onPress={join} />
        <Button label="Ping" onPress={ping} disabled={!peers.length} />
      </View>

      <Text style={styles.section}>Peers ({peers.length})</Text>
      {peers.map((p) => (
        <Text key={p.id} style={styles.mono}>
          {short(p.id)} {p.addr}
          {p.connectMs != null ? ` · ${p.connectMs} ms` : ''}
          {p.rtt != null ? ` · rtt ${p.rtt} ms` : ''}
        </Text>
      ))}

      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="message"
          onSubmitEditing={() => {
            if (!draft.trim()) return;
            chat(draft);
            addLine(`me> ${draft}`);
            setDraft('');
          }}
        />
      </View>

      <FlatList
        style={styles.log}
        data={lines}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => <Text style={styles.mono}>{item}</Text>}
      />
    </SafeAreaView>
  );
}

function Button({
  label,
  onPress,
  disabled,
  selected,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        selected === false && styles.unselected,
        (pressed || disabled) && { opacity: 0.5 },
      ]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16, paddingTop: 48, gap: 6 },
  title: { fontSize: 20, fontWeight: '700' },
  meta: { color: '#666' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 8 },
  button: { backgroundColor: '#2f6f4f', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 6 },
  buttonText: { color: 'white', fontWeight: '600' },
  unselected: { backgroundColor: '#9aa' },
  section: { marginTop: 8, fontWeight: '600' },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  log: { flex: 1, marginTop: 8 },
});
