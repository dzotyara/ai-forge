import "./lang-ru.mjs";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { isolatedHome, mockTelegram } from "./helpers.mjs";

const env = isolatedHome({ chatId: "-1001234567890", extra: { ownerUserId: "4242" } });
process.env.CLAUDE_PLUGIN_ROOT = "/plugins/telegram-action-notifier";
const bridge = await import("../skills/telegram-action-notifier/scripts/lib/bridge.mjs");
const common = await import("../skills/telegram-action-notifier/scripts/lib/common.mjs");
const entry = await import("../skills/telegram-action-notifier/scripts/telegram-action-notifier.mjs");
mkdirSync(env.state, { recursive: true });
writeFileSync(path.join(env.state, "daemon.pid"), String(process.pid));

const GROUP = -1001234567890;

test("CLI argument parsing", () => {
  const opts = entry.parseCliArgs(
    ["--to", "Алерты", "--silent", "--buttons", '[{"text":"Ок","data":"ok"}]', "--reply-to", "12", "Новый", "алерт"],
    { flags: ["silent"], options: ["to", "buttons", "reply-to"] },
  );
  assert.equal(opts.to, "Алерты");
  assert.equal(opts.silent, true);
  assert.equal(opts["reply-to"], "12");
  assert.equal(opts._.join(" "), "Новый алерт");
  assert.throws(() => entry.parseCliArgs(["--to"], { options: ["to"] }), /needs a value/);
  assert.throws(() => entry.parseCliArgs(["--bogus"], {}), /Unknown option/);
});

test("custom buttons are prefixed with u: and validated", () => {
  const keyboard = bridge.buildKeyboard('[[{"text":"Ответить","data":"reply:JIRA-1","style":"primary"},{"text":"Пропустить","data":"skip:JIRA-1"}]]');
  assert.deepEqual(keyboard.inline_keyboard[0], [
    { text: "Ответить", callback_data: "u:reply:JIRA-1", style: "primary" },
    { text: "Пропустить", callback_data: "u:skip:JIRA-1" },
  ]);
  assert.equal(bridge.buildKeyboard([{ text: "A", data: "a" }]).inline_keyboard.length, 1); // flat = one row
  assert.throws(() => bridge.buildKeyboard([{ text: "A", data: "x".repeat(49) }]), /1-48/);
  assert.throws(() => bridge.buildKeyboard([{ text: "", data: "a" }]), /text/);
  assert.throws(() => bridge.buildKeyboard("not json"));
});

const sessions = { alerts: { title: "Алерты", topicId: 40, lastMessageIds: [400, 401] } };
const route = (update) => bridge.routeUpdate(update, { chatId: String(GROUP), ownerUserId: "4242", sessions });

test("u: button press routes to the session that owns the message", () => {
  const press = (from, threaded = true) => ({
    callback_query: {
      id: "cb",
      from: { id: from },
      data: "u:reply:JIRA-1",
      message: {
        message_id: 401,
        chat: { id: GROUP },
        ...(threaded ? { message_thread_id: 40, is_topic_message: true } : {}),
        reply_markup: { inline_keyboard: [[{ text: "Ответить", callback_data: "u:reply:JIRA-1" }]] },
      },
    },
  });
  assert.deepEqual(route(press(4242)), {
    type: "button", callbackId: "cb", sessionId: "alerts", data: "reply:JIRA-1", text: "Ответить", messageId: 401, threadId: 40,
  });
  assert.equal(route(press(4242, false)).sessionId, "alerts"); // no topics: by message id
  assert.equal(route(press(31337)).type, "ignore");
});

test("explicit replies in a topic are marked; topic-root 'replies' are not", () => {
  const msg = (reply) => ({ message: { message_id: 500, chat: { id: GROUP }, from: { id: 4242 }, text: "отправляй", message_thread_id: 40, is_topic_message: true, reply_to_message: reply } });
  assert.equal(route(msg({ message_id: 400 })).replyTo, 400);
  assert.equal(route(msg({ message_id: 40, forum_topic_created: { name: "x" } })).replyTo, null);
});

