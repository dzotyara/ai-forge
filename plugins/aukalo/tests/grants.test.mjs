import "./lang-ru.mjs";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { isolatedHome, mockTelegram } from "./helpers.mjs";

const env = isolatedHome({ chatId: "-100777", extra: { ownerUserId: "55" } });
process.env.CLAUDE_PLUGIN_ROOT = "/plugins/telegram-action-notifier";
delete process.env.TELEGRAM_BRIDGE_HEADLESS;
mkdirSync(env.state, { recursive: true });
writeFileSync(path.join(env.state, "daemon.pid"), String(process.pid)); // no real daemon

const grants = await import("../skills/telegram-action-notifier/scripts/lib/grants.mjs");
const bridge = await import("../skills/telegram-action-notifier/scripts/lib/bridge.mjs");
const entry = await import("../skills/telegram-action-notifier/scripts/telegram-action-notifier.mjs");

const CWD = process.cwd();
const config = (patch) => {
  const file = path.join(env.dir, "config.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));
};
const denied = (input = { command: "git push --force origin main", description: "Force-push main" }) => ({
  hook_event_name: "PermissionDenied",
  session_id: "s-deny",
  cwd: CWD,
  tool_name: "Bash",
  tool_input: input,
  tool_use_id: "toolu_1",
  reason: "[Git Destructive]",
});
const pre = (input) => ({ hook_event_name: "PreToolUse", session_id: "s-deny", cwd: CWD, tool_name: "Bash", tool_input: input });

async function capture(fn) {
  let out = "";
  const write = process.stdout.write;
  // The hooks write strings; the test runner's own reports are binary chunks: pass those through.
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk === "string") {
      out += chunk;
      return true;
    }
    return write.call(this, chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = write;
  }
  return out;
}

/** A Telegram mock where the owner presses the given button a moment after the message goes out. */
function ownerPresses(choice, sent) {
  return mockTelegram((method, params) => {
    if (method === "sendMessage") {
      sent.push(params);
      const data = params.reply_markup.inline_keyboard[0][choice === "allow" ? 0 : 1].callback_data;
      const requestId = /^p:([0-9a-f]{16}):(allow|deny)$/.exec(data)[1];
      setTimeout(() => writeFileSync(path.join(env.state, "approvals", `${requestId}.res.json`), JSON.stringify({ behavior: choice })), 50);
      return { message_id: 7 };
    }
    return true;
  });
}

test("grant key: same call matches, description ignored, key order ignored", () => {
  const a = grants.grantKey("s", "Bash", { command: "x", timeout: 5, description: "one" });
  assert.equal(a, grants.grantKey("s", "Bash", { timeout: 5, command: "x", description: "two" }));
  assert.notEqual(a, grants.grantKey("s", "Bash", { command: "y", timeout: 5 }));
  assert.notEqual(a, grants.grantKey("other", "Bash", { command: "x", timeout: 5 }));
  assert.equal(grants.isNoVerdict("Auto mode could not evaluate this action and is blocking it for safety"), true);
  assert.equal(grants.isNoVerdict("[Data Exfiltration]"), false);
});

test("grants are one-time and expire", async () => {
  const now = 1_000_000;
  await grants.addGrant("s1", "Bash", { command: "ls" }, { now });
  assert.equal(await grants.takeGrant("s1", "Bash", { command: "rm" }, { now }), false);
  assert.equal(await grants.takeGrant("s1", "Bash", { command: "ls" }, { now }), true);
  assert.equal(await grants.takeGrant("s1", "Bash", { command: "ls" }, { now }), false, "used up");
  await grants.addGrant("s1", "Bash", { command: "ls" }, { now });
  assert.equal(await grants.takeGrant("s1", "Bash", { command: "ls" }, { now: now + grants.GRANT_TTL_MS + 1 }), false, "expired");
});

test("denied call message shows the exact command, redacted", () => {
  const html = grants.deniedCallHtml(denied({ command: "curl -H 'token=abc123secret' https://x.example", description: "<b>" }));
  assert.match(html, /Авто-режим заблокировал действие<\/b>: \[Git Destructive\]/);
  assert.match(html, /<pre>curl -H/);
  assert.doesNotMatch(html, /abc123secret/);
  assert.match(html, /&lt;b&gt;/);
  assert.deepEqual(grants.grantKeyboard("0123456789abcdef").inline_keyboard[0].map((b) => b.callback_data), [
    "p:0123456789abcdef:allow",
    "p:0123456789abcdef:deny",
  ]);
});

test("PermissionDenied: «Разрешить один раз» → retry, then PreToolUse allows exactly that call once", async () => {
  const sent = [];
  const tg = ownerPresses("allow", sent);
  let out;
  try {
    out = await capture(() => entry.handleEvent(denied()));
  } finally {
    tg.restore();
  }
  assert.deepEqual(JSON.parse(out), { hookSpecificOutput: { hookEventName: "PermissionDenied", retry: true } });
  assert.match(sent[0].text, /git push --force origin main/);

  // A different call gets nothing; the identical retry (reworded description) is allowed once.
  assert.equal(await capture(() => entry.handleEvent(pre({ command: "git push origin main" }))), "");
  const allowed = JSON.parse(await capture(() => entry.handleEvent(pre({ command: "git push --force origin main", description: "retry" }))));
  assert.equal(allowed.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(await capture(() => entry.handleEvent(pre({ command: "git push --force origin main" }))), "", "one time only");
});

test("PermissionDenied: «Нет» keeps the denial and stores no grant", async () => {
  const sent = [];
  const tg = ownerPresses("deny", sent);
  let out;
  try {
    out = await capture(() => entry.handleEvent(denied({ command: "rm -rf build" })));
  } finally {
    tg.restore();
  }
  assert.equal(out, "");
  assert.equal(await capture(() => entry.handleEvent(pre({ command: "rm -rf build" }))), "");
});

test("PermissionDenied: skipped for no-verdict denials, muted sessions and telegramDenials false", async () => {
  const tg = mockTelegram(() => ({ message_id: 1 }));
  try {
    await entry.handleEvent({ ...denied(), reason: "Auto mode could not evaluate this action and is blocking it for safety" });
    config({ telegramDenials: false });
    await entry.handleEvent(denied());
    config({ telegramDenials: undefined });
    await bridge.updateState((state) => { state.sessions["s-deny"] = { title: "t", muted: true, updatedAt: Date.now() }; });
    await entry.handleEvent(denied());
    assert.equal(tg.calls.filter((c) => c.method === "sendMessage").length, 0);
  } finally {
    tg.restore();
    await bridge.updateState((state) => { delete state.sessions["s-deny"]; });
  }
});
