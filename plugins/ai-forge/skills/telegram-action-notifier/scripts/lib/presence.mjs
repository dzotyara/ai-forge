// Smart delivery: is the user at the Mac, and what to do with an event.
import { execFile } from "node:child_process";
import process from "node:process";

import { isQuietTime } from "./common.mjs";

export function parseHidIdleSeconds(output) {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(output ?? ""));
  if (!match) return null;
  return Number(BigInt(match[1]) / 1_000_000n) / 1000; // nanoseconds -> seconds
}

/** macOS adds CGSSessionScreenIsLocked to IOConsoleUsers only while the screen is locked. */
export function parseScreenLocked(output) {
  const text = String(output ?? "");
  if (/CGSSessionScreenIsLocked"?\s*=\s*(?:Yes|1|true)/i.test(text)) return true;
  return /"kCGSSessionOnConsoleKey"\s*=\s*No/.test(text); // switched to another user
}

export function parseFrontApp(output) {
  const match = /"LSDisplayName"\s*=\s*"([^"]*)"/.exec(String(output ?? ""));
  return match ? match[1] : null;
}

function run(file, args, timeout = 1500) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

const AWAY = (reason) => ({ present: false, idleSec: null, locked: null, frontApp: null, reason });

/**
 * Presence on macOS: present = idle < threshold and screen not locked.
 * Codex, other platforms and any error count as "away" (always deliver).
 */
export async function detectPresence({
  idleThresholdSec = 120,
  platform = process.platform,
  claude = true,
  exec = run,
} = {}) {
  if (!claude) return AWAY("codex");
  const forced = process.env.TELEGRAM_NOTIFIER_PRESENCE; // "present" | "away": tests and debugging
  if (forced === "present" || forced === "away") {
    return { present: forced === "present", idleSec: null, locked: false, frontApp: null, reason: `forced-${forced}` };
  }
  if (platform !== "darwin") return AWAY("platform");
  try {
    const [hid, root] = await Promise.all([
      exec("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"]),
      exec("/usr/sbin/ioreg", ["-n", "Root", "-d", "1"]),
    ]);
    const idleSec = parseHidIdleSeconds(hid);
    if (idleSec == null) return AWAY("no-idle");
    const locked = parseScreenLocked(root);
    let frontApp = null;
    try {
      const front = (await exec("/usr/bin/lsappinfo", ["front"])).trim();
      if (front) frontApp = parseFrontApp(await exec("/usr/bin/lsappinfo", ["info", "-only", "name", front]));
    } catch {
      // Informational only.
    }
    const present = !locked && idleSec < idleThresholdSec;
    return { present, idleSec, locked, frontApp, reason: locked ? "locked" : present ? "active" : "idle" };
  } catch {
    return AWAY("error");
  }
}

/** Effective delivery mode: a temporary override from bot commands beats the config. */
export function effectiveMode(settings, meta = {}, now = Date.now()) {
  const override = meta.override;
  const overrideActive = override && (!override.until || override.until > now);
  const muteUntil = meta.muteUntil && meta.muteUntil > now ? meta.muteUntil : null;
  return {
    mode: overrideActive ? override.mode : settings.deliveryMode,
    overridden: Boolean(overrideActive),
    overrideUntil: overrideActive ? override.until ?? null : null,
    muteUntil,
  };
}

/**
 * What to do with an outbound event.
 *   kind: "approval" | "action" (blocking stop) | "turn" (ordinary turn finished)
 *   presence: { present }; viaTelegram: this turn was started from Telegram
 *   (session.replyToTelegram), so its reply goes there even if the user is present.
 * Returns { action: "send" | "delay" | "skip", delaySec, silent }.
 */
export function decideDelivery({
  kind,
  presence = { present: false },
  mode = "smart",
  muteUntil = null,
  quietHours = null,
  now = Date.now(),
  notify = "all",
  approvalGraceSec = 90,
  actionGraceSec = 180,
  viaTelegram = false,
}) {
  const skip = { action: "skip", delaySec: 0, silent: true };
  if (mode === "never" || (muteUntil && muteUntil > now)) return skip;
  if (kind === "turn" && notify !== "all") return skip;
  const away = mode === "always" || !presence?.present || viaTelegram;
  const quiet = isQuietTime(quietHours, new Date(now));
  if (kind === "turn") return away ? { action: "send", delaySec: 0, silent: true } : skip;
  if (away) return { action: "send", delaySec: 0, silent: quiet };
  return {
    action: "delay",
    delaySec: kind === "approval" ? approvalGraceSec : actionGraceSec,
    silent: quiet,
  };
}

/**
 * Daemon tick for one queued item. Sends on the grace deadline or as soon as
 * the user is away (catch-up); resolved items get edited or dropped.
 * Returns "send" | "wait" | "edit-resolved" | "drop".
 */
export function pendingAction(item, { present, mode = "smart", muteUntil = null, now = Date.now() }) {
  if (item.resolved) return item.sent ? "edit-resolved" : "drop";
  if (item.hold) return "wait"; // its hook sends it itself
  if (now - (item.createdAt ?? now) > 24 * 3600_000) return "drop";
  if (item.sent) return "wait";
  if (mode === "never" || (muteUntil && muteUntil > now)) return "drop";
  if (mode === "always" || !present || now >= item.dueAt) return "send";
  return "wait";
}

/** Parse "/mute 1h", "30m", "90 мин", "off". Returns ms, 0 for off, or null. */
export function parseMuteDuration(arg) {
  const text = String(arg ?? "").trim().toLowerCase();
  if (!text) return 3600_000;
  if (/^(off|выкл|нет|0)$/.test(text)) return 0;
  const match = /^(\d{1,4})\s*(m|min|мин|м|h|ч|час|часа|часов)?$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  const hours = /^(h|ч|час)/.test(match[2] ?? "h");
  const ms = value * (hours ? 3600_000 : 60_000);
  return ms > 0 && ms <= 7 * 86_400_000 ? ms : null;
}
