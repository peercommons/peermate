// Friends (SPECS §2.4): share your link, add a friend's, challenge them.
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { addFriend, friendLink, parseFriendLink, removeFriend, useFriends, type Friend } from '../net/friends';
import { online, presenceOf, TIME_CONTROLS, usePresence } from '../net/online';
import { useUnread } from '../net/messages';
import { loadMe, type Me } from '../net/profile';
import { ui } from '../theme';

const STATUS = {
  online: { label: 'Online', color: '#2e7d32' },
  playing: { label: 'Playing a game', color: '#f9a825' },
  away: { label: 'Away', color: '#9e9e9e' },
  offline: { label: 'Offline', color: '#bdbdbd' },
} as const;

export default function FriendsScreen() {
  const list = useFriends();
  const presence = usePresence();
  const unread = useUnread();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000); // let stale presence go offline
    return () => clearInterval(t);
  }, []);
  const [me, setMe] = useState<Me | null>(null);
  const [paste, setPaste] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    loadMe().then(setMe, () => undefined);
  }, []);

  const myLink = me ? friendLink(me.identity.peer.publicKey, me.identity.nostr.publicKey, me.profile.nick) : null;
  const parsed = parseFriendLink(paste);
  const pasteIsMine = parsed && me && parsed.key === me.identity.peer.publicKey;

  const add = () => {
    if (!parsed || pasteIsMine) return;
    addFriend(parsed.key, parsed.npub, parsed.nick);
    setPaste('');
    void online.listen();
  };

  const challenge = (f: Friend, tc: string) => {
    setOpen(null);
    void online.challenge(f.key, tc);
    router.push('/online');
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.root} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <Text style={styles.heading}>Your friend link</Text>
        <Text style={styles.subtle}>Send it to a friend. When they open it, you're added to their friends.</Text>
        <Pressable
          disabled={!myLink}
          onPress={() => myLink && Share.share({ message: `Play chess with me on Peermate: ${myLink}` })}
          style={({ pressed }) => [styles.primary, pressed && { opacity: 0.7 }]}
          accessibilityRole="button"
        >
          <Text style={styles.primaryText}>Share my link</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Add a friend</Text>
        <TextInput
          value={paste}
          onChangeText={setPaste}
          placeholder="Paste their peermate:// link"
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, paste.length > 0 && !parsed && styles.inputBad]}
          accessibilityLabel="Friend link"
        />
        {paste.length > 0 && !parsed && <Text style={styles.error}>That isn't a Peermate friend link.</Text>}
        {pasteIsMine && <Text style={styles.error}>That's your own link.</Text>}
        {parsed && !pasteIsMine && (
          <Pressable onPress={add} style={({ pressed }) => [styles.primary, pressed && { opacity: 0.7 }]}>
            <Text style={styles.primaryText}>Add {parsed.nick}</Text>
          </Pressable>
        )}
      </View>

      <Text style={styles.section}>Friends</Text>
      {list.length === 0 && (
        <Text style={styles.subtle}>
          No friends yet. Share your link, add theirs, or tap "Add as friend" after an online game.
        </Text>
      )}
      {list.map((f) => (
        <View key={f.key} style={styles.card}>
          <View style={styles.row}>
            <Pressable
              style={{ flex: 1 }}
              onPress={() => router.push({ pathname: '/chat/[key]', params: { key: f.key } })}
              accessibilityRole="button"
              accessibilityLabel={`Messages with ${f.nick}${unread[f.key] ? `, ${unread[f.key]} unread` : ''}`}
            >
              <Text style={styles.name} numberOfLines={1}>
                {f.nick}
                {unread[f.key] ? <Text style={styles.unread}>  {unread[f.key]} new</Text> : null}
              </Text>
              <Text style={styles.subtle}>
                <Text style={{ color: STATUS[presenceOf(presence.get(f.key), now)].color }}>● </Text>
                {STATUS[presenceOf(presence.get(f.key), now)].label} · ID {f.fingerprint}
              </Text>
              <Text style={styles.tapHint}>Tap for messages</Text>
            </Pressable>
            <Pressable
              onPress={() => setOpen(open === f.key ? null : f.key)}
              style={({ pressed }) => [styles.small, pressed && { opacity: 0.7 }]}
              accessibilityRole="button"
              accessibilityLabel={`Challenge ${f.nick}`}
            >
              <Text style={styles.primaryText}>Challenge</Text>
            </Pressable>
          </View>
          {open === f.key && (
            <>
              {presenceOf(presence.get(f.key), now) !== 'online' && (
                <Text style={styles.subtle}>
                  {f.nick} may not see a challenge right now: it only arrives while Peermate is open on their phone.
                </Text>
              )}
              <Text style={styles.subtle}>Time control (minutes + seconds per move)</Text>
              <View style={styles.chips}>
                {TIME_CONTROLS.map((t) => (
                  <Pressable key={t} onPress={() => challenge(f, t)} style={styles.chip} accessibilityRole="button">
                    <Text style={styles.chipText}>{t}</Text>
                  </Pressable>
                ))}
              </View>
              <Pressable
                onPress={() =>
                  Alert.alert(`Remove ${f.nick}?`, 'You can add them again from their link.', [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Remove', style: 'destructive', onPress: () => removeFriend(f.key) },
                  ])
                }
              >
                <Text style={styles.remove}>Remove friend</Text>
              </Pressable>
            </>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: 16, gap: 12 },
  card: {
    backgroundColor: ui.card,
    borderRadius: 12,
    padding: 14,
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ui.border,
  },
  heading: { fontSize: 17, fontWeight: '700', color: ui.text },
  section: { fontSize: 13, fontWeight: '700', color: ui.subtle, textTransform: 'uppercase', marginTop: 4 },
  subtle: { color: ui.subtle },
  name: { fontSize: 16, fontWeight: '700', color: ui.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: {
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: ui.text,
  },
  inputBad: { borderColor: '#b3261e' },
  error: { color: '#b3261e' },
  primary: { backgroundColor: ui.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  primaryText: { color: ui.accentText, fontWeight: '700' },
  small: { backgroundColor: ui.accent, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: ui.background,
  },
  chipText: { color: ui.text, fontWeight: '600' },
  remove: { color: '#b3261e', paddingVertical: 4 },
  unread: { color: '#b3261e', fontSize: 13, fontWeight: '700' },
  tapHint: { color: ui.accent, fontSize: 12, marginTop: 2 },
});
