import { createBot } from "./toolkit/index.js";

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).
export interface Session {
  // example: step?: "awaiting_amount";
}

/**
 * buildBot — assembles the bot and registers every handler, but does NOT start
 * it. Shared by the runtime entry (src/index.ts) and the Tests-gate harness
 * (src/harness-entry.ts) so both exercise the exact same bot. Add new commands
 * and flows here.
 */
export function buildBot(token: string) {
  const bot = createBot<Session>(token, {
    initial: () => ({}),
  });

  // /start — HabitDash entry point. The full dashboard (habit list with
  // ✓ Done buttons + Add/Stats/List row) is wired in E1T1; for now we
  // greet the user and point them at the upcoming commands so the bot is
  // verifiably alive and on-brand.
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Welcome to HabitDash — your private habit tracker. " +
        "Use /add to create a habit, /list to see them, /check to mark one done, " +
        "or /help for the full command list.",
    );
  });

  return bot;
}
