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
import { AppState } from 'react-native';
import { appLog } from '../../modules/peermate-log';
import Storage from 'expo-sqlite/kv-store';
import {
  decode,
  parseTimeControl,
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
  buildReport,
  formatRating,
  roomsToJoin,
  sanitizeOpponent,
} from '@peermate/core';
import { saveGame } from '../storage/games';
import { block, isBlocked } from './blocklist';
import { addMessage, isUnread, MESSAGE_MAX, setStatus, syncedTo } from './messages';
import { applyResult, myRating } from './ratings';
import { notifyChallenge, notifyMessage } from './notify';
import {
  addIncoming,
  challengeText,
  clearIncoming,
  clearOutgoing,
  isAnswer,
  nextIncoming,
  noteOutgoing,
  parseChallenge,
} from './challenges';
import { addFriend, friendByNpub, friends, getFriend, isFriend, refreshFriend, removeFriend } from './friends';
import { loadMe, type Me } from './profile';
import { RelayNet, rumorId, type PresenceStatus, type Seek } from './relay';
import { getWorker, type P2PWorker, type WorkerEvent } from './worker';

export const TIME_CONTROLS = ['1+0', '2+1', '3+2', '5+0', '10+0', '15+10'] as const;

/** Shown when a bullet game runs through the relays, where each move takes 1–3 s to arrive (SPECS §1). */
export const RELAYED_BULLET_WARNING =
  'Playing through relays: each move takes 1–3 s to arrive. The clocks make up for part of the delay, but bullet will feel slow.';

/** A friend's challenge waiting for an answer. */
export type Invite = {
  key: string;
  npub: string;
  nick: string;
  fingerprint: string;
  friend: boolean;
  tc: string;
  at: number;
  /**
   * 'offline': a challenge that came as a message (they may not be online now);
   * answering it challenges them back. 'answer': their live challenge answers
   * an offline challenge of ours.
   */
  kind?: 'offline' | 'answer';
};

/** A friend's last presence note (SPECS §6.5). */
export type Presence = { status: PresenceStatus; at: number };
/** How often we tell each friend we're around, and how long a note counts. */
const PRESENCE_EVERY_MS = 60_000;
export const PRESENCE_FRESH_MS = 120_000;
/** When a friend's note arrives and we haven't told them for this long, answer at once. */
const PRESENCE_ANSWER_AFTER_MS = 30_000;

/** How long a friend has to answer a challenge. */
export const INVITE_TIMEOUT_MS = 120_000;

export type ChatLine = { from: 'me' | 'opponent'; text: string; at: number };
export type Connection = 'direct' | 'relayed' | 'reconnecting';

export type OnlineState =
  | { phase: 'idle' }
  | { phase: 'starting'; tc: string; friend?: string }
  | { phase: 'seeking'; tc: string; since: number; lobbyPeers: number; friend?: string }
  | {
      phase: 'game';
      tc: string;
      myColor: Color;
      opponent: { key: string; nick: string; fingerprint: string; rating: string | null };
      connection: Connection;
      /** After a rated game: our rating before and after (SPECS §7.5). */
      ratingChange: { before: number; after: number; shown: string } | null;
      end: GameEnd | null;
      drawOffered: boolean;
      notice: string | null;
      chat: ChatLine[];
      /** Bumps on every change, so screens re-read the session. */
      version: number;
    }
  | { phase: 'error'; message: string };

/** Lifecycle log for field testing (logcat on Android, the unified log on iOS). */
const log = (...args: unknown[]) => appLog('online', ...args);

/** A running online game, saved as it's played so it survives an app restart. */
const ACTIVE_KEY = 'online.active.v1';

/**
 * A direct link the opponent has been silent on for this long is presumed dead
 * (their session pings every 5 s). A suspended iPhone, for one, leaves the other
 * side's connection looking open for minutes.
 */
const STALE_DIRECT_MS = 12_000;
const LINK_CHECK_MS = 2_000;
/** How long the transports stay up after leaving a game, for its last messages to be acknowledged. */
const LINGER_MS = 15_000;

