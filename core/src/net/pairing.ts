// Pairing and colour assignment without a server (SPECS §6.8). Commit-reveal
// coin flip, so neither side can bias who gets White:
//   challenger -> CHALLENGE { commit = H(nonceA) }
//   acceptor   -> ACCEPT { nonceB }                  (or DECLINE)
//   challenger -> REVEAL { nonceA }, START { gid, white, black, tc, fen }
//   acceptor   -> checks H(nonceA) = commit and the START fields, echoes START
// Each side's game begins once it holds the other's signed START.
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { START_FEN, type Color } from '../game.ts';
import type { ReliableChannel } from './channel.ts';
import { canonical, hashHex, type Message } from './envelope.ts';
import { parseTimeControl } from './clock.ts';

export type StartBody = Extract<Message, { t: 'START' }>;
export type GameStart = { start: StartBody; myColor: Color; opponent: string };
export type PairingResult = { ok: true; game: GameStart } | { ok: false; reason: string };

export const newNonce = (): string => bytesToHex(randomBytes(32));

/** Colour for the challenger: a fair bit neither side controls alone. */
export function challengerColor(nonceA: string, nonceB: string): Color {
  return parseInt(hashHex(`peermate/v1/color|${nonceA}|${nonceB}`).slice(0, 2), 16) & 1 ? 'b' : 'w';
}

export const gameIdFor = (nonceA: string, nonceB: string): string =>
  hashHex(`peermate/v1/gid|${nonceA}|${nonceB}`).slice(0, 32);

const sameStart = (a: StartBody, b: StartBody) => canonical(a) === canonical(b);

/** Challenger side. Call once the channel is bound to the peer's key. */
export function challenge(
  channel: ReliableChannel,
  opts: { tc: string; rated: boolean; me: string; peer: string },
  done: (r: PairingResult) => void,
): void {
  parseTimeControl(opts.tc); // throws on a bad time control
  const nonceA = newNonce();
  let sent: StartBody | null = null;
  let finished = false;
  const finish = (r: PairingResult) => {
    if (!finished) {
      finished = true;
      done(r);
    }
  };

  channel.onMessage((msg) => {
    if (finished) return;
    if (msg.t === 'DECLINE') return finish({ ok: false, reason: msg.reason });
    if (msg.t === 'ACCEPT' && !sent) {
      const color = challengerColor(nonceA, msg.nonce);
      sent = {
        t: 'START',
        gid: gameIdFor(nonceA, msg.nonce),
        white: color === 'w' ? opts.me : opts.peer,
        black: color === 'w' ? opts.peer : opts.me,
        tc: opts.tc,
        fen: START_FEN,
      };
      channel.gid = sent.gid;
      channel.send({ t: 'REVEAL', nonce: nonceA });
      channel.send(sent);
      return;
    }
    if (msg.t === 'START' && sent) {
      if (!sameStart(msg, sent)) return finish({ ok: false, reason: 'start mismatch' });
      finish({ ok: true, game: { start: sent, myColor: sent.white === opts.me ? 'w' : 'b', opponent: opts.peer } });
    }
  });
  channel.send({ t: 'CHALLENGE', tc: opts.tc, rated: opts.rated, commit: hashHex(nonceA) });
}

/**
 * Acceptor side. `decide` sees the challenge and returns null to accept or a
 * decline reason.
 */
export function awaitChallenge(
  channel: ReliableChannel,
  opts: { me: string; decide: (c: Extract<Message, { t: 'CHALLENGE' }>) => string | null },
  done: (r: PairingResult) => void,
): void {
  const nonceB = newNonce();
  let commit: string | null = null;
  let tc = '';
  let nonceA: string | null = null;
  let finished = false;
  const finish = (r: PairingResult) => {
    if (!finished) {
      finished = true;
      done(r);
    }
  };

  channel.onMessage((msg) => {
    if (finished) return;
    if (msg.t === 'CHALLENGE' && commit === null) {
      const reason = (() => {
        try {
          parseTimeControl(msg.tc);
        } catch {
          return 'bad time control';
        }
        return opts.decide(msg);
      })();
      if (reason) {
        channel.send({ t: 'DECLINE', reason });
        return finish({ ok: false, reason: `declined: ${reason}` });
      }
      commit = msg.commit;
      tc = msg.tc;
      channel.send({ t: 'ACCEPT', nonce: nonceB });
      return;
    }
    if (msg.t === 'REVEAL' && commit !== null && nonceA === null) {
      if (hashHex(msg.nonce) !== commit) return finish({ ok: false, reason: 'commitment mismatch' });
      nonceA = msg.nonce;
      return;
    }
    if (msg.t === 'START' && nonceA !== null) {
      const peer = channel.peer!;
      const color = challengerColor(nonceA, nonceB); // challenger's colour
      const expected: StartBody = {
        t: 'START',
        gid: gameIdFor(nonceA, nonceB),
        white: color === 'w' ? peer : opts.me,
        black: color === 'w' ? opts.me : peer,
        tc,
        fen: START_FEN,
      };
      if (!sameStart(msg, expected)) return finish({ ok: false, reason: 'start mismatch' });
      channel.gid = expected.gid;
      channel.send(expected);
      finish({ ok: true, game: { start: expected, myColor: color === 'w' ? 'b' : 'w', opponent: peer } });
    }
  });
}
