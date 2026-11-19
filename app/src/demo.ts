// Demo mode, for store screenshots (SPECS §13.3 screenshots): fills a FRESH
// install with sample content: a nickname, friends with presence, a chat,
// ratings, a computer game in progress, finished games and a live-looking
// online game. Opened with the peermate://demo link (tools/screenshots-android.sh).
//
// It refuses to run on an install that has real data, so it can never overwrite
// a player's friends, games or ratings.
import { Platform, Settings } from 'react-native';
import { router, type Href } from 'expo-router';
import { Chess, deriveIdentity, toPgn } from '@peermate/core';
import { appLog } from '../modules/peermate-log';
import { addFriend, friends } from './net/friends';
import { addMessage } from './net/messages';
import { online } from './net/online';
import { setNick } from './net/profile';
import { setRatingsForDemo } from './net/ratings';
import { listGames, saveGame } from './storage/games';

const DAY = 24 * 3600 * 1000;

/** Sample friends: deterministic keys, so screenshots are stable. */
const FRIENDS = [
  { seed: 11, nick: 'Maya', status: 'online' as const },
  { seed: 12, nick: 'Tomás', status: 'playing' as const },
  { seed: 13, nick: 'Priya', status: 'away' as const },
  { seed: 14, nick: 'Jonas', status: null },
];

/** The Italian game, Møller attack: a lively middlegame. */
const ITALIAN = 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d4 e5d4 c3d4 c5b4 b1c3 f6e4 e1g1 b4c3 d4d5 c3f6 f1e1 c6e7 e1e4 d7d6'.split(' ');
/** Queen's Gambit Declined, a quiet start. */
const QGD = 'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7 e2e3 e8g8 g1f3 b8d7 a1c1 c7c6 f1d3 d5c4 d3c4 f6d5'.split(' ');

function pgnOf(ucis: string[], white: string, black: string, event: string): string {
  const chess = new Chess();
  for (const u of ucis) chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
  return toPgn(chess, { white, black, event }, null);
}

export async function isFreshInstall(): Promise<boolean> {
  return friends().length === 0 && (await listGames(1)).length === 0;
}

/** Fills the app with sample content. Throws if the install isn't fresh. */
export async function seedDemo(): Promise<void> {
  if (!(await isFreshInstall())) throw new Error('Demo mode only runs on a fresh install.');
  const now = Date.now();
  await setNick('Alex');

  const keys = FRIENDS.map((f) => {
    const id = deriveIdentity(new Uint8Array(32).fill(f.seed));
    addFriend(id.peer.publicKey, id.nostr.publicKey, f.nick);
    return id.peer.publicKey;
  });
  online.demoPresence(FRIENDS.flatMap((f, i) => (f.status ? [[keys[i], f.status] as [string, typeof f.status]] : [])));

  const chat: [('me' | 'them'), string, number][] = [
    ['them', 'Rematch tonight? I want my revenge for that endgame!', 52],
    ['me', 'Ha, sure. 10 minutes this time?', 50],
    ['them', 'Deal. Around 8?', 49],
    ['me', "I'll be there. Bring your Sicilian", 47],
    ['them', 'Challenge me when you’re free', 3],
  ];
  chat.forEach(([from, text, minsAgo], i) =>
    addMessage(keys[0], { id: `demo-${i}`, from, text, at: now - minsAgo * 60_000, status: from === 'me' ? 'sent' : undefined }),
  );

  setRatingsForDemo({
    bullet: { r: 1588, rd: 74, vol: 0.06, games: 31 },
    blitz: { r: 1642, rd: 58, vol: 0.06, games: 87 },
    rapid: { r: 1705, rd: 81, vol: 0.06, games: 22 },
  });

  // A computer game in progress (Home: "Continue game").
  await saveGame({
    id: 'demo-cpu',
    mode: 'cpu',
    level: 6,
    player: 'w',
    white: 'Alex',
    black: 'Level 6',
    pgn: pgnOf(QGD, 'Alex', 'Level 6', 'Casual game'),
    plies: QGD.length,
    winner: null,
    reason: null,
    startedAt: now - 20 * 60_000,
    updatedAt: now - 5 * 60_000,
    analysis: null,
  });
  // Finished games for the Games tab.
  const finished: [string, string, string, 'w' | 'b' | 'draw', string, number][] = [
    ['online', 'Alex', 'Maya', 'w', 'checkmate', 1],
    ['online', 'Tomás', 'Alex', 'draw', 'agreement', 2],
    ['cpu', 'Alex', 'Level 5', 'w', 'resignation', 3],
    ['online', 'Alex', 'Priya', 'b', 'timeout', 5],
  ];
  for (const [i, [mode, white, black, winner, reason, daysAgo]] of finished.entries()) {
    await saveGame({
      id: `demo-done-${i}`,
      mode: mode as 'online' | 'cpu',
      level: mode === 'cpu' ? 5 : null,
      player: white === 'Alex' ? 'w' : 'b',
      white,
      black,
      pgn: pgnOf(ITALIAN.slice(0, 12 + i * 2), white, black, 'Peermate'),
      plies: 12 + i * 2,
      winner,
      reason: reason as never,
      startedAt: now - daysAgo * DAY,
      updatedAt: now - daysAgo * DAY + 15 * 60_000,
      analysis: null,
    });
  }
}

/** The live-looking online game (Online screen screenshot). */
export function startDemoGame(): Promise<void> {
  // 18 plies: 9...Bf6, with White (the player) to move.
  return online.demoGame({ nick: 'Tomás', rating: 1671, rd: 64, tc: '5+0', moves: ITALIAN.slice(0, 18) });
}

let touring = false;

/** True while the demo tour runs (screens skip permission prompts, which would spoil shots). */
export function demoTourRunning(): boolean {
  return touring;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * iOS screenshots (tools/screenshots-ios.sh): the simulator can't open a deep
 * link without an "Open in Peermate?" prompt, so the app tours the screens
 * itself when launched with `-peermateDemoTour 1`, logging "demo shot <name>"
 * on each for the script to capture.
 */
export async function maybeRunDemoTour(): Promise<void> {
  if (Platform.OS !== 'ios' || !Settings.get('peermateDemoTour') || touring) return;
  touring = true;
  const shot = async (name: string, href: Href, settle: number) => {
    // Each screen straight from Home, so its back button just says "Peermate".
    if (router.canDismiss()) router.dismissAll();
    if (href !== '/') router.push(href);
    await sleep(settle);
    appLog('demo', 'shot', name);
    await sleep(1500); // the script captures meanwhile
  };
  try {
    await sleep(3000);
    await seedDemo();
    const maya = deriveIdentity(new Uint8Array(32).fill(FRIENDS[0].seed)).peer.publicKey;
    // The computer game first: coming back from it makes Home reload, showing "Continue game".
    await shot('3_vs_computer', { pathname: '/game', params: { resume: 'demo-cpu' } }, 8000);
    await shot('1_home', '/', 3000);
    await shot('4_friends', '/friends', 3000);
    await shot('5_chat', { pathname: '/chat/[key]', params: { key: maya } }, 3000);
    await shot('6_play_online', '/online', 3000);
    await shot('7_games', '/history', 3000);
    void startDemoGame();
    await shot('2_online_game', '/online-game', 12000);
    appLog('demo', 'tour done');
  } catch (err) {
    appLog('demo', 'tour failed', String(err));
  }
}
