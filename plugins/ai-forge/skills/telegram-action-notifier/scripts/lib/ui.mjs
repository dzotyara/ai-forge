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
import { discordId, setupDiscord } from "./discord.mjs";
import { detectPresence, effectiveMode } from "./presence.mjs";

const PAGE = new URL("./settings.html", import.meta.url);
const IDLE_MS = 30 * 60_000;
const TEST_MESSAGE = "✅ Проверка из панели настроек: бот на связи.";

const integer = (min, max) => (value) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;

const VALIDATORS = {
  deliveryMode: (value) => (["smart", "always", "never"].includes(value) ? value : undefined),
  notificationTarget: (value) => (["telegram", "discord", "both"].includes(value) ? value : undefined),
  notify: (value) => (value === "all" || value === "action" ? value : undefined),
  approvalWaitSec: integer(0, MAX_APPROVAL_WAIT_SEC),
  chatReplies: (value) => (typeof value === "boolean" ? value : undefined),
  quietHours: (value) => (value === null ? null : parseQuietHours(value) ?? undefined),
  presenceIdleSec: integer(30, 3600),
  approvalGraceSec: integer(0, 3600),
  actionGraceSec: integer(0, 3600),
  spawnConfirm: (value) => (value === "telegram" || value === "never" ? value : undefined),
  workerPermissions: (value) => (value === "telegram" || value === "auto" ? value : undefined),
};

