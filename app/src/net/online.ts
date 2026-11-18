// Online play controller (SPECS §2.1 Quick Match, §6). One at a time: seeking,
// then one game. Screens read it with useOnline(); it outlives screen changes so
// a game keeps running if the player navigates away.
//
// Transport: Hyperswarm only in this slice (direct, hole-punched). If the
// opponent's connection drops, we redial their key and resync; the Nostr
// relay fallback (§6.6) comes next.
import { useSyncExternalStore } from 'react';
import {
  fingerprint,
  GameSession,
  lobbyRoom,
  Matchmaker,
  timeControlClass,
  toPgn,
  type Color,
  type GameEnd,
  type Match,
  type SessionEvent,
} from '@peermate/core';
import { saveGame } from '../storage/games';
import { loadMe } from './profile';
import { getWorker, type P2PWorker, type WorkerEvent } from './worker';

export const TIME_CONTROLS = ['3+2', '5+0', '10+0', '15+10'] as const;

export type ChatLine = { from: 'me' | 'opponent'; text: string; at: number };
export type Connection = 'direct' | 'reconnecting';

export type OnlineState =
  | { phase: 'idle' }
  | { phase: 'starting'; tc: string }
  | { phase: 'seeking'; tc: string; since: number; lobbyPeers: number }
  | {
      phase: 'game';
      tc: string;
      myColor: Color;
      opponent: { key: string; nick: string; fingerprint: string };
      connection: Connection;
      end: GameEnd | null;
      drawOffered: boolean;
      notice: string | null;
      chat: ChatLine[];
      /** Bumps on every change, so screens re-read the session. */
      version: number;
    }
  | { phase: 'error'; message: string };

export const QUICK_TEXT: Record<string, string> = {
  hi: 'Hi!',
  gl: 'Good luck!',
  hf: 'Have fun!',
  gg: 'Good game',
  thanks: 'Thanks',
  oops: 'Oops',
  wp: 'Well played',
};

class OnlineController {
  state: OnlineState = { phase: 'idle' };
  session: GameSession | null = null;
  private listeners = new Set<() => void>();
  private worker: P2PWorker | null = null;
  private unsubscribe: (() => void) | null = null;
  private matchmaker: Matchmaker | null = null;
  private match: Match | null = null;
  private lobbyPeers = new Set<string>();
  private startedAt = 0;

  get gameId(): string | null {
    return this.match?.game.start.gid ?? null;
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.state;

  private set(next: OnlineState) {
    this.state = next;
    for (const l of [...this.listeners]) l();
  }

  private patchGame(patch: Partial<Extract<OnlineState, { phase: 'game' }>>) {
    if (this.state.phase !== 'game') return;
    this.set({ ...this.state, ...patch, version: this.state.version + 1 });
  }

  async seek(tc: string): Promise<void> {
    if (this.state.phase === 'starting' || this.state.phase === 'seeking') return;
    if (this.state.phase === 'game' && !this.state.end) return;
    this.leave();
    this.set({ phase: 'starting', tc });
    try {
      const [me, worker] = await Promise.all([loadMe(), getWorker()]);
      if ((this.state as OnlineState).phase !== 'starting') return; // cancelled meanwhile
      this.worker = worker;
      this.lobbyPeers.clear();
      this.matchmaker = new Matchmaker({
        identity: me.identity,
        nick: me.profile.nick,
        tc,
        network: {
          send: (peer, data) => worker.send({ type: 'send', peer, data }),
          drop: (peer) => worker.send({ type: 'drop', peer }),
        },
        onMatch: (m) => this.onMatch(m, tc),
      });
      this.unsubscribe = worker.on((e) => this.onWorkerEvent(e));
      worker.send({ type: 'seek', rooms: [lobbyRoom(timeControlClass(tc), 'any')] });
      this.set({ phase: 'seeking', tc, since: Date.now(), lobbyPeers: 0 });
    } catch (err) {
      this.set({ phase: 'error', message: (err as Error).message });
    }
  }

  cancelSeek(): void {
    if (this.state.phase !== 'seeking' && this.state.phase !== 'starting') return;
    this.matchmaker?.close();
    this.matchmaker = null;
    this.worker?.send({ type: 'unseek' });
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.set({ phase: 'idle' });
  }

  /** Leaves a finished game (or abandons the screen state after an error). */
  leave(): void {
    if (this.state.phase === 'game' && !this.state.end) return; // resign or abort first
    this.session?.dispose();
    this.session = null;
    if (this.match) {
      this.match.channel.close();
      this.worker?.send({ type: 'drop', peer: this.match.opponent.key });
    }
    this.match = null;
    this.matchmaker = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.state.phase !== 'idle') this.set({ phase: 'idle' });
  }

