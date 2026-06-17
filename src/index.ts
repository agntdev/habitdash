import { buildBot } from "./bot.js";
import { DEFAULT_DB_PATH, openDb, runMigrations } from "./db.js";

// Runtime entry (dist/index.js). BOT_TOKEN is injected at runtime as a secret.
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN is required");
  process.exit(1);
}

// E5T1: run schema migrations before the bot starts accepting updates so the
// data layer is guaranteed to be in sync with the product code. Migrations are
// idempotent — safe to re-run on every boot.
const dbPath = process.env.HABITDASH_DB ?? DEFAULT_DB_PATH;
const db = openDb(dbPath);
const version = runMigrations(db);
console.error(`[habitdash] db ready at ${dbPath} (schema v${version})`);

const bot = buildBot(token);
bot.start();
