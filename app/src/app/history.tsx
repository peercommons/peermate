// Saved games, newest first. Finished games open in review; unfinished ones resume.
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { describeRecordResult, formatDate } from '../game/format';
import { listGames, type GameRecord } from '../storage/games';
import { ui } from '../theme';

export default function HistoryScreen() {
  const [games, setGames] = useState<GameRecord[] | null>(null);

  // Reload whenever the screen comes back into view (games may have been added or deleted).
  useFocusEffect(
    useCallback(() => {
      listGames().then(setGames).catch(() => setGames([]));
    }, []),
  );

  if (games && games.length === 0) {
    return <Text style={styles.empty}>No games yet. Finished and unfinished games appear here.</Text>;
  }

  return (
    <FlatList
      data={games ?? []}
      keyExtractor={(g) => g.id}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => (
        <Pressable
          onPress={() =>
            item.winner
              ? router.push({ pathname: '/review', params: { id: item.id } })
              : router.push({ pathname: '/game', params: { resume: item.id } })
          }
          style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.title}>
              {item.white} vs {item.black}
            </Text>
            <Text style={[styles.result, !item.winner && styles.unfinished]}>{describeRecordResult(item)}</Text>
            <Text style={styles.meta}>
              {formatDate(item.startedAt)} · {Math.ceil(item.plies / 2)} moves
              {item.analysis ? ' · analysed' : ''}
            </Text>
          </View>
          <Text style={styles.chevron}>{item.winner ? 'Review ›' : 'Continue ›'}</Text>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 12, gap: 8 },
  empty: { padding: 24, textAlign: 'center', color: ui.subtle },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.card,
    borderRadius: 10,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ui.border,
  },
  title: { fontSize: 15, fontWeight: '700', color: ui.text },
  result: { color: ui.accent, fontWeight: '600' },
  unfinished: { color: ui.mistake },
  meta: { color: ui.subtle, fontSize: 12 },
  chevron: { color: ui.accent, fontWeight: '700' },
});
