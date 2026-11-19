import "./lang-ru.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { connectDiscord, discordCall, discordUpdate, setupDiscord, slashCommands } from "../skills/telegram-action-notifier/scripts/lib/discord.mjs";
import { discordSettings, resolveSettings } from "../skills/telegram-action-notifier/scripts/lib/common.mjs";
import { discordActivity, routeUpdate } from "../skills/telegram-action-notifier/scripts/lib/bridge.mjs";

const bot = { secret: "fake", owner: "123456789012345671", channel: "123456789012345672" };
const thread = "123456789012345673";
const id = "123456789012345674";

test("setup discovers the only server, creates private channels and reuses them on reconfiguration", async (t) => {
  const guild = "123456789012345675";
  const category = "123456789012345676";
  const botId = "123456789012345677";
  const channels = [];
  const created = [];
  const branded = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const route = new URL(url).pathname.replace("/api/v10", "");
    if (route === "/users/@me" && options.method === "PATCH") {
      branded.push([route, Object.keys(JSON.parse(options.body))]);
      return Response.json({ id: botId, avatar: "a" });
    }
    if (route === "/users/@me") return Response.json({ id: botId, bot: true, avatar: null });
    if (route === `/guilds/${guild}` && options.method === "PATCH") {
      branded.push([route, Object.keys(JSON.parse(options.body))]);
      return new Response(null, { status: 403 });
    }
    if (route === `/guilds/${guild}`) return Response.json({ id: guild, icon: null });
    if (route === "/applications/@me") return Response.json({ id: botId, flags: 0 });
    if (route === "/users/@me/guilds") return Response.json([{ id: guild }]);
    if (route === `/guilds/${guild}/members/${bot.owner}`) return Response.json({ user: { id: bot.owner } });
    assert.equal(route, `/guilds/${guild}/channels`);
    if (options.method === "GET") return Response.json(channels);
    const body = JSON.parse(options.body);
    created.push(body);
    const channel = { id: [category, bot.channel, thread][channels.length], ...body };
    channels.push(channel);
    return Response.json(channel);
  });
  const { settings, warnings } = await setupDiscord(bot.secret, "", bot.owner);
  assert.equal(settings.discordGuild, guild);
  assert.equal(settings.discordChannel, bot.channel);
  // Bot avatar set; the server icon needs Manage Server, so a warning explains it.
  assert.deepEqual(branded, [["/users/@me", ["avatar"]], [`/guilds/${guild}`, ["default_message_notifications"]],
    [`/guilds/${guild}`, ["icon"]]]);
  assert.match(warnings.join(" "), /Manage Server/);
  assert.match(warnings.join(" "), /Message Content Intent/);
  assert.deepEqual((await setupDiscord(bot.secret, guild, bot.owner, settings)).settings, settings);
  assert.equal(created.length, 2);
  const routed = discordSettings(resolveSettings(settings, {}));
  assert.deepEqual(await discordCall(routed.token, "createForumTopic", { name: "Код · Проект" }),
    { message_thread_id: thread });
  assert.deepEqual(created.map(({ name, type, parent_id }) => [name, type, parent_id]),
    [["AI Forge", 4, undefined], ["🔥・general", 0, category], ["🤖・код-проект", 0, category]]);
  assert.match(created[1].topic, /Босс/);
  for (const channel of created) {
    assert.deepEqual(channel.permission_overwrites.map(({ id, type }) => [id, type]),
      [[guild, 0], [botId, 1], [bot.owner, 1]]);
    assert.equal(channel.permission_overwrites[0].deny, "1024");
  }
});

test("Discord settings require a configured owner and default existing installations to Telegram", () => {
  assert.equal(resolveSettings({}, {}).notificationTarget, "telegram");
  const raw = { notificationTarget: "both", discordToken: "fake", discordChannel: bot.channel, discordOwner: bot.owner };
  assert.equal(resolveSettings(raw, {}).notificationTarget, "both");
  assert.deepEqual(discordSettings(resolveSettings(raw, {})).token, bot);
  assert.equal(discordSettings(resolveSettings({ ...raw, discordOwner: "" }, {})), null);
});

