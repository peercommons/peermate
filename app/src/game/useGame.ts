// State for one offline game: vs CPU or pass & play (SPECS §2.1).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Chess,
  checkedKingSquare,
  getLevel,
  humanizedDelayMs,
  isPromotion,
  legalTargets,
  other,
  outcome as gameOutcome,
  parseUci,
  resignation,
  takeback,
  toPgn,
  tryMove,
  type Color,
  type Outcome,
  type PieceSymbol,
  type Square,
} from '@peermate/core';
import { bestMove, initEngine, newEngineGame } from '../engine/arasan';

export type GameMode = { kind: 'cpu'; level: number; player: Color } | { kind: 'local' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function useGame(mode: GameMode) {
  const chessRef = useRef(new Chess());
  const chess = chessRef.current;
  // chess.js mutates in place; bump this to re-render after any change.
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const [selected, setSelected] = useState<Square | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: Square; to: Square } | null>(null);
  const [resigned, setResigned] = useState<Outcome | null>(null);
  const [thinking, setThinking] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  // Incremented on undo / new game so a CPU move computed for an old position is discarded.
  const epoch = useRef(0);
  // Identifies the latest CPU search, so only it can clear the thinking indicator.
  const searchId = useRef(0);

  const isCpu = mode.kind === 'cpu';
  const player = isCpu ? mode.player : null;
  const level = isCpu ? mode.level : null;

  const result = resigned ?? gameOutcome(chess);
  const turn = chess.turn();
  const humanToMove = !result && (!isCpu || turn === player);

  // Start the engine early so the first CPU move isn't slowed by loading the network.
  useEffect(() => {
    if (!isCpu) return;
    newEngineGame().catch((err) => setEngineError(String(err?.message ?? err)));
  }, [isCpu]);

  // CPU's turn.
  useEffect(() => {
    if (!isCpu || result || turn === player || engineError) return;
    const myEpoch = epoch.current;
    const mySearch = ++searchId.current;
    let cancelled = false;
    setThinking(true);
    (async () => {
      try {
        await initEngine();
        const r = await bestMove(chess.fen(), level!);
        await sleep(humanizedDelayMs(level!, r.thinkMs));
        if (cancelled || epoch.current !== myEpoch) return;
        if (!tryMove(chess, parseUci(r.move))) throw new Error(`engine played an illegal move: ${r.move}`);
        refresh();
      } catch (err) {
        if (!cancelled) setEngineError(String((err as Error)?.message ?? err));
      } finally {
        if (searchId.current === mySearch) setThinking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `version` re-runs this after every move.
  }, [version, isCpu, result, turn, player, level, engineError, chess, refresh]);

  const makeMove = useCallback(
    (from: Square, to: Square, promotion?: PieceSymbol) => {
      if (tryMove(chess, { from, to, ...(promotion ? { promotion } : {}) })) {
        setSelected(null);
        refresh();
        return true;
      }
      return false;
    },
    [chess, refresh],
  );

  const onSquarePress = useCallback(
    (square: Square) => {
      if (!humanToMove || pendingPromotion) return;
      const piece = chess.get(square);
      if (selected && selected !== square && legalTargets(chess, selected).includes(square)) {
        if (isPromotion(chess, selected, square)) {
          setPendingPromotion({ from: selected, to: square });
        } else {
          makeMove(selected, square);
        }
        return;
      }
      // Select one of your own pieces (tap again to deselect).
      if (piece && piece.color === turn && square !== selected) setSelected(square);
      else setSelected(null);
    },
    [chess, humanToMove, pendingPromotion, selected, turn, makeMove],
  );

  const choosePromotion = useCallback(
    (piece: PieceSymbol | null) => {
      if (pendingPromotion && piece) makeMove(pendingPromotion.from, pendingPromotion.to, piece);
      setPendingPromotion(null);
      setSelected(null);
    },
    [pendingPromotion, makeMove],
  );

  const undo = useCallback(() => {
    epoch.current++;
    setResigned(null);
    setSelected(null);
    setPendingPromotion(null);
    if (isCpu) takeback(chess, player!);
    else chess.undo();
    refresh();
  }, [chess, isCpu, player, refresh]);

  const resign = useCallback(() => {
    if (result) return;
    setResigned(resignation(isCpu ? player! : turn));
    setSelected(null);
  }, [result, isCpu, player, turn]);

  const newGame = useCallback(() => {
    epoch.current++;
    searchId.current++;
    setThinking(false);
    chess.reset();
    setResigned(null);
    setSelected(null);
    setPendingPromotion(null);
    setEngineError(null);
    if (isCpu) newEngineGame().catch((err) => setEngineError(String(err?.message ?? err)));
    refresh();
  }, [chess, isCpu, refresh]);

  const names = useMemo(() => {
    if (!isCpu) return { w: 'White', b: 'Black' };
    const cpu = `CPU level ${level} (${getLevel(level!).label})`;
    return player === 'w' ? { w: 'You', b: cpu } : { w: cpu, b: 'You' };
  }, [isCpu, level, player]);

  const pgn = useCallback(() => toPgn(chess, { white: names.w, black: names.b }, result), [chess, names, result]);

  const history = chess.history({ verbose: true });
  const last = history.at(-1);

  return {
    version,
    position: chess.board().map((row) => row.map((p) => (p ? { type: p.type, color: p.color } : null))),
    fen: chess.fen(),
    turn,
    result,
    thinking,
    engineError,
    humanToMove,
    selected,
    targets: selected ? legalTargets(chess, selected) : [],
    lastMove: last ? { from: last.from, to: last.to } : null,
    checkSquare: checkedKingSquare(chess),
    sanMoves: history.map((m) => m.san),
    canUndo: history.length > 0 && !thinking && (!isCpu || history.some((m) => m.color === player)),
    pendingPromotion,
    promotionColor: pendingPromotion ? turn : null,
    names,
    opponentOf: other,
    onSquarePress,
    choosePromotion,
    undo,
    resign,
    newGame,
    pgn,
  };
}
