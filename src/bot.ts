import { createBot } from "./toolkit/index.js";
import { inlineButton, inlineKeyboard } from "./toolkit/ui/keyboard.js";

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).
export interface Session {
  // example: step?: "awaiting_amount";
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

  // /start — welcome + main menu (T02).
  // The full dashboard (habit list with ✓ Done buttons + Add/Stats/List row)
  // is wired in E1T1; this PR ships the menu surface that those features
  // will hang off of.
  bot.command("start", async (ctx) => {
    await ctx.reply(WELCOME, { reply_markup: mainMenu() });
  });

  // Menu button taps + Back: a single catch-all keeps the routing table in
  // one place. Each tap answers the spinner, then either restores the main
  // menu (Back) or edits the message in place to show a feature card. If
  // the edit fails (message too old, deleted, etc.) we fall back to a fresh
  // message so the user is never left without feedback.
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
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
      // Unknown callback — spinner is already stopped; the catch-all error
      // boundary (T03) handles logging.
      return;
    }
    try {
      await ctx.editMessageText(text, { reply_markup: backToMenu() });
    } catch {
      await ctx.reply(text, { reply_markup: backToMenu() });
    }
  });

  return bot;
}
