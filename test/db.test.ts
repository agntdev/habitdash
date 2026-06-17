import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  openDb,
  readSchemaVersion,
  runMigrations,
} from "../src/db";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "habitdash-db-"));
  dbPath = join(tmpDir, "habits.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("openDb", () => {
  it("creates the parent directory if missing", () => {
    const nested = join(tmpDir, "deep", "nested", "habits.db");
    const db = openDb(nested);
    db.exec("CREATE TABLE x (id INTEGER)");
    db.close();
    expect(() => rmSync(join(tmpDir, "deep"), { recursive: true })).not.toThrow();
  });

  it("enables foreign keys (required for ON DELETE CASCADE)", () => {
    const db = openDb(dbPath);
    const row = db.pragma("foreign_keys", { simple: true });
    expect(row).toBe(1);
    db.close();
  });
});

describe("runMigrations", () => {
  it("applies all migrations on a fresh database and stamps schema_meta", () => {
    const db = openDb(dbPath);
    const version = runMigrations(db);
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
    expect(readSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it("is idempotent — re-running on an up-to-date DB is a no-op", () => {
    const db = openDb(dbPath);
    runMigrations(db);
    const before = readSchemaVersion(db);
    const after = runMigrations(db);
    expect(after).toBe(before);
    db.close();
  });

  it("creates users, habits, completions tables with the expected columns", () => {
    const db = openDb(dbPath);
    runMigrations(db);
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toContain("users");
    expect(tables).toContain("habits");
    expect(tables).toContain("completions");
    expect(tables).toContain("schema_meta");
    db.close();
  });

  it("enforces the unique(habit_id, date) index on completions", () => {
    const db = openDb(dbPath);
    runMigrations(db);
    // Insert a user + a habit so we have valid FK targets.
    db.prepare(
      "INSERT INTO users (telegram_id, chat_id) VALUES (?, ?)",
    ).run(1, 1);
    db.prepare(
      "INSERT INTO habits (user_id, name, frequency_type) VALUES (?, ?, ?)",
    ).run(1, "Drink water", "daily");
    db.prepare("INSERT INTO completions (habit_id, date) VALUES (?, ?)").run(
      1,
      "2026-06-17",
    );
    // A second completion for the same habit+date must fail.
    expect(() =>
      db.prepare("INSERT INTO completions (habit_id, date) VALUES (?, ?)").run(
        1,
        "2026-06-17",
      ),
    ).toThrow(/UNIQUE/i);
    db.close();
  });
});
