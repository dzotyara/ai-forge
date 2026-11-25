// Local settings panel: node:http on 127.0.0.1, per-launch secret, no dependencies.
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import process from "node:process";

import {
  TOPIC_REASON_TEXT,
  daemonStatus,
  deliver,
  describeSession,
  describePresence,
  ensureDaemon,
  findChats,
  findGroups,
  forgetSession,
  pidAlive,
  resolveBossId,
  readState,
  setSessionMuted,
  stopDaemon,
  topicSupport,
  updateState,
} from "./bridge.mjs";
import {
  MAX_APPROVAL_WAIT_SEC,
  configurationPath,
  discordSettings,
  isPrivateChatId,
  loadSettings,
  loadNotificationSettings,
  maskToken,
  parseQuietHours,
  readRawConfiguration,
  redactSecrets,
  saveConfiguration,
  setTargetChat,
  telegram,
} from "./common.mjs";
import { discordId, refreshDiscordLook, setupDiscord } from "./discord.mjs";
import { L, lang, resetLang } from "./i18n.mjs";
import { detectPresence, effectiveMode } from "./presence.mjs";

const LOOK_AVATAR = new URL("../../assets/discord-avatar.png", import.meta.url);

/** Telegram: the bot's profile photo and, for a group, the group photo. Returns warnings. */
async function refreshTelegramLook(settings) {
  const warnings = [];
  const photo = new Blob([await readFile(LOOK_AVATAR)], { type: "image/png" });
  const call = async (method, form) => {
    const response = await fetch(`https://api.telegram.org/bot${settings.token}/${method}`, { method: "POST", body: form });
    const data = await response.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.description || `HTTP ${response.status}`);
  };
  const bot = new FormData();
  bot.append("photo", JSON.stringify({ type: "static", photo: "attach://pic" }));
  bot.append("pic", photo, "avatar.png");
  await call("setMyProfilePhoto", bot).catch((error) => warnings.push(L(`Фото бота в Telegram не обновлено (${error.message}).`, `Telegram bot photo not updated (${error.message}).`)));
  if (!isPrivateChatId(settings.chatId)) {
    const group = new FormData();
    group.append("chat_id", String(settings.chatId));
    group.append("photo", photo, "avatar.png");
    await call("setChatPhoto", group).catch((error) => warnings.push(L(`Фото группы не обновлено (${error.message}).`, `Group photo not updated (${error.message}).`)));
  }
  return warnings;
}


const PAGE = new URL("./settings.html", import.meta.url);
const IDLE_MS = 30 * 60_000;
// A function, not a constant: the language can change while the panel runs.
const testMessage = () => L("✅ Проверка из панели настроек: бот на связи.", "✅ Test from the settings panel: the bot is online.");

const integer = (min, max) => (value) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;

const VALIDATORS = {
  deliveryMode: (value) => (["smart", "always", "never"].includes(value) ? value : undefined),
  notificationTarget: (value) => (["telegram", "discord", "both"].includes(value) ? value : undefined),
  notify: (value) => (value === "all" || value === "action" ? value : undefined),
  approvalWaitSec: integer(0, MAX_APPROVAL_WAIT_SEC),
  codexApprovalNotifications: (value) => (typeof value === "boolean" ? value : undefined),
  chatReplies: (value) => (typeof value === "boolean" ? value : undefined),
  quietHours: (value) => (value === null ? null : parseQuietHours(value) ?? undefined),
  presenceIdleSec: integer(30, 3600),
  approvalGraceSec: integer(0, 3600),
  actionGraceSec: integer(0, 3600),
  spawnConfirm: (value) => (value === "telegram" || value === "never" ? value : undefined),
  workerPermissions: (value) => (value === "telegram" || value === "auto" ? value : undefined),
  language: (value) => (value === "en" || value === "ru" ? value : undefined),
};

/** Validate a partial settings update. Unknown keys and bad values are rejected. */
export function validateSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: L("Ожидался объект настроек.", "Expected a settings object.") };
  const value = {};
  for (const [key, raw] of Object.entries(body)) {
    const check = VALIDATORS[key];
    if (!check) return { error: L(`Неизвестная настройка: ${key}`, `Unknown setting: ${key}`) };
    const parsed = check(raw);
    if (parsed === undefined) return { error: L(`Недопустимое значение: ${key}`, `Invalid value: ${key}`) };
    value[key] = parsed;
  }
  return { value };
}

export function isValidTokenFormat(token) {
  return typeof token === "string" && /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}

function sameSecret(given, secret) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("bad json"), { status: 400 });
  }
}

let botCache = { at: 0, token: "", value: null };

