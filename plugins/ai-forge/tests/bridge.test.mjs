import "./lang-ru.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FAKE_TOKEN, isolatedHome, mockTelegram } from "./helpers.mjs";

const env = isolatedHome();
process.env.CLAUDE_PLUGIN_ROOT = "/plugins/telegram-action-notifier";

const bridge = await import("../skills/telegram-action-notifier/scripts/lib/bridge.mjs");
const { loadSettings } = await import("../skills/telegram-action-notifier/scripts/lib/common.mjs");
const ENTRY = fileURLToPath(new URL("../skills/telegram-action-notifier/scripts/telegram-action-notifier.mjs", import.meta.url));

// A live pid in daemon.pid keeps ensureDaemon() from spawning a real poller.
mkdirSync(env.state, { recursive: true });
writeFileSync(path.join(env.state, "daemon.pid"), String(process.pid));

const transcript = (lines) => {
  const file = path.join(env.home, `t-${Math.random().toString(16).slice(2)}.jsonl`);
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return file;
};

test("session title: last custom-title wins", async () => {
  const file = transcript([
    { type: "user", message: "hi" },
    { type: "custom-title", customTitle: "Первое", sessionId: "s" },
    { type: "ai-title", aiTitle: "AI title", sessionId: "s" },
    { type: "custom-title", customTitle: "Рефакторинг myskills репо", sessionId: "s" },
    { type: "assistant", message: "ok" },
  ]);
  assert.equal(await bridge.readSessionTitle(file, "/x/myskills"), "Рефакторинг myskills репо");
});

test("session title: full scan finds a custom-title outside the tail", async () => {
  const filler = Array.from({ length: 200 }, (_, i) => ({ type: "assistant", text: "x".repeat(100), i }));
  const file = transcript([{ type: "custom-title", customTitle: "Старое имя" }, ...filler, { type: "ai-title", aiTitle: "AI" }]);
  assert.equal(await bridge.readSessionTitle(file, "/x/p", { tailBytes: 2048 }), "Старое имя");
});

test("session title: ai-title, then the cwd basename", async () => {
  assert.equal(await bridge.readSessionTitle(transcript([{ type: "ai-title", aiTitle: "Auto" }]), "/x/p"), "Auto");
  assert.equal(await bridge.readSessionTitle(transcript([{ type: "user" }]), "/Users/me/Projects/myskills"), "myskills");
  assert.equal(await bridge.readSessionTitle("/nonexistent/file.jsonl", "/a/b/proj"), "proj");
  assert.equal(bridge.topicName("Т".repeat(200), "p").length, 128);
});

const OWNER = 4242;
const sessions = {
  s1: { topicId: 77, lastMessageIds: [10, 11] },
  s2: { lastMessageIds: [20] },
};
const msg = (extra) => ({ update_id: 1, message: { message_id: 500, chat: { id: OWNER, type: "private" }, from: { id: OWNER }, text: "привет", ...extra } });

test("routing: by topic thread id", () => {
  const route = bridge.routeUpdate(msg({ message_thread_id: 77, is_topic_message: true }), { chatId: "4242", sessions });
  assert.deepEqual(route, { type: "message", sessionId: "s1", text: "привет", messageId: 500, threadId: 77, replyTo: null });
});

test("routing: by reply to a session message", () => {
  const route = bridge.routeUpdate(msg({ reply_to_message: { message_id: 20 } }), { chatId: "4242", sessions });
  assert.equal(route.sessionId, "s2");
});

test("routing: foreign chats, foreign senders, bots and unknown threads are ignored", () => {
  const ignore = { type: "ignore" };
  assert.deepEqual(bridge.routeUpdate(msg({ chat: { id: 999 }, from: { id: 999 }, message_thread_id: 77 }), { chatId: "4242", sessions }), ignore);
  assert.deepEqual(bridge.routeUpdate(msg({ from: { id: 999 }, message_thread_id: 77 }), { chatId: "4242", sessions }), ignore);
  assert.deepEqual(bridge.routeUpdate(msg({ from: { id: OWNER, is_bot: true }, message_thread_id: 77 }), { chatId: "4242", sessions }), ignore);
  assert.deepEqual(bridge.routeUpdate(msg({ message_thread_id: 5, is_topic_message: true }), { chatId: "4242", sessions }), ignore);
});