/** Resolves true once `channel` has nothing unacknowledged, false after `ms`. */
function drained(channel: { unacked: number }, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const until = Date.now() + ms;
    const tick = () => {
      if (channel.unacked === 0) resolve(true);
      else if (Date.now() >= until) resolve(false);
      else setTimeout(tick, 250);
    };
    tick();
  });
}
const RECONNECTING = 'Reconnecting to your game…';
type SavedGame = {
  v: 1;
  tc: string;
  startedAt: number;
  opponent: { key: string; nick: string; npub?: string; rating?: number; rd?: number };
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

/** Our rating for a time control, as sent in HELLO (whole numbers). */
function ratingFor(tc: string): { rating: number; rd: number } {
  const r = myRating(timeControlClass(tc));
  return { rating: Math.round(r.r), rd: Math.round(r.rd) };
}

/** An opponent's self-reported rating, for display ("1532", "1500?"), or null if they sent none. */
function shownRating(o: { rating?: number; rd?: number }): string | null {
  return o.rating === undefined ? null : formatRating(sanitizeOpponent(o.rating, o.rd));
}

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
  private lingering: Promise<void> | null = null;
  /** An incoming friend challenge (shown as a dialog anywhere in the app). */
  invite: Invite | null = null;
  private inviteTimer: ReturnType<typeof setTimeout> | null = null;
  private challengeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The one peer a friend-challenge matchmaker is pairing with. */
  private matchmakerPeer: string | null = null;
  /** The friend our current challenge also went to as a message (sent once). */
  private offlineSentTo: string | null = null;
  private listening = false;
  /** Friends' presence, by peer key. Replaced (not mutated) on change, for React. */
  presence: ReadonlyMap<string, Presence> = new Map();
  private toldAt = new Map<string, number>();
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private dms: { close(): void } | null = null;
  /** When the current direct link to the opponent came up (grace period for the stale check). */
  private directSince = 0;

  constructor() {
    setInterval(() => this.checkLink(), LINK_CHECK_MS);
    AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        this.onForeground();
        this.showOfflineInvite(); // the background check may have stored one
        this.announce();
      } else if (s === 'background') {
        this.announce('away'); // best effort: iOS may suspend us first
      }
    });
  }

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
    if (this.lingering) await this.lingering; // the previous game's last messages first
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
        ...ratingFor(tc),
        network: router,
        onMatch: (m) => this.onMatch(m, tc),
        isBlocked,
      });
      // Our rating band's room and the class-wide one: similar players meet first,
      // and nobody waits for lack of them (SPECS §6.2).
      const rooms = roomsToJoin(timeControlClass(tc), myRating(timeControlClass(tc)).r);
      worker.send({ type: 'seek', rooms });
      relay.seek(rooms, { tc, nick: me.profile.nick });
      this.set({ phase: 'seeking', tc, since: Date.now(), lobbyPeers: 0 });
    } catch (err) {
      this.set({ phase: 'error', message: `Couldn't start: ${(err as Error).message}` });
    }
  }

  cancelSeek(): void {
    if (this.state.phase !== 'seeking' && this.state.phase !== 'starting') return;
    if (this.challengeTimer) clearTimeout(this.challengeTimer);
    this.challengeTimer = null;
    // A friend challenge: take the invitation back, so their dialog closes.
    const invited = this.state.friend ? this.matchmakerPeer : null;
    if (invited) this.sendDecline(invited, 'cancelled');
    this.matchmaker?.close();
    this.matchmaker = null;
    this.worker?.send({ type: 'unseek' });
    this.closeTransports();
    this.set({ phase: 'idle' });
  }

  /** Leaves a finished game (or abandons the screen state after an error). */
  leave(): void {
    if (this.state.phase === 'game' && !this.state.end) return; // resign or abort first
    // The game's last messages (final move, resignation, draw acceptance) may not
    // have reached the opponent yet. Keep the transports up until they're
    // acknowledged, or the opponent is left with a game that never ends.
    const channel = this.match?.channel;
    if (channel && channel.unacked > 0 && !this.lingering) {
      log('leaving with', channel.unacked, 'unacknowledged; lingering');
      this.lingering = drained(channel, LINGER_MS).then((ok) => {
        log('linger', ok ? 'drained' : 'timed out');
        this.lingering = null;
        this.teardown();
      });
      if (this.state.phase !== 'idle') this.set({ phase: 'idle' });
      return;
    }
    if (this.lingering) return; // teardown follows the linger
    this.teardown();
  }

  private teardown(): void {
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
    // Shared by searches, games and listening for friends' challenges.
    if (this.relay && this.router) {
      if (worker && this.worker !== worker) this.attachWorker(worker);
      return { relay: this.relay, router: this.router };
    }
    const relay = new RelayNet({
      nostrSecret: me.identity.nostr.secretKey,
      peerKey: me.identity.peer.publicKey,
      onMessage: (npub, wire) => this.onRelayMessage(npub, wire),
      onSeek: (seek) => this.onRelaySeek(seek),
      onPresence: (npub, status) => this.onPresence(npub, status),
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
    if (!this.isOpponent(peer) && !this.matchmaker) {
      this.checkInvite(peer, wire);
      return;
    }
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
      opponent: {
        key: this.match.opponent.key,
        nick: this.match.opponent.nick,
        npub: this.match.opponent.npub,
        rating: this.match.opponent.rating,
        rd: this.match.opponent.rd,
      },
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
        opponent: { key: opp.key, nick: opp.nick, fingerprint: fingerprint(opp.key), rating: shownRating(opp) },
        ratingChange: null,
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
    // Listening for challenges: keep the transports, just stop seeking.
    if (this.listening) {
      this.relay?.unseek();
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.relay?.close();
    this.relay = null;
    this.router = null;
  }

  private isOpponent(peer: string) {
    return this.match?.opponent.key === peer;
  }

  /** Blocks the current opponent; a running game is aborted or resigned first. */
  blockOpponent(): void {
    if (this.state.phase !== 'game' || !this.session) return;
    if (!this.state.end) {
      if (this.session.canAbort) this.abort();
      else this.resign();
    }
    log('blocked opponent');
    removeFriend(this.state.opponent.key);
    block(this.state.opponent.key, this.state.opponent.nick);
  }

  /** A signed report on the current opponent (SPECS §14.2), for the share sheet. Also blocks them. */
  async reportOpponent(reason?: string): Promise<string | null> {
    if (this.state.phase !== 'game' || !this.session) return null;
    const { opponent, tc, chat } = this.state;
    const moves = this.session.chess.history();
    const gameId = this.gameId;
    const me = await loadMe();
    this.blockOpponent();
    return buildReport(me.identity, {
      reporter: { nick: me.profile.nick },
      opponent: { key: opponent.key, nick: opponent.nick },
      gameId,
      timeControl: tc,
      moves,
      chat,
      reason,
      at: Date.now(),
    });
  }

  // ---- friends ------------------------------------------------------------

  /**
   * Stays reachable for challenges while the app is open: the P2P worker
   * listens on our key, and the relay inbox is subscribed. Anyone who has our
   * friend link (or played us) can challenge; a challenge isn't limited to
   * people already in our friends, since sharing a link is how it starts.
   */
  async listen(): Promise<void> {
    this.listening = true;
    if (this.relay && this.worker) return this.announce(); // e.g. a friend was just added
    try {
      const [me, worker] = await Promise.all([loadMe(), getWorker()]);
      const { relay } = this.openTransports(me, worker);
      log('listening for friends');
      if (!this.dms) {
        // First time on this device: the last 30 days (relays keep messages a while).
        const since = syncedTo() || Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
        log('fetching messages since', new Date(since * 1000).toISOString(), 'from', friends().length, 'friend(s)');
        this.dms = relay.receiveDMs(since, (dm) => this.onDM(dm));
      }
      this.presenceTimer ??= setInterval(() => this.announce(), PRESENCE_EVERY_MS);
      this.announce();
      this.showOfflineInvite();
    } catch (err) {
      log('listen failed:', String(err));
    }
  }

  /** A private message (NIP-17). Only friends' are kept; anyone else's is dropped. */
  private onDM(dm: { id: string; from: string; text: string; at: number }) {
    const f = friendByNpub(dm.from);
    if (!f || isBlocked(f.key)) {
      log('message dropped:', f ? 'blocked' : 'not from a friend', dm.from.slice(0, 8));
      return;
    }
    log('message from', f.nick, new Date(dm.at).toISOString());
    const text = dm.text.slice(0, MESSAGE_MAX);
    if (!addMessage(f.key, { id: dm.id, from: 'them', text, at: dm.at })) return;
    const tc = parseChallenge(text);
    if (tc) {
      if (!addIncoming(f.key, tc, dm.at)) return; // expired, or an older one
      log('offline challenge from', f.nick, tc);
      if (AppState.currentState !== 'active') notifyChallenge(f.key, f.nick, tc);
      this.showOfflineInvite();
    } else if (isUnread(f.key, dm.at)) {
      notifyMessage(f.key, f.nick, text);
    }
  }

  /** Shows a friend's stored offline challenge, if we're free and no dialog is up. */
  private showOfflineInvite() {
    if (this.invite) return;
    const busy = this.state.phase !== 'idle' && this.state.phase !== 'error' && !(this.state.phase === 'game' && this.state.end);
    if (busy) return;
    const p = nextIncoming();
    if (!p) return;
    const f = getFriend(p.key);
    if (!f || isBlocked(f.key)) return clearIncoming(p.key);
    this.invite = {
      key: f.key,
      npub: f.npub,
      nick: f.nick,
      fingerprint: fingerprint(f.key),
      friend: true,
      tc: p.tc,
      at: p.at,
      kind: 'offline',
    };
    this.emit();
  }

  /** Also sends a challenge as a message, for a friend whose app isn't open (once per challenge). */
  private sendOfflineChallenge(friendKey: string, tc: string) {
    if (this.offlineSentTo === friendKey) return;
    this.offlineSentTo = friendKey;
    noteOutgoing(friendKey, tc);
    log('offline challenge to', getFriend(friendKey)?.nick, tc);
    void this.sendMessage(friendKey, challengeText(tc));
  }

  /**
   * Sends a friend a private message; it reaches them even if their app is
   * closed. `retry` resends a failed one (same time, so the same id).
   */
  async sendMessage(friendKey: string, text: string, retry?: { at: number }): Promise<void> {
    const f = getFriend(friendKey);
    const body = text.trim().slice(0, MESSAGE_MAX);
    if (!f || !body) return;
    // Show it at once (connecting can take a while on a cold start).
    const me = await loadMe();
    const at = retry?.at ?? Date.now();
    const createdAt = Math.floor(at / 1000);
    const id = rumorId(me.identity.nostr.secretKey, f.npub, body, createdAt);
    if (retry) setStatus(f.key, id, 'sending');
    else addMessage(f.key, { id, from: 'me', text: body, at, status: 'sending' });
    await this.listen();
    let ok = false;
    try {
      ok = this.relay ? (await this.relay.sendDM(f.npub, body, createdAt)).ok : false;
    } catch (err) {
      log('message send error:', String(err));
    }
    setStatus(f.key, id, ok ? 'sent' : 'failed');
    log('message to', f.nick, ok ? 'sent' : 'failed', this.relay ? '' : '(no relay connection)');
  }

  private myStatus(): PresenceStatus {
    return this.state.phase === 'game' && !this.state.end ? 'playing' : 'online';
  }

  /** Tells every friend we're around (or `status`), through the relays. */
  private announce(status: PresenceStatus = this.myStatus()) {
    if (!this.relay) return;
    const now = Date.now();
    for (const f of friends()) {
      this.relay.sendPresence(f.npub, status);
      this.toldAt.set(f.key, now);
    }
  }

  private onPresence(npub: string, status: PresenceStatus) {
    const f = friendByNpub(npub);
    if (!f) return;
    const next = new Map(this.presence);
    next.set(f.key, { status, at: Date.now() });
    this.presence = next;
    this.emit();
    // They just showed up: answer now rather than at our next round.
    if (status !== 'away' && Date.now() - (this.toldAt.get(f.key) ?? 0) > PRESENCE_ANSWER_AFTER_MS) {
      this.relay?.sendPresence(f.npub, this.myStatus());
      this.toldAt.set(f.key, Date.now());
    }
  }

  /** A message from someone we're not playing or pairing with: a friend's challenge? */
  private checkInvite(peer: string, wire: string) {
    const env = decode(wire);
    if (!env || env.from !== peer) return;
    if (env.body.t === 'DECLINE' && this.invite?.key === peer) {
      log('invite withdrawn by', this.invite.nick);
      return this.clearInvite();
    }
    if (env.body.t !== 'HELLO' || !env.body.invite) return;
    const hello = env.body;
    if (isBlocked(peer)) return;
    try {
      parseTimeControl(hello.invite!);
    } catch {
      return;
    }
    refreshFriend(peer, hello.npub, hello.nick);
    this.router?.relayKnown(peer, hello.npub);
    // Free unless searching or playing (an error screen, e.g. "didn't answer", counts as free).
    const busy = this.state.phase !== 'idle' && this.state.phase !== 'error' && !(this.state.phase === 'game' && this.state.end);
    if (busy) return this.sendDecline(peer, 'busy');
    if (this.invite?.key === peer && this.invite.tc === hello.invite && this.invite.kind !== 'offline') return; // a resend
    log('invite from', hello.nick, hello.invite);
    clearIncoming(peer); // a live challenge replaces their offline one
    const answer = isAnswer(peer, hello.invite!);
    this.invite = {
      key: peer,
      npub: hello.npub,
      nick: getFriend(peer)?.nick ?? hello.nick.slice(0, 32),
      fingerprint: fingerprint(peer),
      friend: isFriend(peer),
      tc: hello.invite!,
      at: Date.now(),
      kind: answer ? 'answer' : undefined,
    };
    if (this.inviteTimer) clearTimeout(this.inviteTimer);
    this.inviteTimer = setTimeout(() => this.clearInvite(), INVITE_TIMEOUT_MS);
    this.emit();
  }

  private clearInvite() {
    if (this.inviteTimer) clearTimeout(this.inviteTimer);
    this.inviteTimer = null;
    this.invite = null;
    this.emit();
    setTimeout(() => this.showOfflineInvite(), 1_000); // the next one, if any
  }

  private emit() {
    for (const l of [...this.listeners]) l();
  }

  private sendDecline(peer: string, reason: string) {
    const router = this.router;
    if (!router) return;
    void loadMe().then((me) => {
      const ch = new ReliableChannel({ key: me.identity.peer, peer, send: (w) => router.send(peer, w) });
      ch.send({ t: 'DECLINE', reason });
      setTimeout(() => ch.close(), 30_000); // resent until acknowledged, for a while
    });
  }

  /** Challenges a friend; they get a dialog, and the game starts if they accept. */
  async challenge(friendKey: string, tc: string): Promise<void> {
    const friend = getFriend(friendKey);
    if (!friend) return;
    clearIncoming(friend.key); // challenging them answers theirs
    this.offlineSentTo = null;
    // Not seen lately: their app is probably closed, so send it as a message too.
    if (presenceOf(this.presence.get(friend.key)) === 'offline') this.sendOfflineChallenge(friend.key, tc);
    await this.pair(friend.key, friend.npub, friend.nick, tc, true);
  }

  async acceptInvite(): Promise<void> {
    const inv = this.invite;
    if (!inv) return;
    this.clearInvite();
    clearOutgoing(inv.key);
    // An offline challenge: they may not be online, so challenge them back (live, and as a message).
    if (inv.kind === 'offline') return this.challenge(inv.key, inv.tc);
    // Accepting someone's challenge makes them a friend (so you can challenge back).
    addFriend(inv.key, inv.npub, inv.nick);
    await this.pair(inv.key, inv.npub, inv.nick, inv.tc, false);
  }

  declineInvite(): void {
    const inv = this.invite;
    if (!inv) return;
    clearIncoming(inv.key);
    this.clearInvite();
    if (inv.kind !== 'offline') this.sendDecline(inv.key, 'declined');
  }

  /** Pairs with one known player (a friend challenge, either side). */
  private async pair(key: string, npub: string, nick: string, tc: string, inviting: boolean) {
    log(inviting ? 'challenge' : 'accept', nick, tc, 'from state', this.state.phase);
    if (this.lingering) await this.lingering;
    if (this.resuming && (await this.resuming)) return;
    if (this.state.phase === 'starting' || this.state.phase === 'seeking') this.cancelSeek();
    if (this.state.phase === 'game' && !this.state.end) return;
    this.leave();
    this.set({ phase: 'starting', tc, friend: nick });
    try {
      const [me, worker] = await Promise.all([loadMe(), getWorker()]);
      if ((this.state as OnlineState).phase !== 'starting') return;
      this.lobbyPeers.clear();
      const { router } = this.openTransports(me, worker);
      router.relayKnown(key, npub);
      this.matchmaker = new Matchmaker({
        identity: me.identity,
        nick: me.profile.nick,
        tc,
        ...ratingFor(tc),
        network: router,
        only: key,
        invite: inviting,
        helloTimeoutMs: INVITE_TIMEOUT_MS,
        onMatch: (m) => this.onMatch(m, tc),
        onDeclined: (reason) => this.challengeOver(reason === 'busy' ? `${nick} is busy` : `${nick} declined`),
      });
      this.matchmakerPeer = key;
      worker.send({ type: 'connect', peer: key }); // direct if we can; the relays otherwise
      this.matchmaker.peerConnected(key);
      this.set({ phase: 'seeking', tc, since: Date.now(), lobbyPeers: 0, friend: nick });
      if (this.challengeTimer) clearTimeout(this.challengeTimer);
      this.challengeTimer = setTimeout(() => {
        if (this.state.phase !== 'seeking' || !this.state.friend) return;
        // Their app may be closed: leave the challenge as a message they'll be notified of.
        if (inviting) this.sendOfflineChallenge(key, tc);
        this.challengeOver(
          inviting
            ? `${nick} didn't answer. They'll get your challenge as a message; if they accept while you're in the app, you'll be asked to play.`
            : `${nick} didn't answer`,
        );
      }, INVITE_TIMEOUT_MS + 5_000);
    } catch (err) {
      this.set({ phase: 'error', message: `Couldn't start: ${(err as Error).message}` });
    }
  }

  private challengeOver(message: string) {
    log('challenge over:', message);
    this.matchmaker?.close();
    this.matchmaker = null;
    this.closeTransports();
    this.set({ phase: 'error', message });
  }

  /** Adds the current (or last) opponent as a friend. */
  addOpponentAsFriend(): void {
    const opp = this.match?.opponent;
    if (!opp?.npub) return;
    addFriend(opp.key, opp.npub, opp.nick);
    void this.listen();
  }

  private gameRunning(): boolean {
    return this.state.phase === 'game' && !this.state.end && !!this.match && !!this.session;
  }

  /** Falls back to the relays when a direct link has gone quiet, and re-dials it. */
  private checkLink() {
    if (!this.gameRunning() || !this.router) return;
    const peer = this.match!.opponent.key;
    if (this.router.route(peer) !== 'direct') return;
    const silent = this.session!.silenceMs();
    if (silent < STALE_DIRECT_MS || Date.now() - this.directSince < STALE_DIRECT_MS) return;
    log('direct link silent for', Math.round(silent / 1000), 's; switching to relays and re-dialling');
    this.router.directDown(peer);
    this.worker?.send({ type: 'drop', peer });
    this.worker?.send({ type: 'connect', peer });
    this.routeChanged();
  }

  /**
   * Back from the background. iOS suspends the app (and its connections) soon
   * after it leaves the screen: catch up at once instead of waiting for retries.
   */
  private onForeground() {
    if (!this.gameRunning()) return;
    log('foreground; silent for', Math.round(this.session!.silenceMs() / 1000), 's');
    this.checkLink();
    const peer = this.match!.opponent.key;
    if (this.router?.route(peer) !== 'direct') this.worker?.send({ type: 'connect', peer });
    this.match!.channel.resync();
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
    if (isBlocked(seek.peer)) return;
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
      if (this.state.phase !== 'seeking') return this.checkInvite(peer, wire);
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
          this.directSince = Date.now();
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
        } else if (this.router?.route(e.id) == null) {
          // Gone for good only if the relays can't reach them either; a lost
          // direct link mid-pairing mustn't throw the handshake away.
          this.lobbyPeers.delete(e.id);
          mm?.peerLeft(e.id);
          if (this.state.phase === 'seeking') this.set({ ...this.state, lobbyPeers: this.lobbyPeers.size });
        }
        return;
    }
  }

  private onMatch(m: Match, tc: string) {
    if (this.challengeTimer) clearTimeout(this.challengeTimer);
    this.challengeTimer = null;
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
    queueMicrotask(() => this.announce()); // friends see "playing" (after the state below is set)
    this.persist();
    this.set({
      phase: 'game',
      tc,
      myColor: m.game.myColor,
      opponent: {
        key: m.opponent.key,
        nick: m.opponent.nick,
        fingerprint: fingerprint(m.opponent.key),
        rating: shownRating(m.opponent),
      },
      ratingChange: null,
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
        // Strangers get quick chat only (SPECS §14.2): an opponent's free text,
        // which our app never sends, isn't shown.
        if (e.from === 'opponent' && e.text !== undefined) return;
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
        this.patchGame({ end: e.end, drawOffered: false, notice: null, ratingChange: this.rate(e.end) });
        this.announce(); // back to "online"
        void this.saveFinished(e.end);
        return;
    }
  }

  /**
   * Updates our rating for a finished game. Aborted games and one-sided
   * results (opponent vanished, unconfirmed) don't count, and neither do
   * opponents that send no rating (the desktop bot, older builds).
   */
  private rate(end: GameEnd): { before: number; after: number; shown: string } | null {
    const s = this.session;
    const m = this.match;
    if (!s || !m || this.state.phase !== 'game' || end.aborted || end.unconfirmed || !end.outcome) return null;
    if (m.opponent.rating === undefined) return null;
    const w = end.outcome.winner;
    const score = w === null ? 0.5 : w === s.myColor ? 1 : 0;
    const cls = timeControlClass(this.state.tc);
    const res = applyResult(m.game.start.gid, cls, sanitizeOpponent(m.opponent.rating, m.opponent.rd), score);
    if (!res) return null;
    log('rating', cls, Math.round(res.before.r), '->', Math.round(res.after.r));
    return { before: res.before.r, after: res.after.r, shown: formatRating(res.after) };
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

/** Friends' presence by peer key (re-renders when it changes). */
export function usePresence(): ReadonlyMap<string, Presence> {
  return useSyncExternalStore(online.subscribe, () => online.presence);
}

/** What to show for a friend: their status, or offline if nothing recent arrived. */
export function presenceOf(p: Presence | undefined, now = Date.now()): PresenceStatus | 'offline' {
  return p && now - p.at < PRESENCE_FRESH_MS ? p.status : 'offline';
}

/** The pending friend challenge, if any (re-renders when it changes). */
export function useInvite(): Invite | null {
  return useSyncExternalStore(online.subscribe, () => online.invite);
}

export function useOnline(): OnlineState {
  return useSyncExternalStore(online.subscribe, online.getSnapshot);
}
