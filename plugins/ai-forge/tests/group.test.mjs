import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { isolatedHome, mockTelegram } from "./helpers.mjs";

const env = isolatedHome({ chatId: "4242" });
process.env.CLAUDE_PLUGIN_ROOT = "/plugins/telegram-action-notifier";
const common = await import("../skills/telegram-action-notifier/scripts/lib/common.mjs");
const bridge = await import("../skills/telegram-action-notifier/scripts/lib/bridge.mjs");
mkdirSync(env.state, { recursive: true });
writeFileSync(path.join(env.state, "daemon.pid"), String(process.pid)); // no real daemon

const config = () => JSON.parse(readFileSync(path.join(env.dir, "config.json"), "utf8"));

test("chat migration: private chat id becomes the owner when switching to a group", async () => {
  const result = await common.setTargetChat("-1001234567890");
  assert.deepEqual(result, { chatId: "-1001234567890", ownerUserId: "4242" });
  assert.equal(config().chatId, "-1001234567890");
  // Switching between groups keeps the owner.
  await common.setTargetChat("-100999");
  assert.equal(config().ownerUserId, "4242");
  await common.setTargetChat("-1001234567890");
  await assert.rejects(common.setTargetChat("abc"));
});

test("legacy groupChatId config migrates on read", () => {
  const settings = common.resolveSettings({ chatId: "4242", groupChatId: "-100777" }, {});
  assert.equal(settings.chatId, "-100777");
  assert.equal(settings.ownerUserId, "4242");
});

test("group without forum: plain group messages, no topic calls", async () => {
  let id = 1;
  const tg = mockTelegram((method) => {
    if (method === "getChat") return { id: -1001234567890, type: "supergroup", is_forum: false };
    if (method === "sendMessage") return { message_id: id++ };
    return true;
  });
  try {
    const settings = await common.loadSettings();
    const support = await bridge.topicSupport(settings, { fresh: true });
    assert.deepEqual(support, { enabled: false, reason: "not-forum" });
    const ctx = { sessionId: "g1", title: "Сессия", project: "p", cwd: "/p", host: "Claude Code" };
    const sent = await bridge.deliver(settings, ctx, ["hi"]);
    assert.equal(sent.threadId, null);
    assert.equal(tg.calls.some((c) => c.method === "createForumTopic"), false);
    const send = tg.calls.find((c) => c.method === "sendMessage");
    assert.equal(send.params.chat_id, "-1001234567890");
    assert.equal(send.params.message_thread_id, undefined);
    assert.match(bridge.TOPIC_REASON_TEXT["not-forum"], /Темы/);
  } finally {
    tg.restore();
  }
});

test("forum group: bot admin with can_manage_topics gets topics; boss posts to General", async () => {
  await bridge.updateState((state) => { delete state.meta.topics; });
  let id = 100;
  const tg = mockTelegram((method, params) => {
    if (method === "getChat") return { id: -1001234567890, type: "supergroup", is_forum: true };
    if (method === "getChatMember") return { status: "administrator", can_manage_topics: true, user: { id: params.user_id } };
    if (method === "createForumTopic") return { message_thread_id: 321 };
    if (method === "sendMessage") return { message_id: id++ };
    return true;
  });
  try {
    const settings = await common.loadSettings();
    assert.deepEqual(await bridge.topicSupport(settings, { fresh: true }), { enabled: true, reason: "ok" });
    assert.equal(tg.calls.find((c) => c.method === "getChatMember").params.user_id, 123456789);
    const worker = await bridge.deliver(settings, { sessionId: "w1", title: "Рабочая", project: "p", cwd: "/p", host: "Claude Code" }, ["x"]);
    assert.equal(worker.threadId, 321);
    const boss = await bridge.deliver(settings, { sessionId: "boss1", title: "Босс", project: "p", cwd: "/p", host: "Claude Code" }, ["y"]);
    assert.equal(boss.threadId, null);
    const state = await bridge.readState();
    assert.equal(bridge.resolveBossId(state), "boss1");
    assert.equal(tg.calls.filter((c) => c.method === "createForumTopic").length, 1);
  } finally {
    tg.restore();
  }
});

test("forum group without admin rights degrades to plain messages", async () => {
  const tg = mockTelegram((method) => {
    if (method === "getChat") return { is_forum: true };
    if (method === "getChatMember") return { status: "member" };
    return true;
  });
  try {
    const support = await bridge.topicSupport(await common.loadSettings(), { fresh: true });
    assert.deepEqual(support, { enabled: false, reason: "not-admin" });
  } finally {
    tg.restore();
  }
});

test("General without a boss: the owner gets a short reply, strangers get nothing", async () => {
  await bridge.updateState((state) => {
    state.sessions = {};
    state.meta = {};
  });
  const tg = mockTelegram(() => ({ message_id: 1 }));
  try {
    const settings = await common.loadSettings();
    const message = (from) => ({ update_id: 9, message: { message_id: 77, chat: { id: -1001234567890, type: "supergroup" }, from: { id: from }, text: "ты тут?" } });
    await bridge.handleUpdate(settings, message(31337));
    assert.equal(tg.calls.length, 0);
    await bridge.handleUpdate(settings, message(4242));
    assert.equal(tg.calls.length, 1);
    assert.match(tg.calls[0].params.text, /Босс сейчас не запущен/);
    assert.equal(tg.calls[0].params.reply_parameters.message_id, 77);
  } finally {
    tg.restore();
  }
});

test("General message for a live boss lands in the boss inbox", async () => {
  await bridge.claimBoss("boss2");
  await bridge.updateState((state) => {
    state.sessions.boss2.waiter = { pid: process.pid, gen: 1 };
    state.sessions.boss2.waiterGen = 1;
  });
  const tg = mockTelegram(() => true);
  try {
    const settings = await common.loadSettings();
    await bridge.handleUpdate(settings, { update_id: 10, message: { message_id: 88, chat: { id: -1001234567890 }, from: { id: 4242 }, text: "собери статус" } });
    const inbox = readFileSync(path.join(env.state, "inbox", "boss2.jsonl"), "utf8");
    assert.match(inbox, /собери статус/);
    assert.equal(tg.calls.length, 0);
  } finally {
    tg.restore();
  }
});
