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

In Claude Code the user can answer in the session's Telegram topic. Their message wakes the session as a system reminder starting with `User message from Telegram:` (in Russian: `Сообщение пользователя из Telegram:`) or `Telegram:` (fixed markers from the bridge; a `Telegram:` line is a reply to a message or a button press). Treat it as the user's next prompt and reply normally; that reply is posted back to the same topic. In Codex, Telegram is notification-only: wait for the user in the agent session.

To post into a topic yourself (for example from an alerts session), run `node <this skill>/scripts/telegram-action-notifier.mjs post --to "<your session title>" "<text>"`. See the plugin README for `--buttons`, `--reply-to` and `edit`.

## Sending files to the owner

When the owner asks for a file ("send me the file", "send it to Discord", a video, a screenshot, a voice sample), do not paste its contents into the chat. Run:

```
node <this skill>/scripts/telegram-action-notifier.mjs send-file [--caption "<text>"] <path>...
```

For example: `send-file --caption "Render v3" ./out/render.mp4 ./out/contact-sheet.jpg`. The files go to this session's Telegram topic and/or Discord channel, whichever the owner chose in "Where to send"; there is nothing to configure and no way to pick the destination per call. Name every file: directories are refused, and so are missing or empty files (then nothing is sent). Images (`.jpg`, `.png`) arrive as images, `.mp4` as a playable video, `.mp3` and `.m4a` as audio, anything else as a document. The caption is optional and goes with the first file.

Limits: Telegram takes 50 MiB per file (a photo 10 MiB, bigger images go as a document); Discord takes 20 MiB per file, 50 or 100 MiB on a server with Boost level 2 or 3. A file over the limit of one destination is not sent there, and the command says so. Read its output and tell the owner exactly what it says: which destination got which file, and which did not, with the reason. The command exits with 1 unless every file reached every destination. Never report a file as sent when it printed `NOT sent`; if a file is too big, offer to shrink or split it. Use `--to "<session title>"` only to send on behalf of another session, and `--json` for machine-readable output.

If notification delivery is not configured, still ask the user in the agent session and mention that the plugin's `configure.mjs` must be run on the device.
