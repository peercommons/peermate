// Captured pieces and the material lead, shown next to a player's name: the
// opponent's pieces this side has taken (small, overlapping) and "+N" when this
// side is ahead (pawn 1, knight and bishop 3, rook 5, queen 9).
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Color, PieceSymbol } from '@peermate/core';
import { PieceIcon, type BoardPiece } from './Board';
import { ui } from '../theme';

const VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const START: Record<Exclude<PieceSymbol, 'k'>, number> = { q: 1, r: 2, b: 2, n: 2, p: 8 };
const ORDER = ['q', 'r', 'b', 'n', 'p'] as const;
const NAME: Record<(typeof ORDER)[number], [string, string]> = {
  q: ['queen', 'queens'],
  r: ['rook', 'rooks'],
  b: ['bishop', 'bishops'],
  n: ['knight', 'knights'],
  p: ['pawn', 'pawns'],
};

export type Material = {
  /** Pieces of the other colour that this colour has taken, most valuable first. */
  captured: Record<Color, PieceSymbol[]>;
  /** White's material minus Black's. */
  balance: number;
};

export function material(position: BoardPiece[][]): Material {
  const count = { w: { q: 0, r: 0, b: 0, n: 0, p: 0 }, b: { q: 0, r: 0, b: 0, n: 0, p: 0 } };
  let balance = 0;
  for (const row of position)
    for (const p of row) {
      if (!p || p.type === 'k') continue;
      count[p.color][p.type]++;
      balance += p.color === 'w' ? VALUE[p.type] : -VALUE[p.type];
    }
  // A piece is missing when there are fewer than at the start (a promoted pawn
  // counts as a missing pawn, its new queen as an extra one).
  const missing = (c: Color) => ORDER.flatMap((t) => Array<PieceSymbol>(Math.max(0, START[t] - count[c][t])).fill(t));
  return { captured: { w: missing('b'), b: missing('w') }, balance };
}

export const Captured = memo(function Captured({ position, side }: { position: BoardPiece[][]; side: Color }) {
  const { captured, balance } = material(position);
  const taken = captured[side];
  const lead = side === 'w' ? balance : -balance;
  if (taken.length === 0 && lead <= 0) return null;
  const them: Color = side === 'w' ? 'b' : 'w';
  const said = ORDER.map((t) => {
    const n = taken.filter((p) => p === t).length;
    return n ? `${n} ${NAME[t][n > 1 ? 1 : 0]}` : '';
  }).filter(Boolean);
  const label = `Captured ${said.join(', ') || 'nothing'}${lead > 0 ? `, up ${lead}` : ''}`;
  return (
    <View style={styles.row} accessible accessibilityLabel={label}>
      {taken.map((t, i) => (
        // Pieces of one kind overlap; a small gap between kinds.
        <View key={i} style={i > 0 && (taken[i - 1] === t ? styles.overlap : styles.gap)}>
          <PieceIcon type={t} color={them} size={18} />
        </View>
      ))}
      {lead > 0 && <Text style={styles.lead}>+{lead}</Text>}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  overlap: { marginLeft: -9 },
  gap: { marginLeft: 1 },
  lead: { marginLeft: 4, fontSize: 13, fontWeight: '600', color: ui.subtle },
});