test("routing: plain/General messages go to the boss, or get a 'no boss' reply", () => {
  assert.equal(bridge.routeUpdate(msg({}), { chatId: "4242", sessions, bossId: "s2" }).sessionId, "s2");
  assert.deepEqual(bridge.routeUpdate(msg({}), { chatId: "4242", sessions }), { type: "no-boss", messageId: 500, threadId: null });
});

const GROUP = -1001234567890;
const gmsg = (extra) => ({ update_id: 3, message: { message_id: 600, chat: { id: GROUP, type: "supergroup" }, from: { id: OWNER }, text: "статус?", ...extra } });
const group = { chatId: String(GROUP), ownerUserId: String(OWNER), sessions, bossId: "s2" };

test("group: only the owner is obeyed, everyone else is ignored silently", () => {
  assert.equal(bridge.routeUpdate(gmsg({ message_thread_id: 77, is_topic_message: true }), group).sessionId, "s1");
  assert.deepEqual(bridge.routeUpdate(gmsg({ from: { id: 31337 }, message_thread_id: 77, is_topic_message: true }), group), { type: "ignore" });
  assert.deepEqual(bridge.routeUpdate(gmsg({ from: { id: 31337 }, text: "/away" }), group), { type: "ignore" });
  // Without a known owner nobody is obeyed in a group.
  assert.deepEqual(bridge.routeUpdate(gmsg({}), { ...group, ownerUserId: "" }), { type: "ignore" });
  const press = (from) => ({ callback_query: { id: "c", from: { id: from }, data: "p:0123456789abcdef:allow", message: { message_id: 1, chat: { id: GROUP } } } });
  assert.equal(bridge.routeUpdate(press(OWNER), group).type, "callback");
  assert.equal(bridge.routeUpdate(press(31337), group).type, "ignore");
});

test("group: General routes to the boss; reply threads in a non-forum group use reply-to", () => {
  assert.equal(bridge.routeUpdate(gmsg({}), group).sessionId, "s2");
  // In a non-forum supergroup a reply carries message_thread_id but is_topic_message is false.
  const reply = gmsg({ message_thread_id: 10, reply_to_message: { message_id: 10 } });
  assert.equal(bridge.routeUpdate(reply, group).sessionId, "s1");
});

test("boss resolution: explicit claim, else the newest live session titled «Босс»", () => {
  const state = bridge.emptyState();
  state.sessions = {
    a: { title: " босс ", updatedAt: 1 },
    b: { title: "Босс", updatedAt: 5 },
    c: { title: "Босс", updatedAt: 9, ended: true },
    d: { title: "Другое", updatedAt: 10 },
    e: { title: "Босс", updatedAt: 20, host: "Codex" },
  };
  assert.equal(bridge.resolveBossId(state), "b");
  state.meta.bossSessionId = "d";
  assert.equal(bridge.resolveBossId(state), "d");
  state.sessions.d.ended = true;
  assert.equal(bridge.resolveBossId(state), "b");
  assert.equal(bridge.resolveBossId(bridge.emptyState()), null);
});

test("routing: topic closed/reopened and bot commands", () => {
  assert.deepEqual(
    bridge.routeUpdate(msg({ message_thread_id: 77, text: undefined, forum_topic_closed: {} }), { chatId: "4242", sessions }),
    { type: "topic-closed", sessionId: "s1" },
  );
  const cmd = bridge.routeUpdate(msg({ text: "/mute@MyBot 30m" }), { chatId: "4242", sessions });
  assert.equal(cmd.type, "command");
  assert.equal(cmd.name, "mute");
  assert.equal(cmd.arg, "30m");
  assert.equal(bridge.routeUpdate(msg({ text: "/status", chat: { id: 1 }, from: { id: 1 } }), { chatId: "4242", sessions }).type, "ignore");
});

