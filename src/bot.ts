import { createBot } from "./toolkit/index.js";

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).
export interface Session {
  // example: step?: "awaiting_amount";
}

// /help body — lists every command the bot currently understands. Updated by
// later tasks (E2T1, E1T2, E3T1, E4T1) as they ship their /command handlers.
const HELP_TEXT =
  "📖 *HabitDash — Commands*\n\n" +
  "/start — Open the main menu\n" +
  "/help — Show this help\n" +
  "/add — Create a new habit\n" +
  "/list — Show all your habits\n" +
  "/check — Mark a habit done for today\n" +
  "/stats — Today's progress + longest streak\n\n" +
  "Just type one of the commands above to get started.";

const UNKNOWN_COMMAND_HINT =
  "🤔 That command isn't recognized. " +
  "Type /help to see the full list of available commands.";

const ERROR_BOUNDARY_TEXT =
  "😅 Something went wrong on my side. " +
  "Please try again in a moment.";

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

  // /start — HabitDash entry point (T01). The main-menu keyboard + dashboard
  // land in T02 and E1T1; this baseline keeps the bot alive and on-brand.
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Welcome to HabitDash — your private habit tracker. " +
        "Use /add to create a habit, /list to see them, /check to mark one done, " +
        "or /help for the full command list.",
    );
  });

  // /help — list every command the bot currently understands.
  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  // Global error boundary (T03). The toolkit already auto-wires a
  // console.error fallback in createBot(); we register an ADDITIONAL
  // handler that also tries to reply to the user so they never see a
  // silent failure. grammY runs every registered catch handler, so the
  // toolkit's logger still fires.
  bot.catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[habitdash] unhandled error:", err);
    const ctx = (err as { ctx?: { reply?: (text: string) => Promise<unknown> } }).ctx;
    if (ctx && typeof ctx.reply === "function") {
      // Fire-and-forget — if the reply itself fails (no chat, rate limit,
      // etc.) there's nothing useful we can do; the error is already
      // logged above.
      ctx.reply(ERROR_BOUNDARY_TEXT).catch(() => {});
    }
  });

  // Unknown-command fallback. Must be registered AFTER every bot.command(...)
  // so the registered handlers claim their prefixes first. Anything still
  // reaching this catch-all that starts with "/" is a command the bot
  // doesn't know; non-command text (a stray "hello") is ignored because
  // HabitDash is button-driven.
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) {
      // Show the offending command (first token) so the user can spot a
      // typo at a glance.
      const cmd = text.split(/\s+/, 1)[0] ?? text;
      await ctx.reply(`Unknown command: ${cmd}\n${UNKNOWN_COMMAND_HINT}`);
    }
  });

  return bot;
}