test("Discord sends long messages with quiet delivery, buttons and exact snowflake IDs", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, ...JSON.parse(options.body) });
    return Response.json({ id });
  });
  const button = { text: "Разрешить", callback_data: "p:00112233445566ff:allow", style: "success" };
  const sent = await discordCall(bot, "sendMessage", {
    text: "я".repeat(1999) + "😀" + " @everyone", message_thread_id: thread, disable_notification: true,
    reply_markup: { inline_keyboard: [[button]] },
  });
  assert.equal(sent.message_id, `${thread}:${id}`);
  assert.equal(calls[0].content.length, 1999);
  assert.equal(calls[1].content, "😀 @everyone");
  assert.ok(calls.every((call) => call.flags === 4100 && call.allowed_mentions.parse.length === 0));
  assert.deepEqual(calls[1].components[0].components[0], {
    type: 2, label: button.text, custom_id: button.callback_data, style: 3, disabled: false,
  });
});

test("Discord routes only the owner's replies and decisions through the shared bridge", () => {
  const routing = { chatId: bot.channel, ownerUserId: bot.owner, sessions: { session: { topicId: thread } } };
  const message = { id, channel_id: thread, author: { id: bot.owner }, content: "Ответ" };
  assert.equal(routeUpdate(discordUpdate(bot, "MESSAGE_CREATE", message), routing).sessionId, "session");
  assert.equal(discordUpdate(bot, "MESSAGE_CREATE", { ...message, author: { id } }), null);
  const interaction = { type: 3, id, channel_id: thread, member: { user: message.author },
    message, data: { custom_id: "p:00112233445566ff:allow" } };
  const route = routeUpdate(discordUpdate(bot, "INTERACTION_CREATE", interaction), routing);
  assert.equal(route.behavior, "allow");
  assert.equal(route.messageId, `${thread}:${id}`);
});

test("long code blocks remain fenced in each Discord message", async (t) => {
  const chunks = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    chunks.push(JSON.parse(options.body).content);
    return Response.json({ id });
  });
  await discordCall(bot, "sendMessage", {
    text: '<b>Result</b>\n<pre><code class="language-js">' + "x".repeat(2200) + '</code></pre>',
    parse_mode: "HTML",
  });
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 2000 && chunk.split("\`\`\`").length === 3));
  assert.ok(chunks[0].startsWith("**Result**"));
  assert.ok(chunks[1].startsWith("\`\`\`js\n"));
});

test("setup renames channels from an older setup instead of making new ones", async (t) => {
  const guild = "123456789012345675";
  const botId = "123456789012345677";
  const overwrites = [{ id: guild, type: 0, allow: "0", deny: "1024" },
    ...[botId, bot.owner].map((id) => ({ id, type: 1, allow: "68672", deny: "0" }))];
  const old = [
    { id: "123456789012345681", type: 4, name: "myskills", permission_overwrites: overwrites },
    { id: "123456789012345682", type: 0, name: "general", parent_id: "123456789012345681", permission_overwrites: overwrites },
  ];
  const patched = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const route = new URL(url).pathname.replace("/api/v10", "");
    if (route === "/users/@me") return Response.json({ id: botId, avatar: "set" });
    if (route === "/users/@me/guilds") return Response.json([{ id: guild }]);
    if (route === `/guilds/${guild}`) return Response.json({ id: guild, icon: "set", default_message_notifications: 1 });
    if (route === "/applications/@me") return Response.json({ id: botId, flags: 1 << 19 });
    if (route.startsWith(`/guilds/${guild}/members/`)) return Response.json({ user: { id: bot.owner } });
    if (route === `/guilds/${guild}/channels` && options.method === "GET") return Response.json(old);
    assert.equal(options.method, "PATCH", `unexpected ${options.method} ${route}`);
    patched.push([route, JSON.parse(options.body)]);
    return Response.json({ ...old.find((c) => route.endsWith(c.id)), ...JSON.parse(options.body) });
  });
  const { settings, warnings } = await setupDiscord("fake2", "", bot.owner);
  assert.deepEqual(warnings, []);
  assert.equal(settings.discordCategory, old[0].id);
  assert.equal(settings.discordChannel, old[1].id);
  assert.deepEqual(patched.map(([route, body]) => [route, body.name]),
    [[`/channels/${old[0].id}`, "AI Forge"], [`/channels/${old[1].id}`, "🔥・general"]]);
});

test("repeated button data still reaches Discord and comes back unchanged", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ id });
  });
  await discordCall(bot, "sendMessage", { text: "?", reply_markup: { inline_keyboard: [[
    { text: "Да", callback_data: "u:yes" }, { text: "Точно да", callback_data: "u:yes" }]] } });
  const buttons = bodies[0].components[0].components;
  assert.equal(new Set(buttons.map((b) => b.custom_id)).size, 2);
  const press = discordUpdate(bot, "INTERACTION_CREATE", { type: 3, id, channel_id: bot.channel,
    member: { user: { id: bot.owner } }, message: { id, content: "?", components: bodies[0].components },
    data: { custom_id: buttons[1].custom_id } });
  assert.equal(press.callback_query.data, "u:yes");
  assert.deepEqual(press.callback_query.message.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["u:yes", "u:yes"]);
});

