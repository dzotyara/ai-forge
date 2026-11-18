import assert from "node:assert/strict";
import test from "node:test";

import { resolveSettings } from "../skills/telegram-action-notifier/scripts/lib/common.mjs";
import {
  decideDelivery,
  detectPresence,
  effectiveMode,
  parseFrontApp,
  parseHidIdleSeconds,
  parseMuteDuration,
  parseScreenLocked,
  pendingAction,
} from "../skills/telegram-action-notifier/scripts/lib/presence.mjs";

const IOREG_HID = `
+-o IOHIDSystem  <class IOHIDSystem, id 0x100000abc>
    | |   "HIDIdleTime" = 12198891791
    | |     "HIDIdleTime" = 99999999999
`;

test("parses HIDIdleTime nanoseconds into seconds (first match)", () => {
  assert.equal(parseHidIdleSeconds(IOREG_HID), 12.198);
  assert.equal(parseHidIdleSeconds("nothing here"), null);
});

test("detects a locked screen or a switched-away console session", () => {
  assert.equal(parseScreenLocked('"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"CGSSessionScreenIsLocked"=Yes})'), true);
  assert.equal(parseScreenLocked('"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes})'), false);
  assert.equal(parseScreenLocked('"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=No})'), true);
  assert.equal(parseFrontApp('"LSDisplayName"="Claude"'), "Claude");
});

function fakeExec({ idleNs = 5_000_000_000, locked = false, fail = false } = {}) {
  return async (file, args) => {
    if (fail) throw new Error("boom");
    if (file.endsWith("ioreg") && args.includes("IOHIDSystem")) return `"HIDIdleTime" = ${idleNs}`;
    if (file.endsWith("ioreg")) return locked ? '"CGSSessionScreenIsLocked"=Yes' : '"kCGSSessionOnConsoleKey"=Yes';
    if (args[0] === "front") return "ASN:0x0-0x1234:";
    return '"LSDisplayName"="Claude"';
  };
}

test("presence: active, idle, locked, error, other platform, Codex", async () => {
  const base = { platform: "darwin", idleThresholdSec: 120, claude: true };
  const active = await detectPresence({ ...base, exec: fakeExec() });
  assert.equal(active.present, true);
  assert.equal(active.frontApp, "Claude");
  assert.equal((await detectPresence({ ...base, exec: fakeExec({ idleNs: 500e9 }) })).present, false);
  assert.equal((await detectPresence({ ...base, exec: fakeExec({ locked: true }) })).present, false);
  assert.equal((await detectPresence({ ...base, exec: fakeExec({ fail: true }) })).present, false);
  assert.equal((await detectPresence({ ...base, platform: "linux", exec: fakeExec() })).present, false);
  assert.equal((await detectPresence({ ...base, claude: false, exec: fakeExec() })).present, false);
});

const NOW = new Date(2026, 10, 6, 14, 0).getTime();
const NIGHT = new Date(2026, 10, 6, 23, 30).getTime();
const here = { present: true };
const away = { present: false };

const cases = [
  // [name, input, expected]
  ["approval, away -> send now", { kind: "approval", presence: away }, { action: "send", silent: false }],
  ["approval, present -> grace", { kind: "approval", presence: here }, { action: "delay", delaySec: 90 }],
  ["action, away -> send now", { kind: "action", presence: away }, { action: "send", silent: false }],
  ["action, present -> grace", { kind: "action", presence: here }, { action: "delay", delaySec: 180 }],
  ["turn, away -> silent post", { kind: "turn", presence: away }, { action: "send", silent: true }],
  ["turn, present -> nothing", { kind: "turn", presence: here }, { action: "skip" }],
  ["turn while chatting from Telegram", { kind: "turn", presence: here, viaTelegram: true }, { action: "send", silent: true }],
  ["turn with notify=action", { kind: "turn", presence: away, notify: "action" }, { action: "skip" }],
  ["mode always ignores presence", { kind: "action", presence: here, mode: "always" }, { action: "send" }],
  ["mode never", { kind: "approval", presence: away, mode: "never" }, { action: "skip" }],
  ["mute active", { kind: "approval", presence: away, muteUntil: NOW + 60_000 }, { action: "skip" }],
  ["mute expired", { kind: "approval", presence: away, muteUntil: NOW - 1 }, { action: "send" }],
  ["quiet hours -> silent", { kind: "action", presence: away, quietHours: { from: "23:00", to: "08:00" }, now: NIGHT }, { action: "send", silent: true }],
  ["custom grace", { kind: "approval", presence: here, approvalGraceSec: 30 }, { action: "delay", delaySec: 30 }],
];

