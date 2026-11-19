// Home: start a game vs the CPU or pass & play (SPECS §2.1).
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { LEVELS } from '@peermate/core';
import { latestUnfinished, type GameRecord } from '../storage/games';
import { formatDate } from '../game/format';
import { ui } from '../theme';
import { engineAvailable, ENGINE_UNAVAILABLE } from '../engine/arasan';
import { useOnline } from '../net/online';

type ColorChoice = 'w' | 'b' | 'random';

export default function Home() {
  const [level, setLevel] = useState(3);
  const [color, setColor] = useState<ColorChoice>('w');
  const [unfinished, setUnfinished] = useState<GameRecord | null>(null);

  useFocusEffect(
    useCallback(() => {
      latestUnfinished().then(setUnfinished).catch(() => setUnfinished(null));
    }, []),
  );

  const playCpu = () => {
    const player = color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : color;
    router.push({ pathname: '/game', params: { mode: 'cpu', level: String(level), player } });
  };

  const selected = LEVELS[level - 1];
  const onlineState = useOnline();
  const liveOnline = onlineState.phase === 'game' && !onlineState.end ? onlineState : null;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.root}>
      {liveOnline && (
        <View style={[styles.card, styles.continueCard]}>
          <Text style={styles.heading}>Online game in progress</Text>
          <Text style={styles.subtle}>
            {liveOnline.tc} vs {liveOnline.opponent.nick}
          </Text>
          <PrimaryButton label="Return to game" onPress={() => router.push('/online-game')} />
        </View>
      )}
      {unfinished && (
        <View style={[styles.card, styles.continueCard]}>
          <Text style={styles.heading}>Continue game</Text>
          <Text style={styles.subtle}>
            {unfinished.white} vs {unfinished.black} · move {Math.ceil(unfinished.plies / 2)} · {formatDate(unfinished.updatedAt)}
          </Text>
          <PrimaryButton
            label="Continue"
            onPress={() => router.push({ pathname: '/game', params: { resume: unfinished.id } })}
          />
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.heading}>Play the computer</Text>

        <Text style={styles.label}>
          Level {selected.level} · {selected.label}
        </Text>
        <Text style={styles.subtle}>{selected.blurb}</Text>
        <View style={styles.levels}>
          {LEVELS.map((l) => (
            <Chip key={l.level} label={String(l.level)} selected={l.level === level} onPress={() => setLevel(l.level)} />
          ))}
        </View>

        <Text style={styles.label}>Play as</Text>
        <View style={styles.row}>
          <Chip label="White" selected={color === 'w'} onPress={() => setColor('w')} />
          <Chip label="Black" selected={color === 'b'} onPress={() => setColor('b')} />
          <Chip label="Random" selected={color === 'random'} onPress={() => setColor('random')} />
        </View>

        {engineAvailable ? (
          <PrimaryButton label="Start game" onPress={playCpu} />
        ) : (
          <Text style={styles.subtle}>{ENGINE_UNAVAILABLE}.</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Pass & play</Text>
        <Text style={styles.subtle}>Two players on this device. The board turns for each move.</Text>
        <PrimaryButton
          label="Start game"
          onPress={() => router.push({ pathname: '/game', params: { mode: 'local' } })}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Play online</Text>
        <Text style={styles.subtle}>Find an opponent anywhere. Games run directly between phones, with no server.</Text>
        <PrimaryButton label="Find an opponent" onPress={() => router.push('/online')} />
      </View>

    </ScrollView>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function PrimaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.primary, pressed && { opacity: 0.7 }]}>
      <Text style={styles.primaryText}>{label}</Text>
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
  label: { fontSize: 15, fontWeight: '600', color: ui.text, marginTop: 4 },
  subtle: { color: ui.subtle, fontWeight: '400' },
  levels: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  row: { flexDirection: 'row', gap: 8 },
  chip: {
    minWidth: 44,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
    alignItems: 'center',
  },
  chipSelected: { backgroundColor: ui.accent, borderColor: ui.accent },
  chipText: { color: ui.text, fontWeight: '600' },
  chipTextSelected: { color: ui.accentText },
  primary: { backgroundColor: ui.accent, borderRadius: 8, paddingVertical: 14, alignItems: 'center', marginTop: 6 },
  primaryText: { color: ui.accentText, fontSize: 16, fontWeight: '700' },
  continueCard: { borderColor: ui.accent, borderWidth: 1.5 },
});
