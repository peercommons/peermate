// Opened from a friend link: peermate://p/<peerKey>?n=<nostrKey>&nick=<name>
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { fingerprint } from '@peermate/core';
import { addFriend, isFriend, parseFriendParams } from '../../net/friends';
import { online } from '../../net/online';
import { loadMe } from '../../net/profile';
import { ui } from '../../theme';

export default function FriendLinkScreen() {
  const params = useLocalSearchParams<{ key: string; n?: string; nick?: string }>();
  const friend = parseFriendParams(params.key, params.n, params.nick);
  const [mine, setMine] = useState(false);

  useEffect(() => {
    loadMe().then((me) => setMine(me.identity.peer.publicKey === friend?.key), () => undefined);
  }, [friend?.key]);

  const done = () => router.replace('/friends');

  if (!friend) {
    return (
      <View style={styles.root}>
        <Text style={styles.text}>This friend link is incomplete or damaged.</Text>
        <Button label="OK" onPress={() => router.replace('/')} />
      </View>
    );
  }
  if (mine) {
    return (
      <View style={styles.root}>
        <Text style={styles.text}>That's your own friend link. Send it to someone else to be added to their friends.</Text>
        <Button label="OK" onPress={done} />
      </View>
    );
  }
  return (
    <View style={styles.root}>
      <Text style={styles.heading}>{isFriend(friend.key) ? `${friend.nick} is already a friend` : `Add ${friend.nick} as a friend?`}</Text>
      <Text style={styles.subtle}>ID {fingerprint(friend.key)}</Text>
      <Text style={styles.text}>Friends can challenge each other to games directly.</Text>
      {!isFriend(friend.key) && (
        <Button
          label="Add friend"
          onPress={() => {
            addFriend(friend.key, friend.npub, friend.nick);
            void online.listen();
            done();
          }}
        />
      )}
      <Button label={isFriend(friend.key) ? 'Open friends' : 'Not now'} onPress={done} secondary />
    </View>
  );
}

function Button({ label, onPress, secondary }: { label: string; onPress: () => void; secondary?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [secondary ? styles.secondary : styles.primary, pressed && { opacity: 0.7 }]}
      accessibilityRole="button"
    >
      <Text style={secondary ? styles.secondaryText : styles.primaryText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24, gap: 12, justifyContent: 'center', backgroundColor: ui.background },
  heading: { fontSize: 20, fontWeight: '700', color: ui.text, textAlign: 'center' },
  subtle: { color: ui.subtle, textAlign: 'center' },
  text: { color: ui.text, textAlign: 'center' },
  primary: { backgroundColor: ui.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  primaryText: { color: ui.accentText, fontWeight: '700' },
  secondary: { borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  secondaryText: { color: ui.accent, fontWeight: '700' },
});
