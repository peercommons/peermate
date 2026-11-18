// Game screen: board, status, moves and controls for an offline game.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Share, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { describeOutcome, getLevel, type Color } from '@peermate/core';
import { Board } from '../components/Board';
import { PromotionPicker } from '../components/PromotionPicker';
import { useGame, type GameMode, type ResumeFrom } from '../game/useGame';
import { formatMoves } from '../game/format';
import { getGame } from '../storage/games';
import { useSettings } from '../settings';
import { BOARD_THEMES, ui } from '../theme';

export default function GameScreen() {
  const params = useLocalSearchParams<{ mode?: string; level?: string; player?: string; resume?: string }>();
  const [loaded, setLoaded] = useState<{ mode: GameMode; resume?: ResumeFrom } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (params.resume) {
      getGame(params.resume)
        .then((g) => {
          if (!g) throw new Error('Saved game not found');
          const mode: GameMode =
            g.mode === 'cpu' ? { kind: 'cpu', level: g.level ?? 3, player: g.player ?? 'w' } : { kind: 'local' };
          setLoaded({ mode, resume: { id: g.id, pgn: g.pgn, startedAt: g.startedAt } });
        })
        .catch((err) => setError(String(err?.message ?? err)));
      return;
    }
    const mode: GameMode =
      params.mode === 'cpu'
        ? {
            kind: 'cpu',
            level: Math.min(10, Math.max(1, Number(params.level) || 3)),
            player: params.player === 'b' ? 'b' : 'w',
          }
        : { kind: 'local' };
    setLoaded({ mode });
  }, [params.resume, params.mode, params.level, params.player]);

  if (error) return <Text style={[styles.status, styles.alert]}>{error}</Text>;
  if (!loaded) return <ActivityIndicator style={{ marginTop: 40 }} color={ui.accent} />;
  return <GameView mode={loaded.mode} resume={loaded.resume} />;
}

function GameView({ mode, resume }: { mode: GameMode; resume?: ResumeFrom }) {
  const game = useGame(mode, resume);
  const { settings } = useSettings();
  const { width } = useWindowDimensions();
  const boardSize = Math.min(width - 16, 560);
  const [flipped, setFlipped] = useState(false);

  // vs CPU: your colour at the bottom. Pass & play: the side to move (if auto-flip is on).
  const base: Color = mode.kind === 'cpu' ? mode.player : settings.autoFlip ? game.turn : 'w';
  const orientation: Color = flipped ? (base === 'w' ? 'b' : 'w') : base;
  const top = orientation === 'w' ? 'b' : 'w';

  // A tap on every move; a firmer one for captures, checks and mates.
  const lastSan = game.sanMoves.at(-1);
  const moveCount = game.sanMoves.length;
  const prevCount = useRef(moveCount);
  useEffect(() => {
    if (settings.haptics && moveCount > prevCount.current && lastSan) {
      const strong = /[x+#]/.test(lastSan);
      Haptics.impactAsync(strong ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(
        () => undefined,
      );
    }
    prevCount.current = moveCount;
  }, [moveCount, lastSan, settings.haptics]);

  const title = useMemo(
    () => (mode.kind === 'cpu' ? `vs CPU · Level ${mode.level} (${getLevel(mode.level).label})` : 'Pass & play'),
    [mode],
  );

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
          targets={settings.showLegalMoves ? game.targets : []}
          lastMove={game.lastMove}
          checkSquare={game.checkSquare}
          onSquarePress={game.onSquarePress}
          movableColor={game.humanToMove ? game.turn : null}
          onDragStart={game.onDragStart}
          onDrop={game.onDrop}
          disabled={!game.humanToMove}
          colors={BOARD_THEMES[settings.boardTheme]}
          showCoordinates={settings.showCoordinates}
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
          <>
            <Control label="New game" onPress={game.newGame} />
            <Control label="Review" onPress={() => router.push({ pathname: '/review', params: { id: game.gameId } })} />
          </>
        ) : (
          <>
            <Control label="Resign" onPress={game.resign} disabled={game.sanMoves.length === 0} />
            <Control label="Undo" onPress={game.undo} disabled={!game.canUndo} />
          </>
        )}
        <Control label="Flip" onPress={() => setFlipped((f) => !f)} />
        <Control label="Share" onPress={() => Share.share({ message: game.pgn() })} disabled={game.sanMoves.length === 0} />
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
