import "./lang-en.mjs";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { isolatedHome } from "./helpers.mjs";

const env = isolatedHome({ chatId: "-1001234567890", extra: { ownerUserId: "55" } });
process.env.CLAUDE_PLUGIN_ROOT = "/plugins/ai-forge";
mkdirSync(env.state, { recursive: true });
writeFileSync(path.join(env.state, "daemon.pid"), String(process.pid));

const bridge = await import("../skills/telegram-action-notifier/scripts/lib/bridge.mjs");
const entry = await import("../skills/telegram-action-notifier/scripts/telegram-action-notifier.mjs");

async function capture(fn) {
  let out = "";
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk === "string") { out += chunk; return true; }
    return write.call(this, chunk, ...rest);
  };
  try { await fn(); } finally { process.stdout.write = write; }
  return out;
}
const pre = (tool_name, tool_input) => ({ hook_event_name: "PreToolUse", session_id: "s-confirm", cwd: "/tmp", tool_name, tool_input });

test("confirm-next forces a permission prompt for the next call only", async () => {
  await bridge.updateState((s) => { s.sessions["s-confirm"] = { title: "t", confirmNext: { what: "Send the draft to Elimir", at: Date.now() } }; });
  // The arming call itself passes through.
  assert.equal(await capture(() => entry.handleEvent(pre("Bash", { command: "node x.mjs confirm-next \"Send\"" }))), "");
  const out = JSON.parse(await capture(() => entry.handleEvent(pre("mcp__slack__send_message", { text: "hi" }))));
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Send the draft to Elimir/);
  assert.equal(await capture(() => entry.handleEvent(pre("mcp__slack__send_message", { text: "hi" }))), "", "one call only");
  assert.ok((await bridge.readState()).sessions["s-confirm"].confirmWhat, "kept for the permission message");
});

test("an old confirm-next expires", async () => {
  await bridge.updateState((s) => { s.sessions["s-confirm"].confirmNext = { what: "x", at: Date.now() - 20 * 60_000 }; });
  assert.equal(await capture(() => entry.handleEvent(pre("Bash", { command: "ls" }))), "");
});
