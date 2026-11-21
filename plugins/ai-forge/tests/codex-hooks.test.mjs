import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedHome, mockTelegram } from "./helpers.mjs";
import { registerCodexHooks } from "../skills/telegram-action-notifier/scripts/lib/codex-hooks.mjs";
import { handleEvent } from "../skills/telegram-action-notifier/scripts/telegram-action-notifier.mjs";

test("fallback registers the bundled events and preserves existing user hooks", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "forge-hooks-"));
  try {
    const file = await registerCodexHooks(home);
    const original = await readFile(file, "utf8");
    const { hooks } = JSON.parse(original);
    assert.deepEqual(Object.keys(hooks), ["SessionStart", "PermissionRequest", "Stop"]);
    assert.match(hooks.Stop[0].hooks[0].command, /^node .*telegram-action-notifier\.mjs/);
    await assert.rejects(registerCodexHooks(home), /already exists|уже существует/);
    assert.equal(await readFile(file, "utf8"), original);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex only sends permission events when explicitly enabled, while action requests still arrive", async () => {
  isolatedHome({ extra: { deliveryMode: "always", topics: false } });
  delete process.env.CLAUDE_PLUGIN_ROOT;
  const telegram = mockTelegram(() => ({ message_id: 42 }));
  try {
    const approval = { hook_event_name: "PermissionRequest", tool_name: "Bash",
      cwd: "/demo", tool_input: { description: "Run tests" } };
    await handleEvent(approval);
    assert.equal(telegram.calls.length, 0);
    await handleEvent({ hook_event_name: "Stop", cwd: "/demo", last_assistant_message: "ACTION_REQUIRED: подтвердите запуск." });
    assert.equal(telegram.calls.filter((call) => call.method === "sendMessage").length, 1);
    isolatedHome({ extra: { deliveryMode: "always", topics: false, codexApprovalNotifications: true } });
    await handleEvent(approval);
    assert.equal(telegram.calls.filter((call) => call.method === "sendMessage").length, 2);
  } finally {
    telegram.restore();
  }
});
