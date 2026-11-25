// Auto-mode denials approved from Telegram.
//
// When the auto-mode classifier blocks a tool call, the PermissionDenied hook
// shows the exact call in Telegram. If the owner presses «Разрешить один раз»,
// a one-time grant is stored for that session + tool + input, and the hook
// tells the model it may retry. The PreToolUse hook then approves exactly that
// retry and consumes the grant. Any other call, or the same call later, goes
// through the classifier as usual.

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { stateDir } from "./bridge.mjs";
import { redactSecrets } from "./common.mjs";
import { escapeHtml, shortenPaths, truncateText } from "./format.mjs";
import { L } from "./i18n.mjs";

export const GRANT_TTL_MS = 30 * 60_000;
const grantsFile = () => path.join(stateDir(), "grants.json");

/** Denials with no classifier verdict: Claude Code ignores `retry` for them. */
export function isNoVerdict(reason) {
  return /^Auto mode could not evaluate this action/i.test(String(reason ?? ""));
}

/** Canonical JSON (sorted keys) of a tool input; `description` is free text the model may reword on retry. */
export function canonicalInput(input) {
  const sort = (value) => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
    }
    return value;
  };
  const { description, ...rest } = input && typeof input === "object" ? input : {};
  return JSON.stringify(sort(rest));
}

export function grantKey(sessionId, toolName, input) {
  return createHash("sha256").update(`${sessionId}\n${toolName}\n${canonicalInput(input)}`).digest("hex");
}

async function readGrants() {
  try {
    const value = JSON.parse(await fsp.readFile(grantsFile(), "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

async function writeGrants(grants, now) {
  const live = Object.fromEntries(Object.entries(grants).filter(([, g]) => g.expiresAt > now));
  if (!Object.keys(live).length) {
    await fsp.rm(grantsFile(), { force: true });
    return;
  }
  await fsp.mkdir(stateDir(), { recursive: true, mode: 0o700 });
  const tmp = `${grantsFile()}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(live), { mode: 0o600 });
  await fsp.rename(tmp, grantsFile());
}

export async function addGrant(sessionId, toolName, input, { now = Date.now() } = {}) {
  const grants = await readGrants();
  grants[grantKey(sessionId, toolName, input)] = { sessionId, toolName, at: now, expiresAt: now + GRANT_TTL_MS };
  await writeGrants(grants, now);
}

/** True once for a granted call; the grant is used up. */
export async function takeGrant(sessionId, toolName, input, { now = Date.now() } = {}) {
  const grants = await readGrants();
  if (!Object.keys(grants).length) return false;
  const key = grantKey(sessionId, toolName, input);
  const hit = grants[key] && grants[key].expiresAt > now;
  delete grants[key];
  await writeGrants(grants, now);
  return Boolean(hit);
}

/** What exactly the owner approves: the command or the tool input, redacted and shortened. */
export function deniedCallHtml(event) {
  const tool = typeof event?.tool_name === "string" && event.tool_name ? event.tool_name : "unknown tool";
  const input = event?.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};
  const clean = (text, max) => escapeHtml(truncateText(shortenPaths(redactSecrets(String(text)), event?.cwd), max));
  const reason = String(event?.reason ?? "").trim();
  const lines = [`🛡 <b>${L("Авто-режим заблокировал действие", "Auto mode blocked an action")}</b>${reason ? `: ${clean(reason, 200)}` : ""}`];
  lines.push(`${L("Инструмент", "Tool")}: <code>${escapeHtml(tool)}</code>`);
  if (typeof input.description === "string" && input.description.trim()) {
    lines.push(`<blockquote>${clean(input.description.trim(), 300)}</blockquote>`);
  }
  if (typeof input.command === "string") lines.push(`<pre>${clean(input.command, 1500)}</pre>`);
  else {
    const { description, ...rest } = input;
    if (Object.keys(rest).length) lines.push(`<pre>${clean(JSON.stringify(rest, null, 1), 1500)}</pre>`);
  }
  lines.push(L(
    "<i>«Разрешить один раз» — сессия повторит именно это действие, и оно пройдёт без проверки авто-режима.</i>",
    "<i>“Allow once”: the session repeats exactly this action, and it skips the auto mode check.</i>",
  ));
  return lines.join("\n");
}

export function grantKeyboard(requestId) {
  return {
    inline_keyboard: [[
      { text: L("✅ Разрешить один раз", "✅ Allow once"), callback_data: `p:${requestId}:allow`, style: "success" },
      { text: L("❌ Нет", "❌ No"), callback_data: `p:${requestId}:deny`, style: "danger" },
    ]],
  };
}
