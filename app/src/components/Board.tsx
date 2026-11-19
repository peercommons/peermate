// 2D chess board (SPECS §10.2). A pure view: it renders a position and reports
// taps and drags; all game logic lives in useGame / @peermate/core.
//
// Moves can be made by tapping (piece, then square) or by dragging a piece. One
// responder on the whole board handles both: a touch that stays put is a tap; one
// that travels from a movable piece becomes a drag. The dragged piece follows the
// finger on an Animated value, so dragging doesn't re-render the board.
import { memo, useMemo, useRef, useState, type ComponentRef } from 'react';
import { Animated, PanResponder, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { Color, PieceSymbol, Square } from '@peermate/core';
import type { BoardColors } from '../theme';
import { PIECES, PIECE_COLORS, STROKE_WIDTH } from './pieces';

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
  /** Pieces of this colour can be dragged (null: none). */
  movableColor?: Color | null;
  onDragStart?: (square: Square) => void;
  onDrop?: (from: Square, to: Square) => void;
  disabled?: boolean;
  colors: BoardColors;
  showCoordinates?: boolean;
};

/** One piece as vector art (original set, see pieces.ts). */
export const PieceIcon = memo(function PieceIcon({ type, color, size }: { type: PieceSymbol; color: Color; size: number }) {
  const c = PIECE_COLORS[color];
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      {PIECES[type].map((layer, i) =>
        layer.role === 'body' ? (
          <Path key={i} d={layer.d} fill={c.fill} stroke={c.stroke} strokeWidth={STROKE_WIDTH} strokeLinejoin="round" />
        ) : (
          <Path key={i} d={layer.d} fill="none" stroke={c.detail} strokeWidth={STROKE_WIDTH * 0.8} strokeLinecap="round" />
        ),
      )}
    </Svg>
  );
});

export const Board = memo(function Board(props: Props) {
  const { position, size, orientation, colors, showCoordinates = true } = props;
  const sq = Math.floor(size / 8);
  const rows = orientation === 'w' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const cols = orientation === 'w' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];

  const [drag, setDrag] = useState<{ from: Square; piece: NonNullable<BoardPiece> } | null>(null);
  const [hover, setHover] = useState<Square | null>(null);
  const dragXY = useRef(new Animated.ValueXY()).current;

  // The responder is created once; it reads the latest props and layout from refs.
  const latest = useRef({ props, sq });
  latest.current = { props, sq };
  const boardRef = useRef<ComponentRef<typeof View>>(null);
  const origin = useRef({ x: 0, y: 0 });
  const gesture = useRef<{ start: Square | null; dragging: boolean; hover: Square | null }>({
    start: null,
    dragging: false,
    hover: null,
  });

  const responder = useMemo(() => {
    const squareAt = (pageX: number, pageY: number): Square | null => {
      const { props: p, sq: s } = latest.current;
      const col = Math.floor((pageX - origin.current.x) / s);
      const row = Math.floor((pageY - origin.current.y) / s);
      if (col < 0 || col > 7 || row < 0 || row > 7) return null;
      return (p.orientation === 'w' ? `${FILES[col]}${8 - row}` : `${FILES[7 - col]}${row + 1}`) as Square;
    };
    const pieceOn = (square: Square): BoardPiece => {
      const f = FILES.indexOf(square[0]);
      const r = 8 - Number(square[1]);
      return latest.current.props.position[r][f];
    };
    const end = () => {
      gesture.current = { start: null, dragging: false, hover: null };
      setDrag(null);
      setHover(null);
    };

    return PanResponder.create({
      onStartShouldSetPanResponder: () => !latest.current.props.disabled,
      onMoveShouldSetPanResponder: () => false,
      onPanResponderGrant: (e) => {
        const { pageX, pageY } = e.nativeEvent;
        gesture.current = { start: squareAt(pageX, pageY), dragging: false, hover: null };
      },
      onPanResponderMove: (e, g) => {
        const { props: p, sq: s } = latest.current;
        const { pageX, pageY } = e.nativeEvent;
        const state = gesture.current;
        if (!state.start) return;
        if (!state.dragging) {
          const piece = pieceOn(state.start);
          const travelled = Math.hypot(g.dx, g.dy) > s * 0.2;
          if (!travelled || !piece || piece.color !== p.movableColor) return;
          state.dragging = true;
          setDrag({ from: state.start, piece });
          p.onDragStart?.(state.start);
        }
        dragXY.setValue({ x: pageX - origin.current.x - s * 0.6, y: pageY - origin.current.y - s * 0.6 });
        const over = squareAt(pageX, pageY);
        if (over !== state.hover) {
          state.hover = over;
          setHover(over);
        }
      },
      onPanResponderRelease: (e) => {
        const { props: p } = latest.current;
        const state = gesture.current;
        if (state.dragging && state.start) {
          const to = squareAt(e.nativeEvent.pageX, e.nativeEvent.pageY);
          if (to && to !== state.start) p.onDrop?.(state.start, to);
        } else if (state.start) {
          const to = squareAt(e.nativeEvent.pageX, e.nativeEvent.pageY);
          if (to === state.start) p.onSquarePress(to);
        }
        end();
      },
      onPanResponderTerminate: end,
      onPanResponderTerminationRequest: () => !gesture.current.dragging,
    });
  }, [dragXY]);

  const measure = () =>
    boardRef.current?.measure((_x, _y, _w, _h, pageX, pageY) => {
      origin.current = { x: pageX, y: pageY };
    });

  return (
    <View
      ref={boardRef}
      onLayout={measure}
      onTouchStart={measure}
      style={{ width: sq * 8, height: sq * 8 }}
      accessibilityRole="grid"
      accessibilityLabel="Chess board"
      {...responder.panHandlers}
    >
      {rows.map((r, ri) => (
        <View key={r} style={styles.row}>
          {cols.map((c, ci) => {
            const square = `${FILES[c]}${8 - r}` as Square;
            return (
              <SquareView
                key={square}
                square={square}
                piece={position[r][c]}
                ghost={drag?.from === square}
                size={sq}
                dark={(r + c) % 2 === 1}
                selected={props.selected === square}
                target={props.targets.includes(square)}
                hover={hover === square && drag !== null}
                last={props.lastMove?.from === square || props.lastMove?.to === square}
                check={props.checkSquare === square}
                rankLabel={showCoordinates && ci === 0 ? String(8 - r) : null}
                fileLabel={showCoordinates && ri === 7 ? FILES[c] : null}
                colors={colors}
                onPress={props.onSquarePress}
                disabled={props.disabled}
              />
            );
          })}
        </View>
      ))}
      {drag && (
        <Animated.View
          pointerEvents="none"
          style={[styles.floating, { width: sq * 1.2, height: sq * 1.2, transform: dragXY.getTranslateTransform() }]}
        >
          <PieceIcon type={drag.piece.type} color={drag.piece.color} size={sq * 1.2} />
        </Animated.View>
      )}
    </View>
  );
});

