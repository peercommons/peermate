// Online play controller (SPECS §2.1 Quick Match, §6). One at a time: seeking,
// then one game. Screens read it with useOnline(); it outlives screen changes so
// a game keeps running if the player navigates away.
//
// Transports (§6.6): direct Hyperswarm connections (hole-punched) and public
// Nostr relays, side by side. Seeks go out on both; each peer is reached
// directly when a connection is up, otherwise through relays, and the game
// moves between the two without interruption (the channel resyncs on a switch).
// Hyperswarm keeps redialing a matched opponent, so a relayed game moves to a
// direct connection whenever one succeeds.
import { useSyncExternalStore } from 'react';
import Storage from 'expo-sqlite/kv-store';
import {
  decode,
  fingerprint,
  PeerRouter,
  wireSender,
  GameSession,
  lobbyRoom,
  Matchmaker,
  timeControlClass,
  toPgn,
  type Color,
  type GameEnd,
  type ChannelSnapshot,
  type Match,
  ReliableChannel,
  type SessionEvent,
  type SessionSnapshot,
} from '@peermate/core';
import { saveGame } from '../storage/games';
import { loadMe, type Me } from './profile';
import { RelayNet, type Seek } from './relay';
import { getWorker, type P2PWorker, type WorkerEvent } from './worker';

export const TIME_CONTROLS = ['3+2', '5+0', '10+0', '15+10'] as const;

export type ChatLine = { from: 'me' | 'opponent'; text: string; at: number };
export type Connection = 'direct' | 'relayed' | 'reconnecting';

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

/** Lifecycle log, readable over USB with `adb logcat -s ReactNativeJS` (field testing). */
const log = (...args: unknown[]) => console.info('[online]', ...args);