async function botInfo(token) {
  if (!token) return { configured: false };
  if (botCache.token === token && Date.now() - botCache.at < 30_000) return botCache.value;
  let value;
  try {
    const me = await telegram(token, "getMe", {}, { timeoutMs: 6000 });
    value = {
      configured: true,
      ok: true,
      username: me.username ?? null,
      topicsEnabled: me.has_topics_enabled === true,
    };
  } catch (error) {
    value = { configured: true, ok: false, error: redactSecrets(error.description || L("Нет связи с Telegram", "Cannot reach Telegram")) };
  }
  botCache = { at: Date.now(), token, value };
  return value;
}

async function snapshot() {
  const settings = await loadSettings();
  const raw = await readRawConfiguration();
  const state = await readState();
  const bot = await botInfo(settings.token);
  const presence = await detectPresence({ idleThresholdSec: settings.presenceIdleSec, claude: true });
  const mode = effectiveMode(settings, state.meta);
  const topics = bot.ok && settings.chatId ? await topicSupport(settings) : null;
  let chatTitle = null;
  if (bot.ok && settings.chatId && !isPrivateChatId(settings.chatId)) {
    chatTitle = await telegram(settings.token, "getChat", { chat_id: settings.chatId }, { timeoutMs: 5000 })
      .then((chat) => chat.title ?? null)
      .catch(() => null);
  }
  const bossId = resolveBossId(state);
  return {
    bot: {
      ...bot,
      tokenHint: maskToken(settings.token),
      fromEnv: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
    },
    chat: {
      id: settings.chatId || null,
      kind: settings.chatId ? (isPrivateChatId(settings.chatId) ? "private" : "group") : null,
      title: chatTitle,
      ownerUserId: settings.ownerUserId || null,
    },
    topics: topics ? { ...topics, text: TOPIC_REASON_TEXT[topics.reason] ?? topics.reason } : null,
    boss: bossId ? { id: bossId, title: state.sessions[bossId]?.title ?? L("Босс", "Boss") } : null,
    settings: {
      deliveryMode: settings.deliveryMode,
      notificationTarget: settings.notificationTarget,
      notify: raw.notify === "action" ? "action" : "all",
      approvalWaitSec: settings.approvalWaitSec,
      codexApprovalNotifications: settings.codexApprovalNotifications,
      chatReplies: settings.chatReplies,
      quietHours: settings.quietHours,
      presenceIdleSec: settings.presenceIdleSec,
      approvalGraceSec: settings.approvalGraceSec,
      actionGraceSec: settings.actionGraceSec,
      spawnConfirm: settings.spawnConfirm,
      workerPermissions: settings.workerPermissions,
      language: settings.language,
    },
    discord: {
      configured: Boolean(discordSettings(settings)),
      guild: settings.discordGuild,
      owner: settings.discordOwner,
    },
    mode,
    presence: { present: presence.present, text: describePresence(presence), frontApp: presence.frontApp },
    sessions: Object.entries(state.sessions)
      .map(([id, session]) => describeSession(id, session, pidAlive, resolveBossId(state)))
      .sort((a, b) => (b.lastPostAt ?? 0) - (a.lastPostAt ?? 0)),
    daemon: await daemonStatus(),
    configPath: configurationPath(),
  };
}

