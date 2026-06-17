## Summary
A private-chat Telegram bot to track daily habits. Users create habits (name, frequency, optional reminder time), mark them done for "today", and view streaks and simple stats. All runtime uses long-polling; data persisted locally. Interactions are button-driven and the bot edits a single dashboard message in-place when possible.

## Audience
Single Telegram users (private 1:1 chats). No groups. The owner (you) is the initial user and must be able to add multiple habits and view their progress.

## Core features (what the bot does)
- /start: welcome message and show the user dashboard (habits list with current status and ✓ Done buttons). Stores user record if new.
- /add: multi-step flow (inline-button-driven) to add a habit. The habit name is typed once by the user (allowed during /add); subsequent steps use inline buttons.
- /list: shows all habits with their current streaks (as an edited dashboard as well).
- /check: marks a habit done for today (also available as a ✓ button on the dashboard). Implemented as both a slash command and button action; primary usage is buttons.
- /stats: shows today’s progress (how many habits completed vs total) and the single longest streak across all habits.
- Dashboard: the bot keeps/edits a single dashboard message per chat showing all habits and quick action buttons. When a button is tapped the bot edits that same message (if editing fails it sends a replacement and records the new message id).

## Core entities (DB schema)
All data persisted in local SQLite (file). Tables and important fields:
- users
  - id INTEGER PRIMARY KEY AUTOINCREMENT
  - telegram_id INTEGER UNIQUE NOT NULL
  - chat_id INTEGER NOT NULL
  - timezone TEXT NULL -- stored IANA zone string if set; default in assumptions
  - last_dashboard_message_id INTEGER NULL
  - created_at DATETIME
- habits
  - id INTEGER PRIMARY KEY AUTOINCREMENT
  - user_id INTEGER REFERENCES users(id)
  - name TEXT NOT NULL
  - frequency_type TEXT NOT NULL -- enum: 'daily', 'weekdays', 'specific_days'
  - frequency_days INTEGER NULL -- bitmask for specific weekdays (0=Sun ... 6=Sat) when frequency_type='specific_days'
  - reminder_time TEXT NULL -- HH:MM stored (kept but not used for notifications in v1)
  - created_at DATETIME
- completions
  - id INTEGER PRIMARY KEY AUTOINCREMENT
  - habit_id INTEGER REFERENCES habits(id)
  - date TEXT NOT NULL -- ISO date (YYYY-MM-DD) representing the day the habit was completed in the user's effective timezone
  - created_at DATETIME
Indexes: unique(habit_id, date) to prevent double-checks.

## Streaks & date logic
- A "day" is defined by the user's timezone if available, otherwise the server default timezone (see Assumptions & defaults).
- A habit is considered completed for a date if a completion row exists with that ISO date.
- Current streak: number of consecutive dates up to and including today with completion entries on days that match the habit frequency. Missing a required day breaks the streak.
- Longest streak: max consecutive run of required days with completion rows for that habit; the /stats command returns the longest streak across all of a user's habits.

## Interaction flows (concrete)
- Global rules
  - Bot accepts interactions only in private chats. If used in group, bot replies with a short message: "This bot works in private chats only. Start a private chat with me." and ignores further group interactions.
  - After initial setup, all in-session actions use inline buttons and the bot edits the same dashboard message. The bot still supports slash commands listed below for convenience.
  - Callback data format: JSON-ish compact strings (e.g. "a:habit_id" for check action, "d:open_add:step" for add-flow steps). The bot validates callback user matches the stored user.

- /start
  - Creates user if missing and shows dashboard: one editable message listing habits (each row: habit name, streak, status icon for today, and a ✓ Done inline button). Also bottom row buttons: Add (+), Stats, List.
  - Stores the message_id in users.last_dashboard_message_id.