test("slash commands read as the same text commands", () => {
  const commands = slashCommands([{ command: "status", description: "s" }, { command: "mute", description: "m" }]);
  assert.equal(commands[1].options[0].required, true);
  const update = discordUpdate(bot, "INTERACTION_CREATE", { type: 2, id, channel_id: bot.channel,
    member: { user: { id: bot.owner } }, data: { name: "mute", options: [{ name: "срок", type: 3, value: "30m" }] } });
  assert.equal(update.message.text, "/mute 30m");
  assert.equal(update.slashCommand, true);
  const routed = routeUpdate(update, { chatId: bot.channel, ownerUserId: bot.owner, sessions: {} });
  assert.deepEqual([routed.type, routed.name, routed.arg], ["command", "mute", "30m"]);
  assert.equal(discordUpdate(bot, "INTERACTION_CREATE", { type: 2, id, channel_id: bot.channel,
    member: { user: { id } }, data: { name: "status" } }), null, "only the owner");
});

test("gateway: Playing status on identify, updates on change, resumes after a drop", async () => {
  const sockets = [];
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    constructor(url) { super(); this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close(code = 1000) { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code })); }
    emit(packet) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(packet) })); }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  const updates = [];
  const ready = [];
  const link = connectDiscord(bot, async (update) => updates.push(update), (error) => { throw error; },
    { activity: "AI Forge", onReady: (info) => ready.push(info) });
  try {
    const first = sockets[0];
    first.emit({ op: 10, d: { heartbeat_interval: 60_000 } });
    assert.equal(first.sent[0].op, 2);
    assert.deepEqual(first.sent[0].d.presence.activities, [{ name: "AI Forge", type: 0 }]);
    first.emit({ op: 0, s: 1, t: "READY", d: { session_id: "s1", resume_gateway_url: "wss://resume.test", application: { id } } });
    assert.deepEqual(ready, [{ applicationId: id }]);
    link.setActivity("AI Forge · в работе: 2");
    link.setActivity("AI Forge · в работе: 2");
    assert.deepEqual(first.sent.filter((p) => p.op === 3).map((p) => p.d.activities[0].name), ["AI Forge · в работе: 2"]);
    first.emit({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id, channel_id: bot.channel, author: { id: bot.owner }, content: "привет" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(updates[0].message.text, "привет");
    first.close(1006);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    const second = sockets[1];
    assert.match(second.url, /^wss:\/\/resume\.test/);
    second.emit({ op: 10, d: { heartbeat_interval: 60_000 } });
    assert.deepEqual([second.sent[0].op, second.sent[0].d.seq], [6, 2]);
    second.emit({ op: 0, s: 3, t: "RESUMED", d: {} });
    assert.equal(second.sent.at(-1).op, 3, "presence restored after resume");
  } finally {
    link.close();
    globalThis.WebSocket = original;
  }
});

test("Playing status counts sessions with a turn in progress, children and headless runs included", () => {
  const now = 10 * 3600_000;
  const settings = resolveSettings({}, {});
  const state = {
    meta: { turns: { app: now - 60_000, child: now - 5_000, stale: now - 4 * 3600_000, gone: now } },
    sessions: { app: {}, child: { parent: "app" }, stale: {}, gone: { ended: true }, worker: { headless: true, run: { pid: 1 } }, idle: { headless: true } },
  };
  assert.equal(discordActivity(settings, { sessions: {}, meta: {} }, now), "AI Forge");
  assert.equal(discordActivity(settings, state, now), "AI Forge · в работе: 3");
  assert.equal(discordActivity(resolveSettings({ discordActivity: "" }, {}), state, now), "");
});

