// Online lobby: pick a time control and find an opponent (SPECS §2.1 Quick Match).
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Link, router, useFocusEffect } from 'expo-router';
import { formatRating, NEW_RATING, TIME_CONTROL_CLASSES, timeControlClass } from '@peermate/core';
import { useRatings } from '../net/ratings';
import { online, TIME_CONTROLS, useOnline } from '../net/online';
import { loadMe, type Me } from '../net/profile';
import { ui } from '../theme';

export default function OnlineLobby() {
  const ratings = useRatings();
  const state = useOnline();
  const [me, setMe] = useState<Me | null>(null);
  const [tc, setTc] = useState<string>('5+0');
  const [now, setNow] = useState(Date.now());

  useFocusEffect(
    useCallback(() => {
      loadMe().then(setMe).catch(() => undefined);
    }, []),
  );

  // Matched: _layout opens the game (from any screen).

  useEffect(() => {
    if (state.phase !== 'seeking') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state.phase]);

  const seeking = state.phase === 'seeking' || state.phase === 'starting';
  const activeGame = state.phase === 'game' && !state.end;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.root}>
      <View style={styles.card}>
        <Text style={styles.label}>Playing as</Text>
        <Text style={styles.nick}>{me?.profile.nick ?? '…'}</Text>
        <Text style={styles.subtle}>ID {me?.fingerprint ?? '…'}</Text>
        <Text style={styles.subtle}>
          {TIME_CONTROL_CLASSES.map(
            (c) => `${c[0].toUpperCase()}${c.slice(1)} ${formatRating(ratings[c] ?? NEW_RATING)}`,
          ).join(' · ')}
        </Text>
        <Text style={styles.fine}>
          Ratings are worked out on your phone from your online games, and aren't official. "?" means not enough
          games yet.
        </Text>
        <Link href="/settings" style={styles.link}>
          Change name or back up your ID
        </Link>
      </View>

      {activeGame ? (
        <View style={styles.card}>
          <Text style={styles.heading}>Game in progress</Text>
          <Primary label="Return to game" onPress={() => router.replace('/online-game')} />
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.heading}>Quick match</Text>
          <Text style={styles.label}>Time control (minutes + seconds per move)</Text>
          <View style={styles.row}>
            {TIME_CONTROLS.map((t) => (
              <Pressable
                key={t}
                onPress={() => setTc(t)}
                disabled={seeking}
                style={[styles.chip, tc === t && styles.chipSelected, seeking && { opacity: 0.5 }]}
                accessibilityRole="button"
                accessibilityState={{ selected: tc === t }}
              >
                <Text style={[styles.chipText, tc === t && styles.chipTextSelected]}>{t}</Text>
              </Pressable>
            ))}
          </View>
          {timeControlClass(tc) === 'bullet' && (
            <Text style={styles.subtle}>
              Bullet plays best on a direct connection. If the game has to go through relays, each move takes 1–3 s to
              arrive.
            </Text>
          )}

          {seeking ? (
            <View style={styles.seeking}>
              <ActivityIndicator color={ui.accent} />
              <Text style={styles.status}>
                {state.phase === 'starting'
                  ? 'Connecting to the network…'
                  : state.friend
                    ? `Waiting for ${state.friend} to accept ${state.tc} · ${Math.floor((now - state.since) / 1000)} s`
                    : `Looking for a ${state.tc} opponent · ${Math.floor((now - state.since) / 1000)} s`}
              </Text>
              {state.phase === 'seeking' && state.friend && (
                <Text style={styles.subtle}>They get your challenge if Peermate is open on their phone.</Text>
              )}
              {state.phase === 'seeking' && !state.friend && (
                <Text style={styles.subtle}>
                  {state.lobbyPeers === 0
                    ? 'Waiting for another player to connect'
                    : `Connected to ${state.lobbyPeers} player${state.lobbyPeers === 1 ? '' : 's'}`}
                </Text>
              )}
              <Secondary label="Cancel" onPress={() => online.cancelSeek()} />
            </View>
          ) : (
            <Primary label="Find opponent" onPress={() => online.seek(tc)} />
          )}

          {state.phase === 'error' && <Text style={styles.error}>{state.message}</Text>}
        </View>
      )}

      <Text style={styles.note}>
        Games run directly between the two phones, with no server. Like any direct connection, your opponent's
        device can see your IP address.
      </Text>
    </ScrollView>
  );
}

function Primary({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.primary, pressed && { opacity: 0.7 }]}>
      <Text style={styles.primaryText}>{label}</Text>
    </Pressable>
  );
}

function Secondary({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.7 }]}>
      <Text style={styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { padding: 16, gap: 16 },
  card: {
    backgroundColor: ui.card,
    borderRadius: 12,
    padding: 16,
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ui.border,
  },
  heading: { fontSize: 20, fontWeight: '700', color: ui.text },
  label: { fontSize: 13, fontWeight: '600', color: ui.subtle },
  nick: { fontSize: 22, fontWeight: '700', color: ui.text },
  subtle: { color: ui.subtle },
  fine: { color: ui.subtle, fontSize: 12 },
  link: { color: ui.accent, fontWeight: '600', paddingVertical: 4 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: ui.border },
  chipSelected: { backgroundColor: ui.accent, borderColor: ui.accent },
  chipText: { color: ui.text, fontWeight: '600' },
  chipTextSelected: { color: ui.accentText },
  seeking: { alignItems: 'center', gap: 8, paddingTop: 8 },
  status: { fontSize: 16, color: ui.text, textAlign: 'center' },
  primary: { backgroundColor: ui.accent, borderRadius: 8, paddingVertical: 14, alignItems: 'center', marginTop: 6 },
  primaryText: { color: ui.accentText, fontSize: 16, fontWeight: '700' },
  secondary: { borderRadius: 8, paddingVertical: 12, paddingHorizontal: 32, borderWidth: 1, borderColor: ui.border },
  secondaryText: { color: ui.text, fontWeight: '700' },
  error: { color: '#b3261e' },
  note: { color: ui.subtle, fontSize: 12, paddingHorizontal: 4 },
});
