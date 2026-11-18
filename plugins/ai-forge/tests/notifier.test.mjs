import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import {
  buildMessageParts,
  buildTelegramMessage,
  redactSecrets,
  requiresUserAction,
} from "../skills/telegram-action-notifier/scripts/telegram-action-notifier.mjs";

test("detects explicit action marker", () => {
  assert.equal(
    requiresUserAction("ACTION_REQUIRED: войдите в GitHub и подтвердите доступ."),
    true,
  );
});

test("does not alert for an ordinary completion", () => {
  assert.equal(requiresUserAction("Готово. Тесты прошли успешно."), false);
});

test("detects common Russian blocking request", () => {
  assert.equal(
    requiresUserAction("Нужно ваше подтверждение перед публикацией."),
    true,
  );
});

test("redacts bot tokens and API keys", () => {
  const botToken = ["123456789", "ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd"].join(":");
  const apiKey = ["sk", "example0123456789abcdef"].join("-");
  const value = redactSecrets(
    `token=abc123 ${botToken} ${apiKey}`,
  );
  assert.equal(value.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), false);
  assert.equal(value.includes("sk-example"), false);
  assert.match(value, /REDACTED/);
});

test("approval messages omit raw tool commands", () => {
  const result = buildTelegramMessage({
    hook_event_name: "PermissionRequest",
    cwd: "C:/project",
    tool_name: "Bash",
    tool_input: {
      command: "deploy --token super-secret",
      description: "Publish the release",
    },
  });
  assert.match(result, /Publish the release/);
  assert.equal(result.includes("deploy --token"), false);
});

test("detects Russian imperative requests despite ASCII-only \\b", () => {
  assert.equal(requiresUserAction("Пожалуйста, подтвердите запуск"), true);
  assert.equal(requiresUserAction("Укажите ключ API."), true);
});

test("detects Russian waiting phrases", () => {
  assert.equal(requiresUserAction("Не могу продолжить без вашего ответа."), true);
  assert.equal(requiresUserAction("Жду вас"), true);
});

test("Russian patterns stop at a word boundary", () => {
  assert.equal(requiresUserAction("Это подтвердитель формата."), false);
  assert.equal(requiresUserAction("Готово, без вашеговых правок."), false);
});

test("labels messages with the current host", () => {
  const event = { hook_event_name: "Stop", cwd: "/p/demo", last_assistant_message: "x" };
  const saved = process.env.CLAUDE_PLUGIN_ROOT;
  try {
    delete process.env.CLAUDE_PLUGIN_ROOT;
    assert.match(buildTelegramMessage(event), /^💬 <b>demo<\/b> · Codex/);
    process.env.CLAUDE_PLUGIN_ROOT = "/plugins/telegram-action-notifier";
    assert.match(buildTelegramMessage(event), /^💬 <b>demo<\/b> · Claude Code/);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = saved;
  }
});

test("blocking stop gets the bell, session title and project in the header", () => {
  const [first] = buildMessageParts(
    { hook_event_name: "Stop", cwd: "/Users/me/Projects/myskills", last_assistant_message: "ACTION_REQUIRED: войдите в GitHub" },
    { title: "Рефакторинг <репо>" },
  );
  assert.match(first, /^🔔 <b>Рефакторинг &lt;репо&gt;<\/b> · myskills · /);
  assert.equal(first.includes("ACTION_REQUIRED"), false);
  assert.equal(first.includes("/Users/me"), false);
});