- /add (multi-step)
  1) User sends /add (or taps Add on dashboard). Bot sends a message editing/creating the dashboard or opening a modal-like flow in-place: "Name? (type once)" — switches to a one-time text-input state for this user.
  2) User types the habit name. Bot replies (edited) with frequency options: [Daily] [Weekdays (Mon–Fri)] [Specific days]
  3) If Specific days chosen: show seven weekday toggle buttons (Mon..Sun) allowing multi-select, and a Done button.
  4) Ask for optional reminder time: buttons [No reminder] [Set time]. If Set time chosen, present quick times (08:00, 12:00, 18:00) plus [Custom] which opens a short typed input for HH:MM.
  5) Confirm summary: "Add habit: NAME — Daily/Weekdays/Mon,Wed,Fri — Reminder: HH:MM or none" with Confirm/Cancel buttons.
  6) On Confirm: create habit row and return to (or update) dashboard.
  - Typing only occurs twice at most in the flow: the habit name and optionally a custom reminder time.

- /check and ✓ Done button
  - Button payload contains habit_id and user_id; on press the bot inserts a completion row for that habit for the user's current date (if not already present), updates the dashboard in-place, and acknowledges transiently by updating the button (e.g. replacing "✓ Done" with "Done ✅" for that session). Avoids sending a new message.
  - If the completion already exists, the button press toggles nothing and the bot returns the edited dashboard (idempotent behavior).

- /list
  - Sends/edits the dashboard showing all habits with streaks and statuses (same view as /start).

- /stats
  - Edits dashboard (or shows a small overlay message) with: today’s progress (X/Y completed), and longest streak across all habits, plus buttons [Back to dashboard].

## Persistence & operational notes
- Use SQLite file (e.g. data/habits.db) with migrations executed on startup.
- Store last_dashboard_message_id per user and use it to edit the dashboard with editMessageText + reply_markup; if edit fails (message deleted or chat changed), send a new dashboard message and update last_dashboard_message_id.
- Keep an in-memory cache of some user state for flows (e.g. add-flow staged data). Persist only final objects to DB; staged flow state should survive short restarts optionally by storing a small JSON blob in a temporary table, but acceptable to lose staged flow on server restart in v1.

## Integrations & notification targets
- None external. No push/scheduled reminders in v1. No webhooks (use long-polling getUpdates). No analytics/external APIs.

## Commands & UI summary
- Commands implemented: /start, /add, /list, /check, /stats.
- Primary UI: dashboard message with inline buttons per-habit:
  - [✓ Done] (press to mark today done)
  - [Add] [Stats] [List]
- All responses are short, friendly, emoji-light.

## Error handling
- If a callback comes from a different Telegram user than the owner of the data, respond with a short alert: "This button isn't for you — please open your own chat with the bot." and do not perform the action.
- If DB write fails, send a short error message and log details server-side.

## Non-goals (explicit)
- No scheduled push notifications or reminder dispatching (reminder_time is stored but unused in v1).
- No group chat support.
- No external API calls or webhooks.
- No payments or subscriptions.

## Assumptions & defaults
- User timezone: default to server timezone (UTC recommended) and store NULL until user sets an explicit timezone later — simplifies v1 and makes date logic deterministic on server time.
  - Rationale: Telegram does not provide timezone; implementing timezone selection is deferred.
- Frequency options: provide three types — daily, weekdays (Mon–Fri), specific weekdays (multi-select). Daily is the default when user skips choosing.
  - Rationale: covers common use cases while keeping the UI simple.
- Reminder_time is stored as HH:MM but not used for scheduling in v1.
  - Rationale: owner requested reminder storage but disabled scheduled notifications for v1.
- Dashboard editing: keep one dashboard message per user (stored in users.last_dashboard_message_id). If editing fails, send a fresh dashboard and update the stored id.
  - Rationale: meets the "edit same message" requirement while recovering from deletions.
- Persistence engine: SQLite file stored on the server (data/habits.db) with simple migrations on startup.
  - Rationale: no external services allowed; SQLite is lightweight and persistent across restarts/uninstalls.
- Staged flow persistence: add-flow staged state kept in-memory and may be lost on server restart (acceptable in v1).
  - Rationale: avoids complexity for v1; can be extended later.