const ROUTES = {
  "GET /api/state": () => snapshot(),

  "POST /api/token": async (body) => {
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!isValidTokenFormat(token)) return [400, { error: L("Это не похоже на токен бота. Скопируйте его из @BotFather целиком.", "This does not look like a bot token. Copy the whole token from @BotFather.") }];
    let me;
    try {
      me = await telegram(token, "getMe", {}, { timeoutMs: 8000 });
    } catch {
      return [400, { error: L("Telegram не принял токен. Проверьте его и подключение к сети.", "Telegram rejected the token. Check the token and your network connection.") }];
    }
    await stopDaemon(); // the old token's poller must not keep running
    await saveConfiguration({ botToken: token });
    await updateState((state) => {
      delete state.meta.topicsEnabled;
      delete state.meta.topicsCheckedAt;
    });
    botCache = { at: 0, token: "", value: null };
    return { ok: true, username: me.username ?? null, topicsEnabled: me.has_topics_enabled === true };
  },

  // Private /start detection. In group mode the found user becomes the owner.
  "POST /api/chat/detect": async () => {
    const settings = await loadSettings();
    if (!settings.token) return [400, { error: L("Сначала сохраните токен бота.", "Save the bot token first.") }];
    let chats;
    try {
      chats = (await findChats(settings.token, { waitSec: 25 })).filter((chat) => chat.type === "private");
    } catch {
      return [502, { error: L("Не удалось прочитать сообщения бота.", "Could not read the bot's messages.") }];
    }
    if (chats.length !== 1) return { chats, saved: null };
    if (settings.chatId && !isPrivateChatId(settings.chatId)) {
      await saveConfiguration({ ownerUserId: chats[0].id });
      return { chats, saved: chats[0].id, as: "owner" };
    }
    await setTargetChat(chats[0].id);
    return { chats, saved: chats[0].id, as: "chat" };
  },

  "POST /api/chat/groups": async () => {
    const settings = await loadSettings();
    if (!settings.token) return [400, { error: L("Сначала сохраните токен бота.", "Save the bot token first.") }];
    try {
      return { groups: await findGroups(settings.token) };
    } catch {
      return [502, { error: L("Не удалось прочитать обновления бота.", "Could not read the bot's updates.") }];
    }
  },

  "POST /api/chat": async (body) => {
    const chatId = String(body.chatId ?? "").trim();
    if (!/^-?\d+$/.test(chatId)) return [400, { error: L("ID чата должен быть числом.", "The chat ID must be a number.") }];
    await stopDaemon();
    const result = await setTargetChat(chatId);
    return { ok: true, ownerKnown: Boolean(result.ownerUserId) };
  },

  "POST /api/settings": async (body) => {
    const { value, error } = validateSettings(body);
    if (error) return [400, { error }];
    const current = await loadSettings();
    if (value.notificationTarget && value.notificationTarget !== "telegram" && !discordSettings(current)) {
      return [400, { error: L("Сначала настройте Discord.", "Set up Discord first.") }];
    }
    if (value.notificationTarget && value.notificationTarget !== "discord" && (!current.token || !current.chatId)) {
      return [400, { error: L("Сначала настройте Telegram.", "Set up Telegram first.") }];
    }
    const changed = value.notificationTarget && current.notificationTarget !== value.notificationTarget;
    // The daemon reads the language once per process, so a new language needs a restart too.
    const languageChanged = value.language && current.language !== value.language;
    const restart = (changed || languageChanged) && (await daemonStatus()).running;
    if (restart) await stopDaemon();
    await saveConfiguration(value);
    if (languageChanged) resetLang();
    if (restart) await ensureDaemon();
    return { ok: true };
  },

  "POST /api/discord": async (body) => {
    const current = await loadSettings();
    const secret = typeof body.token === "string" && body.token.trim() || current.discordToken;
    const { guild = "", owner } = body;
    if (!/^[\w.-]{30,200}$/.test(secret) || (guild && !discordId(guild)) || !discordId(owner)) {
      return [400, { error: L("Укажите токен, свой ID пользователя и, если нужно, ID сервера Discord.", "Enter the bot token, your user ID and, if needed, the Discord server ID.") }];
    }
    let next;
    try {
      next = await setupDiscord(secret, guild, owner, current);
    } catch (error) {
      const explanation = { 401: L("Discord не принял токен бота.", "Discord rejected the bot token."), 403: L("Проверьте права бота на создание каналов и настройку доступа.", "Check that the bot can create channels and manage permissions."), 404: L("Discord не нашёл сервер или пользователя.", "Discord could not find the server or the user.") };
      return [400, { error: explanation[error.status] ?? error.message }];
    }
    const restart = (await daemonStatus()).running;
    if (restart) await stopDaemon();
    await saveConfiguration(next.settings);
    if (restart) await ensureDaemon();
    return { ok: true, warnings: next.warnings };
  },

  "POST /api/override/clear": async () => {
    await updateState((state) => {
      delete state.meta.override;
      delete state.meta.muteUntil;
    });
    return { ok: true };
  },

  "POST /api/sessions/mute": async (body) => {
    if (typeof body.id !== "string") return [400, { error: L("Нет id сессии.", "Missing session id.") }];
    return { ok: await setSessionMuted(body.id, body.muted === true) };
  },

  "POST /api/sessions/forget": async (body) => {
    if (typeof body.id !== "string") return [400, { error: L("Нет id сессии.", "Missing session id.") }];
    try {
      return { ok: true, ...(await forgetSession(await loadSettings(), body.id, { deleteTopic: body.deleteTopic === true })) };
    } catch {
      return [502, { error: L("Сессия забыта, но тему удалить не удалось.", "The session is forgotten, but its topic could not be deleted.") }];
    }
  },

  "POST /api/test": async () => {
    const settings = await loadNotificationSettings();
    if (!settings.token || !settings.chatId) return [400, { error: L("Сначала настройте направление доставки.", "Set up a delivery target first.") }];
    try {
      if (settings.notificationTarget === "both") {
        const discord = discordSettings(settings);
        if (!discord) return [400, { error: L("Сначала настройте Discord.", "Set up Discord first.") }];
        const results = await Promise.allSettled([
          deliver({ ...settings, notificationTarget: "telegram" }, {}, [testMessage()]),
          deliver(discord, {}, [testMessage()]),
        ]);
        const failed = ["Telegram", "Discord"].filter((_, index) => results[index].status === "rejected");
        if (failed.length) return [502, { error: L(`Тест не доставлен в ${failed.join(" и ")}.`, `Test not delivered to ${failed.join(" and ")}.`) }];
      } else await deliver(settings, {}, [testMessage()]);
    } catch (error) {
      return [502, { error: redactSecrets(error.description || L("Не удалось отправить", "Could not send")) }];
    }
    return { ok: true };
  },

  "POST /api/look/refresh": async () => {
    const settings = await loadSettings();
    const warnings = [];
    let done = 0;
    const discord = discordSettings(settings);
    if (discord && discord.token?.guild) {
      warnings.push(...await refreshDiscordLook(discord.token).catch((error) => [redactSecrets(error.message)]));
      done += 1;
    }
    if (settings.token && settings.chatId) {
      warnings.push(...await refreshTelegramLook(settings).catch((error) => [redactSecrets(error.message)]));
      done += 1;
    }
    if (!done) return [400, { error: L("Сначала подключите Discord или Telegram.", "Connect Discord or Telegram first.") }];
    return { ok: true, warnings };
  },

  "POST /api/daemon/restart": async () => {
    await stopDaemon();
    const settings = await loadNotificationSettings();
    if (!settings.token || !settings.chatId) return [400, { error: L("Сначала укажите токен и чат.", "Set the token and the chat first.") }];
    return { ok: true, pid: await ensureDaemon() };
  },

  "POST /api/daemon/stop": async () => ({ ok: true, pid: await stopDaemon() }),
};

