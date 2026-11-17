// Saved games (SQLite, on device only; SPECS §9.1). Every game is saved as it's
// played, so unfinished games can be resumed and finished ones reviewed.
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import type { Color, EndReason, Outcome } from '@peermate/core';

export type GameRecord = {
  id: string;
  mode: 'cpu' | 'local';
  level: number | null;
  player: Color | null;
  white: string;
  black: string;
  pgn: string;
  plies: number;
  /** null while the game is unfinished. */
  winner: Color | 'draw' | null;
  reason: EndReason | null;
  startedAt: number;
  updatedAt: number;
  /** JSON of StoredAnalysis, once analysed. */
  analysis: string | null;
};

type Row = {
  id: string;
  mode: string;
  level: number | null;
  player: string | null;
  white: string;
  black: string;
  pgn: string;
  plies: number;
  winner: string | null;
  reason: string | null;
  started_at: number;
  updated_at: number;
  analysis: string | null;
};

const MIGRATIONS = [
  `CREATE TABLE games (
     id TEXT PRIMARY KEY NOT NULL,
     mode TEXT NOT NULL,
     level INTEGER,
     player TEXT,
     white TEXT NOT NULL,
     black TEXT NOT NULL,
     pgn TEXT NOT NULL,
     plies INTEGER NOT NULL,
     winner TEXT,
     reason TEXT,
     started_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     analysis TEXT
   );
   CREATE INDEX games_updated ON games (updated_at DESC);`,
];

let dbPromise: Promise<SQLiteDatabase> | null = null;

function db(): Promise<SQLiteDatabase> {
  dbPromise ??= (async () => {
    const d = await openDatabaseAsync('peermate.db');
    await d.execAsync('PRAGMA journal_mode = WAL;');
    const row = await d.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    let version = row?.user_version ?? 0;
    while (version < MIGRATIONS.length) {
      await d.withTransactionAsync(async () => {
        await d.execAsync(MIGRATIONS[version]);
        await d.execAsync(`PRAGMA user_version = ${version + 1}`);
      });
      version++;
    }
    return d;
  })();
  return dbPromise;
}

export function newGameId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function outcomeOf(record: GameRecord): Outcome | null {
  if (!record.winner || !record.reason) return null;
  return { winner: record.winner === 'draw' ? null : record.winner, reason: record.reason };
}

export async function saveGame(g: GameRecord): Promise<void> {
  const d = await db();
  await d.runAsync(
    `INSERT INTO games (id, mode, level, player, white, black, pgn, plies, winner, reason, started_at, updated_at, analysis)
     VALUES ($id, $mode, $level, $player, $white, $black, $pgn, $plies, $winner, $reason, $started, $updated, $analysis)
     ON CONFLICT(id) DO UPDATE SET
       pgn = excluded.pgn, plies = excluded.plies, winner = excluded.winner, reason = excluded.reason,
       updated_at = excluded.updated_at, analysis = NULL`,
    {
      $id: g.id,
      $mode: g.mode,
      $level: g.level,
      $player: g.player,
      $white: g.white,
      $black: g.black,
      $pgn: g.pgn,
      $plies: g.plies,
      $winner: g.winner,
      $reason: g.reason,
      $started: g.startedAt,
      $updated: g.updatedAt,
      $analysis: null,
    },
  );
}

export async function deleteGame(id: string): Promise<void> {
  await (await db()).runAsync('DELETE FROM games WHERE id = ?', id);
}

export async function saveAnalysis(id: string, analysis: string): Promise<void> {
  await (await db()).runAsync('UPDATE games SET analysis = ? WHERE id = ?', analysis, id);
}

export async function getGame(id: string): Promise<GameRecord | null> {
  const row = await (await db()).getFirstAsync<Row>('SELECT * FROM games WHERE id = ?', id);
  return row ? fromRow(row) : null;
}

export async function listGames(limit = 200): Promise<GameRecord[]> {
  const rows = await (await db()).getAllAsync<Row>('SELECT * FROM games ORDER BY updated_at DESC LIMIT ?', limit);
  return rows.map(fromRow);
}

export async function latestUnfinished(): Promise<GameRecord | null> {
  const row = await (await db()).getFirstAsync<Row>(
    'SELECT * FROM games WHERE winner IS NULL ORDER BY updated_at DESC LIMIT 1',
  );
  return row ? fromRow(row) : null;
}

function fromRow(r: Row): GameRecord {
  return {
    id: r.id,
    mode: r.mode === 'cpu' ? 'cpu' : 'local',
    level: r.level,
    player: r.player === 'w' || r.player === 'b' ? r.player : null,
    white: r.white,
    black: r.black,
    pgn: r.pgn,
    plies: r.plies,
    winner: r.winner === 'w' || r.winner === 'b' || r.winner === 'draw' ? r.winner : null,
    reason: (r.reason as EndReason | null) ?? null,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    analysis: r.analysis,
  };
}
