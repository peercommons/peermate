// Player reports (SPECS §14.2). There's no server: a report is a plain-text
// document the reporter shares (share sheet, email). It's signed with the
// reporter's peer key, so whoever receives it can check that it came from that
// ID and wasn't edited. It can't prove the opponent's messages were real, but
// each one is quoted as received.
import { ed25519 } from '@noble/curves/ed25519.js';
import { fingerprint, fromHex, toHex, type Identity } from './identity.ts';

export type ReportInput = {
  reporter: { nick: string };
  opponent: { key: string; nick: string };
  gameId: string | null;
  timeControl: string | null;
  /** Moves in SAN, in order. */
  moves: string[];
  chat: { from: 'me' | 'opponent'; text: string; at: number }[];
  /** The reporter's own words, optional. */
  reason?: string;
  at: number;
};

const SIGNATURE_MARK = '\n-- signed by Peermate ID ';

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

/** The report text, ending in a signature line over everything above it. */
export function buildReport(identity: Identity, r: ReportInput): string {
  const me = identity.peer.publicKey;
  const lines = [
    'Peermate player report',
    `Date: ${iso(r.at)}`,
    '',
    `Reported player: ${oneLine(r.opponent.nick)} (ID ${fingerprint(r.opponent.key)})`,
    `Reported key: ${r.opponent.key}`,
    `Reported by: ${oneLine(r.reporter.nick)} (ID ${fingerprint(me)})`,
    `Game: ${r.gameId ?? 'none'}${r.timeControl ? ` · ${r.timeControl}` : ''}`,
  ];
  if (r.reason?.trim()) lines.push('', 'Reason:', r.reason.trim());
  lines.push('', 'Moves:', r.moves.length ? formatMoves(r.moves) : '(none)');
  lines.push('', 'Chat:');
  if (!r.chat.length) lines.push('(none)');
  for (const c of r.chat) {
    lines.push(`[${iso(c.at)}] ${c.from === 'me' ? r.reporter.nick : r.opponent.nick}: ${oneLine(c.text)}`);
  }
  const body = lines.join('\n');
  const sig = toHex(ed25519.sign(new TextEncoder().encode(body), identity.peer.secretKey));
  return `${body}${SIGNATURE_MARK}${me}\n-- signature ${sig}\n`;
}

/** Checks a report's signature; returns the signer's key, or null if it doesn't verify. */
export function verifyReport(text: string): string | null {
  const at = text.lastIndexOf(SIGNATURE_MARK);
  if (at < 0) return null;
  const body = text.slice(0, at);
  const m = /^([0-9a-f]{64})\n-- signature ([0-9a-f]{128})\n?$/.exec(text.slice(at + SIGNATURE_MARK.length));
  if (!m) return null;
  try {
    return ed25519.verify(fromHex(m[2]), new TextEncoder().encode(body), fromHex(m[1])) ? m[1] : null;
  } catch {
    return null;
  }
}

function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function formatMoves(moves: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < moves.length; i += 2) out.push(`${i / 2 + 1}. ${moves[i]}${moves[i + 1] ? ` ${moves[i + 1]}` : ''}`);
  return out.join(' ');
}
