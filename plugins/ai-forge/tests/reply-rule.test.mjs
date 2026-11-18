import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { isolatedHome, mockTelegram } from "./helpers.mjs";

const env = isolatedHome({ chatId: "-1001234567890", extra: { ownerUserId: "4242" } });
process.env.CLAUDE_PLUGIN_ROOT = "/plugins/telegram-action-notifier";
process.env.TELEGRAM_NOTIFIER_PRESENCE = "present"; // the owner is at the Mac
const bridge = await import("../skills/telegram-action-notifier/scripts/lib/bridge.mjs");
const entry = await import("../skills/telegram-action-notifier/scripts/telegram-action-notifier.mjs");
mkdirSync(env.state, { recursive: true });
writeFileSync(path.join(env.state, "daemon.pid"), String(process.pid));

const stop = (text) => ({ hook_event_name: "Stop", session_id: "phone1", cwd: "/x/proj", last_assistant_message: text });

test("a turn started from Telegram answers in Telegram even when the owner is present", async () => {
  let id = 1;
  const tg = mockTelegram((method) => {
    if (method === "getChat") return { is_forum: true };
    if (method === "getChatMember") return { status: "administrator", can_manage_topics: true };
    if (method === "createForumTopic") return { message_thread_id: 55 };
    if (method === "sendMessage") return { message_id: id++ };
    return true;
  });
  try {
    // Present and not from Telegram: an ordinary turn is not sent.
    await entry.handleEvent(stop("Готово, первый ход."));
    assert.equal(tg.calls.filter((c) => c.method === "sendMessage").length, 0);

    // The waiter delivered a Telegram message -> the next reply goes to the topic.
    await bridge.updateState((state) => { state.sessions.phone1.replyToTelegram = true; });
    await entry.handleEvent(stop("Ответ на сообщение из Telegram."));
    const sends = tg.calls.filter((c) => c.method === "sendMessage");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].params.message_thread_id, 55);
    assert.equal(sends[0].params.disable_notification, true);
    assert.equal((await bridge.readState()).sessions.phone1.replyToTelegram, false, "spent after one post");

    // The following turn (owner still present, typed nothing from TG) is quiet again.
    await entry.handleEvent(stop("Ещё ход."));
    assert.equal(tg.calls.filter((c) => c.method === "sendMessage").length, 1);

    // A prompt typed in the app clears a pending flag; a Telegram-sourced prompt keeps it.
    await bridge.updateState((state) => { state.sessions.phone1.replyToTelegram = true; });
    await entry.handleEvent({ hook_event_name: "UserPromptSubmit", session_id: "phone1", prompt: "Сообщение пользователя из Telegram: да" });
    assert.equal((await bridge.readState()).sessions.phone1.replyToTelegram, true);
    await entry.handleEvent({ hook_event_name: "UserPromptSubmit", session_id: "phone1", prompt: "сделай иначе" });
    assert.equal((await bridge.readState()).sessions.phone1.replyToTelegram, false);
  } finally {
    tg.restore();
  }
});

test("present owner: a blocking stop is queued for the grace period, not sent", async () => {
  const tg = mockTelegram(() => ({ message_id: 1 }));
  try {
    await entry.handleEvent(stop("ACTION_REQUIRED: подтвердите деплой."));
    assert.equal(tg.calls.filter((c) => c.method === "sendMessage").length, 0);
    const pending = Object.values((await bridge.readState()).pending);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, "action");
    assert.ok(pending[0].dueAt - pending[0].createdAt >= 179_000);
    // The owner answers in the app: the timer is cancelled.
    await entry.handleEvent({ hook_event_name: "UserPromptSubmit", session_id: "phone1", prompt: "подтверждаю" });
    assert.equal(Object.keys((await bridge.readState()).pending).length, 0);
  } finally {
    tg.restore();
  }
});

test("present owner: PermissionRequest holds the buttons for the grace period; an app answer cancels them", async () => {
  const tg = mockTelegram(() => ({ message_id: 1 }));
  let out = "";
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk === "string") { out += chunk; return true; }
    return write.call(this, chunk, ...rest);
  };
  try {
    const hook = entry.handleEvent({ hook_event_name: "PermissionRequest", session_id: "phone1", cwd: "/x/proj", tool_name: "Bash", tool_input: { command: "rm -rf x", description: "Удалить x" } });
    let pending = [];
    for (let i = 0; i < 100 && !pending.length; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      pending = Object.values((await bridge.readState()).pending);
    }
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, "approval");
    assert.equal(pending[0].hold, true, "held: the daemon does not send it");
    assert.equal(pending[0].toolName, "Bash");
    assert.equal(pending[0].parts[0].includes("rm -rf"), false);
    assert.equal(tg.calls.some((c) => c.method === "sendMessage"), false, "nothing sent during the grace period");
    // The owner approves in the app: PostToolUse for the same tool resolves it, the hook ends with no decision.
    await entry.handleEvent({ hook_event_name: "PostToolUse", session_id: "phone1", tool_name: "Bash" });
    await hook;
  } finally {
    process.stdout.write = write;
    tg.restore();
  }
  assert.equal(out.includes("hookSpecificOutput"), false, "no permission decision printed");
  assert.equal(Object.keys((await bridge.readState()).pending).length, 0);
});
