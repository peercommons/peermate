// Review a saved game move by move, with optional engine analysis (SPECS §2.5).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { ScreenView } from '../components/ScreenView';
import {
  ARASAN_CP_SCALE,
  Chess,
  JUDGMENT_SYMBOL,
  normalize,
  formatScore,
  parseUci,
  reviewGame,
  summarize,
  terminalScore,
  winChance,
  type Color,
  type Judgment,
  type Move,
  type Score,
} from '@peermate/core';
import { Board } from '../components/Board';
import { analyse, engineAvailable } from '../engine/arasan';
import { describeRecordResult, formatDate } from '../game/format';
import { deleteGame, getGame, saveAnalysis, type GameRecord } from '../storage/games';
import { useSettings } from '../settings';
import { BOARD_THEMES, ui } from '../theme';

/** Cached in the games table (JSON). Evals are RAW engine scores. Bump `v` if the format changes. */
type StoredAnalysis = { v: 1; movetimeMs: number; evals: Score[]; best: (string | null)[] };

const MOVETIME_MS = 250;

export default function ReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [record, setRecord] = useState<GameRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    getGame(id)
      .then((g) => (g ? setRecord(g) : setError('Game not found')))
      .catch((err) => setError(String(err?.message ?? err)));
  }, [id]);

  if (error) return <Text style={styles.error}>{error}</Text>;
  if (!record) return <ActivityIndicator style={{ marginTop: 40 }} color={ui.accent} />;
  return <ReviewView record={record} />;
}