test("forwarding format for the waiter", () => {
  assert.equal(
    bridge.formatReplies([
      { kind: "button", data: "reply:JIRA-1", buttonText: "Ответить", messageId: 401 },
      { text: "да, отправляй", replyTo: 400, messageId: 501 },
      { text: "что нового?", messageId: 502 },
    ]),
    "Telegram: кнопка «Ответить» data=reply:JIRA-1 на сообщении 401\n\n"
      + "Telegram: ответ на сообщение 400: да, отправляй\n\n"
      + "Сообщение пользователя из Telegram: что нового?",
  );
  assert.equal(bridge.isTelegramPrompt("Telegram: кнопка «x» data=y на сообщении 1"), true);
  assert.equal(bridge.isTelegramPrompt("обычный запрос"), false);
});

test("button press: inbox entry and a toast", async () => {
  await bridge.updateState((state) => {
    state.sessions.alerts = { ...sessions.alerts, waiter: { pid: process.pid, gen: 1 }, waiterGen: 1 };
  });
  const tg = mockTelegram(() => true);
  try {
    const settings = await common.loadSettings();
    await bridge.handleUpdate(settings, {
      update_id: 1,
      callback_query: { id: "cb9", from: { id: 4242 }, data: "u:ok", message: { message_id: 400, chat: { id: GROUP }, message_thread_id: 40, is_topic_message: true } },
    });
    assert.equal(tg.calls[0].method, "answerCallbackQuery");
    assert.equal(tg.calls[0].params.text, "Передано в сессию");
    const result = await bridge.waitForReply({ session_id: "alerts" }, { pollMs: 10, maxMs: 2000 });
    assert.deepEqual(result, { code: 2, text: "Telegram: кнопка «ok» data=ok на сообщении 400" });
  } finally {
    tg.restore();
  }
});

test("a restarted session with the same title reuses its topic", async () => {
  let id = 1;
  const tg = mockTelegram((method) => {
    if (method === "getChat") return { is_forum: true };
    if (method === "getChatMember") return { status: "administrator", can_manage_topics: true };
    if (method === "createForumTopic") return { message_thread_id: 700 + id };
    if (method === "sendMessage") return { message_id: id++ };
    return true;
  });
  try {
    const settings = await common.loadSettings();
    const ctx = (sessionId) => ({ sessionId, title: "Алерты", project: "ops", cwd: "/ops", host: "Claude Code" });
    const first = await bridge.deliver(settings, ctx("old-alerts"), ["a"]);
    // A second live session with the same title gets its own topic.
    const parallel = await bridge.deliver(settings, ctx("parallel"), ["b"]);
    assert.notEqual(parallel.threadId, first.threadId);
    await bridge.markSessionEnded("old-alerts");
    await bridge.markSessionEnded("parallel");
    const restarted = await bridge.deliver(settings, ctx("new-alerts"), ["c"]);
    assert.equal(restarted.threadId, parallel.threadId, "reuses the latest topic for the title");
    const state = await bridge.readState();
    assert.equal(state.sessions.parallel.topicId, undefined, "the ended owner lets go");
    assert.equal(tg.calls.filter((c) => c.method === "createForumTopic").length, 2);
    // Routing in that topic now reaches the new session.
    const routed = bridge.routeUpdate(
      { message: { message_id: 9, chat: { id: GROUP }, from: { id: 4242 }, text: "x", message_thread_id: restarted.threadId, is_topic_message: true } },
      { chatId: String(GROUP), ownerUserId: "4242", sessions: state.sessions },
    );
    assert.equal(routed.sessionId, "new-alerts");
  } finally {
    tg.restore();
  }
});

test("findSession: boss, id, and case-insensitive title (live, newest first)", () => {
  const state = bridge.emptyState();
  state.sessions = {
    a: { title: "Алерты", updatedAt: 1, ended: true },
    b: { title: "алерты ", updatedAt: 2 },
    boss: { title: "Босс", updatedAt: 3 },
  };
  assert.equal(bridge.findSession(state, "АЛЕРТЫ"), "b");
  assert.equal(bridge.findSession(state, "a"), "a");
  assert.equal(bridge.findSession(state, "boss"), "boss");
  assert.equal(bridge.findSession(state, "нет такой"), null);
});
