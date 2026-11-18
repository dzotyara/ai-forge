---
name: telegram-action-notifier
description: Notify the user through Telegram or Discord when a Codex or Claude Code task cannot continue without their approval, answer, choice, credential, login, or other concrete action. Do not use for optional next steps or ordinary completed work.
---

# Telegram Action Notifier

Use this skill only when the current task is blocked on a concrete user action.

Before ending the turn:

1. Exhaust safe, in-scope work that does not require the user.
2. Ask for only the minimum action needed to continue.
3. Start the final user-facing request with exactly `ACTION_REQUIRED:`. Keep the action and reason concise.

The bundled `Stop` hook detects that marker and sends the request to the configured destination: Telegram, Discord, or both. Approval prompts use the bundled `PermissionRequest` hook. In smart mode, the bridge waits for the user to answer in the app before notifying them.

Do not use the marker for optional suggestions, progress updates, routine handoffs, or a completed task. Never include secrets in the message.

## Claude Code: replies from Telegram

In Claude Code the user can answer in the session's Telegram topic. Their message wakes the session as a system reminder starting with `Сообщение пользователя из Telegram:`, `Telegram: ответ на сообщение …` or `Telegram: кнопка …`. Treat it as the user's next prompt and reply normally; that reply is posted back to the same topic. In Codex, Telegram is notification-only: wait for the user in the agent session.

To post into a topic yourself (for example from an alerts session), run `node <this skill>/scripts/telegram-action-notifier.mjs post --to "<your session title>" "<text>"`. See the plugin README for `--buttons`, `--reply-to` and `edit`.

If notification delivery is not configured, still ask the user in the agent session and mention that the plugin's `configure.mjs` must be run on the device.
