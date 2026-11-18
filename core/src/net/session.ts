// One online game between two peers (SPECS §6.7, §7). Transport-agnostic: it
// talks through a ReliableChannel. Both sides validate every move with chess.js
// and keep a hash chain over the moves, so a modified client can't sneak in an
// illegal move or rewrite history:
//   h0 = H(canonical START),  h_n = H(h_{n-1} | ply | uci | fenAfter | clockMs)
//
// Clocks start once both sides have moved (until then either side may abort).
// Each side measures the opponent's thinking time itself and overrules a
// reported clock that is better than its own measurement by more than the
// tolerance (§7.3).
import {
  Chess,
  other,
  outcome as boardOutcome,
  parseUci,
  tryMove,
  type Color,
  type Outcome,
} from '../game.ts';
import { realTimers, type ReliableChannel, type Timers } from './channel.ts';
import { canMate, clockTolerance, lagCredit, parseTimeControl, type TimeControl } from './clock.ts';
import { canonical, hashHex, MAX_CHAT_LENGTH, type Message } from './envelope.ts';
import type { GameStart } from './pairing.ts';

export const QUICK_CHAT = ['hi', 'gl', 'hf', 'gg', 'thanks', 'oops', 'wp'] as const;
export const PING_INTERVAL_MS = 5000;
/** Silence after which the opponent counts as away, and after which a win may be claimed (§6.9). */
export const AWAY_AFTER_MS = 15_000;
export const ABANDON_AFTER_MS = 60_000;
/** Most credit given for a late ACK of my move (see opponentMove). */
export const MAX_ACK_CREDIT_MS = 3000;
const CHAT_LIMIT = { count: 5, windowMs: 10_000 };

export type GameEnd = {
  outcome: Outcome | null;
  /** Ended before both sides moved; no result. */
  aborted?: boolean;
  /** Opponent broke the protocol (illegal move, bad hash...). */
  violation?: string;
  /** Decided by one side alone (e.g. abandonment): not co-signed (SPECS §6.9, §7.5). */
  unconfirmed?: boolean;
};

export type SessionEvent =
  | { type: 'move'; ply: number; san: string; uci: string; color: Color }
  | { type: 'chat'; from: 'me' | 'opponent'; text?: string; quick?: string }
  | { type: 'drawOffered' }
  | { type: 'drawDeclined' }
  | { type: 'flagDisputed' }
  | { type: 'clockDiscrepancy'; count: number }
  | { type: 'ended'; end: GameEnd };

export class GameSession {
  readonly chess: Chess;
  readonly myColor: Color;
  readonly tc: TimeControl;
  end: GameEnd | null = null;
  /** Remaining ms at the start of the current turn. */
  readonly remaining: Record<Color, number>;
  discrepancies = 0;
  /** The opponent's last reported clock (their own view). */
  private lastReport: number;

  private readonly channel: ReliableChannel;
  private readonly timers: Timers;
  private readonly emit: (e: SessionEvent) => void;
  private hash: string;
  private turnStartedAt: number;
  /** When the opponent acknowledged my latest move (≈ when their turn really began). */
  private myMoveSeq = 0;
  private myMoveAckedAt: number | null = null;
  private drawOfferFromOpponent: number | null = null;
  private myDrawOffer: number | null = null;
  private flagClaimPending = false;
  private chatTimes: number[] = [];
  private pingTimer: unknown = null;

  constructor(opts: { channel: ReliableChannel; game: GameStart; onEvent: (e: SessionEvent) => void; timers?: Timers }) {
    this.channel = opts.channel;
    this.timers = opts.timers ?? realTimers;
    this.emit = opts.onEvent;
    this.myColor = opts.game.myColor;
    this.tc = parseTimeControl(opts.game.start.tc);
    this.chess = new Chess(opts.game.start.fen);
    this.hash = hashHex(canonical(opts.game.start));
    this.remaining = { w: this.tc.initialMs, b: this.tc.initialMs };
    this.lastReport = this.tc.initialMs;
    this.turnStartedAt = this.timers.now();
    this.channel.onMessage((msg) => this.handle(msg));
    this.channel.onAck = (seq) => {
      if (seq === this.myMoveSeq) this.myMoveAckedAt = this.timers.now();
    };
    this.schedulePing();
  }

  get ply(): number {
    return this.chess.history().length;
  }
  get myTurn(): boolean {
    return !this.end && this.chess.turn() === this.myColor;
  }
  /** Clocks run once both sides have made a move. */
  get clocksRunning(): boolean {
    return this.ply >= 2 && !this.end;
  }
  get canAbort(): boolean {
    return !this.end && this.ply < 2;
  }
  get opponentOfferedDraw(): boolean {
    return this.drawOfferFromOpponent !== null && this.drawOfferFromOpponent === this.ply;
  }

  /** Both clocks as of `now` (the side to move's clock running). */
  clocks(now = this.timers.now()): Record<Color, number> {
    const c = { ...this.remaining };
    if (this.clocksRunning) c[this.chess.turn()] -= now - this.turnStartedAt;
    return c;
  }