function ReviewView({ record }: { record: GameRecord }) {
  const { settings } = useSettings();
  const { width } = useWindowDimensions();
  const boardSize = Math.min(width - 16, 560);

  // All moves (with before/after FENs) from the stored PGN.
  const moves = useMemo<Move[]>(() => {
    const c = new Chess();
    c.loadPgn(record.pgn);
    return c.history({ verbose: true });
  }, [record.pgn]);
  const fens = useMemo(
    () => (moves.length ? [moves[0].before, ...moves.map((m) => m.after)] : [new Chess().fen()]),
    [moves],
  );

  const [ply, setPly] = useState(moves.length); // 0 = start, k = after k moves
  const [flipped, setFlipped] = useState(record.player === 'b');
  const [analysis, setAnalysis] = useState<StoredAnalysis | null>(() => parseAnalysis(record.analysis));
  const [progress, setProgress] = useState<number | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const cancelled = useRef(false);
  useEffect(() => () => void (cancelled.current = true), []);

  const reviews = useMemo(() => (analysis ? reviewGame(analysis.evals, ARASAN_CP_SCALE) : null), [analysis]);
  const summary = useMemo(() => (reviews ? summarize(reviews) : null), [reviews]);

  const runAnalysis = useCallback(async () => {
    setAnalysisError(null);
    setProgress(0);
    try {
      const evals: Score[] = [];
      const best: (string | null)[] = [];
      for (let i = 0; i < fens.length; i++) {
        if (cancelled.current) return;
        const pos = new Chess(fens[i]);
        if (pos.isGameOver()) {
          evals.push(terminalScore(pos.turn(), pos.isCheckmate()));
          best.push(null);
        } else {
          const r = await analyse(fens[i], MOVETIME_MS);
          evals.push(r.score);
          best.push(r.bestMove ? (pos.move(parseUci(r.bestMove))?.san ?? null) : null);
        }
        setProgress((i + 1) / fens.length);
      }
      const result: StoredAnalysis = { v: 1, movetimeMs: MOVETIME_MS, evals, best };
      await saveAnalysis(record.id, JSON.stringify(result));
      if (!cancelled.current) setAnalysis(result);
    } catch (err) {
      if (!cancelled.current) setAnalysisError(String((err as Error)?.message ?? err));
    } finally {
      if (!cancelled.current) setProgress(null);
    }
  }, [fens, record.id]);

  const position = useMemo(
    () => new Chess(fens[ply]).board().map((row) => row.map((p) => (p ? { type: p.type, color: p.color } : null))),
    [fens, ply],
  );
  const last = ply > 0 ? moves[ply - 1] : null;
  const lastReview = ply > 0 && reviews ? reviews[ply - 1] : null;
  const bestInstead = ply > 0 && analysis && lastReview?.judgment ? analysis.best[ply - 1] : null;
  const evalHere = analysis ? normalize(analysis.evals[ply], ARASAN_CP_SCALE) : null;

  const confirmDelete = () =>
    Alert.alert('Delete this game?', 'It will be removed from your history.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => deleteGame(record.id).then(() => router.back()),
      },
    ]);

  return (
    <ScreenView style={styles.root}>
      <Stack.Screen options={{ title: 'Review' }} />
      <Text style={styles.heading}>
        {record.white} vs {record.black}
      </Text>
      <Text style={styles.subtle}>
        {describeRecordResult(record)} · {formatDate(record.startedAt)}
      </Text>

      {evalHere && <EvalBar score={evalHere} />}

      <View style={styles.boardWrap}>
        <Board
          position={position}
          size={boardSize}
          orientation={flipped ? 'b' : 'w'}
          selected={null}
          targets={[]}
          lastMove={last ? { from: last.from, to: last.to } : null}
          checkSquare={null}
          onSquarePress={() => undefined}
          colors={BOARD_THEMES[settings.boardTheme]}
          showCoordinates={settings.showCoordinates}
        />
      </View>

      <View style={styles.nav}>
        <NavButton label="⏮" onPress={() => setPly(0)} disabled={ply === 0} />
        <NavButton label="◀" onPress={() => setPly((p) => Math.max(0, p - 1))} disabled={ply === 0} />
        <Text style={styles.plyText}>
          {ply === 0 ? 'Start' : `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '…'} ${last?.san}`}
          {lastReview?.judgment ? ` ${JUDGMENT_SYMBOL[lastReview.judgment]}` : ''}
        </Text>
        <NavButton label="▶" onPress={() => setPly((p) => Math.min(moves.length, p + 1))} disabled={ply === moves.length} />
        <NavButton label="⏭" onPress={() => setPly(moves.length)} disabled={ply === moves.length} />
        <NavButton label="⇅" onPress={() => setFlipped((f) => !f)} />
      </View>

      {lastReview?.judgment && (
        <Text style={[styles.judgment, { color: ui[lastReview.judgment] }]}>
          {capitalize(lastReview.judgment)}
          {bestInstead ? ` · best was ${bestInstead}` : ''}
        </Text>
      )}

      <ScrollView style={styles.moves} contentContainerStyle={styles.moveList}>
        {moves.map((m, i) => (
          <Pressable key={i} onPress={() => setPly(i + 1)} style={[styles.moveChip, ply === i + 1 && styles.moveChipActive]}>
            <Text style={[styles.moveText, ply === i + 1 && styles.moveTextActive]}>
              {i % 2 === 0 ? `${i / 2 + 1}. ` : ''}
              {m.san}
              {reviews?.[i]?.judgment && (
                <Text style={{ color: ui[reviews[i].judgment as Judgment], fontWeight: '700' }}>
                  {JUDGMENT_SYMBOL[reviews[i].judgment as Judgment]}
                </Text>
              )}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {summary && <Summary summary={summary} names={{ w: record.white, b: record.black }} />}

      <View style={styles.actions}>
        {!analysis &&
          (progress === null ? (
            <Action label={`Analyse (~${Math.ceil((fens.length * MOVETIME_MS) / 1000)} s)`} onPress={runAnalysis} disabled={moves.length === 0 || !engineAvailable} />
          ) : (
            <View style={styles.progress}>
              <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
              <Text style={styles.progressText}>Analysing… {Math.round(progress * 100)}%</Text>
            </View>
          ))}
        {!record.winner && (
          <Action label="Continue" onPress={() => router.replace({ pathname: '/game', params: { resume: record.id } })} />
        )}
        <Action label="Delete" onPress={confirmDelete} tone="danger" />
      </View>
      {analysisError && <Text style={styles.error}>Analysis failed: {analysisError}</Text>}
    </ScreenView>
  );
}

function EvalBar({ score }: { score: Score }) {
  const white = (winChance(score) + 1) / 2; // 0..1 share for White
  return (
    <View style={styles.evalBar} accessibilityLabel={`Evaluation ${formatScore(score)}`}>
      <View style={[styles.evalWhite, { flex: white }]} />
      <View style={[styles.evalBlack, { flex: 1 - white }]} />
      <Text style={styles.evalText}>{formatScore(score)}</Text>
    </View>
  );
}

function Summary({
  summary,
  names,
}: {
  summary: Record<Color, Record<Judgment, number>>;
  names: Record<Color, string>;
}) {
  return (
    <View style={styles.summary}>
      {(['w', 'b'] as const).map((c) => (
        <Text key={c} style={styles.summaryText}>
          <Text style={{ fontWeight: '700' }}>{names[c]}</Text>
          {`: `}
          <Text style={{ color: ui.inaccuracy }}>{plural(summary[c].inaccuracy, 'inaccuracy', 'inaccuracies')}</Text>
          {', '}
          <Text style={{ color: ui.mistake }}>{plural(summary[c].mistake, 'mistake', 'mistakes')}</Text>
          {', '}
          <Text style={{ color: ui.blunder }}>{plural(summary[c].blunder, 'blunder', 'blunders')}</Text>
        </Text>
      ))}
    </View>
  );
}

function NavButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [styles.navButton, (pressed || disabled) && { opacity: 0.4 }]}>
      <Text style={styles.navText}>{label}</Text>
    </Pressable>
  );
}

