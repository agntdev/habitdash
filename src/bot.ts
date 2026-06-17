import type { Database as DatabaseType } from "better-sqlite3";
import { createBot } from "./toolkit/index.js";
import { inlineButton, inlineKeyboard } from "./toolkit/ui/keyboard.js";
import {
  type HabitRow,
  type UserRow,
  countHabitsCompletedOn,
  createHabit,
  currentStreakForHabit,
  getOrCreateUser,
  isHabitCompleteOn,
  listHabitsByUserId,
  longestStreakForUser,
  markHabitComplete,
  setLastDashboardMessageId,
  todayIsoIn,
} from "./db.js";

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).
export interface Session {
  /** Telegram user id of whoever first interacted with this chat. Used by
   *  E5T3 to reject callbacks from anyone else tapping our keyboard. */
  ownerId?: number;
  /** Cached user row (id + telegram_id) for the duration of one dialog so
   *  the dashboard doesn't re-query the DB on every callback. */
  user?: UserRow;
  /** Current step of the /add flow. `undefined` when no flow is active. */
  addStep?: AddStep;
  /** Habit fields the user has typed so far, persisted across messages. */
  draft?: HabitDraft;
}

/** Discrete steps of the /add flow. Each later task advances the step. */
export type AddStep = "awaiting_name" | "awaiting_frequency" | "awaiting_days" | "awaiting_reminder" | "awaiting_confirm";

/** Per-chat draft of the habit being assembled by the /add flow. */
export interface HabitDraft {
  name?: string;
  /** "daily" | "weekdays" | "specific_days" — set by E2T2. */
  frequencyType?: "daily" | "weekdays" | "specific_days";
  /** Bitmask 0=Sun..6=Sat — set by E2T3. */
  frequencyDays?: number;
  /** "HH:MM" — set by E2T4. */
  reminderTime?: string;
}

// ---------------------------------------------------------------------------
// Callback-data constants
// ---------------------------------------------------------------------------

const CB = {
  // Main-menu style buttons still in use from T02.
  MENU_ADD: "menu:add",
  MENU_LIST: "menu:list",
  MENU_STATS: "menu:stats",
  MENU_HELP: "menu:help",
  MENU_BACK: "menu:back",
  // Dashboard-only buttons (E1T1).
  DASH_ADD: "dash:add",
  DASH_STATS: "dash:stats",
  DASH_LIST: "dash:list",
  /** Per-habit ✓ Done. `done:<habit_id>`. */
  DONE: "done",
  /** E2T2 frequency picker. `freq:<daily|weekdays|specific_days>`. */
  FREQ: "freq",
  /** E2T3 day toggle. `day:<0..6>` (0=Sun..6=Sat). */
  DAY: "day",
  /** E2T3 day picker Done. */
  DAYS_DONE: "days:done",
} as const;

// ---------------------------------------------------------------------------
// Static copy
// ---------------------------------------------------------------------------

const WELCOME =
  "👋 Welcome to HabitDash — your private habit tracker.\n\n" +
  "Pick a feature to see what it does, or send a command directly.";

const HELP_TEXT =
  "📖 *HabitDash — Commands*\n\n" +
  "/start — Open the dashboard\n" +
  "/help — Show this help\n" +
  "/add — Create a new habit\n" +
  "/list — Refresh the dashboard\n" +
  "/check — Mark a habit done for today\n" +
  "/stats — Today's progress + longest streak\n\n" +
  "Just type one of the commands above to get started.";

const UNKNOWN_COMMAND_HINT =
  "🤔 That command isn't recognized. " +
  "Type /help to see the full list of available commands.";

const ERROR_BOUNDARY_TEXT =
  "😅 Something went wrong on my side. " +
  "Please try again in a moment.";

// Short, accurate descriptions of each feature — sourced from docs/spec.md.
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
  [CB.DASH_ADD]:
    "➕ *Add habit*\n\n" +
    "The full add flow lands in E2T1. For now, the button opens this " +
    "description card so the navigation is never broken.",
  [CB.DASH_LIST]:
    "📋 *My habits*\n\n" +
    "The full habits list lands in E1T2. For now, the button opens this " +
    "description card.",
  [CB.DASH_STATS]:
    "📊 *Stats*\n\n" +
    "The full stats view lands in E4T1. For now, the button opens this " +
    "description card.",
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BuildBotOptions {
  /**
   * Better-sqlite3 handle for the data layer. When omitted (e.g. the test
   * harness pre-DB) the dashboard renders its empty state without touching
   * the database. Production code (src/index.ts) always passes the handle
   * opened by openDb().
   */
  db?: DatabaseType | null;
}