  // ---- my actions ---------------------------------------------------------

  /** Plays my move (UCI). Returns false if it isn't legal or allowed now. */
  move(uci: string): boolean {
    if (!this.myTurn) return false;
    const now = this.timers.now();
    const running = this.clocksRunning;
    let clock = this.remaining[this.myColor];
    if (running) {
      clock -= now - this.turnStartedAt;
      if (clock <= 0) return false; // my flag fell; the opponent may claim
      clock += this.tc.incrementMs;
    }
    const made = tryMove(this.chess, parseUci(uci));
    if (!made) return false;
    const ply = this.ply;
    this.remaining[this.myColor] = clock;
    this.turnStartedAt = now;
    this.hash = hashHex(`${this.hash}|${ply}|${uci}|${this.chess.fen()}|${clock}`);
    this.drawOfferFromOpponent = null; // moving declines a pending offer
    this.myMoveAckedAt = null;
    this.myMoveSeq = this.channel.send({ t: 'MOVE', ply, uci, clock, hash: this.hash });
    this.emit({ type: 'move', ply, san: made.san, uci, color: this.myColor });
    this.checkBoardEnd();
    return true;
  }

  resign(): void {
    if (this.end) return;
    this.channel.send({ t: 'RESIGN', ply: this.ply });
    this.finish({ outcome: { winner: other(this.myColor), reason: 'resignation' } });
  }

  abort(): boolean {
    if (!this.canAbort) return false;
    this.channel.send({ t: 'ABORT', ply: this.ply });
    this.finish({ outcome: null, aborted: true });
    return true;
  }

  /** Offer a draw; allowed on the opponent's turn, so the offer can't cross a move of mine. */
  offerDraw(): boolean {
    if (this.end || this.myTurn || this.myDrawOffer === this.ply) return false;
    this.myDrawOffer = this.ply;
    this.channel.send({ t: 'DRAW_OFFER', ply: this.ply });
    return true;
  }

  respondDraw(accept: boolean): void {
    if (!this.opponentOfferedDraw) return;
    const ply = this.ply;
    this.drawOfferFromOpponent = null;
    this.channel.send({ t: 'DRAW_RESP', ply, accept });
    if (accept) this.finish({ outcome: { winner: null, reason: 'agreement' } });
  }

  /** Claims a win on time when the opponent's clock (as I see it) has run out. */
  claimFlag(): boolean {
    if (this.end || this.myTurn || !this.clocksRunning || this.flagClaimPending) return false;
    if (this.clocks()[other(this.myColor)] > 0) return false;
    this.flagClaimPending = true;
    this.channel.send({ t: 'FLAG_CLAIM', ply: this.ply });
    return true;
  }

  /** Ms since we last heard anything from the opponent. */
  silenceMs(now = this.timers.now()): number {
    return now - this.channel.lastHeardAt;
  }

  get canClaimAbandonment(): boolean {
    return !this.end && this.silenceMs() >= ABANDON_AFTER_MS;
  }

  /** Opponent silent for 60 s: claim the win. Recorded as unconfirmed. */
  claimAbandonment(): boolean {
    if (!this.canClaimAbandonment) return false;
    this.finish({ outcome: { winner: this.myColor, reason: 'abandonment' }, unconfirmed: true });
    return true;
  }

  /** Free text (≤ 280 chars) or a quick-chat id. Rate limited to 5 per 10 s. */
  chat(content: { text: string } | { quick: (typeof QUICK_CHAT)[number] }): boolean {
    const now = this.timers.now();
    this.chatTimes = this.chatTimes.filter((t) => now - t < CHAT_LIMIT.windowMs);
    if (this.chatTimes.length >= CHAT_LIMIT.count) return false;
    let msg: Message;
    if ('text' in content) {
      const text = content.text.trim();
      if (!text || text.length > MAX_CHAT_LENGTH) return false;
      msg = { t: 'CHAT', text };
    } else {
      msg = { t: 'CHAT', quick: content.quick };
    }
    this.chatTimes.push(now);
    this.channel.send(msg);
    this.emit({ type: 'chat', from: 'me', ...('text' in content ? { text: content.text.trim() } : content) });
    return true;
  }

  /** Stops background work (pings). The channel stays open for chat and retransmits. */
  dispose(): void {
    this.timers.clearTimeout(this.pingTimer);
    this.pingTimer = null;
  }

  // ---- opponent's messages ------------------------------------------------