  private onWorkerEvent(e: WorkerEvent) {
    const mm = this.matchmaker;
    switch (e.type) {
      case 'peer-joined':
        if (this.match?.opponent.key === e.id) {
          this.match.channel.resync(); // back after a drop: replay anything missed
          this.patchGame({ connection: 'direct' });
        } else if (this.state.phase === 'seeking') {
          this.lobbyPeers.add(e.id);
          this.set({ ...this.state, lobbyPeers: this.lobbyPeers.size });
          mm?.peerConnected(e.id);
        }
        return;
      case 'msg':
        mm?.peerData(e.from, e.data);
        return;
      case 'peer-left':
        if (this.match?.opponent.key === e.id) {
          if (this.state.phase === 'game' && !this.state.end) {
            this.patchGame({ connection: 'reconnecting' });
            this.worker?.send({ type: 'connect', peer: e.id }); // redial by key
          }
        } else {
          this.lobbyPeers.delete(e.id);
          mm?.peerLeft(e.id);
          if (this.state.phase === 'seeking') this.set({ ...this.state, lobbyPeers: this.lobbyPeers.size });
        }
        return;
    }
  }

  private onMatch(m: Match, tc: string) {
    this.match = m;
    this.worker?.send({ type: 'unseek' });
    this.startedAt = Date.now();
    this.session = new GameSession({ channel: m.channel, game: m.game, onEvent: (e) => this.onSessionEvent(e) });
    this.set({
      phase: 'game',
      tc,
      myColor: m.game.myColor,
      opponent: { key: m.opponent.key, nick: m.opponent.nick, fingerprint: fingerprint(m.opponent.key) },
      connection: 'direct',
      end: null,
      drawOffered: false,
      notice: null,
      chat: [],
      version: 0,
    });
  }

  private onSessionEvent(e: SessionEvent) {
    if (this.state.phase !== 'game') return;
    switch (e.type) {
      case 'move':
        this.patchGame({ drawOffered: false, notice: null });
        return;
      case 'chat': {
        const text = e.text ?? QUICK_TEXT[e.quick ?? ''] ?? '';
        if (text) this.patchGame({ chat: [...this.state.chat, { from: e.from, text, at: Date.now() }].slice(-50) });
        return;
      }
      case 'drawOffered':
        this.patchGame({ drawOffered: true, notice: `${this.state.opponent.nick} offers a draw` });
        return;
      case 'drawDeclined':
        this.patchGame({ notice: 'Draw declined' });
        return;
      case 'flagDisputed':
        this.patchGame({ notice: "Opponent's clock disagrees; play on" });
        return;
      case 'clockDiscrepancy':
        if (e.count >= 3) this.patchGame({ notice: "Opponent's reported clock keeps disagreeing with ours" });
        return;
      case 'ended':
        this.patchGame({ end: e.end, drawOffered: false, notice: null });
        void this.saveFinished(e.end);
        return;
    }
  }

  private async saveFinished(end: GameEnd) {
    const s = this.session;
    if (!s || this.state.phase !== 'game' || end.aborted || !end.outcome || !this.match) return;
    const me = await loadMe();
    const names = { [s.myColor]: me.profile.nick, [s.myColor === 'w' ? 'b' : 'w']: this.state.opponent.nick } as Record<
      Color,
      string
    >;
    await saveGame({
      id: this.match.game.start.gid,
      mode: 'online',
      level: null,
      player: s.myColor,
      white: names.w,
      black: names.b,
      pgn: toPgn(s.chess, { white: names.w, black: names.b, event: `Peermate online ${this.state.tc}` }, end.outcome),
      plies: s.ply,
      winner: end.outcome.winner ?? 'draw',
      reason: end.outcome.reason,
      startedAt: this.startedAt,
      updatedAt: Date.now(),
      analysis: null,
    }).catch(() => undefined);
  }

  // ---- game actions (thin wrappers so screens re-render) -------------------

  move(uci: string): boolean {
    const ok = this.session?.move(uci) ?? false;
    if (ok) this.patchGame({});
    return ok;
  }
  resign() {
    this.session?.resign();
  }
  abort() {
    this.session?.abort();
  }
  offerDraw() {
    if (this.session?.offerDraw()) this.patchGame({ notice: 'Draw offered' });
  }
  respondDraw(accept: boolean) {
    this.session?.respondDraw(accept);
    this.patchGame({ drawOffered: false, notice: accept ? null : 'You declined the draw' });
  }
  claimFlag() {
    if (this.session?.claimFlag()) this.patchGame({ notice: 'Claiming a win on time…' });
  }
  chat(content: Parameters<GameSession['chat']>[0]) {
    return this.session?.chat(content) ?? false;
  }
}

export const online = new OnlineController();

export function useOnline(): OnlineState {
  return useSyncExternalStore(online.subscribe, online.getSnapshot);
}
