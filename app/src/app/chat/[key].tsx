// A private conversation with one friend (NIP-17 messages through relays).
import { useEffect, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { ScreenView } from '../../components/ScreenView';
import { getFriend } from '../../net/friends';
import { markRead, MESSAGE_MAX, useThread, type Message } from '../../net/messages';
import { online } from '../../net/online';
import { ui } from '../../theme';

export default function ChatScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const friend = getFriend(String(key));
  const thread = useThread(String(key));
  const [draft, setDraft] = useState('');
  const headerHeight = useHeaderHeight();

  // Everything on screen counts as read, including messages arriving while it's open.
  useEffect(() => {
    if (friend) markRead(friend.key);
  }, [friend, thread.length]);

  useEffect(() => {
    void online.listen();
  }, []);

  if (!friend) {
    return (
      <View style={styles.center}>
        <Text style={styles.subtle}>Not in your friends.</Text>
      </View>
    );
  }

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void online.sendMessage(friend.key, text);
  };

  return (
    <ScreenView style={styles.root}>
      <KeyboardAvoidingView
        style={styles.root}
        behavior="padding" // Android draws edge to edge (no adjustResize): pad on both
        keyboardVerticalOffset={headerHeight}
      >
        <Stack.Screen
          options={{
            title: friend.nick,
            headerRight: () => (
              <Pressable onPress={() => router.push('/friends')} accessibilityRole="button" hitSlop={8}>
                <Text style={styles.headerLink}>Challenge</Text>
              </Pressable>
            ),
          }}
        />
        <FlatList
          data={[...thread].reverse()}
          inverted
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Bubble m={item} onRetry={() => online.sendMessage(friend.key, item.text, { at: item.at })} />
          )}
          ListEmptyComponent={
            <Text style={[styles.subtle, styles.empty]}>
              Messages are end-to-end encrypted and reach {friend.nick} even if their app is closed: they arrive when
              they next open Peermate.
            </Text>
          }
        />
        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={`Message ${friend.nick}`}
            multiline
            maxLength={MESSAGE_MAX}
            style={styles.input}
            accessibilityLabel="Message"
          />
          <Pressable
            onPress={send}
            disabled={!draft.trim()}
            style={({ pressed }) => [styles.send, (!draft.trim() || pressed) && { opacity: 0.5 }]}
            accessibilityRole="button"
          >
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </ScreenView>
  );
}

function Bubble({ m, onRetry }: { m: Message; onRetry: () => void }) {
  const mine = m.from === 'me';
  const time = new Date(m.at).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <View style={[styles.bubbleRow, mine && { alignItems: 'flex-end' }]}>
      <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
        <Text style={mine ? styles.mineText : styles.theirText} selectable>
          {m.text}
        </Text>
      </View>
      <Text style={styles.meta}>
        {time}
        {mine && m.status === 'sending' && ' · sending…'}
        {mine && m.status === 'failed' && ' · not sent'}
      </Text>
      {mine && m.status === 'failed' && (
        <Pressable onPress={onRetry} accessibilityRole="button">
          <Text style={styles.retry}>Tap to retry</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: ui.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { padding: 12, gap: 8 },
  empty: { textAlign: 'center', padding: 24 },
  subtle: { color: ui.subtle },
  headerLink: { color: ui.accent, fontWeight: '700' },
  bubbleRow: { alignItems: 'flex-start', gap: 2 },
  bubble: {
    maxWidth: '82%',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  mine: { backgroundColor: ui.accent },
  theirs: {
    backgroundColor: ui.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ui.border,
  },
  mineText: { color: ui.accentText, fontSize: 15 },
  theirText: { color: ui.text, fontSize: 15 },
  meta: { fontSize: 11, color: ui.subtle, paddingHorizontal: 4 },
  retry: {
    fontSize: 12,
    color: '#b3261e',
    fontWeight: '700',
    paddingHorizontal: 4,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: ui.border,
    backgroundColor: ui.card,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
    fontSize: 15,
    color: ui.text,
    backgroundColor: ui.background,
  },
  send: {
    backgroundColor: ui.accent,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendText: { color: ui.accentText, fontWeight: '700' },
});
