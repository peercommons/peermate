// Online game screen (SPECS §2.4, §6, §8.1). Reads the running GameSession from
// the online controller; moves go out over the P2P connection.
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Stack, router } from 'expo-router';
import { ScreenView } from '../components/ScreenView';
import * as Haptics from 'expo-haptics';
import {
  AWAY_AFTER_MS,
  checkedKingSquare,
  describeOutcome,
  isPromotion,
  legalTargets,
  type Color,
  type PieceSymbol,
  type Square,
} from '@peermate/core';
import { Board } from '../components/Board';
import { PromotionPicker } from '../components/PromotionPicker';
import { formatMoves } from '../game/format';
import { online, QUICK_TEXT, useOnline, type Connection } from '../net/online';
import { useSettings } from '../settings';
import { BOARD_THEMES, ui } from '../theme';

const BADGE_COLOR: Record<Connection, string> = { direct: '#2e7d32', relayed: '#f9a825', reconnecting: '#c62828' };

const QUICK_ORDER = ['hi', 'gl', 'hf', 'gg', 'thanks', 'wp', 'oops'] as const;

function formatClock(ms: number): string {
  const t = Math.max(0, ms);
  if (t < 10_000) return `0:0${(t / 1000).toFixed(1)}`;
  const s = Math.ceil(t / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function OnlineGameScreen() {
  const state = useOnline();
  const session = online.session;
  const { settings } = useSettings();
  const { width } = useWindowDimensions();
  const boardSize = Math.min(width - 16, 560);
  const [selected, setSelected] = useState<Square | null>(null);
  const [promotion, setPromotion] = useState<{ from: Square; to: Square } | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [, setTick] = useState(0);

  // Clocks: re-render a few times a second while the game runs.
  const running = state.phase === 'game' && !state.end;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 200);
    return () => clearInterval(t);
  }, [running]);

  // Haptic tap on every move (either side).
  const ply = session?.ply ?? 0;
  const prevPly = useRef(ply);
  useEffect(() => {
    if (ply > prevPly.current && settings.haptics) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    }
    prevPly.current = ply;
    setSelected(null);
  }, [ply, settings.haptics]);

  // Claim the win as soon as the opponent's clock runs out (they must confirm).
  useEffect(() => {
    const s = online.session;
    if (!s || s.end || s.myTurn || !s.clocksRunning) return;
    if (s.clocks()[s.myColor === 'w' ? 'b' : 'w'] <= 0) online.claimFlag();
  });

  if (state.phase !== 'game' || !session) {
    return (
      <View style={styles.center}>
        <Text style={styles.status}>No online game right now.</Text>
        <Pressable onPress={() => router.replace('/online')} style={styles.control}>
          <Text style={styles.controlText}>Go to lobby</Text>
        </Pressable>
      </View>
    );
  }

  const me = state.myColor;
  const them: Color = me === 'w' ? 'b' : 'w';
  const clocks = session.clocks();
  const orientation: Color = flipped ? them : me;
  const top = orientation === 'w' ? 'b' : 'w';
  const myTurn = session.myTurn;
  const history = session.chess.history({ verbose: true });
  const last = history.at(-1);


  const play = (from: Square, to: Square, promo?: PieceSymbol) => {
    online.move(`${from}${to}${promo ?? ''}`);
    setSelected(null);
  };
  const tryPlay = (from: Square, to: Square) => {
    if (!legalTargets(session.chess, from).includes(to)) return false;
    if (isPromotion(session.chess, from, to)) setPromotion({ from, to });
    else play(from, to);
    return true;
  };
  const onSquarePress = (sq: Square) => {
    if (!myTurn) return;
    if (selected && selected !== sq && tryPlay(selected, sq)) return;
    const piece = session.chess.get(sq);
    setSelected(piece && piece.color === me && sq !== selected ? sq : null);
  };

  const names: Record<Color, string> = { [me]: 'You', [them]: state.opponent.nick } as Record<Color, string>;
  const confirm = (title: string, action: () => void) =>
    Alert.alert(title, undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: title, style: 'destructive', onPress: action },
    ]);

  let status: string;
  if (state.end) {
    status = state.end.aborted
      ? 'Game aborted'
      : state.end.unconfirmed && state.end.outcome
        ? `${describeOutcome(state.end.outcome)} (opponent left; not confirmed by them)`
      : state.end.violation
        ? `Opponent broke the rules (${state.end.violation}). You win.`
        : state.end.outcome
          ? describeOutcome(state.end.outcome)
          : 'Game over';
  } else if (state.connection === 'reconnecting') {
    status = 'Connection lost, reconnecting…';
  } else {
    status = myTurn ? 'Your move' : `${state.opponent.nick} is thinking`;
    if (state.connection === 'relayed') status += ' · via relays';
  }
  const silent = running ? session.silenceMs() : 0;
  const away = silent >= AWAY_AFTER_MS;

  return (
    <ScreenView style={styles.root}>
      <Stack.Screen options={{ title: `${state.tc} vs ${state.opponent.nick}` }} />

      <PlayerBar
        name={names[top]}
        sub={top === them ? state.opponent.fingerprint : undefined}
        clock={formatClock(clocks[top])}
        active={running && session.chess.turn() === top}
        low={clocks[top] < 20_000}
        badge={top === them ? state.connection : undefined}
      />
      <View style={styles.boardWrap}>
        <Board
          position={session.chess.board().map((r) => r.map((p) => (p ? { type: p.type, color: p.color } : null)))}
          size={boardSize}
          orientation={orientation}
          selected={selected}
          targets={settings.showLegalMoves && selected ? legalTargets(session.chess, selected) : []}
          lastMove={last ? { from: last.from, to: last.to } : null}
          checkSquare={checkedKingSquare(session.chess)}
          onSquarePress={onSquarePress}
          movableColor={myTurn ? me : null}
          onDragStart={(sq) => myTurn && session.chess.get(sq)?.color === me && setSelected(sq)}
          onDrop={(from, to) => tryPlay(from, to)}
          disabled={!myTurn}
          colors={BOARD_THEMES[settings.boardTheme]}
          showCoordinates={settings.showCoordinates}
        />
      </View>
      <PlayerBar
        name={names[orientation]}
        clock={formatClock(clocks[orientation])}
        active={running && session.chess.turn() === orientation}
        low={clocks[orientation] < 20_000}
      />

      <Text style={[styles.status, state.end && styles.final]} accessibilityLiveRegion="polite">
        {status}
      </Text>
      {state.notice && <Text style={styles.notice}>{state.notice}</Text>}
      {away && (
        <Text style={styles.notice}>
          {state.opponent.nick} hasn't responded for {Math.floor(silent / 1000)} s
          {session.canClaimAbandonment ? '' : ' (you can claim the win after 60 s)'}
        </Text>
      )}
      {away && session.canClaimAbandonment && (
        <View style={styles.controls}>
          <Control label="Claim win" onPress={() => confirm('Claim win', () => online.claimAbandonment())} />
        </View>
      )}

      {state.drawOffered && !state.end && (
        <View style={styles.controls}>
          <Control label="Accept draw" onPress={() => online.respondDraw(true)} />
          <Control label="Decline" onPress={() => online.respondDraw(false)} />
        </View>
      )}

      <ScrollView style={styles.panel} contentContainerStyle={styles.panelContent}>
        <Text style={styles.moves} selectable>
          {formatMoves(session.chess.history()) || 'No moves yet.'}
        </Text>
        {state.chat.slice(-4).map((c) => (
          <Text key={c.at + c.text} style={styles.chatLine}>
            <Text style={styles.chatFrom}>{c.from === 'me' ? 'You' : state.opponent.nick}: </Text>
            {c.text}
          </Text>
        ))}
      </ScrollView>

      <ScrollView horizontal style={styles.quickRow} contentContainerStyle={{ gap: 6 }} showsHorizontalScrollIndicator={false}>
        {QUICK_ORDER.map((q) => (
          <Pressable key={q} onPress={() => online.chat({ quick: q })} style={styles.quick}>
            <Text style={styles.quickText}>{QUICK_TEXT[q]}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <View style={styles.controls}>
        {state.end ? (
          <>
            <Control
              label="New opponent"
              onPress={() => {
                online.leave();
                online.seek(state.tc);
                router.replace('/online');
              }}
            />
            {!state.end.aborted && (
              <Control
                label="Review"
                onPress={() => {
                  const id = online.gameId;
                  online.leave();
                  router.replace({ pathname: '/review', params: { id } });
                }}
              />
            )}
            <Control
              label="Done"
              onPress={() => {
                online.leave();
                router.replace('/');
              }}
            />
          </>
        ) : (
          <>
            {session.canAbort ? (
              <Control label="Abort" onPress={() => confirm('Abort', () => online.abort())} />
            ) : (
              <Control label="Resign" onPress={() => confirm('Resign', () => online.resign())} />
            )}
            <Control label="Offer draw" onPress={() => online.offerDraw()} disabled={myTurn || session.canAbort} />
            <Control label="Flip" onPress={() => setFlipped((f) => !f)} />
          </>
        )}
      </View>

      <PromotionPicker
        color={promotion ? me : null}
        onChoose={(p) => {
          if (promotion && p) play(promotion.from, promotion.to, p);
          setPromotion(null);
        }}
      />
    </ScreenView>
  );
}

function PlayerBar(p: {
  name: string;
  sub?: string;
  clock: string;
  active: boolean;
  low: boolean;
  badge?: Connection;
}) {
  return (
    <View style={styles.playerBar}>
      <View style={{ flex: 1 }}>
        <Text style={styles.playerName} numberOfLines={1}>
          {p.badge && <Text style={{ color: BADGE_COLOR[p.badge] }}>● </Text>}
          {p.name}
        </Text>
        {p.sub && <Text style={styles.sub}>{p.sub}</Text>}
      </View>
      <Text
        style={[styles.clock, p.active && styles.clockActive, p.active && p.low && styles.clockLow]}
        accessibilityLabel={`${p.name} clock ${p.clock}`}
      >
        {p.clock}
      </Text>
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  boardWrap: { alignItems: 'center' },
  playerBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  playerName: { fontSize: 15, fontWeight: '600', color: ui.text },
  sub: { fontSize: 11, color: ui.subtle },
  clock: {
    fontSize: 20,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    color: ui.subtle,
    paddingHorizontal: 10,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: ui.card,
  },
  clockActive: { color: ui.accentText, backgroundColor: ui.accent },
  clockLow: { backgroundColor: '#c62828' },
  status: { fontSize: 16, textAlign: 'center', color: ui.text },
  final: { fontWeight: '700', color: ui.accent },
  notice: { textAlign: 'center', color: ui.mistake, fontWeight: '600' },
  panel: { flex: 1, backgroundColor: ui.card, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: ui.border },
  panelContent: { padding: 10, gap: 4 },
  moves: { fontSize: 14, lineHeight: 22, color: ui.text },
  chatLine: { fontSize: 14, color: ui.text },
  chatFrom: { fontWeight: '700' },
  quickRow: { flexGrow: 0 },
  quick: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: ui.border },
  quickText: { color: ui.text },
  controls: { flexDirection: 'row', gap: 8, paddingBottom: 8 },
  control: { flex: 1, backgroundColor: ui.accent, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 12, alignItems: 'center' },
  controlText: { color: ui.accentText, fontWeight: '700' },
});
