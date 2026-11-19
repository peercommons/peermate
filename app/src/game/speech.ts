// Moves in words for screen readers (SPECS §10.4): "Nxe5+" -> "knight takes e5, check".
import { AccessibilityInfo } from 'react-native';

const PIECES: Record<string, string> = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight' };

export function spokenMove(san: string): string {
  const check = san.endsWith('#') ? ', checkmate' : san.endsWith('+') ? ', check' : '';
  const s = san.replace(/[+#!?]+$/, '');
  if (s === 'O-O') return `castles kingside${check}`;
  if (s === 'O-O-O') return `castles queenside${check}`;
  const m = /^([KQRBN])?([a-h]?[1-8]?)(x)?([a-h][1-8])(?:=([QRBN]))?$/.exec(s);
  if (!m) return san;
  const [, piece, from, takes, to, promo] = m;
  const who = piece ? PIECES[piece] : 'pawn';
  const disamb = from ? ` ${from}` : '';
  const verb = takes ? ' takes ' : ' to ';
  const promotion = promo ? `, promotes to ${PIECES[promo]}` : '';
  return `${who}${disamb}${verb}${to}${promotion}${check}`;
}

/** Announces a move made by the other side (the computer or the opponent). */
export function announceMove(color: 'w' | 'b', san: string): void {
  AccessibilityInfo.announceForAccessibility(`${color === 'w' ? 'White' : 'Black'}: ${spokenMove(san)}`);
}
