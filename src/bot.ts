import { createBot } from "./toolkit/index.js";
import { inlineButton, inlineKeyboard } from "./toolkit/ui/keyboard.js";

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).
export interface Session {
  /** Telegram user id of whoever first interacted with this chat. Used by
   *  E5T3 to reject callbacks from anyone else tapping the same keyboard. */
  ownerId?: number;
}

// Callback-data constants for the /start main menu. Kept here so the menu
// builder and the callback handler can never drift apart.
const CB = {
  MENU_ADD: "menu:add",
  MENU_LIST: "menu:list",
  MENU_STATS: "menu:stats",
  MENU_HELP: "menu:help",
  MENU_BACK: "menu:back",
} as const;

const WELCOME =
  "👋 Welcome to HabitDash — your private habit tracker.\n\n" +
  "Pick a feature to see what it does, or send a command directly.";

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

function mainMenu() {
  return inlineKeyboard([
    [inlineButton("➕ Add habit", CB.MENU_ADD)],
    [inlineButton("📋 My habits", CB.MENU_LIST)],
    [inlineButton("📊 Stats", CB.MENU_STATS)],
    [inlineButton("❓ Help", CB.MENU_HELP)],
  ]);
}

function backToMenu() {
  return inlineKeyboard([[inlineButton("« Back to menu", CB.MENU_BACK)]]);
}

// Short, accurate descriptions of each feature — sourced from docs/spec.md so
// they reflect the real product (not "coming soon" stubs). Each tap replaces
// the menu message in place with this card + a Back button.
const FEATURE_CARDS: Record<string, string> = {
  [CB.MENU_ADD]:
    "➕ *Add habit*\n\n" +
    "Create a new habit to track. You'll set a name, a frequency " +
    "(daily, weekdays, or specific days), and an optional reminder time.",
  [CB.MENU_LIST]:
    "📋 *My habits*\n\n" +
    "See every habit you track, with its current streak and a quick " +
    "✓ Done button for each one.",
  [CB.MENU_STATS]:
    "📊 *Stats*\n\n" +
    "Today's progress (X of Y habits completed) and your longest streak " +
    "across all habits.",
  [CB.MENU_HELP]:
    "❓ *Help*\n\n" +
    "The full list of commands this bot understands.",
};

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

  // Private-chat guard (E6T1). HabitDash is a 1:1 habit tracker — it must
  // never carry state for groups/channels. Registered first so every
  // downstream command/handler is skipped for non-private chats; we reply
  // once with the user-facing message and stop the middleware chain.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private") {
      await ctx.reply(
        "This bot works in private chats only. Start a private chat with me.",
      );
      return;
    }
    await next();
  });

  // /start — welcome + main menu (T02). The full dashboard (habit list with
  // ✓ Done buttons + Add/Stats/List row) is wired in E1T1; this PR ships the
  // menu surface that those features will hang off of.
  bot.command("start", async (ctx) => {
    // Record the owner of this chat so E5T3 can reject callbacks from any
    // other Telegram user that ends up tapping our keyboard.
    if (ctx.from) ctx.session.ownerId = ctx.from.id;
    await ctx.reply(WELCOME, { reply_markup: mainMenu() });
  });

  // /help — list every command the bot currently understands.
  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  // Menu button taps + Back: a single catch-all keeps the routing table in
  // one place. Each tap answers the spinner, then either restores the main
  // menu (Back) or edits the message in place to show a feature card. If
  // the edit fails (message too old, deleted, etc.) we fall back to a fresh
  // message so the user is never left without feedback.
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const fromId = ctx.callbackQuery.from.id;

    // E5T3 — reject callbacks from a different user than the one who
    // opened the chat. In a private chat this is effectively a no-op
    // (only one user can chat with the bot), but the guard matters once
    // richer per-user data lands (E2T1's add flow, E3T1's check action).
    const ownerId = ctx.session.ownerId;
    if (ownerId !== undefined && fromId !== ownerId) {
      await ctx.answerCallbackQuery({
        text: "This button isn't for you — please open your own chat with the bot.",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();

    if (data === CB.MENU_BACK) {
      try {
        await ctx.editMessageText(WELCOME, { reply_markup: mainMenu() });
      } catch {
        // Best effort — edit can fail if the message is gone.
      }
      return;
    }

    const text = FEATURE_CARDS[data];
    if (text === undefined) {
      // Unknown callback — spinner is already stopped; nothing more to do.
      return;
    }
    try {
      await ctx.editMessageText(text, { reply_markup: backToMenu() });
    } catch {
      await ctx.reply(text, { reply_markup: backToMenu() });
    }
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
      const cmd = text.split(/\s+/, 1)[0] ?? text;
      await ctx.reply(`Unknown command: ${cmd}\n${UNKNOWN_COMMAND_HINT}`);
    }
  });

  return bot;
}