test("gateway: without the Message Content intent it reconnects for buttons, commands and status", async () => {
  const sockets = [];
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    constructor(url) { super(); this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close(code = 1000) { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code })); }
    emit(packet) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(packet) })); }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  const errors = [];
  const link = connectDiscord(bot, async () => {}, (error) => errors.push(error.message));
  try {
    sockets[0].emit({ op: 10, d: { heartbeat_interval: 60_000 } });
    assert.equal(sockets[0].sent[0].d.intents, 1 | 512 | 32768);
    sockets[0].close(4014);
    await new Promise((resolve) => setTimeout(resolve, 10));
    sockets[1].emit({ op: 10, d: { heartbeat_interval: 60_000 } });
    assert.deepEqual([sockets[1].sent[0].op, sockets[1].sent[0].d.intents], [2, 1 | 512]);
    assert.match(errors[0], /кнопки, команды и статус работают/);
    sockets[1].close(4014);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sockets.length, 2, "a second 4014 stops");
  } finally {
    link.close();
    globalThis.WebSocket = original;
  }
  assert.equal(discordUpdate(bot, "MESSAGE_CREATE", { id, channel_id: bot.channel, author: { id: bot.owner }, content: "" }), null);
});

test("a press gets a reply only the owner sees, like Telegram's toast", async (t) => {
  const posts = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    posts.push([new URL(url).pathname, JSON.parse(options.body)]);
    return Response.json({ id });
  });
  const press = discordUpdate(bot, "INTERACTION_CREATE", { type: 3, id, application_id: thread, token: "tok-1",
    channel_id: bot.channel, member: { user: { id: bot.owner } }, message: { id, content: "?", components: [] },
    data: { custom_id: "u:yes" } });
  await discordCall(bot, "answerCallbackQuery", { callback_query_id: press.callback_query.id, text: "Передано в сессию" });
  await discordCall(bot, "answerCallbackQuery", { callback_query_id: press.callback_query.id });
  assert.deepEqual(posts, [[`/api/v10/webhooks/${thread}/tok-1`,
    { content: "Передано в сессию", flags: 64, allowed_mentions: { parse: [], replied_user: false } }]]);
});

test("Discord is quiet by default and pings the owner only when they are needed", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ id });
  });
  await discordCall(bot, "sendMessage", { text: "Ход завершён" });
  await discordCall(bot, "sendMessage", { text: "Нужен ваш ответ", ping: true });
  await discordCall(bot, "sendMessage", { text: "Ночью", ping: true, disable_notification: true });
  assert.deepEqual(bodies.map((b) => b.flags), [4100, 4, 4100]);
  assert.equal(bodies[0].content, "Ход завершён");
  assert.deepEqual(bodies[0].allowed_mentions.parse, []);
  assert.equal(bodies[1].content, `<@${bot.owner}> Нужен ваш ответ`);
  assert.deepEqual(bodies[1].allowed_mentions.users, [bot.owner]);
  assert.match(bodies[2].content, /^<@\d+> Ночью/, "quiet hours: mention without a sound");
});

test("an approval pressed in Discord says Discord, not Telegram", async () => {
  const { OUTCOME_TEXT } = await import("../skills/telegram-action-notifier/scripts/lib/bridge.mjs");
  assert.match(OUTCOME_TEXT["allow-discord"], /Discord/);
  assert.match(OUTCOME_TEXT["deny-discord"], /Discord/);
});

test("a ping is removed once the question is settled, text and buttons stay", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push([options.method, new URL(url).pathname, options.body ? JSON.parse(options.body) : null]);
    if (options.method === "GET") return Response.json({ id, content: `<@${bot.owner}> 🔔 Need you` });
    return Response.json({ id });
  });
  await discordCall(bot, "removeOwnerMention", { message_id: `${thread}:${id}` });
  assert.deepEqual(calls[1], ["PATCH", `/api/v10/channels/${thread}/messages/${id}`,
    { content: "🔔 Need you", allowed_mentions: { parse: [], replied_user: false } }]);
  calls.length = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(options.method);
    return Response.json({ id, content: "no ping here" });
  });
  await discordCall(bot, "removeOwnerMention", { message_id: `${thread}:${id}` });
  assert.deepEqual(calls, ["GET"], "nothing to remove");
});

test("an action answered in the app is kept for the daemon to unping", async () => {
  const { resolvePendingIn } = await import("../skills/telegram-action-notifier/scripts/lib/bridge.mjs");
  const state = { pending: {
    a: { id: "a", sessionId: "s", kind: "action", sent: true, messageIds: [5], createdAt: 1 },
    b: { id: "b", sessionId: "s", kind: "action", sent: false, createdAt: 2 },
  } };
  assert.equal(resolvePendingIn(state, "s", { kinds: ["action"], edit: false }), 1);
  assert.deepEqual([state.pending.a.resolved, state.pending.a.keepText, state.pending.b], [true, true, undefined]);
});