function Action({ label, onPress, disabled, tone }: { label: string; onPress: () => void; disabled?: boolean; tone?: 'danger' }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.action, tone === 'danger' && styles.danger, (pressed || disabled) && { opacity: 0.5 }]}
    >
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

function parseAnalysis(json: string | null): StoredAnalysis | null {
  if (!json) return null;
  try {
    const a = JSON.parse(json);
    return a?.v === 1 ? a : null;
  } catch {
    return null;
  }
}

const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 8, paddingTop: 8, gap: 6 },
  heading: { fontSize: 16, fontWeight: '700', color: ui.text, paddingHorizontal: 4 },
  subtle: { color: ui.subtle, paddingHorizontal: 4 },
  error: { color: ui.blunder, padding: 16 },
  boardWrap: { alignItems: 'center' },
  evalBar: { height: 18, flexDirection: 'row', borderRadius: 4, overflow: 'hidden', borderWidth: 1, borderColor: ui.border },
  evalWhite: { backgroundColor: '#f4f4f0' },
  evalBlack: { backgroundColor: '#333' },
  evalText: { position: 'absolute', alignSelf: 'center', left: 0, right: 0, textAlign: 'center', fontSize: 12, fontWeight: '700', color: '#888' },
  nav: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  navButton: { backgroundColor: ui.accent, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 12 },
  navText: { color: ui.accentText, fontSize: 16, fontWeight: '700' },
  plyText: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '600', color: ui.text },
  judgment: { textAlign: 'center', fontWeight: '700' },
  moves: { flex: 1, backgroundColor: ui.card, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: ui.border },
  moveList: { flexDirection: 'row', flexWrap: 'wrap', padding: 8, gap: 4 },
  moveChip: { paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4 },
  moveChipActive: { backgroundColor: ui.accent },
  moveText: { fontSize: 14, color: ui.text },
  moveTextActive: { color: ui.accentText },
  summary: { gap: 2, paddingHorizontal: 4 },
  summaryText: { fontSize: 13, color: ui.text },
  actions: { flexDirection: 'row', gap: 8, paddingBottom: 8 },
  action: { flex: 1, backgroundColor: ui.accent, borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  danger: { backgroundColor: ui.blunder, flex: 0, paddingHorizontal: 16 },
  actionText: { color: ui.accentText, fontWeight: '700' },
  progress: { flex: 1, height: 44, borderRadius: 8, backgroundColor: ui.border, overflow: 'hidden', justifyContent: 'center' },
  progressFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: ui.accent },
  progressText: { textAlign: 'center', fontWeight: '700', color: ui.text },
});
