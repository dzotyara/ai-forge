import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { isolatedHome, mockTelegram } from "./helpers.mjs";

const env = isolatedHome({ chatId: "-100555", extra: { ownerUserId: "4242" } });
process.env.CLAUDE_PLUGIN_ROOT = "/plugins/telegram-action-notifier";
delete process.env.TELEGRAM_BRIDGE_HEADLESS;

const common = await import("../skills/telegram-action-notifier/scripts/lib/common.mjs");
const bridge = await import("../skills/telegram-action-notifier/scripts/lib/bridge.mjs");
const workers = await import("../skills/telegram-action-notifier/scripts/lib/workers.mjs");
const entry = await import("../skills/telegram-action-notifier/scripts/telegram-action-notifier.mjs");

// A live pid in daemon.pid keeps ensureDaemon() from spawning a real poller.
mkdirSync(env.state, { recursive: true });
writeFileSync(path.join(env.state, "daemon.pid"), String(process.pid));

// No real processes: record every spawn.
const spawned = [];
workers.deps.spawn = (cmd, args, opts) => {
  spawned.push({ cmd, args, opts });
  const child = new EventEmitter();
  child.pid = 999_999_0 + spawned.length;
  child.unref = () => {};
  return child;
};

const config = (patch) => {
  const file = path.join(env.dir, "config.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));
};
const reset = () => bridge.updateState((state) => {
  state.sessions = {};
  state.spawns = {};
  state.pending = {};
  state.meta = { topics: { chatId: "-100555", enabled: true, reason: "ok", at: Date.now() } };
});
const CWD = process.cwd();
const owner = { id: 4242 };
const chat = { id: -100555, type: "supergroup" };
const press = (data, messageId, from = owner) => ({
  update_id: 1,
  callback_query: { id: "cb1", from, data, message: { message_id: messageId, chat } },
});

test("settings: worker defaults follow the permission choice", () => {
  const plain = common.resolveSettings({}, {});
  assert.equal(plain.spawnConfirm, "telegram");
  assert.equal(plain.workerPermissions, "telegram");
  assert.deepEqual(plain.workerDefaults, { model: "claude-sonnet-5-5", effort: "medium", permissionMode: "acceptEdits" });
  const auto = common.resolveSettings({ spawnConfirm: "never", workerPermissions: "auto", workerDefaults: { model: "claude-opus-5-5", effort: "high", permissionMode: "acceptEdits" } }, {});
  assert.equal(auto.spawnConfirm, "never");
  assert.deepEqual(auto.workerDefaults, { model: "claude-opus-5-5", effort: "high", permissionMode: "auto" });
  assert.equal(common.resolveSettings({ workerDefaults: { permissionMode: "bypassPermissions", effort: "huge" } }, {}).workerDefaults.permissionMode, "acceptEdits");
});

test("spawn spec: validation and permission branches", () => {
  const settings = common.resolveSettings({}, {});
  const spec = workers.resolveWorkerSpec(settings, { cwd: CWD, title: "  тест ", parent: "myskills", brief: "Скажи привет" });
  assert.equal(spec.title, "тест");
  assert.equal(spec.parent, "myskills");
  assert.equal(spec.model, "claude-sonnet-5-5");
  assert.equal(spec.permissionMode, "acceptEdits");
  assert.throws(() => workers.resolveWorkerSpec(settings, { cwd: CWD, title: "x", brief: "b", "permission-mode": "bypassPermissions" }), /permission-mode/);
  assert.throws(() => workers.resolveWorkerSpec(settings, { cwd: CWD, title: "x", brief: "b", "permission-mode": "auto" }), /workerPermissions/);
  assert.throws(() => workers.resolveWorkerSpec(settings, { cwd: "/definitely/not/here", title: "x", brief: "b" }), /directory/);
  assert.throws(() => workers.resolveWorkerSpec(settings, { cwd: CWD, title: "x", brief: " " }), /brief/);
  assert.throws(() => workers.resolveWorkerSpec(settings, { cwd: CWD, title: "x", brief: "b", effort: "huge" }), /effort/);
  assert.throws(() => workers.resolveWorkerSpec(settings, { cwd: CWD, title: "x", brief: "b", model: "a b" }), /model/);
  const auto = common.resolveSettings({ workerPermissions: "auto" }, {});
  assert.equal(workers.resolveWorkerSpec(auto, { cwd: CWD, title: "x", brief: "b", "permission-mode": "acceptEdits" }).permissionMode, "auto");
  assert.equal(workers.resolveWorkerSpec(auto, { cwd: CWD, title: "x", brief: "b", "permission-mode": "plan" }).permissionMode, "plan");
});

test("spawn args: first run names the session, later runs resume it", () => {
  const session = { title: "тест", model: "claude-sonnet-5-5", effort: "low", permissionMode: "acceptEdits" };
  assert.deepEqual(workers.buildWorkerArgs("u-1", session, { prompt: "Скажи привет", resume: false }), [
    "-p", "--session-id", "u-1", "--name", "тест",
    "--model", "claude-sonnet-5-5", "--effort", "low", "--permission-mode", "acceptEdits",
    "--output-format", "json", "--", "Скажи привет",
  ]);
  const resume = workers.buildWorkerArgs("u-1", session, { prompt: "-да", resume: true, allowedTools: ["Bash(git *)"] });
  assert.deepEqual(resume.slice(0, 3), ["-p", "--resume", "u-1"]);
  assert.equal(resume.includes("--session-id"), false);
  assert.deepEqual(resume.slice(-4), ["--allowedTools", "Bash(git *)", "--", "-да"]);
});

test("worker env drops the caller's session variables", () => {
  const out = workers.workerEnv({ PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", CLAUDE_CODE_ENTRYPOINT: "app", CLAUDE_PLUGIN_ROOT: "/p", CLAUDE_CODE_USE_BEDROCK: "1", CODEX_HOME: "/h" });
  assert.deepEqual(out, { PATH: "/bin", CLAUDE_CODE_USE_BEDROCK: "1", CODEX_HOME: "/h", TELEGRAM_BRIDGE_HEADLESS: "1" });
});

test("confirm flow: spawn asks in General, only the owner's press starts it", async () => {
  await reset();
  config({ spawnConfirm: "telegram" });
  spawned.length = 0;
  let id = 500;
  const tg = mockTelegram((method) => (method === "sendMessage" ? { message_id: id++ } : true));
  try {
    const settings = await common.loadSettings();
    const result = await workers.spawnCommand(settings, { cwd: CWD, title: "тест", parent: "myskills", brief: "Скажи привет", "no-confirm": true });
    assert.equal(result.status, "awaiting-confirmation");
    assert.match(result.note, /--no-confirm ignored/);
    assert.equal(spawned.length, 0, "nothing starts before the press");
    const ask = tg.calls.find((c) => c.method === "sendMessage");
    assert.equal(ask.params.message_thread_id, undefined); // General
    assert.match(ask.params.text, /Запустить сессию «тест» · .+ · claude-sonnet-5-5\?/);
    assert.match(ask.params.text, /<blockquote>Скажи привет<\/blockquote>/);
    const [go, no] = ask.params.reply_markup.inline_keyboard[0];
    assert.equal(go.text, "▶️ Запустить");
    assert.equal(no.text, "✕ Отмена");
    assert.equal(go.callback_data, `s:${result.requestId}:go`);

    // A stranger's press is ignored.
    await bridge.handleUpdate(settings, press(go.callback_data, 500, { id: 31337 }));
    assert.equal(spawned.length, 0);

    await bridge.handleUpdate(settings, press(go.callback_data, 500));
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args.slice(1), ["run-worker", spawned[0].args[2]]);
    assert.equal(spawned[0].opts.env.TELEGRAM_BRIDGE_HEADLESS, "1");
    const edit = tg.calls.find((c) => c.method === "editMessageText");
    assert.match(edit.params.text, /Запущена сессия «тест»/);
    const state = await bridge.readState();
    const session = state.sessions[spawned[0].args[2]];
    assert.equal(session.headless, true);
    assert.equal(session.parent, "myskills");
    assert.equal(session.job.prompt, "Скажи привет");
    assert.deepEqual(state.spawns, {});

    // A second press finds nothing.
    await bridge.handleUpdate(settings, press(go.callback_data, 500));
    assert.equal(spawned.length, 1);
    assert.equal(tg.calls.at(-1).params.text, "Запрос уже закрыт");
  } finally {
    tg.restore();
  }
});

test("confirm flow: ✕ cancels and edits the message", async () => {
  await reset();
  spawned.length = 0;
  const tg = mockTelegram((method) => (method === "sendMessage" ? { message_id: 600 } : true));
  try {
    const settings = await common.loadSettings();
    const { requestId } = await workers.spawnCommand(settings, { cwd: CWD, title: "отмена", brief: "b" });
    await bridge.handleUpdate(settings, press(`s:${requestId}:no`, 600));
    assert.equal(spawned.length, 0);
    assert.match(tg.calls.find((c) => c.method === "editMessageText").params.text, /Отменено/);
  } finally {
    tg.restore();
  }
});

test('spawnConfirm "never" starts at once and posts a silent line', async () => {
  await reset();
  config({ spawnConfirm: "never" });
  spawned.length = 0;
  const tg = mockTelegram(() => ({ message_id: 700 }));
  try {
    const settings = await common.loadSettings();
    const result = await workers.spawnCommand(settings, { cwd: CWD, title: "сразу", brief: "b", "no-confirm": true });
    assert.equal(result.status, "started");
    assert.equal(spawned.length, 1);
    const line = tg.calls.find((c) => c.method === "sendMessage");
    assert.equal(line.params.disable_notification, true);
    assert.match(line.params.text, /▶️ <b>Запущена сессия «сразу»/);
  } finally {
    tg.restore();
    config({ spawnConfirm: "telegram" });
  }
});

test("runner: first job, then queued replies as one resume; one runner per session", async () => {
  await reset();
  const sid = "11111111-2222-3333-4444-555555555555";
  await bridge.updateState((state) => {
    state.sessions[sid] = { title: "тест", headless: true, cwd: CWD, model: "m", effort: "low", permissionMode: "acceptEdits", job: { prompt: "старт", resume: false }, updatedAt: Date.now() };
  });
  const runs = [];
  const exec = async (bin, args) => {
    runs.push(args);
    if (runs.length === 1) {
      // Owner writes twice while the first run is busy.
      await bridge.appendInbox(sid, { text: "первое", messageId: 1, at: 1 });
      await bridge.appendInbox(sid, { text: "второе", messageId: 2, at: 2 });
      // A second runner (another live process holds the claim) must not run in parallel.
      await bridge.updateState((state) => { state.sessions[sid].run.pid = process.ppid; });
      assert.equal(await workers.runWorker(sid, { exec: async () => assert.fail("parallel run") }), 0);
      assert.equal(await workers.kickWorker(sid), "queued");
      await bridge.updateState((state) => { state.sessions[sid].run.pid = process.pid; });
    }
    return { code: 0, json: { result: "ok" }, stderr: "" };
  };
  assert.equal(await workers.runWorker(sid, { exec }), 2);
  assert.equal(runs[0][1], "--session-id");
  assert.deepEqual(runs[1].slice(0, 3), ["-p", "--resume", sid]);
  assert.equal(runs[1].at(-1), "Сообщение пользователя из Telegram: первое\n\nСообщение пользователя из Telegram: второе");
  const session = (await bridge.readState()).sessions[sid];
  assert.equal(session.run, undefined);
  assert.equal(session.job, undefined);
  assert.equal(session.replyToTelegram, true);
});

test("runner: a failed run is reported in the worker's topic", async () => {
  await reset();
  const sid = "fail-1";
  await bridge.updateState((state) => {
    state.sessions[sid] = { title: "тест", headless: true, cwd: CWD, model: "m", effort: "low", permissionMode: "acceptEdits", job: { prompt: "x", resume: false }, updatedAt: Date.now() };
  });
  const tg = mockTelegram((method) => (method === "createForumTopic" ? { message_thread_id: 55 } : { message_id: 1 }));
  try {
    await workers.runWorker(sid, { exec: async () => ({ code: 1, json: null, stderr: "error: model not found\n" }) });
    const sent = tg.calls.find((c) => c.method === "sendMessage");
    assert.match(sent.params.text, /Запуск не удался[\s\S]*model not found/);
    assert.equal(sent.params.message_thread_id, 55);
  } finally {
    tg.restore();
  }
});

test("daemon: an owner reply to a headless topic is queued, 👀, and resumes the worker", async () => {
  await reset();
  spawned.length = 0;
  const sid = "head-1";
  await bridge.updateState((state) => {
    state.sessions[sid] = { title: "тест", headless: true, topicId: 77, cwd: CWD, updatedAt: Date.now() };
  });
  const tg = mockTelegram(() => true);
  try {
    const settings = await common.loadSettings();
    const reply = (n) => ({ update_id: n, message: { message_id: n, message_thread_id: 77, is_topic_message: true, chat, from: owner, text: `ответ ${n}` } });
    await bridge.handleUpdate(settings, reply(10));
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args.slice(1), ["run-worker", sid]);
    const reaction = tg.calls.find((c) => c.method === "setMessageReaction");
    assert.equal(reaction.params.message_id, 10);
    assert.equal(tg.calls.some((c) => c.method === "sendMessage"), false, "no 'busy' notice for workers");
    // A resume is running: the next reply only queues.
    await bridge.updateState((state) => { state.sessions[sid].run = { pid: process.pid }; });
    await bridge.handleUpdate(settings, reply(11));
    assert.equal(spawned.length, 1);
    const inbox = readFileSync(bridge.inboxFile(sid), "utf8");
    assert.match(inbox, /ответ 10[\s\S]*ответ 11/);
    // Once the run is gone, the daemon tick delivers the queue.
    await bridge.updateState((state) => { delete state.sessions[sid].run; });
    await workers.tickWorkers(settings);
    assert.equal(spawned.length, 2);
  } finally {
    tg.restore();
  }
});

test("headless sessions: no waiter, SessionEnd keeps them resumable, title kept", async () => {
  await reset();
  await bridge.updateState((state) => {
    state.sessions.h2 = { title: "тест", headless: true, cwd: "/x/myskills", updatedAt: Date.now() };
  });
  assert.deepEqual(await bridge.waitForReply({ session_id: "h2" }), { code: 0 });
  assert.equal((await bridge.readState()).sessions.h2.waiter, undefined);
  await bridge.markSessionEnded("h2");
  assert.equal((await bridge.readState()).sessions.h2.ended, undefined);
  const ctx = await bridge.sessionContext({ session_id: "h2", cwd: "/x/myskills", transcript_path: "/nonexistent.jsonl" }, "Claude Code");
  assert.equal(ctx.title, "тест");
  const described = bridge.describeSession("h2", (await bridge.readState()).sessions.h2, () => false);
  assert.equal(described.headless, true);
  assert.equal(described.waiting, true);
});

test("hierarchy: child topics are named «parent › title», at most 128 chars", async () => {
  assert.equal(bridge.topicName("тест", "myskills", "myskills"), "myskills › тест");
  assert.equal(bridge.topicName("тест", "proj", null), "тест · proj");
  assert.equal(bridge.topicName("т".repeat(200), "p", "родитель").length, 128);
  await reset();
  const result = await workers.setParent("app-1", "  myskills ");
  assert.deepEqual(result, { sessionId: "app-1", parent: "myskills", parentKnown: false });
  const tg = mockTelegram((method) => (method === "createForumTopic" ? { message_thread_id: 90 } : { message_id: 5 }));
  try {
    await bridge.deliver(await common.loadSettings(), { sessionId: "app-1", title: "тест", project: "myskills", cwd: "/x/myskills", host: "Claude Code" }, ["hi"]);
    assert.equal(tg.calls.find((c) => c.method === "createForumTopic").params.name, "myskills › тест");
  } finally {
    tg.restore();
  }
  assert.equal((await workers.setParent("app-1", "")).parent, null);
});

test("notify-boss: inbox line, rate limit, no boss, not to self", async () => {
  await reset();
  assert.deepEqual(await workers.notifyBoss("w1", "готово"), { error: "no-boss" });
  await bridge.claimBoss("boss-1");
  await bridge.updateState((state) => { state.sessions.w1 = { title: "тест", updatedAt: Date.now() }; });
  const now = 1_000_000;
  assert.deepEqual(await workers.notifyBoss("w1", "готово, PR #5", { now }), { ok: true, bossId: "boss-1" });
  const limited = await workers.notifyBoss("w1", "ещё", { now: now + 10_000 });
  assert.equal(limited.error, "rate");
  assert.equal(limited.retryInSec, 20);
  assert.equal((await workers.notifyBoss("w1", "ещё", { now: now + 30_000 })).ok, true);
  assert.equal((await workers.notifyBoss("boss-1", "сам себе", { now })).error, "self");
  const entries = await bridge.takeInbox("boss-1");
  assert.equal(entries.length, 2);
  assert.equal(bridge.formatReplies(entries.slice(0, 1)), "Сессия «тест» сообщает: готово, PR #5");
});

test("permission hook in a headless worker: auto stays silent, telegram asks with buttons", async () => {
  await reset();
  await bridge.updateState((state) => {
    state.sessions.hw = { title: "тест", headless: true, topicId: 66, cwd: CWD, updatedAt: Date.now() };
  });
  const event = { hook_event_name: "PermissionRequest", session_id: "hw", cwd: CWD, tool_name: "Bash", tool_input: { description: "Запустить тесты" } };
  let out = "";
  const write = process.stdout.write;
  process.stdout.write = (chunk) => { out += chunk; return true; };
  try {
    config({ workerPermissions: "auto" });
    let tg = mockTelegram(() => true);
    await entry.handleEvent(event);
    assert.equal(out, "");
    assert.equal(tg.calls.length, 0, "auto: nothing is asked");
    tg.restore();

    config({ workerPermissions: "telegram" });
    tg = mockTelegram((method, params) => {
      if (method === "sendMessage") {
        const data = params.reply_markup.inline_keyboard[0][0].callback_data;
        const requestId = /^p:([0-9a-f]{16}):allow$/.exec(data)[1];
        // The owner presses ✅ a moment later.
        setTimeout(() => writeFileSync(path.join(env.state, "approvals", `${requestId}.res.json`), JSON.stringify({ behavior: "allow" })), 50);
        return { message_id: 9 };
      }
      return true;
    });
    await entry.handleEvent(event);
    tg.restore();
    assert.equal(JSON.parse(out).hookSpecificOutput.decision.behavior, "allow");
    assert.equal(tg.calls.find((c) => c.method === "sendMessage").params.message_thread_id, 66);
  } finally {
    process.stdout.write = write;
    config({ workerPermissions: "telegram" });
  }
});

test("settings panel validates the worker settings", async () => {
  const ui = await import("../skills/telegram-action-notifier/scripts/lib/ui.mjs");
  assert.deepEqual(ui.validateSettings({ spawnConfirm: "never", workerPermissions: "auto" }).value, { spawnConfirm: "never", workerPermissions: "auto" });
  assert.ok(ui.validateSettings({ spawnConfirm: "yes" }).error);
  assert.ok(ui.validateSettings({ workerPermissions: "bypass" }).error);
});

const generalMessage = (n, text = `привет ${n}`) => ({ update_id: n, message: { message_id: n, chat, from: owner, text } });
const stoppedBoss = (sid, extra = {}) => bridge.updateState((state) => {
  state.sessions[sid] = { title: "Босс", host: "Claude Code", cwd: CWD, ended: true, endedAt: 1, updatedAt: Date.now(), ...extra };
  state.meta.bossSessionId = sid;
  state.meta.bossClaimed = true;
});

test("stopped Boss: a General message is queued, 👀, and resumes it headless on Opus", async () => {
  await reset();
  spawned.length = 0;
  const sid = "boss-stopped-1";
  await stoppedBoss(sid);
  const tg = mockTelegram(() => true);
  try {
    const settings = await common.loadSettings();
    await bridge.handleUpdate(settings, generalMessage(20));
    assert.equal(tg.calls.some((c) => c.method === "sendMessage"), false, "no «не запущен» notice");
    assert.equal(tg.calls.find((c) => c.method === "setMessageReaction").params.message_id, 20);
    assert.deepEqual(spawned.map((s) => s.args.slice(1)), [["run-worker", sid]]);
    const session = (await bridge.readState()).sessions[sid];
    assert.deepEqual([session.revive.model, session.revive.effort], ["claude-opus-5-5", "high"]);
    assert.notEqual(session.revive.permissionMode, "bypassPermissions");

    // The runner resumes the same session with the queued message.
    const runs = [];
    const exec = async (bin, args) => {
      runs.push(args);
      return { code: 0, json: { result: "ok" }, stderr: "" };
    };
    assert.equal(await workers.runWorker(sid, { exec }), 1);
    assert.deepEqual(runs[0].slice(0, 3), ["-p", "--resume", sid]);
    assert.equal(runs[0][runs[0].indexOf("--model") + 1], "claude-opus-5-5");
    assert.match(runs[0].at(-1), /Сообщение пользователя из Telegram: привет 20/);
    const after = (await bridge.readState()).sessions[sid];
    assert.equal(after.revive, undefined);
    assert.equal(after.run, undefined);
    assert.equal(after.headless, undefined, "stays an app session");
  } finally {
    tg.restore();
  }
});

test("stopped Boss: a second message during the resume only queues", async () => {
  await reset();
  spawned.length = 0;
  const sid = "boss-stopped-2";
  await stoppedBoss(sid, { run: { pid: process.pid }, revive: { model: "claude-opus-5-5", effort: "high", permissionMode: "default" } });
  const tg = mockTelegram(() => true);
  try {
    await bridge.handleUpdate(await common.loadSettings(), generalMessage(21));
    assert.equal(spawned.length, 0);
    assert.match(readFileSync(bridge.inboxFile(sid), "utf8"), /привет 21/);
  } finally {
    tg.restore();
    await bridge.takeInbox(sid);
  }
});

test("Boss opened in the app again: no headless resume, the app's waiter gets the message", async () => {
  await reset();
  spawned.length = 0;
  const sid = "boss-live-1";
  await stoppedBoss(sid, { ended: false });
  const tg = mockTelegram(() => true);
  try {
    await bridge.handleUpdate(await common.loadSettings(), generalMessage(22));
    assert.equal(spawned.length, 0);
    assert.match(readFileSync(bridge.inboxFile(sid), "utf8"), /привет 22/);
    // A runner that finds the app back stops without taking the inbox.
    await bridge.updateState((state) => { state.sessions[sid].revive = { model: "m", effort: "high", permissionMode: "default" }; });
    assert.equal(await workers.runWorker(sid, { exec: async () => assert.fail("must not run") }), 0);
    assert.match(readFileSync(bridge.inboxFile(sid), "utf8"), /привет 22/);
    assert.equal(await workers.wakeBoss(await common.loadSettings(), sid), "live");
  } finally {
    tg.restore();
    await bridge.takeInbox(sid);
  }
});

test('stopped Boss with bossRevive false: the old «не запущен» notice', async () => {
  await reset();
  spawned.length = 0;
  await stoppedBoss("boss-stopped-3");
  config({ bossRevive: false });
  const tg = mockTelegram(() => ({ message_id: 1 }));
  try {
    await bridge.handleUpdate(await common.loadSettings(), generalMessage(23));
    assert.equal(spawned.length, 0);
    assert.match(tg.calls.find((c) => c.method === "sendMessage").params.text, /Босс сейчас не запущен/);
    assert.deepEqual(await workers.notifyBoss("w9", "готово"), { error: "no-boss" });
  } finally {
    tg.restore();
    config({ bossRevive: undefined });
  }
});

test("notify-boss wakes a stopped Boss", async () => {
  await reset();
  spawned.length = 0;
  const sid = "boss-stopped-4";
  await stoppedBoss(sid);
  await bridge.updateState((state) => { state.sessions.w2 = { title: "тест", updatedAt: Date.now() }; });
  assert.deepEqual(await workers.notifyBoss("w2", "готово", { now: 5_000_000 }), { ok: true, bossId: sid });
  assert.deepEqual(spawned.map((s) => s.args.slice(1)), [["run-worker", sid]]);
  await bridge.takeInbox(sid);
});

test("SessionStart context for a revived Boss points to spawn, not app tools", () => {
  const text = entry.headlessContext({ title: "Босс", revive: { model: "claude-opus-5-5" } });
  assert.match(text, /Boss session, resumed headless/);
  assert.match(text, /spawn/);
});
