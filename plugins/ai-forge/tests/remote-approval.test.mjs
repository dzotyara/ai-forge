import "./lang-en.mjs";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { isolatedHome } from "./helpers.mjs";

const owner = "123456789012345611", general = "123456789012345612", guild = "123456789012345613", category = "123456789012345614";
const env = isolatedHome({ chatId: "-1001234567890", extra: { ownerUserId: "55", notificationTarget: "both",
  discordToken: "fake.discord.token", discordChannel: general, discordOwner: owner, discordGuild: guild, discordCategory: category } });
delete process.env.CLAUDE_PLUGIN_ROOT; // a Codex hook
process.env.TELEGRAM_BRIDGE_HEADLESS = "1";
mkdirSync(env.state, { recursive: true });
writeFileSync(path.join(env.state, "daemon.pid"), String(process.pid));

const { discordCall, remoteDecision, REMOTE_LINE } = await import("../skills/telegram-action-notifier/scripts/lib/discord.mjs");
const bridge = await import("../skills/telegram-action-notifier/scripts/lib/bridge.mjs");
const common = await import("../skills/telegram-action-notifier/scripts/lib/common.mjs");

const bot = { secret: "s", owner, channel: general };
const msg = "123456789012345615";

test("the daemon writes the owner's choice into a remote request, once", async (t) => {
  let content = `<@${owner}> 🔐 **Fix** · Codex\n\nPermission needed\n${REMOTE_LINE}`;
  const patches = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options.method === "GET") return Response.json({ id: msg, content });
    const body = JSON.parse(options.body);
    patches.push(body);
    content = body.content;
    return Response.json({ id: msg });
  });
  assert.deepEqual(await discordCall(bot, "recordRemoteDecision", { message_id: `${general}:${msg}`, behavior: "allow", outcome: "✅ <b>Allowed in Discord</b>" }), { ok: true });
  assert.equal(remoteDecision(content), "allow");
  assert.doesNotMatch(content, /<@/, "the ping is gone");
  assert.deepEqual(patches[0].components, [], "buttons are removed");
  assert.deepEqual(await discordCall(bot, "recordRemoteDecision", { message_id: `${general}:${msg}`, behavior: "deny" }), { ok: false }, "decided only once");
  content = "an ordinary message";
  assert.deepEqual(await discordCall(bot, "recordRemoteDecision", { message_id: `${general}:${msg}`, behavior: "allow" }), { ok: false });
});

test("a Codex hook sends the request to Discord only and reads the decision back", async (t) => {
  const posted = [];
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const u = new URL(String(url));
    if (u.host === "api.telegram.org") throw new Error("Telegram must not be used for a remote request");
    const route = u.pathname.replace("/api/v10", "");
    if (route === "/users/@me") return Response.json({ id: "123456789012345616" });
    if (route === `/guilds/${guild}/channels`) return Response.json({ id: "123456789012345617" });
    if (options.method === "POST" && route.endsWith("/messages")) {
      posted.push(JSON.parse(options.body));
      return Response.json({ id: msg });
    }
    if (options.method === "GET") {
      reads += 1;
      return Response.json({ id: msg, content: reads < 2 ? posted[0].content : `${posted[0].content}\n\n✅ Allowed\n-# ai-forge decision=allow` });
    }
    return Response.json({ id: msg });
  });
  const settings = await common.loadNotificationSettings();
  const ctx = { sessionId: "codex-1", title: "Fix", project: "app", cwd: "/tmp", host: "Codex" };
  const behavior = await bridge.requestApproval(settings, ctx, "🔐 <b>Fix</b>", 30, { remote: true, pollMs: 10, remotePollMs: 20 });
  assert.equal(behavior, "allow");
  assert.equal(posted.length, 1);
  assert.match(posted[0].content, /-# ai-forge remote$/m);
  assert.equal(posted[0].components[0].components[0].custom_id.startsWith("p:"), true);
});

test("a press on another device's request is recorded instead of 'Request already closed'", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const route = new URL(String(url)).pathname.replace("/api/v10", "");
    calls.push(`${options.method} ${route}`);
    if (options.method === "GET") return Response.json({ id: msg, content: `🔐 Fix\n${REMOTE_LINE}` });
    return Response.json({ id: msg });
  });
  const d = common.discordSettings(await common.loadNotificationSettings());
  const thread = "123456789012345618";
  await bridge.updateState((s) => { s.sessions["codex-2"] = { title: "Fix", discordTopic: { channel: general, id: thread, name: "Fix" } }; });
  const update = { callback_query: { id: `${"123456789012345619"}/tok`, data: "p:0011223344556677:allow", from: { id: owner },
    message: { chat: { id: general }, from: { id: owner }, message_id: `${thread}:${msg}`, message_thread_id: thread, is_topic_message: true, text: "x", reply_markup: { inline_keyboard: [] } } } };
  await bridge.handleUpdate({ ...d, notificationTarget: "both" }, update);
  assert.ok(calls.includes(`PATCH /channels/${thread}/messages/${msg}`), calls.join(", "));
  assert.ok(calls.some((c) => c.startsWith("POST /webhooks/")), "the press gets an answer");
});