type SquareProps = {
  square: Square;
  piece: BoardPiece;
  /** The piece is being dragged from here: draw it faded. (It must stay mounted:
   *  removing the view a touch started on makes Android drop the gesture.) */
  ghost: boolean;
  size: number;
  dark: boolean;
  selected: boolean;
  target: boolean;
  hover: boolean;
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
  const description =
    (p.piece ? `${p.square}, ${p.piece.color === 'w' ? 'white' : 'black'} ${PIECE_NAME[p.piece.type]}` : p.square) +
    (p.check ? ', in check' : p.last ? ', last move' : '');

  return (
    // Touches are handled by the board's responder; screen readers activate squares directly.
    <View
      style={{ width: p.size, height: p.size, backgroundColor: base }}
      accessible
      accessibilityRole="button"
      accessibilityLabel={description}
      accessibilityHint={p.target ? 'Legal move' : undefined}
      accessibilityState={{ disabled: p.disabled, selected: p.selected }}
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={() => !p.disabled && p.onPress(p.square)}
    >
      {overlay && <View style={[StyleSheet.absoluteFill, { backgroundColor: overlay }]} />}
      {p.hover && <View style={[StyleSheet.absoluteFill, { borderWidth: p.size * 0.06, borderColor: colors.hint }]} />}
      {p.rankLabel && (
        <Text maxFontSizeMultiplier={1} style={[styles.rank, { color: labelColor, fontSize: p.size * 0.2 }]}>{p.rankLabel}</Text>
      )}
      {p.fileLabel && (
        <Text maxFontSizeMultiplier={1} style={[styles.file, { color: labelColor, fontSize: p.size * 0.2 }]}>{p.fileLabel}</Text>
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
        <View pointerEvents="none" style={p.ghost && styles.ghost}>
          <PieceIcon type={p.piece.type} color={p.piece.color} size={p.size} />
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  ghost: { opacity: 0.3 },
  floating: { position: 'absolute', left: 0, top: 0, zIndex: 10, elevation: 10 },
  rank: { position: 'absolute', left: 2, top: 1, fontWeight: '600' },
  file: { position: 'absolute', right: 3, bottom: 0, fontWeight: '600' },
});
