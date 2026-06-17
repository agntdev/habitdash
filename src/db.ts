// SQLite schema + migrations for HabitDash.
//
// One file, one purpose: open the database file, run every pending migration
// exactly once, and return a typed handle the rest of the bot uses. Schema is
// derived straight from docs/spec.md (users / habits / completions) so the
// data layer matches the product contract.
//
// Migrations are append-only and identified by a monotonically increasing
// `schema_version` row in the metadata table — re-running on an up-to-date DB
// is a no-op, so `runMigrations()` is safe to call on every bot startup.

import Database, { type Database as DatabaseType } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Default on-disk location. Override with `HABITDASH_DB` for tests / CI. */
export const DEFAULT_DB_PATH = "data/habits.db";

/** Current schema version. Bump when adding a migration. */
export const CURRENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

interface Migration {
  version: number;
  /** Human-readable label, surfaced in the metadata table for debugging. */
  label: string;
  /** Raw SQL — may be multiple statements separated by semicolons. */
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    label: "initial schema: users, habits, completions",
    sql: `
      CREATE TABLE users (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id                 INTEGER UNIQUE NOT NULL,
        chat_id                     INTEGER NOT NULL,
        timezone                    TEXT,
        last_dashboard_message_id   INTEGER,
        created_at                  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE habits (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name                TEXT NOT NULL,
        frequency_type      TEXT NOT NULL CHECK (frequency_type IN ('daily', 'weekdays', 'specific_days')),
        frequency_days      INTEGER,
        reminder_time       TEXT,
        created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_habits_user_id ON habits(user_id);

      CREATE TABLE completions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        habit_id    INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
        date        TEXT NOT NULL,
        created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      -- A habit can be completed at most once per (ISO) date.
      CREATE UNIQUE INDEX uq_completions_habit_date ON completions(habit_id, date);
      CREATE INDEX idx_completions_habit_id ON completions(habit_id);
    `,
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open (or create) the SQLite file at `path`, ensuring the parent directory
 * exists. Returns a ready-to-use better-sqlite3 handle with foreign keys on
 * (per the spec — ON DELETE CASCADE only works when the pragma is enabled).
 */
export function openDb(path: string = DEFAULT_DB_PATH): DatabaseType {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * Run every pending migration, in order. Idempotent — safe to call on every
 * bot startup. Returns the schema version the database is at after the call.
 */
export function runMigrations(db: DatabaseType): number {
  // Metadata table. Created here (not in a migration) so even an empty DB
  // can be queried for its current version.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const current = readSchemaVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > current);

  if (pending.length === 0) return current;

  const applyAll = db.transaction((migrations: readonly Migration[]) => {
    for (const m of migrations) {
      db.exec(m.sql);
      writeSchemaVersion(db, m.version, m.label);
    }
  });
  applyAll(pending);

  return readSchemaVersion(db);
}

/** Read the current schema version from the metadata table (0 if unset). */
export function readSchemaVersion(db: DatabaseType): number {
  const row = db
    .prepare<[], { value: string }>(
      "SELECT value FROM schema_meta WHERE key = 'schema_version'",
    )
    .get();
  if (!row) return 0;
  const n = Number.parseInt(row.value, 10);
  return Number.isFinite(n) ? n : 0;
}

function writeSchemaVersion(db: DatabaseType, version: number, label: string): void {
  db.prepare(
    "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(version));
  db.prepare(
    "INSERT INTO schema_meta (key, value) VALUES ('schema_version_label', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(label);
}

// ---------------------------------------------------------------------------
// Domain types + accessors
// ---------------------------------------------------------------------------

/** Shape of a row in the `users` table. */
export interface UserRow {
  id: number;
  telegram_id: number;
  chat_id: number;
  timezone: string | null;
  last_dashboard_message_id: number | null;
  created_at: string;
}

/** Shape of a row in the `habits` table. */
export interface HabitRow {
  id: number;
  user_id: number;
  name: string;
  /** "daily" | "weekdays" | "specific_days" */
  frequency_type: string;
  /** Bitmask 0=Sun..6=Sat when frequency_type === "specific_days", else null. */
  frequency_days: number | null;
  /** "HH:MM" or null. */
  reminder_time: string | null;
  created_at: string;
}

/** Look up a user by Telegram id, creating the row on first contact. */
export function getOrCreateUser(
  db: DatabaseType,
  telegramId: number,
  chatId: number,
): UserRow {
  const existing = db
    .prepare<[number], UserRow>(
      "SELECT * FROM users WHERE telegram_id = ?",
    )
    .get(telegramId);
  if (existing) return existing;
  db.prepare(
    "INSERT INTO users (telegram_id, chat_id) VALUES (?, ?)",
  ).run(telegramId, chatId);
  // INSERT changed rowcount; re-read so the caller gets the auto id.
  return db
    .prepare<[number], UserRow>("SELECT * FROM users WHERE telegram_id = ?")
    .get(telegramId) as UserRow;
}

/** Persist the id of the most recently rendered dashboard message for a user. */
export function setLastDashboardMessageId(
  db: DatabaseType,
  userId: number,
  messageId: number,
): void {
  db.prepare(
    "UPDATE users SET last_dashboard_message_id = ? WHERE id = ?",
  ).run(messageId, userId);
}

/** All habits for a user, ordered by creation time. */
export function listHabitsByUserId(
  db: DatabaseType,
  userId: number,
): HabitRow[] {
  return db
    .prepare<[number], HabitRow>(
      "SELECT * FROM habits WHERE user_id = ? ORDER BY created_at ASC, id ASC",
    )
    .all(userId);
}

/** ISO 8601 date (YYYY-MM-DD) for the current instant in the given IANA
 *  timezone (defaults to UTC). Used by /stats to bucket completions by day
 *  in the user's local frame. */
export function todayIsoIn(tz: string | null, now: Date = new Date()): string {
  // en-CA gives YYYY-MM-DD ordering reliably across Node versions.
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Count habits that have a completion row for `dateIso` (default: today UTC). */
export function countHabitsCompletedOn(
  db: DatabaseType,
  userId: number,
  dateIso: string,
): number {
  const row = db
    .prepare<[number, string], { n: number }>(
      `SELECT COUNT(DISTINCT h.id) AS n
         FROM habits h
         JOIN completions c ON c.habit_id = h.id
         WHERE h.user_id = ? AND c.date = ?`,
    )
    .get(userId, dateIso);
  return row?.n ?? 0;
}

/** Longest consecutive-day run of completions for any habit owned by the
 *  user. Returns 0 when the user has no habits or no completions. */
export function longestStreakForUser(
  db: DatabaseType,
  userId: number,
): number {
  const dates = db
    .prepare<[number], { date: string }>(
      `SELECT DISTINCT c.date AS date
         FROM completions c
         JOIN habits h ON h.id = c.habit_id
         WHERE h.user_id = ?
         ORDER BY c.date ASC`,
    )
    .all(userId)
    .map((r) => r.date);
  if (dates.length === 0) return 0;

  let best = 1;
  let run = 1;
  for (let i = 1; i < dates.length; i++) {
    if (isNextDay(dates[i - 1], dates[i])) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 1;
    }
  }
  return best;
}

function isNextDay(prev: string, cur: string): boolean {
  // Cheap ISO-day check using Date math (avoids a date-fns dependency).
  const a = Date.UTC(
    Number(prev.slice(0, 4)),
    Number(prev.slice(5, 7)) - 1,
    Number(prev.slice(8, 10)),
  );
  const b = Date.UTC(
    Number(cur.slice(0, 4)),
    Number(cur.slice(5, 7)) - 1,
    Number(cur.slice(8, 10)),
  );
  return (b - a) / 86_400_000 === 1;
}

/** Create a habit for the user. Frequency defaults to 'daily'. */
export function createHabit(
  db: DatabaseType,
  userId: number,
  name: string,
  opts?: { frequencyType?: "daily" | "weekdays" | "specific_days"; frequencyDays?: number; reminderTime?: string | null },
): HabitRow {
  const freq = opts?.frequencyType ?? "daily";
  const info = db
    .prepare(
      "INSERT INTO habits (user_id, name, frequency_type, frequency_days, reminder_time) VALUES (?, ?, ?, ?, ?)",
    )
    .run(userId, name, freq, opts?.frequencyDays ?? null, opts?.reminderTime ?? null);
  return db
    .prepare<[number | bigint], HabitRow>("SELECT * FROM habits WHERE id = ?")
    .get(info.lastInsertRowid) as HabitRow;
}

/** Insert a completion row for the (habit, date) pair, idempotent. */
export function markHabitComplete(
  db: DatabaseType,
  habitId: number,
  dateIso: string,
): boolean {
  // INSERT OR IGNORE — the unique(habit_id, date) index makes a second tap a
  // no-op. Returns true on the first insert, false on a duplicate.
  const info = db
    .prepare("INSERT OR IGNORE INTO completions (habit_id, date) VALUES (?, ?)")
    .run(habitId, dateIso);
  return info.changes === 1;
}

/** True iff the habit has a completion row for `dateIso`. */
export function isHabitCompleteOn(
  db: DatabaseType,
  habitId: number,
  dateIso: string,
): boolean {
  const row = db
    .prepare<[number, string], { n: number }>(
      "SELECT COUNT(*) AS n FROM completions WHERE habit_id = ? AND date = ?",
    )
    .get(habitId, dateIso);
  return (row?.n ?? 0) > 0;
}