test("callback parsing and owner check", () => {
  assert.deepEqual(bridge.parseCallbackData("p:0123456789abcdef:allow"), { requestId: "0123456789abcdef", behavior: "allow" });
  assert.equal(bridge.parseCallbackData("p:0123:allow"), null);
  assert.equal(bridge.parseCallbackData("p:0123456789abcdef:maybe"), null);
  const query = (from) => ({ callback_query: { id: "cb", from: { id: from }, data: "p:0123456789abcdef:deny", message: { message_id: 9, chat: { id: OWNER } } } });
  assert.equal(bridge.routeUpdate(query(OWNER), { chatId: "4242" }).type, "callback");
  assert.equal(bridge.routeUpdate(query(1), { chatId: "4242" }).type, "ignore");
});

test("waiter supersession: a newer waiter wins, old one sees 'superseded'", () => {
  const state = bridge.emptyState();
  const first = bridge.claimWaiter(state, "s", 100, 1);
  const second = bridge.claimWaiter(state, "s", 200, 2);
  assert.equal(second, first + 1);
  assert.equal(bridge.waiterStatus(state.sessions.s, first), "superseded");
  assert.equal(bridge.waiterStatus(state.sessions.s, second), "active");
  assert.equal(bridge.hasLiveWaiter(state.sessions.s, (pid) => pid === 200), true);
  state.sessions.s.ended = true;
  assert.equal(bridge.waiterStatus(state.sessions.s, second), "ended");
  state.sessions.s.ended = false;
  state.sessions.s.closed = true;
  assert.equal(bridge.waiterStatus(state.sessions.s, second), "closed");
});

test("waitForReply: delivers inbox text, older waiter exits quietly", async () => {
  const tg = mockTelegram(() => true);
  try {
    await bridge.updateState((state) => {
      state.sessions.chat1 = { topicId: 5, lastMessageIds: [1] };
    });
    const old = bridge.waitForReply({ session_id: "chat1" }, { pollMs: 20 });
    await new Promise((r) => setTimeout(r, 100));
    const current = bridge.waitForReply({ session_id: "chat1" }, { pollMs: 20 });
    assert.deepEqual(await old, { code: 0 });
    mkdirSync(path.join(env.state, "inbox"), { recursive: true });
    writeFileSync(path.join(env.state, "inbox", "chat1.jsonl"), `${JSON.stringify({ text: "продолжай", messageId: 33 })}\n`);
    const result = await current;
    assert.equal(result.code, 2);
    assert.equal(result.text, "Сообщение пользователя из Telegram: продолжай");
    assert.ok(tg.calls.some((c) => c.method === "setMessageReaction" && c.params.message_id === 33));
    const state = await bridge.readState();
    assert.equal(state.sessions.chat1.replyToTelegram, true);
    assert.equal(state.sessions.chat1.waiter, undefined);
  } finally {
    tg.restore();
  }
});

test("waitForReply: exits 0 when the session ends", async () => {
  await bridge.updateState((state) => {
    state.sessions.end1 = { topicId: 6 };
  });
  const waiting = bridge.waitForReply({ session_id: "end1" }, { pollMs: 20 });
  await new Promise((r) => setTimeout(r, 60));
  await bridge.markSessionEnded("end1");
  assert.deepEqual(await waiting, { code: 0 });
});

