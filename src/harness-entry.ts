import { buildBot } from "./bot.js";
import { openDb, runMigrations } from "./db.js";

// The Tests-gate harness imports THIS module and calls makeBot() with no args,
// replaying dialog specs tokenlessly (it fakes the Bot API transport — no real
// Telegram call is made). The token is a placeholder for replay. The agntdev-ci
// orchestrator points AGNTDEV_BOT_MODULE at the compiled dist/harness-entry.js.
//
// Each spec runs against a FRESH in-memory SQLite + bot, so dialog state never
// leaks between specs (the test runner calls makeBot() once per spec).
export function makeBot() {
  const db = openDb(":memory:");
  runMigrations(db);
  return buildBot(process.env.BOT_TOKEN ?? "harness-test-token", { db });
}