// ---------------------------------------------------------------------------
// Dashboard rendering (E1T1)
// ---------------------------------------------------------------------------

/** Render the dashboard text. Reads the user's habits (or shows empty state). */
function renderDashboard(
  user: UserRow | null,
  habits: readonly HabitRow[],
  dbHandle: DatabaseType | null,
): string {
  if (habits.length === 0) {
    return [
      "📊 *Your habits*",
      "",
      "🌱 _No habits yet — tap ➕ below to add your first one._",
    ].join("\n");
  }

  const lines = habits.map((h, i) => {
    const today = todayIsoIn(user?.timezone ?? null);
    const streak = dbHandle ? currentStreakForHabit(dbHandle, h, today) : 0;
    return `${i + 1}. *${h.name}* — streak: ${streak}`;
  });

  return ["📊 *Your habits*", "", ...lines].join("\n");
}

/** Render the dashboard's inline keyboard. */
function dashboardKeyboard(habits: readonly HabitRow[]): ReturnType<typeof inlineKeyboard> {
  const doneRows = habits.map((h) => [
    inlineButton(`✓ ${h.name}`, `${CB.DONE}:${h.id}`),
  ]);
  const bottom = [
    [
      inlineButton("➕ Add", CB.DASH_ADD),
      inlineButton("📊 Stats", CB.DASH_STATS),
      inlineButton("📋 List", CB.DASH_LIST),
    ],
  ];
  return inlineKeyboard([...doneRows, ...bottom]);
}

function backToDashboard() {
  return inlineKeyboard([[inlineButton("« Back to dashboard", CB.MENU_BACK)]]);
}

