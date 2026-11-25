// Shared configuration, host detection and Telegram Bot API access.
import { openAsBlob } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { discordCall, discordId, uploadTimeoutMs } from "./discord.mjs";

// Claude Code exports CLAUDE_PLUGIN_ROOT to plugin hooks; Codex sets PLUGIN_ROOT.
export function isClaudeCode(env = process.env) {
  return Boolean(env.CLAUDE_PLUGIN_ROOT);
}

export function hostName(env = process.env) {
  return isClaudeCode(env) ? "Claude Code" : "Codex";
}

export function redactSecrets(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_BOT_TOKEN]")
    .replace(/\b[A-Za-z0-9_-]{23,30}\.[A-Za-z0-9_-]{6,8}\.[A-Za-z0-9_-]{25,}\b/g, "[REDACTED_DISCORD_TOKEN]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(
      /\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu,
      "$1=[REDACTED]",
    );
}

export function configurationPath(env = process.env) {
  const codexHome = env.CODEX_HOME?.trim();
  const base = codexHome || path.join(os.homedir(), ".codex");
  return path.join(base, "telegram-action-notifier", "config.json");
}

export async function readRawConfiguration() {
  try {
    const value = JSON.parse(await readFile(configurationPath(), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error("Could not read the Telegram notifier configuration.");
  }
}

/** Merge `patch` into the stored configuration; `undefined` values delete keys. */
export async function saveConfiguration(patch) {
  const current = await readRawConfiguration();
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  const file = configurationPath();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.platform !== "win32") await chmod(tmp, 0o600);
  await rename(tmp, file);
  return next;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseQuietHours(value) {
  if (!value || typeof value !== "object") return null;
  if (!TIME.test(value.from ?? "") || !TIME.test(value.to ?? "")) return null;
  if (value.from === value.to) return null;
  return { from: value.from, to: value.to };
}

export function isQuietTime(quietHours, now = new Date()) {
  const range = parseQuietHours(quietHours);
  if (!range) return false;
  const toMinutes = (text) => {
    const [h, m] = text.split(":").map(Number);
    return h * 60 + m;
  };
  const minute = now.getHours() * 60 + now.getMinutes();
  const from = toMinutes(range.from);
  const to = toMinutes(range.to);
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

// The PermissionRequest hook timeout in hooks.json is 43200 s; keep 5 minutes in reserve.
export const MAX_APPROVAL_WAIT_SEC = 12 * 3600 - 300;

/** Stored config + env overrides + defaults. Missing keys mean defaults. */
export function resolveSettings(raw = {}, env = process.env) {
  const claude = isClaudeCode(env);
  const seconds = (value, fallback, max) => {
    const number = Number(value);
    return value != null && Number.isFinite(number)
      ? Math.max(0, Math.min(max, Math.round(number)))
      : fallback;
  };
  // Group mode: chatId is the group, ownerUserId the only person the bridge obeys.
  // An older private config ({chatId: <user id>} plus groupChatId) migrates on read.
  const storedChat = text(raw.groupChatId) || text(raw.chatId);
  const chatId = env.TELEGRAM_CHAT_ID?.trim() || storedChat;
  const legacyOwner = text(raw.groupChatId) && isPrivateChatId(raw.chatId) ? text(raw.chatId) : "";
  const ownerUserId =
    text(raw.ownerUserId) || legacyOwner || (isPrivateChatId(chatId) ? chatId : "");
  return {
    // Interface language: "en" (default) or "ru". See i18n.mjs.
    language: raw.language === "ru" ? "ru" : "en",
    deliveryMode: ["smart", "always", "never"].includes(raw.deliveryMode) ? raw.deliveryMode : "smart",
    notificationTarget: ["telegram", "discord", "both"].includes(raw.notificationTarget) ? raw.notificationTarget : "telegram",
    discordToken: env.DISCORD_BOT_TOKEN?.trim() || text(raw.discordToken),
    discordChannel: env.DISCORD_CHANNEL_ID?.trim() || text(raw.discordChannel),
    discordGuild: text(raw.discordGuild),
    discordCategory: text(raw.discordCategory),
    discordOwner: env.DISCORD_OWNER_ID?.trim() || text(raw.discordOwner),
    // The bot's "Playing …" status in Discord; "" hides it.
    // "AI Forge" was the default before the rename: it follows the new name.
    discordActivity: typeof raw.discordActivity === "string" && raw.discordActivity.trim() !== "AI Forge"
      ? raw.discordActivity.trim().slice(0, 100)
      : "Aukalo",
    // The owner's own Discord profile shows the activity (needs the Discord app running on this Mac).
    discordRichPresence: raw.discordRichPresence !== false,
    presenceIdleSec: seconds(raw.presenceIdleSec, 120, 3600),
    approvalGraceSec: seconds(raw.approvalGraceSec, 90, 3600),
    actionGraceSec: seconds(raw.actionGraceSec, 180, 3600),
    token: env.TELEGRAM_BOT_TOKEN?.trim() || text(raw.botToken),
    chatId,
    ownerUserId,
    threadId: env.TELEGRAM_MESSAGE_THREAD_ID?.trim() || text(raw.messageThreadId),
    // Codex keeps "action" semantics: only blocking turns are sent.
    notify: claude ? (raw.notify === "action" ? "action" : "all") : "action",
    approvalWaitSec: seconds(raw.approvalWaitSec, MAX_APPROVAL_WAIT_SEC, MAX_APPROVAL_WAIT_SEC),
    // Codex blocks on its PermissionRequest hook: wait less, then Codex asks itself.
    // The hook timeout in codex-hooks.json is 960 s.
    codexApprovalWaitSec: seconds(raw.codexApprovalWaitSec, 900, 900),
    codexApprovalNotifications: raw.codexApprovalNotifications === true,
    topics: raw.topics !== false,
    chatReplies: raw.chatReplies !== false,
    quietHours: parseQuietHours(raw.quietHours),
    // Headless workers (spawn): the owner confirms each start in Telegram unless "never".
    spawnConfirm: raw.spawnConfirm === "never" ? "never" : "telegram",
    workerPermissions: raw.workerPermissions === "auto" ? "auto" : "telegram",
    workerDefaults: resolveWorkerDefaults(raw.workerDefaults, raw.workerPermissions === "auto" ? "auto" : "telegram"),
    claudePath: text(raw.claudePath),
    // A General message for a stopped "Босс" resumes it headless (claude -p --resume).
    bossRevive: raw.bossRevive !== false,
    // Folder for a Boss the bridge has to create from scratch (default: home).
    bossCwd: text(raw.bossCwd),
    // Auto-mode denials go to Telegram with «Разрешить один раз» (Claude Code).
    telegramDenials: raw.telegramDenials !== false,
  };
}

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// Modes a worker may run in. bypassPermissions is never allowed for workers.
export const WORKER_MODES = ["default", "manual", "acceptEdits", "plan", "dontAsk", "auto"];
export const isModelId = (value) => typeof value === "string" && /^[\w.\-[\]]{1,64}$/.test(value);

/** Worker defaults: Sonnet 5.5, medium effort; acceptEdits ("telegram") or auto ("auto"). */
export function resolveWorkerDefaults(raw = {}, permissions = "telegram") {
  const value = raw && typeof raw === "object" ? raw : {};
  const auto = permissions === "auto";
  return {
    model: isModelId(value.model) ? value.model : "claude-sonnet-5-5",
    effort: EFFORTS.includes(value.effort) ? value.effort : "medium",
    permissionMode: auto
      ? "auto"
      : WORKER_MODES.includes(value.permissionMode) && value.permissionMode !== "auto"
        ? value.permissionMode
        : "acceptEdits",
  };
}

export async function loadSettings(env = process.env) {
  return resolveSettings(await readRawConfiguration(), env);
}

export function discordSettings(settings) {
  if (!settings.discordToken || !discordId(settings.discordChannel) || !discordId(settings.discordOwner)) return null;
  return {
    ...settings, notificationTarget: "discord", chatId: settings.discordChannel,
    ownerUserId: settings.discordOwner, threadId: "",
    token: {
      secret: settings.discordToken, channel: settings.discordChannel, owner: settings.discordOwner,
      ...(discordId(settings.discordGuild) && discordId(settings.discordCategory)
        ? { guild: settings.discordGuild, category: settings.discordCategory } : {}),
    },
  };
}

export async function loadNotificationSettings(env = process.env) {
  const settings = await loadSettings(env);
  if (settings.notificationTarget === "telegram") return settings;
  // "both" keeps Telegram as the primary target; deliver() mirrors to Discord.
  if (settings.notificationTarget === "both" && settings.token && settings.chatId) return settings;
  return discordSettings(settings) ?? { ...settings, token: "", chatId: "" };
}

export function isPrivateChatId(chatId) {
  return /^\d+$/.test(String(chatId ?? ""));
}

/**
 * Point the bridge at a chat. Switching from a private chat to a group keeps the
 * old private chat id as ownerUserId (in a private chat it equals the user id).
 */
export async function setTargetChat(chatId) {
  const id = String(chatId ?? "").trim();
  if (!/^-?\d+$/.test(id)) throw new Error("Chat ID must be an integer.");
  const raw = await readRawConfiguration();
  const patch = { chatId: id, groupChatId: undefined };
  const previous = text(raw.chatId);
  if (!isPrivateChatId(id) && !text(raw.ownerUserId) && isPrivateChatId(previous)) {
    patch.ownerUserId = previous;
  }
  if (isPrivateChatId(id) && !text(raw.ownerUserId)) patch.ownerUserId = id;
  const saved = await saveConfiguration(patch);
  return { chatId: saved.chatId, ownerUserId: saved.ownerUserId ?? null };
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

export class TelegramError extends Error {
  constructor(method, status, description, parameters) {
    super(`Telegram ${method} failed: ${redactSecrets(String(description))}`);
    this.method = method;
    this.status = status;
    this.description = String(description ?? "");
    this.parameters = parameters;
  }
}

/**
 * `params.file` = { path, name, field, size } turns the call into a multipart upload:
 * the file is streamed from disk (never read into memory or logged), the other
 * params become form fields.
 */
async function uploadBody(params) {
  const { file, ...fields } = params;
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  form.append(file.field, await openAsBlob(file.path), file.name);
  return form;
}

/** Call a Bot API method. The token never appears in thrown errors. */
export async function telegram(token, method, params = {}, { timeoutMs = 10_000 } = {}) {
  if (typeof token === "object" && token?.channel) return discordCall(token, method, params);
  const upload = Boolean(params.file);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), upload ? Math.max(timeoutMs, uploadTimeoutMs(params.file.size)) : timeoutMs);
  try {
    const response = await globalThis.fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        ...(upload ? {} : { headers: { "content-type": "application/json" } }),
        body: upload ? await uploadBody(params) : JSON.stringify(params),
        signal: controller.signal,
      },
    );
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!payload?.ok) {
      throw new TelegramError(
        method,
        response.status,
        payload?.description || `HTTP ${response.status}`,
        payload?.parameters,
      );
    }
    return payload.result;
  } catch (error) {
    if (error instanceof TelegramError) throw error;
    throw new TelegramError(
      method,
      0,
      error?.name === "AbortError" ? "timeout" : "network error",
    );
  } finally {
    clearTimeout(timer);
  }
}

export function maskToken(token) {
  const value = String(token ?? "");
  if (!value) return "";
  const [id] = value.split(":");
  return `${/^\d+$/.test(id) ? id : "•••"}:••••${value.slice(-3)}`;
}
