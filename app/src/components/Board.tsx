// 2D chess board (SPECS §10.2). A pure view: it renders a position and reports
// taps; all game logic lives in useGame / @peermate/core.
//
// Pieces are Unicode chess glyphs for now. Original SVG piece sets replace them
// later in Phase 1 (they must be original or permissively licensed, SPECS §14.1).
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Color, PieceSymbol, Square } from '@peermate/core';
import type { BoardColors } from '../theme';

// Filled glyphs for both sides; colour comes from styling. U+FE0E forces text
// (not emoji) presentation, which matters for the pawn on Android.
const GLYPH: Record<PieceSymbol, string> = {
  k: '♚︎',
  q: '♛︎',
  r: '♜︎',
  b: '♝︎',
  n: '♞︎',
  p: '♟︎',
};

const PIECE_NAME: Record<PieceSymbol, string> = {
  k: 'king',
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight',
  p: 'pawn',
};

const FILES = 'abcdefgh';

export type BoardPiece = { type: PieceSymbol; color: Color } | null;

type Props = {
  /** 8x8 from chess.js board(): row 0 is rank 8, column 0 is file a. */
  position: BoardPiece[][];
  size: number;
  orientation: Color;
  selected: Square | null;
  targets: Square[];
  lastMove: { from: Square; to: Square } | null;
  checkSquare: Square | null;
  onSquarePress: (square: Square) => void;
  disabled?: boolean;
  colors: BoardColors;
  showCoordinates?: boolean;
};

export const Board = memo(function Board(props: Props) {
  const { position, size, orientation, onSquarePress, disabled, colors, showCoordinates = true } = props;
  const sq = Math.floor(size / 8);
  const rows = orientation === 'w' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const cols = orientation === 'w' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];

  return (
    <View style={{ width: sq * 8, height: sq * 8 }} accessibilityRole="grid" accessibilityLabel="Chess board">
      {rows.map((r, ri) => (
        <View key={r} style={styles.row}>
          {cols.map((c, ci) => {
            const square = `${FILES[c]}${8 - r}` as Square;
            const piece = position[r][c];
            return (
              <SquareView
                key={square}
                square={square}
                piece={piece}
                size={sq}
                dark={(r + c) % 2 === 1}
                selected={props.selected === square}
                target={props.targets.includes(square)}
                last={props.lastMove?.from === square || props.lastMove?.to === square}
                check={props.checkSquare === square}
                rankLabel={showCoordinates && ci === 0 ? String(8 - r) : null}
                fileLabel={showCoordinates && ri === 7 ? FILES[c] : null}
                colors={colors}
                onPress={onSquarePress}
                disabled={disabled}
              />
            );
          })}
        </View>
      ))}
    </View>
  );
});

type SquareProps = {
  square: Square;
  piece: BoardPiece;
  size: number;
  dark: boolean;
  selected: boolean;
  target: boolean;
  last: boolean;
  check: boolean;
  rankLabel: string | null;
  fileLabel: string | null;
  onPress: (square: Square) => void;
  disabled?: boolean;
  colors: BoardColors;
};

const SquareView = memo(function SquareView(p: SquareProps) {
  const colors = p.colors;
  const base = p.dark ? colors.dark : colors.light;
  const labelColor = p.dark ? colors.light : colors.dark;
  const overlay = p.check ? colors.check : p.selected ? colors.selected : p.last ? colors.lastMove : null;
  const description = p.piece
    ? `${p.square}, ${p.piece.color === 'w' ? 'white' : 'black'} ${PIECE_NAME[p.piece.type]}`
    : p.square;

  return (
    <Pressable
      onPress={() => p.onPress(p.square)}
      disabled={p.disabled}
      style={{ width: p.size, height: p.size, backgroundColor: base }}
      accessibilityLabel={description}
      accessibilityHint={p.target ? 'Legal move' : undefined}
    >
      {overlay && <View style={[StyleSheet.absoluteFill, { backgroundColor: overlay }]} />}
      {p.rankLabel && (
        <Text style={[styles.rank, { color: labelColor, fontSize: p.size * 0.2 }]}>{p.rankLabel}</Text>
      )}
      {p.fileLabel && (
        <Text style={[styles.file, { color: labelColor, fontSize: p.size * 0.2 }]}>{p.fileLabel}</Text>
      )}
      {p.target &&
        (p.piece ? (
          <View
            style={[
              StyleSheet.absoluteFill,
              { borderRadius: p.size / 2, borderWidth: p.size * 0.08, borderColor: colors.hint },
            ]}
          />
        ) : (
          <View
            style={{
              position: 'absolute',
              left: p.size * 0.35,
              top: p.size * 0.35,
              width: p.size * 0.3,
              height: p.size * 0.3,
              borderRadius: p.size * 0.15,
              backgroundColor: colors.hint,
            }}
          />
        ))}
      {p.piece && (
        <Text
          allowFontScaling={false}
          style={[
            styles.piece,
            { fontSize: p.size * 0.78, lineHeight: p.size },
            p.piece.color === 'w' ? styles.white : styles.black,
          ]}
        >
          {GLYPH[p.piece.type]}
        </Text>
      )}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  piece: { textAlign: 'center', includeFontPadding: false },
  white: {
    color: '#fbfbf8',
    textShadowColor: '#222',
    textShadowRadius: 2,
    textShadowOffset: { width: 0, height: 0 },
  },
  black: { color: '#1b1b1b' },
  rank: { position: 'absolute', left: 2, top: 1, fontWeight: '600' },
  file: { position: 'absolute', right: 3, bottom: 0, fontWeight: '600' },
});