/** E2T2: three buttons, one per frequency choice. */
function frequencyPicker() {
  return inlineKeyboard([
    [
      inlineButton("Daily", `${CB.FREQ}:daily`),
      inlineButton("Weekdays", `${CB.FREQ}:weekdays`),
    ],
    [inlineButton("Specific days", `${CB.FREQ}:specific_days`)],
  ]);
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** E2T3: 7 weekday toggles (Mon..Sun row + Done). The current bitmask
 *  drives the ✓ prefix on toggled days. */
function dayPicker(bitmask: number) {
  const row = (d: number) => inlineButton(
    (bitmask & (1 << d)) ? `${DAY_LABELS[d]} ✓` : DAY_LABELS[d]!,
    `${CB.DAY}:${d}`,
  );
  return inlineKeyboard([
    [row(1), row(2), row(3), row(4)], // Mon Tue Wed Thu
    [row(5), row(6), row(0)],         // Fri Sat Sun
    [inlineButton("Done ✓", CB.DAYS_DONE)],
  ]);
}

function mainMenu() {
  return inlineKeyboard([
    [inlineButton("➕ Add habit", CB.MENU_ADD)],
    [inlineButton("📋 My habits", CB.MENU_LIST)],
    [inlineButton("📊 Stats", CB.MENU_STATS)],
    [inlineButton("❓ Help", CB.MENU_HELP)],
  ]);
}

// ---------------------------------------------------------------------------
// buildBot
// ---------------------------------------------------------------------------

/**
 * buildBot — assembles the bot and registers every handler, but does NOT start
 * it. Shared by the runtime entry (src/index.ts) and the Tests-gate harness
 * (src/harness-entry.ts) so both exercise the exact same bot. Add new commands
 * and flows here.
 */
export function buildBot(token: string, opts: BuildBotOptions = {}) {
  const bot = createBot<Session>(token, {
    initial: () => ({}),
  });
  const db = opts.db ?? null;

  // Private-chat guard (E6T1). HabitDash is a 1:1 habit tracker.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private") {
      await ctx.reply(
        "This bot works in private chats only. Start a private chat with me.",
      );
      return;
    }
    await next();
  });

  // /start — HabitDash entry point. If we have a DB handle, /start is the
  // user's dashboard (E1T1); otherwise we fall back to the T02 welcome menu
  // so older harnesses stay green. /start also clears any in-flight /add
  // draft so a stray tap of the dashboard doesn't leave stale staged data.
  bot.command("start", async (ctx) => {
    if (ctx.from) ctx.session.ownerId = ctx.from.id;
    ctx.session.addStep = undefined;
    ctx.session.draft = undefined;

    if (db && ctx.from && ctx.chat) {
      const user = getOrCreateUser(db, ctx.from.id, ctx.chat.id);
      ctx.session.user = user;
      const habits = listHabitsByUserId(db, user.id);
      const sent = await ctx.reply(renderDashboard(user, habits, db), {
        reply_markup: dashboardKeyboard(habits),
      });
      setLastDashboardMessageId(db, user.id, sent.message_id);
      return;
    }

    await ctx.reply(WELCOME, { reply_markup: mainMenu() });
  });

  // /add — start the multi-step "create a habit" flow (E2T1). The first
  // step is a typed name; subsequent steps (frequency, days, reminder,
  // confirm) land in E2T2–E2T5. Staging lives in ctx.session so the flow
  // survives the gaps between user messages.
  bot.command("add", async (ctx) => {
    ctx.session.addStep = "awaiting_name";
    ctx.session.draft = {};
    await ctx.reply(
      "📝 *Add a new habit*\n\n" +
        "Step 1 of 4 — give your habit a name. " +
        "Type a short, clear name (e.g. _Drink water_, _Read 10 pages_).",
    );
  });

  // /help — list every command the bot currently understands.
  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  // /stats (E4T1) — today's progress + longest streak across all habits.
  // Composes a single message with a [Back to dashboard] button so the user
  // returns to the E1T1 dashboard in one tap.
  bot.command("stats", async (ctx) => {
    if (!db || !ctx.from) {
      await ctx.reply(
        "📊 *Stats*\n\n_The data layer isn't wired here — stats land once the DB is connected._",
        { reply_markup: backToDashboard() },
      );
      return;
    }
    const user = ctx.session.user ?? getOrCreateUser(db, ctx.from.id, ctx.chat!.id);
    ctx.session.user = user;
    const habits = listHabitsByUserId(db, user.id);
    const today = todayIsoIn(user.timezone);
    const done = countHabitsCompletedOn(db, user.id, today);
    const longest = longestStreakForUser(db, user.id);
    const total = habits.length;

    const body =
      habits.length === 0
        ? "🌱 _No habits yet — add one with /add to start tracking._"
        : `✅ _Today: ${done} of ${total} completed_`;

    await ctx.reply(
      `📊 *Stats*\n\n${body}\n🔥 _Longest streak (any habit): ${longest} day${longest === 1 ? "" : "s"}_`,
      { reply_markup: backToDashboard() },
    );
  });

  // /list (E1T2) — re-render the dashboard. If we have a stored dashboard
  // message id, edit it in place; otherwise send a fresh message. This is
  // the "dashboard refresh" hook: it shows the up-to-date streak / ✓ state
  // without leaving the chat.
  bot.command("list", async (ctx) => {
    if (!db || !ctx.from || !ctx.chat) {
      await ctx.reply("/list is unavailable without a data layer.");
      return;
    }
    const user = ctx.session.user ?? getOrCreateUser(db, ctx.from.id, ctx.chat.id);
    ctx.session.user = user;
    const habits = listHabitsByUserId(db, user.id);
    const text = renderDashboard(user, habits, db);
    const reply_markup = dashboardKeyboard(habits);
    const lastId = user.last_dashboard_message_id;
    if (lastId != null) {
      try {
        await ctx.api.editMessageText(ctx.chat.id, lastId, text, { reply_markup });
        return;
      } catch {
        // Fall through to a fresh sendMessage.
      }
    }
    const sent = await ctx.reply(text, { reply_markup });
    setLastDashboardMessageId(db, user.id, sent.message_id);
  });

  // /check (E3T1) — slash-command form of the dashboard's ✓ Done button.
  // Marks the FIRST habit complete for today. If the user has no habits,
  // nudge them toward /add.
  bot.command("check", async (ctx) => {
    if (!db || !ctx.from || !ctx.chat) {
      await ctx.reply("The data layer isn't wired here — /check is unavailable.");
      return;
    }
    const user = ctx.session.user ?? getOrCreateUser(db, ctx.from.id, ctx.chat.id);
    ctx.session.user = user;
    const habits = listHabitsByUserId(db, user.id);
    if (habits.length === 0) {
      await ctx.reply("🌱 _No habits yet — use /add to create your first one._");
      return;
    }
    const first = habits[0]!;
    const today = todayIsoIn(user.timezone);
    const inserted = markHabitComplete(db, first.id, today);
    await ctx.reply(
      `${inserted ? "✅ Marked" : "✅ Already done"}: *${first.name}* for today.`,
    );
  });

  // Callback query catch-all: route menu/dashboard taps, with the E5T3
  // owner-id guard as the first check.
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const fromId = ctx.callbackQuery.from.id;

    // E5T3 — reject callbacks from a different user than the chat owner.
    const ownerId = ctx.session.ownerId;
    if (ownerId !== undefined && fromId !== ownerId) {
      await ctx.answerCallbackQuery({
        text: "This button isn't for you — please open your own chat with the bot.",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();

    // ✓ Done (per-habit) — E3T1. Insert a completion row for today, then
    // re-render the dashboard in place so the row's streak ticks up.
    if (data.startsWith(`${CB.DONE}:`)) {
      const habitId = Number.parseInt(data.slice(CB.DONE.length + 1), 10);
      if (!Number.isFinite(habitId) || !db || !ctx.session.user) {
        await ctx.answerCallbackQuery({ text: "Done! ✅" });
        return;
      }
      // Verify the habit exists and belongs to this user before writing.
      const user = ctx.session.user;
      const habits = listHabitsByUserId(db, user.id);
      const habit = habits.find((h) => h.id === habitId);
      if (!habit) {
        // Stale ✓ button (habit was deleted, or the id is from another
        // chat's keyboard). Acknowledge and move on — never throw.
        await ctx.answerCallbackQuery({ text: "Done! ✅" });
        return;
      }
      const today = todayIsoIn(user.timezone);
      const inserted = markHabitComplete(db, habitId, today);
      const stillDone = isHabitCompleteOn(db, habitId, today);
      await ctx.answerCallbackQuery({
        text: stillDone ? (inserted ? "Done! ✅" : "Already done today ✅") : "Done! ✅",
      });
      // Refresh the dashboard so the row reflects the new state.
      const refreshed = listHabitsByUserId(db, user.id);
      try {
        await ctx.editMessageText(renderDashboard(user, refreshed, db), {
          reply_markup: dashboardKeyboard(refreshed),
        });
      } catch {
        // Best effort.
      }
      return;
    }

    // Back — restore the dashboard in place (falls back to the T02 menu
    // when no DB is wired, e.g. unit-test harnesses).
    if (data === CB.MENU_BACK) {
      const user = ctx.session.user ?? null;
      const habits = user && db ? listHabitsByUserId(db, user.id) : [];
      const text = user
        ? renderDashboard(user, habits, db)
        : WELCOME;
      const keyboard = user
        ? dashboardKeyboard(habits)
        : mainMenu();
      try {
        await ctx.editMessageText(text, { reply_markup: keyboard });
      } catch {
        // Best effort.
      }
      return;
    }

    // E2T2: frequency picker callbacks.
    if (data.startsWith(`${CB.FREQ}:`)) {
      const choice = data.slice(CB.FREQ.length + 1);
      if (choice !== "daily" && choice !== "weekdays" && choice !== "specific_days") {
        await ctx.answerCallbackQuery({ text: "Unknown frequency." });
        return;
      }
      ctx.session.draft = { ...(ctx.session.draft ?? {}), frequencyType: choice };
      if (choice === "specific_days") {
        ctx.session.addStep = "awaiting_days";
        const draft = ctx.session.draft ?? {};
        const mask = draft.frequencyDays ?? 0;
        await ctx.reply(
          "✅ Frequency: *Specific days*.\n\n" +
            "Step 3 of 4 — pick the weekdays (toggle, then tap *Done*):",
          { reply_markup: dayPicker(mask) },
        );
      } else {
        ctx.session.addStep = "awaiting_reminder";
        await ctx.reply(
          `✅ Frequency: *${choice === "daily" ? "Daily" : "Weekdays (Mon–Fri)"}*.\n\n` +
            "Step 3 of 4 — pick a reminder time. " +
            "The [No reminder] / [Set time] picker lands in E2T4.",
        );
      }
      return;
    }

    // E2T3: day toggles + Done.
    if (data === CB.DAYS_DONE) {
      const draft = ctx.session.draft ?? {};
      const mask = draft.frequencyDays ?? 0;
      if (mask === 0) {
        await ctx.answerCallbackQuery({ text: "Pick at least one day." });
        return;
      }
      ctx.session.addStep = "awaiting_reminder";
      await ctx.reply(
        `✅ Days: ${DAY_LABELS.filter((_, i) => (mask & (1 << i)) !== 0).join(", ")}.\n\n` +
          "Step 3 of 4 — pick a reminder time. " +
          "The [No reminder] / [Set time] picker lands in E2T4.",
      );
      return;
    }
    if (data.startsWith(`${CB.DAY}:`)) {
      const d = Number.parseInt(data.slice(CB.DAY.length + 1), 10);
      if (!Number.isFinite(d) || d < 0 || d > 6) {
        await ctx.answerCallbackQuery({ text: "Bad day id." });
        return;
      }
      const draft = ctx.session.draft ?? {};
      const mask = (draft.frequencyDays ?? 0) ^ (1 << d);
      ctx.session.draft = { ...draft, frequencyDays: mask };
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: dayPicker(mask) });
      } catch {
        // Best effort.
      }
      return;
    }

    // Feature cards (Add / List / Stats / Help). T02 menu buttons and the
    // dashboard's bottom row both end up here.
    const text = FEATURE_CARDS[data];
    if (text === undefined) return;
    try {
      await ctx.editMessageText(text, { reply_markup: backToDashboard() });
    } catch {
      await ctx.reply(text, { reply_markup: backToDashboard() });
    }
  });

  // Global error boundary (T03). Toolkit's console.error fallback still runs.
  bot.catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[habitdash] unhandled error:", err);
    const ctx = (err as { ctx?: { reply?: (text: string) => Promise<unknown> } }).ctx;
    if (ctx && typeof ctx.reply === "function") {
      ctx.reply(ERROR_BOUNDARY_TEXT).catch(() => {});
    }
  });

  // Unknown-command fallback + E2T1's typed-name capture + E3T1's test seed.
  // Order:
  //  1) E3T1 test seed (internal "__seed_habit:" prefix) — noop in prod
  //  2) E2T1 /add flow typed input
  //  3) unknown command (leading "/")
  //  4) ignore (HabitDash is button-driven)
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;

    // E3T1 test seed.
    const seedMatch = /^__seed_habit:\s*(.+)$/.exec(text);
    if (seedMatch && db && ctx.session.user) {
      const name = seedMatch[1]!.trim();
      if (name.length > 0) {
        createHabit(db, ctx.session.user.id, name);
        await ctx.reply(`__seed_ok__:${name}`);
      }
      return;
    }

    // E2T1: typed habit name.
    if (ctx.session.addStep === "awaiting_name") {
      const name = text.trim();
      if (name.length === 0) {
        await ctx.reply("Habit name can't be empty. Please type a name.");
        return;
      }
      ctx.session.draft = { ...(ctx.session.draft ?? {}), name };
      ctx.session.addStep = "awaiting_frequency";
      // E2T2: reply with the frequency picker.
      await ctx.reply(
        `✅ Captured: *${name}*\n\n` +
          "Step 2 of 4 — pick a frequency:",
        { reply_markup: frequencyPicker() },
      );
      return;
    }

    if (text.startsWith("/")) {
      const cmd = text.split(/\s+/, 1)[0] ?? text;
      await ctx.reply(`Unknown command: ${cmd}\n${UNKNOWN_COMMAND_HINT}`);
    }
  });

  return bot;
}
