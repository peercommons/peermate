// Saved games, newest first. Finished games open in review; unfinished ones resume.
// Filter by kind of game; press and hold a game to delete it.
import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { describeRecordResult, formatDate } from '../game/format';
import { deleteGame, listGames, type GameRecord } from '../storage/games';
import { ui } from '../theme';

type Filter = 'all' | GameRecord['mode'];
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'cpu', label: 'Computer' },
  { key: 'online', label: 'Online' },
  { key: 'local', label: 'Pass & play' },
];

function kindOf(g: GameRecord): string {
  if (g.mode === 'cpu') return `Computer${g.level ? ` · level ${g.level}` : ''}`;
  return g.mode === 'online' ? 'Online' : 'Pass & play';
}

/** Won / Lost / Draw from the player's side, where there is one (computer and online games). */
function verdict(g: GameRecord): { text: string; tone: 'won' | 'lost' | 'draw' } | null {
  if (!g.winner || !g.player || g.mode === 'local') return null;
  if (g.winner === 'draw') return { text: 'Draw', tone: 'draw' };
  return g.winner === g.player ? { text: 'Won', tone: 'won' } : { text: 'Lost', tone: 'lost' };
}

export default function HistoryScreen() {
  const [games, setGames] = useState<GameRecord[] | null>(null);
  const [chosen, setFilter] = useState<Filter>('all');

  const load = useCallback(() => {
    listGames().then(setGames).catch(() => setGames([]));
  }, []);
  // Reload whenever the screen comes back into view (games may have been added or deleted).
  useFocusEffect(load);

  const confirmDelete = (g: GameRecord) =>
    Alert.alert('Delete this game?', `${g.white} vs ${g.black}, ${formatDate(g.startedAt)}. This can't be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void deleteGame(g.id).then(load) },
    ]);

  if (games && games.length === 0) {
    return <Text style={styles.empty}>No games yet. Finished and unfinished games appear here.</Text>;
  }

  // Only the kinds you've actually played get a filter (no empty "Online" for an offline player).
  const kinds = new Set((games ?? []).map((g) => g.mode));
  const filters = FILTERS.filter((f) => f.key === 'all' || kinds.has(f.key));
  // Deleting the last game of a kind removes its filter: fall back to All.
  const filter: Filter = filters.some((f) => f.key === chosen) ? chosen : 'all';
  const shown = (games ?? []).filter((g) => filter === 'all' || g.mode === filter);

  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      data={shown}
      keyExtractor={(g) => g.id}
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        filters.length > 2 ? (
          <View style={styles.filters} accessibilityRole="tablist">
            {filters.map((f) => {
              const selected = f.key === filter;
              return (
                <Pressable
                  key={f.key}
                  onPress={() => setFilter(f.key)}
                  style={[styles.chip, selected && styles.chipSelected]}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{f.label}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : undefined
      }
      ListFooterComponent={
        games && games.length > 0 ? <Text style={styles.hint}>Press and hold a game to delete it.</Text> : undefined
      }
      renderItem={({ item }) => {
        const v = verdict(item);
        return (
          <Pressable
            onPress={() =>
              item.winner
                ? router.push({ pathname: '/review', params: { id: item.id } })
                : router.push({ pathname: '/game', params: { resume: item.id } })
            }
            onLongPress={() => confirmDelete(item)}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            accessibilityHint="Press and hold to delete"
            accessibilityActions={[{ name: 'delete', label: 'Delete game' }]}
            onAccessibilityAction={(e) => e.nativeEvent.actionName === 'delete' && confirmDelete(item)}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.title}>
                {item.white} vs {item.black}
              </Text>
              <Text style={[styles.result, !item.winner && styles.unfinished]}>
                {v && <Text style={styles[v.tone]}>{v.text} · </Text>}
                {describeRecordResult(item)}
              </Text>
              <Text style={styles.meta}>
                {kindOf(item)} · {formatDate(item.startedAt)} · {Math.ceil(item.plies / 2)} moves
                {item.analysis ? ' · analysed' : ''}
              </Text>
            </View>
            <Text style={styles.chevron}>{item.winner ? 'Review ›' : 'Continue ›'}</Text>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 12, gap: 8 },
  empty: { padding: 24, textAlign: 'center', color: ui.subtle },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.card,
  },
  chipSelected: { backgroundColor: ui.accent, borderColor: ui.accent },
  chipText: { color: ui.text, fontWeight: '600' },
  chipTextSelected: { color: ui.accentText },
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
  won: { color: ui.accent, fontWeight: '700' },
  lost: { color: '#b3261e', fontWeight: '700' },
  draw: { color: ui.subtle, fontWeight: '700' },
  meta: { color: ui.subtle, fontSize: 12 },
  chevron: { color: ui.accent, fontWeight: '700' },
  hint: { textAlign: 'center', color: ui.subtle, fontSize: 12, paddingVertical: 8 },
});