/** A running online game, saved as it's played so it survives an app restart. */
const ACTIVE_KEY = 'online.active.v1';
const RECONNECTING = 'Reconnecting to your game…';
type SavedGame = {
  v: 1;
  tc: string;
  startedAt: number;
  opponent: { key: string; nick: string; npub?: string };
  channel: ChannelSnapshot;
  session: SessionSnapshot;
};

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
  private relay: RelayNet | null = null;
  private router: PeerRouter | null = null;
  private startedAt = 0;
  private resuming: Promise<boolean> | null = null;

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
    log('seek', tc, 'from state', this.state.phase);
    // A saved game is being picked up (app just started): it wins over a new seek.
    if (this.resuming && (await this.resuming)) return;
    if (this.state.phase === 'starting' || this.state.phase === 'seeking') return;
    if (this.state.phase === 'game' && !this.state.end) return;
    this.leave();
    this.set({ phase: 'starting', tc });
    try {
      const [me, worker] = await Promise.all([loadMe(), getWorker()]);
      if ((this.state as OnlineState).phase !== 'starting') return; // cancelled meanwhile
      this.lobbyPeers.clear();
      const { relay, router } = this.openTransports(me, worker);
      this.matchmaker = new Matchmaker({
        identity: me.identity,
        nick: me.profile.nick,
        tc,
        network: router,
        onMatch: (m) => this.onMatch(m, tc),
      });
      const rooms = [lobbyRoom(timeControlClass(tc), 'any')];
      worker.send({ type: 'seek', rooms });
      relay.seek(rooms, { tc, nick: me.profile.nick });
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
    this.closeTransports();
    this.set({ phase: 'idle' });
  }

  /** Leaves a finished game (or abandons the screen state after an error). */
  leave(): void {
    if (this.state.phase === 'game' && !this.state.end) return; // resign or abort first
    this.session?.dispose();
    this.session = null;
    if (this.match) {
      this.match.channel.close();
      this.router?.drop(this.match.opponent.key);
    }
    this.match = null;
    this.matchmaker = null;
    this.closeTransports();
    if (this.state.phase !== 'idle') this.set({ phase: 'idle' });
  }

  private openTransports(me: Me, worker: P2PWorker | null) {
    const relay = new RelayNet({
      nostrSecret: me.identity.nostr.secretKey,
      peerKey: me.identity.peer.publicKey,
      onMessage: (npub, wire) => this.onRelayMessage(npub, wire),
      onSeek: (seek) => this.onRelaySeek(seek),
    });
    const router = new PeerRouter({
      directSend: (peer, data) => this.worker?.send({ type: 'send', peer, data }),
      directDrop: (peer) => this.worker?.send({ type: 'drop', peer }),
      relaySend: (npub, wire) => relay.send(npub, wire),
    });
    this.relay = relay;
    this.router = router;
    if (worker) this.attachWorker(worker);
    return { relay, router };
  }

  private attachWorker(worker: P2PWorker) {
    this.worker = worker;
    this.unsubscribe?.();
    this.unsubscribe = worker.on((e) => this.onWorkerEvent(e));
  }

  /** Feeds a message from `peer` to the running game or the matchmaker. */
  private deliver(peer: string, wire: string) {
    if (this.isOpponent(peer)) {
      this.match!.channel.receive(wire);
      // First word from the opponent after a resume: we're back in touch.
      if (this.state.phase === 'game' && this.state.notice === RECONNECTING) {
        log('resume: opponent heard');
        this.patchGame({ notice: null });
      }
    }
    else this.matchmaker?.peerData(peer, wire);
  }

  // ---- saving and resuming a running game ----------------------------------

  /** Synchronous on purpose: called before each new message goes out (see ReliableChannel.onPersist). */
  private persist() {
    const s = this.session;
    if (!s || !this.match || this.state.phase !== 'game' || s.end) return;
    const saved: SavedGame = {
      v: 1,
      tc: this.state.tc,
      startedAt: this.startedAt,
      opponent: { key: this.match.opponent.key, nick: this.match.opponent.nick, npub: this.match.opponent.npub },
      channel: this.match.channel.snapshot(),
      session: s.snapshot(),
    };
    try {
      Storage.setItemSync(ACTIVE_KEY, JSON.stringify(saved));
    } catch (err) {
      log('save failed:', String(err)); // the game goes on, it just can't be resumed
    }
  }

  private clearSaved() {
    try {
      Storage.removeItemSync(ACTIVE_KEY);
    } catch {
      // nothing saved
    }
  }

  /** Opponent of a saved unfinished game, if any (for the home screen). */
  savedOpponent(): string | null {
    try {
      const raw = Storage.getItemSync(ACTIVE_KEY);
      return raw ? (JSON.parse(raw) as SavedGame).opponent.nick : null;
    } catch {
      return null;
    }
  }

  /**
   * Picks up a game that was running when the app last closed. Clocks kept
   * running meanwhile; the opponent replays anything we missed.
   */
  resumeSaved(): Promise<boolean> {
    this.resuming ??= this.doResume().finally(() => (this.resuming = null));
    return this.resuming;
  }

  private async doResume(): Promise<boolean> {
    log('resume: state', this.state.phase);
    if (this.state.phase !== 'idle') return this.state.phase === 'game';
    let saved: SavedGame;
    try {
      const raw = Storage.getItemSync(ACTIVE_KEY);
      if (!raw) return false;
      saved = JSON.parse(raw) as SavedGame;
      if (saved.v !== 1) throw new Error('old format');
    } catch (err) {
      log('resume: unreadable save', String(err));
      this.clearSaved();
      return false;
    }
    try {
      // Only the identity is awaited here. The P2P worker can take many seconds
      // to start on a phone; the game resumes over the relays meanwhile and goes
      // direct once the worker is up.
      const me = await loadMe();
      const now = (this.state as OnlineState).phase;
      if (now !== 'idle') {
        log('resume: skipped, state', now);
        return false;
      }
      const start = saved.session.game.start;
      if (start.white !== me.identity.peer.publicKey && start.black !== me.identity.peer.publicKey) {
        log('resume: saved under another identity');
        this.clearSaved(); // saved under another identity (restored from a phrase)
        return false;
      }
      const { router } = this.openTransports(me, null);
      const opp = saved.opponent;
      if (opp.npub) router.relayKnown(opp.key, opp.npub);
      const channel = ReliableChannel.restore(
        { key: me.identity.peer, send: (wire) => router.send(opp.key, wire) },
        saved.channel,
      );
      const game = saved.session.game;
      this.match = { game: { start: game.start, myColor: game.myColor, opponent: opp.key }, channel, opponent: opp };
      this.startedAt = saved.startedAt;
      this.session = GameSession.restore({ channel, snapshot: saved.session, onEvent: (e) => this.onSessionEvent(e) });
      channel.onPersist = () => this.persist();
      this.set({
        phase: 'game',
        tc: saved.tc,
        myColor: game.myColor,
        opponent: { key: opp.key, nick: opp.nick, fingerprint: fingerprint(opp.key) },
        connection: opp.npub ? 'relayed' : 'reconnecting',
        end: null,
        drawOffered: false,
        notice: RECONNECTING,
        chat: [],
        version: 0,
      });
      channel.resync();
      log('resumed vs', opp.nick, 'at ply', this.session.ply, 'relay', Boolean(opp.npub));
      getWorker().then(
        (worker) => {
          if (this.match?.channel !== channel) return; // game left meanwhile
          this.attachWorker(worker);
          worker.send({ type: 'connect', peer: opp.key }); // try for a direct link
          log('resume: worker up');
        },
        (err) => log('resume: no P2P worker, relays only:', String(err)),
      );
      return true;
    } catch (err) {
      log('resume failed:', String(err));
      this.clearSaved();
      this.set({ phase: 'error', message: `Couldn't resume the game: ${(err as Error).message}` });
      return false;
    }
  }

  private closeTransports() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.relay?.close();
    this.relay = null;
    this.router = null;
  }

  private isOpponent(peer: string) {
    return this.match?.opponent.key === peer;
  }

  /** Re-evaluates the opponent's route after a transport change. */
  private routeChanged() {
    if (!this.match || this.state.phase !== 'game' || this.state.end) return;
    const route = this.router?.route(this.match.opponent.key) ?? null;
    const connection: Connection = route === 'direct' ? 'direct' : route === 'relay' ? 'relayed' : 'reconnecting';
    if (connection !== this.state.connection) {
      log('route', this.state.connection, '->', connection);
      this.match.channel.resync(); // replay anything lost in the switch
      this.patchGame({ connection });
    }
  }

  private noteLobbyPeer(peer: string) {
    if (this.state.phase !== 'seeking' || this.lobbyPeers.has(peer)) return;
    this.lobbyPeers.add(peer);
    this.set({ ...this.state, lobbyPeers: this.lobbyPeers.size });
  }

  /** Another player's seek on the relays. */
  private onRelaySeek(seek: Seek) {
    if (this.state.phase !== 'seeking' || seek.tc !== this.state.tc || !this.router) return;
    // Seeks are unsigned: never let one overwrite a route we already have.
    if (!this.router.npubOf(seek.peer)) this.router.relayKnown(seek.peer, seek.npub);
    this.worker?.send({ type: 'connect', peer: seek.peer }); // try for a direct link too
    this.noteLobbyPeer(seek.peer);
    this.matchmaker?.peerConnected(seek.peer);
  }

  /** A protocol message through the relays. */
  private onRelayMessage(npub: string, wire: string) {
    const peer = wireSender(wire);
    if (!peer || !this.router) return;
    // Bind peer key -> Nostr key only from a validly signed message.
    if (!decode(wire)) return;
    this.router.relayKnown(peer, npub);
    if (!this.isOpponent(peer)) {
      if (this.state.phase !== 'seeking') return;
      this.noteLobbyPeer(peer);
      this.matchmaker?.peerConnected(peer);
    }
    this.deliver(peer, wire);
  }

  private onWorkerEvent(e: WorkerEvent) {
    const mm = this.matchmaker;
    switch (e.type) {
      case 'peer-joined':
        this.router?.directUp(e.id);
        if (this.isOpponent(e.id)) {
          this.routeChanged();
        } else if (this.state.phase === 'seeking') {
          this.noteLobbyPeer(e.id);
          mm?.peerConnected(e.id);
        }
        return;
      case 'msg':
        this.deliver(e.from, e.data);
        return;
      case 'peer-left':
        this.router?.directDown(e.id);
        if (this.isOpponent(e.id)) {
          if (this.state.phase === 'game' && !this.state.end) {
            this.worker?.send({ type: 'connect', peer: e.id }); // keep trying direct
            this.routeChanged();
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
    log('matched', m.opponent.nick, 'as', m.game.myColor, 'via', this.router?.route(m.opponent.key));
    this.worker?.send({ type: 'unseek' });
    this.relay?.unseek();
    // The npub in the signed HELLO lets us reach the opponent through relays
    // even if this game started on a direct connection.
    if (m.opponent.npub) this.router?.relayKnown(m.opponent.key, m.opponent.npub);
    m.channel.onPersist = () => this.persist();
    // Not directly connected (paired via relays)? Keep dialing for a direct link.
    const route = this.router?.route(m.opponent.key) ?? null;
    if (route !== 'direct') this.worker?.send({ type: 'connect', peer: m.opponent.key });
    this.startedAt = Date.now();
    this.session = new GameSession({ channel: m.channel, game: m.game, onEvent: (e) => this.onSessionEvent(e) });
    this.persist();
    this.set({
      phase: 'game',
      tc,
      myColor: m.game.myColor,
      opponent: { key: m.opponent.key, nick: m.opponent.nick, fingerprint: fingerprint(m.opponent.key) },
      connection: route === 'direct' ? 'direct' : 'relayed',
      end: null,
      drawOffered: false,
      notice: null,
      chat: [],
      version: 0,
    });
  }

  private onSessionEvent(e: SessionEvent) {
    if (this.state.phase !== 'game') return;
    if (e.type === 'move') this.persist();
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
        log('ended', JSON.stringify(e.end), 'at ply', this.session?.ply);
        this.clearSaved();
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
  claimAbandonment() {
    this.session?.claimAbandonment();
  }
  chat(content: Parameters<GameSession['chat']>[0]) {
    return this.session?.chat(content) ?? false;
  }
}

export const online = new OnlineController();

export function useOnline(): OnlineState {
  return useSyncExternalStore(online.subscribe, online.getSnapshot);
}
