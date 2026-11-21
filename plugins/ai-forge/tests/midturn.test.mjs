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
const entry = await import("../skills/telegram-action-notifier/scripts/telegram-action-notifier.mjs");
mkdirSync(env.state, { recursive: true });
writeFileSync(path.join(env.state, "daemon.pid"), String(process.pid));

async function postToolUse(sessionId, extra = {}) {
  let out = "";
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk === "string") { out += chunk; return true; }
    return write.call(this, chunk, ...rest);
  };
  try {
    await entry.handleEvent({ hook_event_name: "PostToolUse", session_id: sessionId, tool_name: "Bash", ...extra });
  } finally {
    process.stdout.write = write;
  }
  return out;
}

test("PostToolUse prints nothing when no chat message is waiting", async () => {
  await bridge.updateState((state) => { state.sessions.busy0 = { title: "Busy", topicId: 7 }; });
  assert.equal(await postToolUse("busy0"), "");
});

test("a chat message reaches a busy session at its next tool call", async () => {
  const tg = mockTelegram(() => true);
  try {
    await bridge.updateState((state) => { state.sessions.busy1 = { title: "DarkBox", topicId: 9 }; });
    await bridge.appendInbox("busy1", { text: "датадог не заработал опять?", messageId: 501, at: Date.now() });

    const out = await postToolUse("busy1");
    const parsed = JSON.parse(out);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
    const context = parsed.hookSpecificOutput.additionalContext;
    assert.match(context, /Пока вы работали/);
    assert.match(context, new RegExp(`${bridge.REPLY_PREFIX} датадог не заработал опять\\?`));

    // Taken once: the next tool call has nothing left, the waiter will not repeat it.
    assert.deepEqual(await bridge.takeInbox("busy1"), []);
    assert.equal(await postToolUse("busy1"), "");

    const state = await bridge.readState();
    assert.equal(state.sessions.busy1.replyToTelegram, true, "the turn answers in the chat");
    const reaction = tg.calls.find((c) => c.method === "setMessageReaction");
    assert.equal(reaction?.params.message_id, 501);
  } finally {
    tg.restore();
  }
});

test("Codex sessions keep the old behaviour: no mid-turn delivery", async () => {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.CLAUDE_PLUGIN_ROOT;
  try {
    await bridge.updateState((state) => { state.sessions.cx1 = { title: "Codex", host: "Codex" }; });
    await bridge.appendInbox("cx1", { text: "ping", messageId: 1, at: Date.now() });
    assert.equal(await postToolUse("cx1"), "");
    assert.equal((await bridge.takeInbox("cx1")).length, 1);
  } finally {
    process.env.CLAUDE_PLUGIN_ROOT = root;
  }
});

test("a subagent's tool call leaves the message for the main agent", async () => {
  const tg = mockTelegram(() => true);
  try {
    await bridge.updateState((state) => { state.sessions.sub1 = { title: "Parent", topicId: 11 }; });
    await bridge.appendInbox("sub1", { text: "для основного агента", messageId: 7, at: Date.now() });
    assert.equal(await postToolUse("sub1", { agent_id: "a1", agent_type: "Explore" }), "");
    assert.match(JSON.parse(await postToolUse("sub1")).hookSpecificOutput.additionalContext, /для основного агента/);
  } finally {
    tg.restore();
  }
});
