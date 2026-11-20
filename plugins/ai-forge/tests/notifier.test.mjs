import "./lang-ru.mjs";
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

test("a turn counts from UserPromptSubmit to Stop", async () => {
  const bridgeMod = await import("../skills/telegram-action-notifier/scripts/lib/bridge.mjs");
  await bridgeMod.markTurn("turn-s", true);
  assert.equal(bridgeMod.workingSessions(await bridgeMod.readState()) >= 1, true);
  assert.ok((await bridgeMod.readState()).meta.turns["turn-s"]);
  await bridgeMod.markTurn("turn-s", false);
  assert.equal((await bridgeMod.readState()).meta.turns["turn-s"], undefined);
});

test("working counts sessions and each running subagent", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const bridgeMod = await import("../skills/telegram-action-notifier/scripts/lib/bridge.mjs");
  const root = mkdtempSync(path.join(os.tmpdir(), "projects-"));
  const project = path.join(root, "-Users-me-app");
  mkdirSync(path.join(project, "child-id", "subagents"), { recursive: true });
  writeFileSync(path.join(project, "busy-id.jsonl"), "{}");
  writeFileSync(path.join(project, "idle-id.jsonl"), "{}");
  utimesSync(path.join(project, "idle-id.jsonl"), new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
  writeFileSync(path.join(project, "child-id.jsonl"), "{}");
  utimesSync(path.join(project, "child-id.jsonl"), new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
  writeFileSync(path.join(project, "child-id", "subagents", "agent-1.jsonl"), "{}");
  writeFileSync(path.join(project, "child-id", "subagents", "agent-2.jsonl"), "{}");
  const ids = await bridgeMod.refreshActiveTranscripts(Date.now(), root);
  assert.deepEqual([...ids].sort(), ["busy-id", "child-id/agent-1.jsonl", "child-id/agent-2.jsonl"]);
  const state = { sessions: { "busy-id": {}, "child-id": {} }, meta: { turns: { "child-id": Date.now() } } };
  // The parent mid-turn plus each of its two running subagents, plus the busy session.
  assert.equal(bridgeMod.workingSessions(state, Date.now(), () => false, ids), 4);
  assert.equal(bridgeMod.workingSessions({ sessions: { "busy-id": { ended: true } }, meta: {} }, Date.now(), () => false, ids), 2);
});

test("a session listens to the chat from its start, not only after its first turn", async () => {
  const { readFileSync } = await import("node:fs");
  const hooks = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8")).hooks;
  const waiter = (event) => hooks[event].flatMap((group) => group.hooks).find((hook) => hook.asyncRewake);
  for (const event of ["SessionStart", "Stop"]) {
    assert.ok(waiter(event), `${event} starts the reply waiter`);
    assert.match(waiter(event).command, /wait-reply/);
  }
});

test("a waiter started right after an app restart clears the ended flag and delivers", async () => {
  const bridgeMod = await import("../skills/telegram-action-notifier/scripts/lib/bridge.mjs");
  const state = { sessions: { s: { ended: true, endedAt: 1 } } };
  bridgeMod.claimWaiter(state, "s", process.pid);
  assert.equal(state.sessions.s.ended, false);
  assert.equal(state.sessions.s.endedAt, undefined);
  const headless = { sessions: { h: { ended: true, headless: true } } };
  bridgeMod.claimWaiter(headless, "h", process.pid);
  assert.equal(headless.sessions.h.ended, true, "headless workers keep their flag");
});