/** The page is written in English; the inline script switches it to Russian when LANG is "ru". */
function localizePage(html) {
  const current = lang();
  return html
    .replace('<html lang="en">', `<html lang="${current}">`)
    .replace('"use strict";', `"use strict";\nconst LANG = "${current}";`);
}

/**
 * Request handler. Every request must carry the right Host; the page needs
 * ?k=<secret>, every API call the X-Panel-Key header.
 */
export function createUiHandler({ secret, getPort, onActivity = () => {} }) {
  return async (req, res) => {
    const port = getPort();
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 403, { error: "forbidden" });
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}`) return send(res, 403, { error: "forbidden" });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === "GET" && url.pathname === "/") {
      if (!sameSecret(url.searchParams.get("k"), secret)) return send(res, 403, "Forbidden", "text/plain; charset=utf-8");
      onActivity();
      return send(res, 200, localizePage(await readFile(PAGE, "utf8")), "text/html; charset=utf-8");
    }

    if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
    if (!sameSecret(req.headers["x-panel-key"], secret)) return send(res, 403, { error: "forbidden" });
    const route = ROUTES[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, { error: "not found" });
    if (req.method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      return send(res, 415, { error: "json only" });
    }
    if (req.headers["x-poll"] !== "1") onActivity();
    try {
      const body = req.method === "POST" ? await readBody(req) : {};
      const result = await route(body);
      if (Array.isArray(result)) return send(res, result[0], result[1]);
      return send(res, 200, result);
    } catch (error) {
      return send(res, error.status ?? 500, { error: error.status ? error.message : L("Внутренняя ошибка", "Internal error") });
    }
  };
}

export async function startUi({ openBrowser = true, idleMs = IDLE_MS, log = console.log } = {}) {
  const secret = randomBytes(24).toString("base64url");
  let port = 0;
  let timer;
  const server = http.createServer();
  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      log(L("Панель закрыта: 30 минут без действий.", "Panel closed after 30 minutes of inactivity."));
      shutdown();
    }, idleMs);
  };
  server.on("request", createUiHandler({ secret, getPort: () => port, onActivity: touch }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  touch();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  const url = `http://127.0.0.1:${port}/?k=${secret}`;
  log(L(`Панель настроек: ${url}`, `Settings panel: ${url}`));
  log(L("Ссылка работает только на этом Mac. Остановить: Ctrl-C (или закроется сама через 30 минут без действий).", "The link works only on this Mac. Stop with Ctrl-C (it also closes by itself after 30 minutes of inactivity)."));
  if (openBrowser && process.platform === "darwin") execFile("open", [url], () => {});
  return { server, port, url, secret };
}