/** Validate a partial settings update. Unknown keys and bad values are rejected. */
export function validateSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Ожидался объект настроек." };
  const value = {};
  for (const [key, raw] of Object.entries(body)) {
    const check = VALIDATORS[key];
    if (!check) return { error: `Неизвестная настройка: ${key}` };
    const parsed = check(raw);
    if (parsed === undefined) return { error: `Недопустимое значение: ${key}` };
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
    value = { configured: true, ok: false, error: redactSecrets(error.description || "Нет связи с Telegram") };
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
    boss: bossId ? { id: bossId, title: state.sessions[bossId]?.title ?? "Босс" } : null,
    settings: {
      deliveryMode: settings.deliveryMode,
      notificationTarget: settings.notificationTarget,
      notify: raw.notify === "action" ? "action" : "all",
      approvalWaitSec: settings.approvalWaitSec,
      chatReplies: settings.chatReplies,
      quietHours: settings.quietHours,
      presenceIdleSec: settings.presenceIdleSec,
      approvalGraceSec: settings.approvalGraceSec,
      actionGraceSec: settings.actionGraceSec,
      spawnConfirm: settings.spawnConfirm,
      workerPermissions: settings.workerPermissions,
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
    if (!isValidTokenFormat(token)) return [400, { error: "Это не похоже на токен бота. Скопируйте его из @BotFather целиком." }];
    let me;
    try {
      me = await telegram(token, "getMe", {}, { timeoutMs: 8000 });
    } catch {
      return [400, { error: "Telegram не принял токен. Проверьте его и подключение к сети." }];
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
    if (!settings.token) return [400, { error: "Сначала сохраните токен бота." }];
    let chats;
    try {
      chats = (await findChats(settings.token, { waitSec: 25 })).filter((chat) => chat.type === "private");
    } catch {
      return [502, { error: "Не удалось прочитать сообщения бота." }];
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
    if (!settings.token) return [400, { error: "Сначала сохраните токен бота." }];
    try {
      return { groups: await findGroups(settings.token) };
    } catch {
      return [502, { error: "Не удалось прочитать обновления бота." }];
    }
  },

  "POST /api/chat": async (body) => {
    const chatId = String(body.chatId ?? "").trim();
    if (!/^-?\d+$/.test(chatId)) return [400, { error: "ID чата должен быть числом." }];
    await stopDaemon();
    const result = await setTargetChat(chatId);
    return { ok: true, ownerKnown: Boolean(result.ownerUserId) };
  },

  "POST /api/settings": async (body) => {
    const { value, error } = validateSettings(body);
    if (error) return [400, { error }];
    const current = await loadSettings();
    if (value.notificationTarget && value.notificationTarget !== "telegram" && !discordSettings(current)) {
      return [400, { error: "Сначала настройте Discord." }];
    }
    if (value.notificationTarget && value.notificationTarget !== "discord" && (!current.token || !current.chatId)) {
      return [400, { error: "Сначала настройте Telegram." }];
    }
    const changed = value.notificationTarget && current.notificationTarget !== value.notificationTarget;
    const restart = changed && (await daemonStatus()).running;
    if (restart) await stopDaemon();
    await saveConfiguration(value);
    if (restart) await ensureDaemon();
    return { ok: true };
  },

  "POST /api/discord": async (body) => {
    const current = await loadSettings();
    const secret = typeof body.token === "string" && body.token.trim() || current.discordToken;
    const { guild = "", owner } = body;
    if (!/^[\w.-]{30,200}$/.test(secret) || (guild && !discordId(guild)) || !discordId(owner)) {
      return [400, { error: "Укажите токен, свой ID пользователя и, если нужно, ID сервера Discord." }];
    }
    let next;
    try {
      next = await setupDiscord(secret, guild, owner, current);
    } catch (error) {
      const explanation = { 401: "Discord не принял токен бота.", 403: "Проверьте права бота на создание каналов и настройку доступа.", 404: "Discord не нашёл сервер или пользователя." };
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
    if (typeof body.id !== "string") return [400, { error: "Нет id сессии." }];
    return { ok: await setSessionMuted(body.id, body.muted === true) };
  },

  "POST /api/sessions/forget": async (body) => {
    if (typeof body.id !== "string") return [400, { error: "Нет id сессии." }];
    try {
      return { ok: true, ...(await forgetSession(await loadSettings(), body.id, { deleteTopic: body.deleteTopic === true })) };
    } catch {
      return [502, { error: "Сессия забыта, но тему удалить не удалось." }];
    }
  },

  "POST /api/test": async () => {
    const settings = await loadNotificationSettings();
    if (!settings.token || !settings.chatId) return [400, { error: "Сначала настройте направление доставки." }];
    try {
      if (settings.notificationTarget === "both") {
        const discord = discordSettings(settings);
        if (!discord) return [400, { error: "Сначала настройте Discord." }];
        const results = await Promise.allSettled([
          deliver({ ...settings, notificationTarget: "telegram" }, {}, [TEST_MESSAGE]),
          deliver(discord, {}, [TEST_MESSAGE]),
        ]);
        const failed = ["Telegram", "Discord"].filter((_, index) => results[index].status === "rejected");
        if (failed.length) return [502, { error: `Тест не доставлен в ${failed.join(" и ")}.` }];
      } else await deliver(settings, {}, [TEST_MESSAGE]);
    } catch (error) {
      return [502, { error: redactSecrets(error.description || "Не удалось отправить") }];
    }
    return { ok: true };
  },

  "POST /api/daemon/restart": async () => {
    await stopDaemon();
    const settings = await loadNotificationSettings();
    if (!settings.token || !settings.chatId) return [400, { error: "Сначала укажите токен и чат." }];
    return { ok: true, pid: await ensureDaemon() };
  },

  "POST /api/daemon/stop": async () => ({ ok: true, pid: await stopDaemon() }),
};

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
      return send(res, 200, await readFile(PAGE, "utf8"), "text/html; charset=utf-8");
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
      return send(res, error.status ?? 500, { error: error.status ? error.message : "Внутренняя ошибка" });
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
      log("Панель закрыта: 30 минут без действий.");
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
  log(`Панель настроек: ${url}`);
  log("Ссылка работает только на этом Mac. Остановить: Ctrl-C (или закроется сама через 30 минут без действий).");
  if (openBrowser && process.platform === "darwin") execFile("open", [url], () => {});
  return { server, port, url, secret };
}