  private handle(msg: Message): void {
    if (msg.t === 'CHAT') {
      if (msg.quick !== undefined && !(QUICK_CHAT as readonly string[]).includes(msg.quick)) return;
      this.emit({ type: 'chat', from: 'opponent', text: msg.text, quick: msg.quick });
      return;
    }
    if (this.end) return;
    switch (msg.t) {
      case 'MOVE':
        return this.opponentMove(msg);
      case 'RESIGN':
        return this.finish({ outcome: { winner: this.myColor, reason: 'resignation' } });
      case 'ABORT':
        if (this.ply < 2) this.finish({ outcome: null, aborted: true });
        return;
      case 'DRAW_OFFER':
        if (this.myTurn && msg.ply === this.ply) {
          this.drawOfferFromOpponent = msg.ply;
          this.emit({ type: 'drawOffered' });
        }
        return;
      case 'DRAW_RESP':
        if (msg.ply !== this.myDrawOffer || msg.ply !== this.ply) return;
        this.myDrawOffer = null;
        if (msg.accept) this.finish({ outcome: { winner: null, reason: 'agreement' } });
        else this.emit({ type: 'drawDeclined' });
        return;
      case 'FLAG_CLAIM':
        return this.answerFlagClaim(msg.ply);
      case 'FLAG_RESP':
        if (!this.flagClaimPending || msg.ply !== this.ply) return;
        this.flagClaimPending = false;
        if (msg.accept) this.finish(this.timeoutEnd(other(this.myColor)));
        else this.emit({ type: 'flagDisputed' });
        return;
    }
  }

  private opponentMove(msg: Extract<Message, { t: 'MOVE' }>) {
    const them = other(this.myColor);
    if (this.chess.turn() !== them) return this.violate('move out of turn');
    if (msg.ply !== this.ply + 1) return this.violate(`expected ply ${this.ply + 1}, got ${msg.ply}`);

    const now = this.timers.now();
    const running = this.clocksRunning;
    const made = tryMove(this.chess, parseUci(msg.uci));
    if (!made) return this.violate(`illegal move ${msg.uci}`);
    const expected = hashHex(`${this.hash}|${msg.ply}|${msg.uci}|${this.chess.fen()}|${msg.clock}`);
    if (expected !== msg.hash) {
      this.chess.undo();
      return this.violate('hash chain mismatch');
    }
    this.hash = expected;

    // Clock: judge the time used on this move, i.e. the drop since the opponent's
    // previous report. (Comparing absolute clocks would make one overrule cascade
    // into overruling every later move.) Trust the report unless it claims less
    // thinking time than we measured, beyond the tolerance.
    const reportedUsed = this.lastReport - msg.clock + (running ? this.tc.incrementMs : 0);
    this.lastReport = msg.clock;
    let used = Math.max(0, reportedUsed);
    if (running) {
      // Their turn began when my move reached them: the ACK's arrival minus half
      // the round trip. Capped, since a dishonest peer could delay its ACKs.
      const lag = lagCredit(this.channel.rtt);
      const ackDelay = this.myMoveAckedAt === null ? 0 : this.myMoveAckedAt - lag - this.turnStartedAt;
      const begun = this.turnStartedAt + Math.min(MAX_ACK_CREDIT_MS, Math.max(0, ackDelay));
      const observed = Math.max(0, now - begun - lag);
      if (observed > reportedUsed + clockTolerance(this.channel.rtt)) {
        used = observed;
        this.discrepancies++;
        this.emit({ type: 'clockDiscrepancy', count: this.discrepancies });
      }
    }
    const clock = this.remaining[them] - used + (running ? this.tc.incrementMs : 0);
    this.remaining[them] = clock;
    this.turnStartedAt = now;
    this.myDrawOffer = null;
    this.flagClaimPending = false;
    this.emit({ type: 'move', ply: msg.ply, san: made.san, uci: msg.uci, color: them });
    this.checkBoardEnd();
  }

  private answerFlagClaim(ply: number) {
    // The claim is about my clock; agree if my own view says it's (nearly) out.
    const accept = ply === this.ply && this.myTurn && this.clocksRunning &&
      this.clocks()[this.myColor] <= Math.max(500, this.channel.rtt ?? 0);
    this.channel.send({ t: 'FLAG_RESP', ply, accept });
    if (accept) this.finish(this.timeoutEnd(this.myColor));
  }

  /** `loser` ran out of time: a loss, or a draw if the other side can't mate. */
  private timeoutEnd(loser: Color): GameEnd {
    const winner = other(loser);
    return canMate(this.chess, winner)
      ? { outcome: { winner, reason: 'timeout' } }
      : { outcome: { winner: null, reason: 'timeout-vs-insufficient-material' } };
  }

  private violate(reason: string) {
    this.finish({ outcome: { winner: this.myColor, reason: 'abandonment' }, violation: reason });
  }

  private checkBoardEnd() {
    const o = boardOutcome(this.chess);
    if (o) this.finish({ outcome: o });
  }

  private finish(end: GameEnd) {
    if (this.end) return;
    this.end = end;
    this.dispose();
    this.emit({ type: 'ended', end });
  }

  private schedulePing() {
    this.pingTimer = this.timers.setTimeout(() => {
      if (this.end) return;
      this.channel.ping();
      this.schedulePing();
    }, PING_INTERVAL_MS);
  }
}