for (const [name, input, expected] of cases) {
  test(`decideDelivery: ${name}`, () => {
    const result = decideDelivery({ now: NOW, ...input });
    for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value, key);
  });
}

test("pendingAction: grace timer, catch-up on leaving, resolution", () => {
  const item = { createdAt: NOW, dueAt: NOW + 90_000, sent: false };
  assert.equal(pendingAction(item, { present: true, now: NOW + 10_000 }), "wait");
  // present -> away transition before the deadline: send right away (catch-up)
  assert.equal(pendingAction(item, { present: false, now: NOW + 10_000 }), "send");
  assert.equal(pendingAction(item, { present: true, now: NOW + 90_000 }), "send");
  assert.equal(pendingAction({ ...item, sent: true }, { present: false, now: NOW }), "wait");
  assert.equal(pendingAction({ ...item, resolved: true }, { present: false, now: NOW }), "drop");
  assert.equal(pendingAction({ ...item, sent: true, resolved: true }, { present: true, now: NOW }), "edit-resolved");
  assert.equal(pendingAction(item, { present: true, mode: "always", now: NOW }), "send");
  assert.equal(pendingAction(item, { present: false, mode: "never", now: NOW }), "drop");
  assert.equal(pendingAction(item, { present: false, muteUntil: NOW + 1, now: NOW }), "drop");
  assert.equal(pendingAction(item, { present: true, now: NOW + 25 * 3600_000 }), "drop");
});

test("parseMuteDuration", () => {
  assert.equal(parseMuteDuration("1h"), 3600_000);
  assert.equal(parseMuteDuration("30m"), 1800_000);
  assert.equal(parseMuteDuration("90 мин"), 5400_000);
  assert.equal(parseMuteDuration("2ч"), 7200_000);
  assert.equal(parseMuteDuration(""), 3600_000);
  assert.equal(parseMuteDuration("off"), 0);
  assert.equal(parseMuteDuration("soon"), null);
});

test("effectiveMode: override until expiry, then config", () => {
  const settings = { deliveryMode: "smart" };
  const meta = { override: { mode: "always", until: NOW + 1000 }, muteUntil: NOW + 5000 };
  assert.deepEqual(effectiveMode(settings, meta, NOW), { mode: "always", overridden: true, overrideUntil: NOW + 1000, muteUntil: NOW + 5000 });
  assert.equal(effectiveMode(settings, meta, NOW + 10_000).mode, "smart");
  assert.equal(effectiveMode(settings, meta, NOW + 10_000).muteUntil, null);
});

test("settings defaults and the Codex-vs-Claude switch", () => {
  const claude = resolveSettings({}, { CLAUDE_PLUGIN_ROOT: "/x" });
  assert.equal(claude.notify, "all");
  assert.equal(claude.deliveryMode, "smart");
  assert.equal(claude.approvalWaitSec, 12 * 3600 - 300);
  assert.equal(claude.presenceIdleSec, 120);
  assert.equal(claude.approvalGraceSec, 90);
  assert.equal(claude.actionGraceSec, 180);
  assert.equal(claude.chatReplies, true);
  const codex = resolveSettings({ notify: "all" }, {});
  assert.equal(codex.notify, "action");
  assert.equal(resolveSettings({ approvalWaitSec: 999_999 }, {}).approvalWaitSec, 12 * 3600 - 300);
  assert.equal(resolveSettings({ approvalWaitSec: 0 }, {}).approvalWaitSec, 0);
  assert.equal(resolveSettings({ approvalWaitSec: null }, {}).approvalWaitSec, 12 * 3600 - 300);
  assert.equal(resolveSettings({ quietHours: { from: "25:00", to: "08:00" } }, {}).quietHours, null);
});