test("wait-reply exits 0 immediately under Codex (no CLAUDE_PLUGIN_ROOT)", () => {
  const childEnv = { ...process.env };
  delete childEnv.CLAUDE_PLUGIN_ROOT;
  const started = Date.now();
  const result = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(ENTRY)}).then(m=>m.run(['wait-reply']))`], {
    input: JSON.stringify({ session_id: "x", hook_event_name: "Stop" }),
    env: childEnv,
    timeout: 10_000,
  });
  assert.equal(result.status, 0);
  assert.ok(Date.now() - started < 5000);
});

test("resolvePendingIn: unsent cancelled, sent marked for edit, tool match picks the oldest", () => {
  const state = bridge.emptyState();
  state.pending = {
    a: { id: "a", kind: "approval", sessionId: "s", toolName: "Bash", createdAt: 1, sent: false },
    b: { id: "b", kind: "approval", sessionId: "s", toolName: "Bash", createdAt: 2, sent: true },
    c: { id: "c", kind: "action", sessionId: "s", createdAt: 3, sent: true },
    d: { id: "d", kind: "action", sessionId: "other", createdAt: 4, sent: false },
  };
  assert.equal(bridge.resolvePendingIn(state, "s", { kinds: ["approval"], toolName: "Bash" }), 0);
  assert.deepEqual(Object.keys(state.pending).sort(), ["b", "c", "d"]);
  assert.equal(bridge.resolvePendingIn(state, "s", {}), 2);
  assert.equal(state.pending.b.resolved, true);
  assert.equal(state.pending.c.resolved, true);
  assert.equal(state.pending.d.resolved, undefined);
});

test("permission decision JSON", () => {
  assert.deepEqual(bridge.permissionDecision("allow").hookSpecificOutput.decision, { behavior: "allow" });
  assert.deepEqual(bridge.permissionDecision("deny").hookSpecificOutput.decision, {
    behavior: "deny",
    message: "Отклонено пользователем кнопкой в Telegram или Discord",
  });
});

test("deliver: creates the topic once, renames it, retries plain text on parse errors", async () => {
  let nextId = 100;
  const tg = mockTelegram((method, params) => {
    if (method === "getMe") return { id: 1, username: "bot", has_topics_enabled: true };
    if (method === "createForumTopic") return { message_thread_id: 900, name: params.name };
    if (method === "editForumTopic") return true;
    if (method === "sendMessage" && params.parse_mode === "HTML" && params.text.includes("BROKEN")) return { error: "Bad Request: can't parse entities" };
    if (method === "sendMessage") return { message_id: nextId++ };
    return true;
  });
  try {
    const settings = await loadSettings();
    const ctx = { sessionId: "topic1", title: "TEST bridge", project: "proj", cwd: "/x/proj", host: "Claude Code" };
    const first = await bridge.deliver(settings, ctx, ["<b>one</b>"], { silent: true });
    assert.equal(first.threadId, 900);
    await bridge.deliver(settings, { ...ctx, title: "Новое имя" }, ["two <b>BROKEN"]);
    const methods = tg.calls.map((c) => c.method);
    assert.equal(methods.filter((m) => m === "createForumTopic").length, 1);
    assert.equal(tg.calls.find((c) => c.method === "createForumTopic").params.name, "TEST bridge · proj");
    assert.equal(tg.calls.find((c) => c.method === "editForumTopic").params.name, "Новое имя · proj");
    const sends = tg.calls.filter((c) => c.method === "sendMessage");
    assert.equal(sends[0].params.message_thread_id, 900);
    assert.equal(sends[0].params.disable_notification, true);
    assert.equal(sends.at(-1).params.parse_mode, undefined);
    assert.equal(sends.at(-1).params.text, "two BROKEN");
    const state = await bridge.readState();
    assert.deepEqual(state.sessions.topic1.lastMessageIds, [100, 101]); // failed HTML send consumes no id
    assert.equal(statSync(path.join(env.state, "sessions.json")).mode & 0o777, 0o600);
    assert.equal(statSync(env.state).mode & 0o777, 0o700);
  } finally {
    tg.restore();
  }
});

test("button press: owner callback records the decision and edits the message", async () => {
  const tg = mockTelegram(() => true);
  try {
    const settings = await loadSettings();
    const id = "00112233445566ff";
    mkdirSync(path.join(env.state, "approvals"), { recursive: true });
    writeFileSync(path.join(env.state, "approvals", `${id}.req.json`), JSON.stringify({ html: "🔐 <b>T</b>", pid: process.pid }));
    const update = { update_id: 2, callback_query: { id: "cb1", from: { id: OWNER }, data: `p:${id}:allow`, message: { message_id: 55, chat: { id: OWNER } } } };
    await bridge.handleUpdate(settings, update);
    assert.equal(JSON.parse(readFileSync(path.join(env.state, "approvals", `${id}.res.json`), "utf8")).behavior, "allow");
    const edit = tg.calls.find((c) => c.method === "editMessageText");
    assert.equal(edit.params.message_id, 55);
    assert.match(edit.params.text, /Разрешено в Telegram/);
    assert.equal(edit.params.reply_markup, undefined);
    // A second press is answered but changes nothing.
    await bridge.handleUpdate(settings, update);
    assert.equal(tg.calls.filter((c) => c.method === "editMessageText").length, 1);
  } finally {
    tg.restore();
  }
});

test("requestApproval: buttons, then edit on timeout", async () => {
  const tg = mockTelegram((method) => {
    if (method === "getMe") return { has_topics_enabled: false };
    if (method === "sendMessage") return { message_id: 70 };
    return true;
  });
  try {
    await bridge.updateState((state) => { state.meta = {}; });
    const settings = await loadSettings();
    const ctx = { sessionId: "appr1", title: "T", project: "p", cwd: "/p", host: "Claude Code" };
    const result = await bridge.requestApproval(settings, ctx, "🔐 <b>T</b>", 0.3, { pollMs: 20, toolName: "Bash" });
    assert.equal(result, null);
    const send = tg.calls.find((c) => c.method === "sendMessage");
    const buttons = send.params.reply_markup.inline_keyboard[0];
    assert.deepEqual(buttons.map((b) => b.style), ["success", "danger"]);
    assert.match(buttons[0].callback_data, /^p:[0-9a-f]{16}:allow$/);
    const edit = tg.calls.find((c) => c.method === "editMessageText");
    assert.match(edit.params.text, /Ответа нет — решите в приложении/);
    const state = await bridge.readState();
    assert.equal(Object.keys(state.pending).length, 0);
  } finally {
    tg.restore();
  }
});

test("an approval sent to both services closes both messages after a Discord click", async (t) => {
  const channel = "123456789012345672";
  const owner = "123456789012345671";
  const message = "123456789012345674";
  const requestId = "00112233445566aa";
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), method: options.method, body: JSON.parse(options.body ?? "{}") });
    if (String(url).includes("discord.com")) return Response.json({ id: message });
    return Response.json({ ok: true, result: { message_id: 880 } });
  });
  const settings = { ...await loadSettings(), notificationTarget: "both", topics: false,
    discordToken: "fake", discordChannel: channel, discordOwner: owner };
  const markup = { inline_keyboard: [[{ text: "Разрешить", callback_data: `p:${requestId}:allow` }]] };
  const sent = await bridge.deliver(settings, {}, ["Разрешить?"], { replyMarkup: markup });
  assert.deepEqual(sent.messageIds, [880]);
  assert.equal(await bridge.mirrorId(880), `${channel}:${message}`);
  mkdirSync(path.join(env.state, "approvals"), { recursive: true });
  writeFileSync(path.join(env.state, "approvals", `${requestId}.req.json`), JSON.stringify({ html: "Разрешить?", pid: process.pid }));
  const inbound = {
    ...settings, token: { channel, owner, secret: "fake" }, chatId: channel, ownerUserId: owner,
    telegramToken: settings.token, telegramChatId: settings.chatId,
  };
  const update = { callback_query: { id: "cb", from: { id: owner }, data: `p:${requestId}:allow`,
    message: { chat: { id: channel }, message_id: `${channel}:${message}` } } };
  await bridge.handleUpdate(inbound, update);
  await bridge.handleUpdate(inbound, update);
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/editMessageText")).length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(env.state, "approvals", `${requestId}.res.json`))).behavior, "allow");
});

test("daemon never logs the token", async () => {
  const tg = mockTelegram(() => ({ error: `Unauthorized ${FAKE_TOKEN}`, status: 401 }));
  try {
    await bridge.telegram?.(FAKE_TOKEN, "getMe").catch(() => {});
    await bridge.logLine(`error with ${FAKE_TOKEN}`);
    const log = readFileSync(path.join(env.state, "daemon.log"), "utf8");
    assert.equal(log.includes(FAKE_TOKEN), false);
    assert.equal(existsSync(path.join(env.state, "daemon.log")), true);
  } finally {
    tg.restore();
  }
});
