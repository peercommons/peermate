// Game screen: board, status, moves and controls for an offline game.
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { describeOutcome, getLevel, type Color } from '@peermate/core';
import { Board } from '../components/Board';
import { PromotionPicker } from '../components/PromotionPicker';
import { useGame, type GameMode } from '../game/useGame';
import { ui } from '../theme';

export default function GameScreen() {
  const params = useLocalSearchParams<{ mode?: string; level?: string; player?: string }>();
  const mode = useMemo<GameMode>(
    () =>
      params.mode === 'cpu'
        ? {
            kind: 'cpu',
            level: Math.min(10, Math.max(1, Number(params.level) || 3)),
            player: params.player === 'b' ? 'b' : 'w',
          }
        : { kind: 'local' },
    [params.mode, params.level, params.player],
  );

  const game = useGame(mode);
  const { width } = useWindowDimensions();
  const boardSize = Math.min(width - 16, 560);
  const [flipped, setFlipped] = useState(false);

  // vs CPU: your colour at the bottom. Pass & play: the side to move at the bottom.
  const base: Color = mode.kind === 'cpu' ? mode.player : game.turn;
  const orientation: Color = flipped ? (base === 'w' ? 'b' : 'w') : base;
  const top = orientation === 'w' ? 'b' : 'w';

  const title = mode.kind === 'cpu' ? `vs CPU · Level ${mode.level} (${getLevel(mode.level).label})` : 'Pass & play';

  return (
    <SafeAreaView style={styles.root} edges={['bottom', 'left', 'right']}>
      <Stack.Screen options={{ title }} />

      <PlayerBar name={game.names[top]} active={!game.result && game.turn === top} thinking={game.thinking && game.turn === top} />

      <View style={styles.boardWrap}>
        <Board
          position={game.position}
          size={boardSize}
          orientation={orientation}
          selected={game.selected}
          targets={game.targets}
          lastMove={game.lastMove}
          checkSquare={game.checkSquare}
          onSquarePress={game.onSquarePress}
          disabled={!game.humanToMove}
        />
      </View>

      <PlayerBar
        name={game.names[orientation]}
        active={!game.result && game.turn === orientation}
        thinking={game.thinking && game.turn === orientation}
      />

      <Status game={game} />

      <ScrollView style={styles.moves} contentContainerStyle={styles.movesContent}>
        <Text style={styles.movesText} selectable>
          {formatMoves(game.sanMoves) || 'No moves yet.'}
        </Text>
      </ScrollView>

      <View style={styles.controls}>
        {game.result ? (
          <Control label="New game" onPress={game.newGame} />
        ) : (
          <Control label="Resign" onPress={game.resign} disabled={game.sanMoves.length === 0} />
        )}
        <Control label="Undo" onPress={game.undo} disabled={!game.canUndo} />
        <Control label="Flip" onPress={() => setFlipped((f) => !f)} />
        <Control label="Share PGN" onPress={() => Share.share({ message: game.pgn() })} disabled={game.sanMoves.length === 0} />
      </View>

      <PromotionPicker color={game.promotionColor} onChoose={game.choosePromotion} />
    </SafeAreaView>
  );
}

function Status({ game }: { game: ReturnType<typeof useGame> }) {
  let text: string;
  let tone: 'normal' | 'alert' | 'final' = 'normal';
  if (game.engineError) {
    text = `CPU unavailable: ${game.engineError}`;
    tone = 'alert';
  } else if (game.result) {
    text = describeOutcome(game.result);
    tone = 'final';
  } else if (game.thinking) {
    text = 'CPU is thinking…';
  } else {
    text = `${game.turn === 'w' ? 'White' : 'Black'} to move${game.checkSquare ? ' · Check!' : ''}`;
    if (game.checkSquare) tone = 'alert';
  }
  return (
    <Text style={[styles.status, tone === 'alert' && styles.alert, tone === 'final' && styles.final]} accessibilityLiveRegion="polite">
      {text}
    </Text>
  );
}

function PlayerBar({ name, active, thinking }: { name: string; active: boolean; thinking: boolean }) {
  return (
    <View style={styles.playerBar}>
      <View style={[styles.dot, active && styles.dotActive]} />
      <Text style={styles.playerName}>{name}</Text>
      {thinking && <Text style={styles.subtle}>thinking…</Text>}
    </View>
  );
}

function Control({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.control, (pressed || disabled) && { opacity: 0.45 }]}
    >
      <Text style={styles.controlText}>{label}</Text>
    </Pressable>
  );
}

/** "1. e4 e5 2. Nf3 Nc6 ..." */
function formatMoves(san: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < san.length; i += 2) {
    parts.push(`${i / 2 + 1}. ${san[i]}${san[i + 1] ? ` ${san[i + 1]}` : ''}`);
  }
  return parts.join('  ');
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 8, paddingTop: 8, gap: 6 },
  boardWrap: { alignItems: 'center' },
  playerBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: ui.border },
  dotActive: { backgroundColor: ui.accent },
  playerName: { fontSize: 15, fontWeight: '600', color: ui.text },
  subtle: { color: ui.subtle },
  status: { fontSize: 16, textAlign: 'center', color: ui.text, paddingVertical: 4 },
  alert: { color: '#b3261e', fontWeight: '600' },
  final: { fontWeight: '700', color: ui.accent },
  moves: { flex: 1, backgroundColor: ui.card, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: ui.border },
  movesContent: { padding: 10 },
  movesText: { fontSize: 14, lineHeight: 22, color: ui.text },
  controls: { flexDirection: 'row', gap: 8, paddingBottom: 8 },
  control: { flex: 1, backgroundColor: ui.accent, borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  controlText: { color: ui.accentText, fontWeight: '700' },
});
