import "./lang-en.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { OUTCOME_TEXT, REPLY_PREFIX, isBossTitle, isTelegramPrompt } from "../skills/telegram-action-notifier/scripts/lib/bridge.mjs";
import { slashCommands } from "../skills/telegram-action-notifier/scripts/lib/discord.mjs";
import { richPresenceActivity } from "../skills/telegram-action-notifier/scripts/lib/rpc.mjs";
import { buildHeader } from "../skills/telegram-action-notifier/scripts/lib/format.mjs";
import { lang } from "../skills/telegram-action-notifier/scripts/lib/i18n.mjs";

test("English is the interface language here", () => {
  assert.equal(lang(), "en");
  assert.match(OUTCOME_TEXT.allow, /Allowed/);
  assert.match(OUTCOME_TEXT["allow-discord"], /Discord/);
  assert.equal(REPLY_PREFIX, "User message from Telegram:");
});

test("markers and titles are understood in both languages", () => {
  assert.equal(isTelegramPrompt("User message from Telegram: hi"), true);
  assert.equal(isTelegramPrompt("Сообщение пользователя из Telegram: привет"), true);
  assert.equal(isBossTitle("Boss"), true);
  assert.equal(isBossTitle("Босс"), true);
});

test("Discord and Rich Presence texts are English", () => {
  const mute = slashCommands([{ command: "mute", description: "Pause" }])[0];
  assert.equal(mute.options[0].name, "duration");
  const activity = richPresenceActivity({ working: 2, startedAt: 0 });
  assert.equal(activity.details, "Agents working: 2");
  assert.equal(activity.buttons[0].label, "⭐ AI Forge on GitHub");
  assert.match(buildHeader({ kind: "turn" }), /Session/);
});
