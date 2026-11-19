// Two-way bridge: per-session state, forum topics, the getUpdates daemon,
// reply waiters and approval buttons.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  TelegramError,
  configurationPath,
  isPrivateChatId,
  isQuietTime,
  discordSettings,
  loadNotificationSettings as loadSettings,
  redactSecrets,
  telegram,
} from "./common.mjs";
import { botUser, connectDiscord, discordApi, slashCommands } from "./discord.mjs";
import { connectRichPresence, richPresenceActivity } from "./rpc.mjs";
import { escapeHtml, htmlToPlain, projectName, truncateText } from "./format.mjs";
import { L } from "./i18n.mjs";
import { detectPresence, effectiveMode, parseMuteDuration, pendingAction } from "./presence.mjs";
import {
  QUESTION_CALLBACK,
  QUESTION_WAIT_SEC,
  allAnswered,
  answeredText,
  answersFrom,
  applyPress,
  applyText,
  isTurnAnswerData,
  newRequestId,
  questionKeyboard,
} from "./questions.mjs";

const ENTRY_SCRIPT = fileURLToPath(new URL("../telegram-action-notifier.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const DAEMON_IDLE_MS = 2 * 60 * 60 * 1000;
export const WAITER_MAX_MS = 43_000 * 1000; // just under the hook timeout (43200 s)
// Both languages are recognised on input: the prefix may come from a daemon that ran in the other language.
const REPLY_PREFIX_RU = "Сообщение пользователя из Telegram:";
const REPLY_PREFIX_EN = "User message from Telegram:";
export const REPLY_PREFIX = L(REPLY_PREFIX_RU, REPLY_PREFIX_EN);
const KEEP_MESSAGE_IDS = 40;

// ---------------------------------------------------------------- state files

export function stateDir() {
  return path.join(path.dirname(configurationPath()), "state");
}

const files = {
  sessions: () => path.join(stateDir(), "sessions.json"),
  lock: () => path.join(stateDir(), "lock"),
  pid: () => path.join(stateDir(), "daemon.pid"),
  daemon: () => path.join(stateDir(), "daemon.json"),
  offset: () => path.join(stateDir(), "offset.json"),
  log: () => path.join(stateDir(), "daemon.log"),
  inbox: (sid) => path.join(stateDir(), "inbox", `${sid}.jsonl`),
  approval: (id, kind) => path.join(stateDir(), "approvals", `${id}.${kind}.json`),
  run: (sid, ext) => path.join(stateDir(), "runs", `${sid}.${ext}`),
};

/** Per-run output files of a headless worker (stdout JSON, stderr). */
export const runFile = (sid, ext) => files.run(sid, ext);
export const inboxFile = (sid) => files.inbox(sid);
export const HEADLESS_LISTEN_MS = 3 * 86_400_000; // the daemon keeps listening for idle workers this long

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fsp.chmod(dir, 0o700).catch(() => {});
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fsp.rename(tmp, file);
}

/** Exclusive create: only the first writer wins. Used for approval outcomes. */
async function createExclusive(file, value) {
  await ensureDir(path.dirname(file));
  try {
    await fsp.writeFile(file, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

/** Cross-process mutex: an atomic mkdir; a lock older than 20 s is stale. */
export async function withLock(fn) {
  await ensureDir(stateDir());
  const lock = files.lock();
  const deadline = Date.now() + 25_000;
  let held = false;
  while (!held && Date.now() < deadline) {
    try {
      await fsp.mkdir(lock, { mode: 0o700 });
      held = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = await fsp.stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 20_000) {
        await fsp.rm(lock, { recursive: true, force: true });
      } else {
        await sleep(20 + Math.random() * 30);
      }
    }
  }
  try {
    return await fn();
  } finally {
    if (held) await fsp.rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}

export function emptyState() {
  return { version: 1, sessions: {}, pending: {}, meta: {}, spawns: {} };
}

export async function readState() {
  const value = await readJson(files.sessions(), null);
  if (!value || typeof value !== "object") return emptyState();
  return {
    ...emptyState(),
    ...value,
    sessions: value.sessions ?? {},
    pending: value.pending ?? {},
    meta: value.meta ?? {},
    spawns: value.spawns ?? {},
  };
}

/** Read-modify-write sessions.json under the lock. */
export async function updateState(mutate) {
  return withLock(async () => {
    const state = await readState();
    const result = await mutate(state);
    await writeJsonAtomic(files.sessions(), state);
    return result;
  });
}

export function safeSessionId(id) {
  const value = String(id ?? "");
  if (/^[\w-]{1,128}$/.test(value)) return value;
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function logLine(message) {
  try {
    await ensureDir(stateDir());
    const file = files.log();
    const info = await fsp.stat(file).catch(() => null);
    if (info && info.size > 256 * 1024) await fsp.rename(file, `${file}.1`);
    await fsp.appendFile(
      file,
      `${new Date().toISOString()} ${redactSecrets(String(message))}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Logging must never break a hook.
  }
}

// ------------------------------------------------------------ session titles

export function titlesFromLines(lines) {
  let custom = "";
  let ai = "";
  for (const line of lines) {
    if (!line.includes('-title"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === "custom-title" && typeof entry.customTitle === "string" && entry.customTitle.trim()) {
        custom = entry.customTitle;
      } else if (entry?.type === "ai-title" && typeof entry.aiTitle === "string" && entry.aiTitle.trim()) {
        ai = entry.aiTitle;
      }
    } catch {
      // Partial or foreign line.
    }
  }
  return { custom, ai };
}

function cleanTitle(value) {
  return truncateText(String(value).replace(/\s+/g, " ").trim(), 100);
}

/**
 * Session title from the transcript: the last `custom-title` wins, then the last
 * `ai-title`, then the project name. Reads the tail first; full scan only if needed.
 */
export async function readSessionTitle(transcriptPath, cwd, { tailBytes = 256 * 1024, fullScan = true } = {}) {
  const fallback = projectName(cwd) || L("Сессия", "Session");
  if (typeof transcriptPath !== "string" || !transcriptPath) return fallback;
  let handle;
  try {
    handle = await fsp.open(transcriptPath, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (length < size) lines.shift();
    let { custom, ai } = titlesFromLines(lines);
    if (custom) return cleanTitle(custom);
    if (length < size && fullScan) {
      const all = [];
      const reader = readline.createInterface({
        input: createReadStream(transcriptPath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of reader) {
        if (line.includes('-title"')) all.push(line);
      }
      ({ custom, ai } = titlesFromLines(all));
      if (custom) return cleanTitle(custom);
    }
    return ai ? cleanTitle(ai) : fallback;
  } catch {
    return fallback;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Topic name: "<title> · <project>", or "<parent> › <title>" for a child session. */
export function topicName(title, project, parent) {
  if (parent) return truncateText(`${parent} › ${title || L("Сессия", "Session")}`, 128);
  const name = project && project !== title ? `${title} · ${project}` : title;
  return truncateText(name || L("Сессия", "Session"), 128);
}

export async function sessionContext(event, host, { fullScan = true } = {}) {
  const cwd = typeof event?.cwd === "string" ? event.cwd : "";
  const project = projectName(cwd);
  const sessionId = event?.session_id ? safeSessionId(event.session_id) : null;
  // A headless worker keeps its spawn title: its transcript gets the --name title
  // only after SessionStart, and the project name must never stand in for it.
  const known = sessionId ? (await readState()).sessions[sessionId] : null;
  return {
    sessionId,
    cwd,
    project,
    host,
    title: known?.headless && known.title ? known.title : await readSessionTitle(event?.transcript_path, cwd, { fullScan }),
  };
}

export const BOSS_TITLE = L("босс", "boss");
// A session titled "Босс" or "Boss" is the boss in either language.
const BOSS_TITLES = new Set(["босс", "boss"]);
export const isBossTitle = (title) => BOSS_TITLES.has(String(title ?? "").trim().toLowerCase());

/**
 * The boss session (it owns the General topic): an explicit claim, else the
 * newest live session titled "Босс".
 */
export function resolveBossId(state) {
  const bound = state.meta?.bossSessionId;
  if (bound && state.sessions[bound] && !state.sessions[bound].ended) return bound;
  const candidates = Object.entries(state.sessions)
    .filter(([, session]) => !session.ended && session.host !== "Codex" && isBossTitle(session.title))
    .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0));
  return candidates[0]?.[0] ?? null;
}

/**
 * The boss whose app process stopped (SessionEnd fired): the claimed session,
 * else the newest Claude Code session titled "Босс". The daemon can resume it
 * headless, so the General topic keeps working while the app is not running it.
 */
export function dormantBossId(state) {
  const dormant = (session) => Boolean(session?.ended && !session.headless && !session.closed && session.host !== "Codex");
  const bound = state.meta?.bossSessionId;
  if (bound && dormant(state.sessions[bound])) return bound;
  const candidates = Object.entries(state.sessions)
    .filter(([, session]) => dormant(session) && isBossTitle(session.title))
    .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0));
  return candidates[0]?.[0] ?? null;
}

function applyContext(state, ctx) {
  const session = (state.sessions[ctx.sessionId] ??= { createdAt: Date.now() });
  session.title = ctx.title;
  session.project = ctx.project;
  session.cwd = ctx.cwd;
  session.host = ctx.host;
  session.updatedAt = Date.now();
  // Auto-bind: a Claude Code session titled "Босс" becomes the boss; renaming it unbinds.
  if (ctx.host !== "Codex" && isBossTitle(ctx.title)) {
    if (!state.meta.bossClaimed || !state.sessions[state.meta.bossSessionId]) {
      state.meta.bossSessionId = ctx.sessionId;
      state.meta.bossClaimed = false;
    }
  } else if (state.meta.bossSessionId === ctx.sessionId && !state.meta.bossClaimed) {
    delete state.meta.bossSessionId;
  }
  return session;
}

/** Resolve a CLI target: "boss", a session id, or a title (case-insensitive; live and newest first). */
export function findSession(state, target) {
  if (String(target).toLowerCase() === "boss") return resolveBossId(state);
  if (state.sessions[target]) return target;
  const key = String(target ?? "").trim().toLowerCase();
  const match = Object.entries(state.sessions)
    .filter(([, s]) => String(s.title ?? "").trim().toLowerCase() === key)
    .sort((a, b) => Number(Boolean(a[1].ended)) - Number(Boolean(b[1].ended)) || (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0));
  return match[0]?.[0] ?? null;
}

/** Explicitly make a session the boss (CLI `claim-boss`). */
export async function claimBoss(sessionId) {
  const sid = safeSessionId(sessionId);
  return updateState((state) => {
    state.sessions[sid] ??= { createdAt: Date.now(), title: L("Босс", "Boss"), host: "Claude Code", updatedAt: Date.now() };
    state.sessions[sid].ended = false;
    state.meta.bossSessionId = sid;
    state.meta.bossClaimed = true;
    return sid;
  });
}

export async function touchSession(ctx, extra = {}) {
  if (!ctx.sessionId) return null;
  return updateState((state) => {
    const session = applyContext(state, ctx);
    Object.assign(session, extra);
    return { ...session };
  });
}

export async function markSessionEnded(sessionId) {
  if (!sessionId) return;
  const sid = safeSessionId(sessionId);
  await updateState((state) => {
    const session = state.sessions[sid];
    // A headless worker "ends" after every -p run; it stays resumable from its topic.
    if (session?.headless) session.lastRunEndedAt = Date.now();
    else if (session) {
      session.ended = true;
      session.endedAt = Date.now();
    }
  });
}

// ------------------------------------------------------------- topics, sends

const botIdOf = (token) => String(token ?? "").split(":")[0];

/**
 * Can the bridge create per-session topics in the target chat?
 *   private chat: the bot's topic mode (getMe.has_topics_enabled)
 *   group: the chat is a forum and the bot may manage topics
 * Returns { enabled, reason } with reason in
 * "ok" | "private-off" | "not-forum" | "no-rights" | "not-admin" | "error". Cached.
 */
export async function topicSupport(settings, { fresh = false } = {}) {
  if (settings.token?.channel) return { enabled: true, reason: "ok" };
  const state = await readState();
  const cached = state.meta.topics;
  if (!fresh && cached && cached.chatId === settings.chatId) {
    const ttl = cached.enabled ? 6 * 3600_000 : 5 * 60_000;
    if (Date.now() - cached.at < ttl) return { enabled: cached.enabled, reason: cached.reason };
  }
  let result;
  try {
    if (isPrivateChatId(settings.chatId)) {
      const me = await telegram(settings.token, "getMe", {}, { timeoutMs: 6000 });
      result = { enabled: me?.has_topics_enabled === true, reason: me?.has_topics_enabled ? "ok" : "private-off" };
    } else {
      const chat = await telegram(settings.token, "getChat", { chat_id: settings.chatId }, { timeoutMs: 6000 });
      if (!chat?.is_forum) result = { enabled: false, reason: "not-forum" };
      else {
        const member = await telegram(settings.token, "getChatMember", {
          chat_id: settings.chatId,
          user_id: Number(botIdOf(settings.token)),
        }, { timeoutMs: 6000 });
        const canManage = member?.status === "creator" || (member?.status === "administrator" && member.can_manage_topics);
        result = canManage
          ? { enabled: true, reason: "ok" }
          : { enabled: false, reason: member?.status === "administrator" ? "no-rights" : "not-admin" };
      }
    }
  } catch {
    return { enabled: cached?.chatId === settings.chatId && cached.enabled === true, reason: "error" };
  }
  await updateState((next) => {
    next.meta.topics = { chatId: settings.chatId, ...result, at: Date.now() };
  });
  return result;
}

export async function topicsEnabled(settings) {
  return (await topicSupport(settings)).enabled;
}

export const TOPIC_REASON_TEXT = {
  ok: L("включены: у каждой сессии своя тема", "on: each session has its own topic"),
  "private-off": L(
    "выключены в личном чате с ботом: включите режим тем в @BotFather (Bot Settings → Threaded Mode)",
    "off in the private chat with the bot: turn on topics in @BotFather (Bot Settings → Threaded Mode)",
  ),
  "not-forum": L(
    "в группе выключены темы: откройте настройки группы и включите «Темы» (Topics)",
    "off in the group: open the group settings and turn on Topics",
  ),
  "not-admin": L(
    "бот не администратор группы: сделайте его админом с правом «Управление темами»",
    "the bot is not a group admin: make it an admin with the “Manage topics” right",
  ),
  "no-rights": L(
    "у бота нет права «Управление темами»: включите его в правах администратора",
    "the bot lacks the “Manage topics” right: turn it on in the admin rights",
  ),
  error: L("не удалось проверить", "could not check"),
};

function threadGone(error) {
  return /thread not found|TOPIC_DELETED|TOPIC_ID_INVALID|topic not found/i.test(error?.description ?? "");
}

function topicClosed(error) {
  return /TOPIC_CLOSED/i.test(error?.description ?? "");
}

export const titleKey = (title) => String(title ?? "").trim().toLowerCase();

/**
 * A restarted session with the same title (new session_id) gets its old topic
 * back, unless another live session still owns it. The ended owner lets go.
 */
export function reusableTopic(state, ctx, chatId) {
  const known = state.meta.topicsByTitle?.[titleKey(ctx.title)];
  if (!known || String(known.chatId) !== String(chatId)) return null;
  const owners = Object.entries(state.sessions).filter(
    ([id, s]) => id !== ctx.sessionId && Number(s.topicId) === Number(known.topicId),
  );
  if (owners.some(([, s]) => !s.ended)) return null;
  for (const [, s] of owners) {
    delete s.topicId;
    delete s.topicName;
  }
  return known;
}

/** Create the session topic lazily, or rename it when the title changed. */
async function ensureTopic(settings, ctx) {
  if (settings.token?.channel) {
    return updateState(async (state) => {
      const session = applyContext(state, ctx);
      const channel = settings.token.channel;
      const name = topicName(ctx.title, ctx.project, session.parent);
      const known = session.discordTopic;
      if (known?.channel === channel) {
        if (known.name !== name) {
          await telegram(settings.token, "editForumTopic", { message_thread_id: known.id, name });
          known.name = name;
        }
        return known.id;
      }
      const description = L(
        `Сессия «${ctx.title ?? "без названия"}»${ctx.project ? ` · ${ctx.project}` : ""}. Ответ здесь уйдёт в эту сессию.`,
        `Session “${ctx.title ?? "untitled"}”${ctx.project ? ` · ${ctx.project}` : ""}. Replies here go to this session.`,
      );
      const topic = await telegram(settings.token, "createForumTopic", { name, description });
      session.discordTopic = { channel, id: topic.message_thread_id, name };
      return topic.message_thread_id;
    });
  }
  return withLock(async () => {
    const state = await readState();
    const session = applyContext(state, ctx);
    const desired = topicName(ctx.title, ctx.project, session.parent);
    if (session.topicId) {
      if (session.topicName !== desired) {
        try {
          await telegram(settings.token, "editForumTopic", {
            chat_id: settings.chatId,
            message_thread_id: session.topicId,
            name: desired,
          }, { timeoutMs: 6000 });
          session.topicName = desired;
        } catch (error) {
          if (/not modified/i.test(error?.description ?? "")) session.topicName = desired;
          else await logLine(`editForumTopic: ${error.message}`);
        }
      }
    } else {
      const reused = reusableTopic(state, ctx, settings.chatId);
      if (reused) {
        session.topicId = reused.topicId;
        session.topicName = reused.topicName;
        session.closed = false;
        if (reused.topicName !== desired) {
          await telegram(settings.token, "editForumTopic", {
            chat_id: settings.chatId,
            message_thread_id: reused.topicId,
            name: desired,
          }, { timeoutMs: 6000 }).then(() => { session.topicName = desired; }).catch(() => {});
        }
      } else {
        try {
          const topic = await telegram(settings.token, "createForumTopic", {
            chat_id: settings.chatId,
            name: desired,
          }, { timeoutMs: 6000 });
          session.topicId = topic.message_thread_id;
          session.topicName = desired;
          session.closed = false;
        } catch (error) {
          await logLine(`createForumTopic: ${error.message}`);
        }
      }
    }
    if (session.topicId) {
      state.meta.topicsByTitle ??= {};
      state.meta.topicsByTitle[titleKey(ctx.title)] = {
        chatId: settings.chatId,
        topicId: session.topicId,
        topicName: session.topicName,
      };
    }
    await writeJsonAtomic(files.sessions(), state);
    return session.topicId ?? null;
  });
}

const PARSE_ERROR = /can't parse entities|unsupported start tag|can't find end tag|unclosed|unexpected end tag/i;

/** Send or edit with HTML; on a parse error retry once as plain text. */
export async function sendHtml(token, method, params) {
  try {
    return await telegram(token, method, params);
  } catch (error) {
    if (!(error instanceof TelegramError) || !PARSE_ERROR.test(error.description)) throw error;
    const plain = { ...params, text: htmlToPlain(params.text) };
    delete plain.parse_mode;
    return telegram(token, method, plain);
  }
}

/**
 * Deliver message parts to the session's topic (created lazily) or the plain chat.
 * Records the sent message ids for reply routing.
 */
export async function deliver(settings, ctx, parts, { silent = false, replyMarkup, replyTo, ping = false } = {}) {
  const options = { silent, replyMarkup, replyTo, ping };
  const discord = settings.notificationTarget === "both" && discordSettings(settings);
  if (!discord) return deliverOne(settings, ctx, parts, options);
  const replyingInDiscord = String(replyTo ?? "").includes(":");
  const mirroredReply = replyTo == null ? undefined : await mirrorId(replyTo);
  const [primary, mirror] = await Promise.allSettled([
    deliverOne(settings, ctx, parts, { ...options, replyTo: replyingInDiscord ? mirroredReply : replyTo }),
    deliverOne(discord, ctx, parts, { ...options, replyTo: replyingInDiscord ? replyTo : mirroredReply }),
  ]);
  if (primary.status === "rejected") await logLine(`Telegram delivery: ${primary.reason.message}`);
  if (mirror.status === "rejected") await logLine(`Discord delivery: ${mirror.reason.message}`);
  if (primary.status === "rejected" && mirror.status === "rejected") throw primary.reason;
  if (primary.status === "rejected") return mirror.value;
  if (mirror.status === "fulfilled") {
    await updateState((state) => {
      const links = (state.meta.messageMirrors ??= {});
      primary.value.messageIds.forEach((id, index) => {
        const other = mirror.value.messageIds[index];
        if (other != null) links[id] = other;
      });
      const keys = Object.keys(links);
      for (const key of keys.slice(0, Math.max(0, keys.length - 4000))) delete links[key];
    });
  }
  return primary.value;
}

export async function mirrorId(messageId) {
  const links = (await readState()).meta.messageMirrors ?? {};
  if (String(messageId).includes(":")) {
    const key = Object.keys(links).find((key) => links[key] === messageId);
    return key == null ? null : Number(key);
  }
  return links[messageId] ?? null;
}

export async function editNotification(settings, method, params) {
  const id = params.message_id;
  const discordMessage = typeof id === "string" && id.includes(":");
  if (discordMessage && settings.notificationTarget === "telegram") return null;
  if (!discordMessage && settings.notificationTarget === "discord") return null;
  const discord = discordSettings(settings);
  const active = settings.notificationTarget === "both" && settings.token?.channel
    ? { ...settings, token: settings.telegramToken, chatId: settings.telegramChatId } : settings;
  const main = discordMessage ? discord : active;
  if (!main?.token) return null;
  const calls = [sendHtml(main.token, method, { ...params, chat_id: main.chatId })];
  if (settings.notificationTarget === "both") {
    const other = discordMessage ? active : discord;
    const otherId = await mirrorId(id);
    if (other?.token && otherId != null) {
      calls.push(sendHtml(other.token, method, { ...params, chat_id: other.chatId, message_id: otherId }));
    }
  }
  const [result, mirror] = await Promise.allSettled(calls);
  if (mirror?.status === "rejected") await logLine(`mirror edit: ${mirror.reason.message}`);
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

async function deliverOne(settings, ctx, parts, { silent, replyMarkup, replyTo, ping }) {
  const discord = Boolean(settings.token?.channel);
  let threadId = settings.threadId || null;
  // The boss lives in General: no topic, plain (thread-less) messages.
  const isBoss =
    Boolean(ctx.sessionId) &&
    ((ctx.host !== "Codex" && isBossTitle(ctx.title)) || resolveBossId(await readState()) === ctx.sessionId);
  const useTopics = !threadId && ctx.sessionId && settings.topics && !isBoss;
  if (useTopics && (await topicsEnabled(settings))) {
    try {
      threadId = await ensureTopic(settings, ctx);
    } catch (error) {
      if (!discord) throw error;
      await logLine(`Discord thread: ${error.message}`);
    }
  }

  const ids = [];
  for (let index = 0; index < parts.length; index += 1) {
    const params = {
      chat_id: settings.chatId,
      text: parts[index],
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      disable_notification: Boolean(silent),
    };
    if (threadId) params.message_thread_id = discord ? threadId : Number(threadId) || threadId;
    if (discord && ping && index === 0) params.ping = true; // Discord only: mention the owner
    if (replyMarkup && index === parts.length - 1) params.reply_markup = replyMarkup;
    if (replyTo && index === 0) {
      params.reply_parameters = { message_id: discord ? replyTo : Number(replyTo), allow_sending_without_reply: true };
    }
    let message;
    try {
      message = await sendHtml(settings.token, "sendMessage", params);
    } catch (error) {
      if (discord && threadId && error.status === 404) {
        await updateState((state) => { delete state.sessions[ctx.sessionId].discordTopic; });
        threadId = await ensureTopic(settings, ctx);
        params.message_thread_id = threadId;
        ids.push((await sendHtml(settings.token, "sendMessage", params)).message_id);
        continue;
      }
      if (!useTopics || !threadId || !(threadGone(error) || topicClosed(error))) throw error;
      // The user deleted or closed the topic: forget it and fall back.
      const closed = topicClosed(error);
      await updateState((state) => {
        const session = state.sessions[ctx.sessionId];
        if (!session) return;
        if (closed) session.closed = true;
        else {
          const map = state.meta.topicsByTitle ?? {};
          for (const [key, value] of Object.entries(map)) {
            if (Number(value.topicId) === Number(session.topicId)) delete map[key];
          }
          delete session.topicId;
          delete session.topicName;
        }
      });
      threadId = closed ? null : await ensureTopic(settings, ctx);
      if (threadId) params.message_thread_id = threadId;
      else delete params.message_thread_id;
      message = await sendHtml(settings.token, "sendMessage", params);
    }
    ids.push(message.message_id);
  }

  if (ctx.sessionId && ids.length) {
    await updateState((state) => {
      const session = applyContext(state, ctx);
      const key = discord ? "discordMessageIds" : "lastMessageIds";
      session[key] = [...(session[key] ?? []), ...ids].slice(-KEEP_MESSAGE_IDS);
      session.lastPostAt = Date.now();
      session.ended = false;
    });
  }
  return { messageIds: ids, threadId };
}

// ------------------------------------------------------------------- routing

const CALLBACK = /^p:([0-9a-f]{16}):(allow|deny)$/;
const SPAWN_CALLBACK = /^s:([0-9a-f]{12}):(go|no)$/;
const USER_CALLBACK = /^u:([\s\S]{1,48})$/;

/**
 * Custom buttons for `post --buttons`: rows of {text, data[, style]}, data <= 48
 * chars. Sent as callback_data "u:<data>" and forwarded to the session on press.
 */
export function buildKeyboard(spec) {
  const value = typeof spec === "string" ? JSON.parse(spec) : spec;
  if (!Array.isArray(value) || !value.length) throw new Error("--buttons must be a JSON array of rows");
  const rows = Array.isArray(value[0]) ? value : [value];
  return {
    inline_keyboard: rows.map((row) => {
      if (!Array.isArray(row) || !row.length) throw new Error("each button row must be a non-empty array");
      return row.map((button) => {
        const text = typeof button?.text === "string" ? button.text.trim() : "";
        const data = typeof button?.data === "string" ? button.data : "";
        if (!text) throw new Error("button text is required");
        if (!data || data.length > 48 || Buffer.byteLength(`u:${data}`) > 64) {
          throw new Error(`button data must be 1-48 characters: ${JSON.stringify(data)}`);
        }
        const out = { text, callback_data: `u:${data}` };
        if (["danger", "success", "primary"].includes(button.style)) out.style = button.style;
        return out;
      });
    }),
  };
}

function buttonText(message, callbackData) {
  for (const row of message?.reply_markup?.inline_keyboard ?? []) {
    for (const button of row) if (button.callback_data === callbackData) return button.text;
  }
  return "";
}

function sessionForMessage(entries, message) {
  if (message?.is_topic_message && message.message_thread_id != null) {
    const byTopic = entries.find(([, s]) => !s.ended && String(s.topicId) === String(message.message_thread_id))
      ?? entries.find(([, s]) => String(s.topicId) === String(message.message_thread_id));
    if (byTopic) return byTopic[0];
  }
  return entries.find(([, s]) => (s.lastMessageIds ?? []).includes(message?.message_id))?.[0] ?? null;
}

export function parseCallbackData(data) {
  const match = CALLBACK.exec(String(data ?? ""));
  return match ? { requestId: match[1], behavior: match[2] } : null;
}

/** Only the configured chat, and in it only the owner (never a bot). */
function fromOwner(chat, from, chatId, ownerUserId) {
  if (String(chat?.id) !== String(chatId)) return false;
  // In a private chat the owner's user id equals the chat id.
  const owner = ownerUserId || (isPrivateChatId(chatId) ? chatId : "");
  if (!owner || String(from?.id) !== String(owner)) return false;
  return !from?.is_bot;
}

/** Decide what an update means. Pure: no I/O. Anything not from the owner is ignored. */
export function routeUpdate(update, { chatId, ownerUserId = "", sessions = {}, bossId = null }) {
  const query = update?.callback_query;
  if (query) {
    if (!fromOwner(query.message?.chat, query.from, chatId, ownerUserId)) return { type: "ignore" };
    const custom = USER_CALLBACK.exec(String(query.data ?? ""));
    if (custom) {
      return {
        type: "button",
        callbackId: query.id,
        sessionId: sessionForMessage(Object.entries(sessions), query.message),
        data: custom[1],
        text: buttonText(query.message, query.data),
        messageId: query.message.message_id,
        threadId: query.message.is_topic_message ? query.message.message_thread_id ?? null : null,
      };
    }
    const questionPress = QUESTION_CALLBACK.exec(String(query.data ?? ""));
    if (questionPress) {
      return {
        type: "question",
        callbackId: query.id,
        requestId: questionPress[1],
        qi: Number(questionPress[2]),
        choice: questionPress[3],
        chatId: query.message.chat.id,
        messageId: query.message.message_id,
      };
    }
    const spawnPress = SPAWN_CALLBACK.exec(String(query.data ?? ""));
    if (spawnPress) {
      return {
        type: "spawn",
        callbackId: query.id,
        requestId: spawnPress[1],
        go: spawnPress[2] === "go",
        chatId: query.message.chat.id,
        messageId: query.message.message_id,
      };
    }
    const parsed = parseCallbackData(query.data);
    if (!parsed) return { type: "callback-unknown", callbackId: query.id };
    return {
      type: "callback",
      callbackId: query.id,
      chatId: query.message.chat.id,
      messageId: query.message.message_id,
      ...parsed,
    };
  }

  const message = update?.message;
  if (!message || !fromOwner(message.chat, message.from, chatId, ownerUserId)) return { type: "ignore" };
  const command = /^\/(away|here|mute|status)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(
    typeof message.text === "string" ? message.text.trim() : "",
  );
  if (command) {
    return {
      type: "command",
      name: command[1].toLowerCase(),
      arg: (command[2] ?? "").trim(),
      messageId: message.message_id,
      threadId: message.message_thread_id ?? null,
    };
  }
  const entries = Object.entries(sessions);
  // A real forum topic (not General, not a reply thread in a plain group).
  const inTopic =
    message.message_thread_id != null &&
    (message.is_topic_message === true || Boolean(message.forum_topic_closed || message.forum_topic_reopened));
  let sessionId = null;
  if (inTopic) {
    sessionId =
      (entries.find(([, s]) => !s.ended && String(s.topicId) === String(message.message_thread_id))
        ?? entries.find(([, s]) => String(s.topicId) === String(message.message_thread_id)))?.[0] ?? null;
  }
  if (sessionId && message.forum_topic_closed) return { type: "topic-closed", sessionId };
  if (sessionId && message.forum_topic_reopened) return { type: "topic-reopened", sessionId };
  const replyTo = message.reply_to_message?.message_id;
  if (!sessionId && replyTo != null) {
    sessionId = entries.find(([, s]) => (s.lastMessageIds ?? []).includes(replyTo))?.[0] ?? null;
  }
  const text = typeof message.text === "string" ? message.text : message.caption;
  if (typeof text !== "string" || !text.trim() || /^\/start\b/.test(text)) return { type: "ignore" };
  if (!sessionId) {
    if (inTopic) return { type: "ignore" }; // a topic of a forgotten session
    // General (or the plain chat): the boss session.
    if (!bossId) return { type: "no-boss", messageId: message.message_id, threadId: null };
    sessionId = bossId;
  }
  // In a forum topic every message "replies" to the topic root; only real replies count.
  const explicitReply =
    replyTo != null &&
    replyTo !== message.message_thread_id &&
    !message.reply_to_message?.forum_topic_created
      ? replyTo
      : null;
  return {
    type: "message",
    sessionId,
    text: text.trim(),
    messageId: message.message_id,
    threadId: message.message_thread_id ?? null,
    replyTo: explicitReply,
  };
}

// ------------------------------------------------------------------- waiters

/** Register a new waiter; any older waiter of the session is superseded. */
export function claimWaiter(state, sessionId, pid, now = Date.now()) {
  const session = (state.sessions[sessionId] ??= { createdAt: now });
  const gen = (session.waiterGen ?? 0) + 1;
  session.waiterGen = gen;
  session.waiter = { pid, gen, since: now };
  return gen;
}

export function waiterStatus(session, gen) {
  if (!session || session.waiterGen !== gen) return "superseded";
  if (session.ended) return "ended";
  if (session.closed) return "closed";
  if (session.muted) return "muted";
  return "active";
}

export function hasLiveWaiter(session, alive = pidAlive) {
  return Boolean(session?.waiter && session.waiter.gen === session.waiterGen && alive(session.waiter.pid));
}

export async function takeInbox(sessionId) {
  return withLock(async () => {
    const file = files.inbox(sessionId);
    const raw = await fsp.readFile(file, "utf8").catch(() => "");
    if (!raw.trim()) return [];
    await fsp.rm(file, { force: true });
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry && (typeof entry.text === "string" || entry.kind === "button"));
  });
}

/** One structured line per Telegram event, as Claude sees it in the wake-up reminder. */
export function formatReplies(entries) {
  return entries
    .map((entry) => {
      if (entry.kind === "notify") return L(`Сессия «${entry.from}» сообщает: ${entry.text}`, `Session “${entry.from}” says: ${entry.text}`);
      if (entry.kind === "button" && isTurnAnswerData(entry.data) && entry.buttonText) {
        return `${REPLY_PREFIX} ${entry.buttonText}`;
      }
      if (entry.kind === "button") {
        return L(
          `Telegram: кнопка «${entry.buttonText || entry.data}» data=${entry.data} на сообщении ${entry.messageId}`,
          `Telegram: button “${entry.buttonText || entry.data}” data=${entry.data} on message ${entry.messageId}`,
        );
      }
      if (entry.replyTo) {
        return L(`Telegram: ответ на сообщение ${entry.replyTo}: ${entry.text}`, `Telegram: reply to message ${entry.replyTo}: ${entry.text}`);
      }
      return `${REPLY_PREFIX} ${entry.text}`;
    })
    .join("\n\n");
}

/** True for a prompt that came from the Telegram waiter rather than the keyboard. */
export const isTelegramPrompt = (prompt) =>
  typeof prompt === "string" &&
  (prompt.includes(REPLY_PREFIX_RU) || prompt.includes(REPLY_PREFIX_EN) || /(^|\n)Telegram: /.test(prompt));

/**
 * Wait for the user's next Telegram message for this session.
 * Returns { code: 2, text } to wake Claude, or { code: 0 } to exit quietly.
 */
export async function waitForReply(event, { pollMs = 1000, maxMs = WAITER_MAX_MS } = {}) {
  const settings = await loadSettings();
  if (!settings.token || !settings.chatId || !settings.chatReplies || !event?.session_id) {
    return { code: 0 };
  }
  const sessionId = safeSessionId(event.session_id);
  // Headless workers: claude -p waits for asyncRewake hooks before it exits, so a
  // waiter would keep the run alive for hours. The daemon resumes them instead.
  if (process.env.TELEGRAM_BRIDGE_HEADLESS === "1" || (await readState()).sessions[sessionId]?.headless) {
    return { code: 0 };
  }
  const gen = await updateState((state) => claimWaiter(state, sessionId, process.pid));
  await ensureDaemon();
  const started = Date.now();
  let lastDaemonCheck = Date.now();
  let lastProbe = Date.now();
  try {
    while (Date.now() - started < maxMs) {
      const state = await readState();
      const session = state.sessions[sessionId];
      if (waiterStatus(session, gen) !== "active") return { code: 0 };
      const routable = session.topicId || (session.lastMessageIds ?? []).length || resolveBossId(state) === sessionId;
      if (!routable && Date.now() - started > 60_000) {
        return { code: 0 }; // nothing the user could reply to
      }
      const entries = await takeInbox(sessionId);
      if (entries.length) {
        const last = entries.filter((entry) => entry.kind !== "button" && entry.messageId).at(-1);
        await updateState((next) => {
          if (next.sessions[sessionId]) next.sessions[sessionId].replyToTelegram = true; // this turn answers in Telegram
        });
        // The session is back at work: count it until its Stop.
        await markTurn(sessionId, true);
        if (last) {
          const fromDiscord = String(last.messageId).includes(":");
          const target = fromDiscord ? discordSettings(settings) : settings;
          await telegram(target?.token, "setMessageReaction", {
            chat_id: target?.chatId,
            message_id: last.messageId,
            reaction: [{ type: "emoji", emoji: "👀" }],
          }, { timeoutMs: 5000 }).catch(() => {});
        }
        return { code: 2, text: formatReplies(entries) };
      }
      if (Date.now() - lastDaemonCheck > 30_000) {
        lastDaemonCheck = Date.now();
        await ensureDaemon();
      }
      if (session.topicId && Date.now() - lastProbe > 15 * 60_000) {
        lastProbe = Date.now();
        if (await topicDeleted(settings, session)) {
          await updateState((next) => {
            const current = next.sessions[sessionId];
            if (current?.topicId === session.topicId) {
              delete current.topicId;
              delete current.topicName;
            }
          });
          return { code: 0 };
        }
      }
      await sleep(pollMs);
    }
    return { code: 0 };
  } finally {
    await updateState((state) => {
      const session = state.sessions[sessionId];
      if (session?.waiter?.gen === gen) delete session.waiter;
    }).catch(() => {});
  }
}

/** Probe a topic by re-applying its name; only explicit "not found" errors count. */
async function topicDeleted(settings, session) {
  try {
    await telegram(settings.token, "editForumTopic", {
      chat_id: settings.chatId,
      message_thread_id: session.topicId,
      name: session.topicName,
    }, { timeoutMs: 6000 });
    return false;
  } catch (error) {
    return threadGone(error);
  }
}

// ----------------------------------------------------------------- approvals

export function approvalKeyboard(requestId) {
  return {
    inline_keyboard: [[
      { text: L("✅ Разрешить", "✅ Allow"), callback_data: `p:${requestId}:allow`, style: "success" },
      { text: L("❌ Отклонить", "❌ Deny"), callback_data: `p:${requestId}:deny`, style: "danger" },
    ]],
  };
}

export const OUTCOME_TEXT = {
  allow: L("✅ <b>Разрешено в Telegram</b>", "✅ <b>Allowed in Telegram</b>"),
  deny: L("❌ <b>Отклонено в Telegram</b>", "❌ <b>Denied in Telegram</b>"),
  "allow-discord": L("✅ <b>Разрешено в Discord</b>", "✅ <b>Allowed in Discord</b>"),
  "deny-discord": L("❌ <b>Отклонено в Discord</b>", "❌ <b>Denied in Discord</b>"),
  timeout: L("⏱ <i>Ответа нет — решите в приложении</i>", "⏱ <i>No answer — decide in the app</i>"),
  "timeout-denied": L("⏱ <i>Ответа нет — запрос отклонён</i>", "⏱ <i>No answer — request denied</i>"),
  cancelled: L("↩️ <i>Запрос закрыт в приложении</i>", "↩️ <i>Request closed in the app</i>"),
  app: L("✓ <i>Решено в приложении</i>", "✓ <i>Decided in the app</i>"),
};

async function readOutcome(requestId) {
  const value = await readJson(files.approval(requestId, "res"), null);
  return value?.behavior ? value : null;
}

const decided = (outcome) =>
  outcome.behavior === "allow" || outcome.behavior === "deny" ? outcome.behavior : null;

/**
 * Send an approval request with buttons and wait up to `waitSec`.
 * Returns "allow" | "deny" | null (null: let the normal dialog decide).
 * While waiting it is also a pending item, so PostToolUse/UserPromptSubmit
 * (the user answered in the app) end the wait early.
 */
export async function requestApproval(settings, ctx, html, waitSec, { pollMs = 400, toolName = null, timeoutOutcome = "timeout", keyboard = approvalKeyboard, graceSec = 0, silent = false, presenceEveryMs = 10_000 } = {}) {
  const requestId = randomBytes(8).toString("hex");
  const request = files.approval(requestId, "req");
  await writeJsonAtomic(request, { sessionId: ctx.sessionId, html, pid: process.pid, createdAt: Date.now() });
  let sent;
  let pendingId = null;
  const finish = async (behavior) => {
    if (!(await createExclusive(files.approval(requestId, "res"), { behavior, at: Date.now() }))) return false;
    if (sent?.messageIds?.length) {
      await editNotification(settings, "editMessageText", {
        chat_id: settings.chatId,
        message_id: sent.messageIds.at(-1),
        text: `${html}\n\n${OUTCOME_TEXT[behavior]}`,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }).catch((error) => logLine(`edit approval: ${error.message}`));
    }
    return true;
  };

  const onSignal = () => {
    finish("cancelled").finally(() => process.exit(0));
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  const pendingAlive = async () => Boolean((await readState()).pending[pendingId]);
  try {
    await ensureDaemon();
    // The owner is at the Mac: give the app dialog `graceSec` first (a held item the
    // daemon never sends; an answer in the app removes it), then send the buttons.
    pendingId = await addPending({ kind: "approval", ctx, parts: [html], toolName, hold: true });
    const graceEnd = Date.now() + graceSec * 1000;
    let checkedAt = Date.now();
    while (Date.now() < graceEnd) {
      if (!(await pendingAlive())) return null;
      if (Date.now() - checkedAt >= presenceEveryMs) {
        checkedAt = Date.now();
        const presence = await detectPresence({ idleThresholdSec: settings.presenceIdleSec, claude: true }).catch(() => ({ present: true }));
        if (!presence.present) break;
      }
      await sleep(pollMs);
    }
    if (!(await pendingAlive())) return null;
    sent = await deliver(settings, ctx, [html], {
      ping: true,
      replyMarkup: keyboard(requestId),
      silent: silent || isQuietTime(settings.quietHours),
    });
    await updateState((state) => {
      const item = state.pending[pendingId];
      if (!item) return;
      delete item.hold;
      item.sent = true;
      item.requestId = requestId;
      item.messageIds = sent.messageIds;
    });
    const deadline = Date.now() + waitSec * 1000;
    while (Date.now() < deadline) {
      const outcome = await readOutcome(requestId);
      if (outcome) return decided(outcome);
      if (!(await pendingAlive())) {
        await finish("app");
        return null;
      }
      await sleep(pollMs);
    }
    if (await finish(timeoutOutcome)) return null;
    // A button press or app resolution won the race at the last moment.
    for (let i = 0; i < 10; i += 1) {
      const outcome = await readOutcome(requestId);
      if (outcome) return decided(outcome);
      await sleep(100);
    }
    return null;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    if (pendingId) await removePending(pendingId).catch(() => {});
    await fsp.rm(request, { force: true }).catch(() => {});
    await fsp.rm(files.approval(requestId, "res"), { force: true }).catch(() => {});
  }
}

export function permissionDecision(behavior) {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision:
        behavior === "allow"
          ? { behavior: "allow" }
          : { behavior: "deny", message: L("Отклонено пользователем кнопкой в Telegram или Discord", "Denied by the user with a button in Telegram or Discord") },
    },
  };
}

// ---------------------------------------------------------- delayed delivery

/** Queue an outbound item; the daemon sends it on the deadline or when the user leaves. */
export async function addPending({ kind, ctx, parts, silent = false, delaySec = 0, toolName = null, sent = false, requestId = null, messageIds = [], replyMarkup = null, hold = false }) {
  const id = randomBytes(6).toString("hex");
  const now = Date.now();
  await updateState((state) => {
    state.pending[id] = {
      id,
      kind,
      sessionId: ctx.sessionId,
      ctx,
      parts,
      silent: Boolean(silent),
      toolName,
      createdAt: now,
      dueAt: now + delaySec * 1000,
      sent,
      requestId,
      messageIds,
      ...(replyMarkup ? { replyMarkup } : {}),
      ...(hold ? { hold: true } : {}),
    };
  });
  if (!sent) await ensureDaemon();
  return id;
}

async function removePending(id) {
  await updateState((state) => {
    delete state.pending[id];
  });
}

/**
 * Mark a session's pending items resolved. Unsent items are cancelled; sent ones
 * are edited by the daemon when `edit` is set ("✓ Решено в приложении").
 * With `toolName`, only the oldest approval for that tool is resolved.
 */
export function resolvePendingIn(state, sessionId, { kinds = ["approval", "action", "alert"], toolName = null, edit = true } = {}) {
  let items = Object.values(state.pending)
    .filter((item) => item.sessionId === sessionId && kinds.includes(item.kind) && !item.resolved)
    .sort((a, b) => a.createdAt - b.createdAt);
  if (toolName) items = items.filter((item) => item.toolName === toolName).slice(0, 1);
  let toEdit = 0;
  for (const item of items) {
    if (item.sent && edit) {
      item.resolved = true;
      toEdit += 1;
    } else if (item.sent && item.messageIds?.length) {
      // Keep the text, but the daemon still removes the Discord ping: nothing is waiting on the owner.
      item.resolved = true;
      item.keepText = true;
      toEdit += 1;
    } else {
      delete state.pending[item.id];
    }
  }
  return toEdit;
}

export async function resolvePending(sessionId, options) {
  if (!sessionId) return 0;
  const state = await readState();
  if (!Object.values(state.pending).some((item) => item.sessionId === sessionId)) return 0; // fast path
  const toEdit = await updateState((next) => resolvePendingIn(next, sessionId, options));
  if (toEdit) await ensureDaemon();
  return toEdit;
}

/** Remove the leading @owner mention from the Discord copy of a message (no-op elsewhere). */
export async function clearOwnerMention(settings, messageId) {
  const discord = discordSettings(settings);
  if (!discord || messageId == null) return;
  const id = String(messageId).includes(":")
    ? messageId
    : settings.notificationTarget === "both" ? await mirrorId(messageId) : null;
  if (!id) return;
  await telegram(discord.token, "removeOwnerMention", { message_id: id })
    .catch((error) => logLine(`clear mention: ${error.message}`));
}

async function processPending(settings, presence) {
  const state = await readState();
  const now = Date.now();
  const mode = effectiveMode(settings, state.meta, now);
  for (const item of Object.values(state.pending)) {
    const action = pendingAction(item, { present: presence.present, mode: mode.mode, muteUntil: mode.muteUntil, now });
    if (action === "wait") continue;
    if (action === "drop") {
      await removePending(item.id);
      continue;
    }
    if (action === "edit-resolved") {
      // A hook still waiting on buttons learns about the app decision via its outcome file.
      const claimed = item.requestId
        ? await createExclusive(files.approval(item.requestId, "res"), { behavior: "app", at: now })
        : true;
      if (item.messageIds?.length) await clearOwnerMention(settings, item.messageIds[0]);
      if (claimed && item.messageIds?.length && !item.keepText) {
        await editNotification(settings, "editMessageText", {
          chat_id: settings.chatId,
          message_id: item.messageIds.at(-1),
          text: `${item.parts.at(-1)}\n\n${OUTCOME_TEXT.app}`,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }).catch((error) => logLine(`edit resolved: ${error.message}`));
      }
      await removePending(item.id);
      continue;
    }
    // send
    try {
      const sent = await deliver(settings, item.ctx, item.parts, {
        silent: item.silent || isQuietTime(settings.quietHours),
        replyMarkup: item.replyMarkup ?? undefined,
        ping: item.kind !== "turn",
      });
      await updateState((next) => {
        const current = next.pending[item.id];
        if (!current) return;
        current.sent = true;
        current.messageIds = sent.messageIds;
      });
    } catch (error) {
      await logLine(`pending ${item.id}: ${error.message}`);
      await updateState((next) => {
        const current = next.pending[item.id];
        if (!current) return;
        current.attempts = (current.attempts ?? 0) + 1;
        if (current.attempts >= 5) delete next.pending[item.id];
      });
    }
  }
}

// -------------------------------------------------------------------- daemon

export async function readDaemonPid() {
  const raw = await fsp.readFile(files.pid(), "utf8").catch(() => "");
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) ? pid : null;
}

export async function daemonStatus() {
  const pid = await readDaemonPid();
  const info = await readJson(files.daemon(), {});
  const running = Boolean(pid && pidAlive(pid));
  return {
    running,
    pid: running ? pid : null,
    startedAt: running ? info.startedAt ?? null : null,
    lastPollAt: info.lastPollAt ?? null,
  };
}

/** Spawn the detached poller unless a live one holds the pid file. */
export async function ensureDaemon() {
  const pid = await readDaemonPid();
  if (pid && pidAlive(pid)) return pid;
  await ensureDir(stateDir());
  const child = spawn(process.execPath, [ENTRY_SCRIPT, "daemon"], {
    detached: true,
    stdio: "ignore",
    cwd: os.homedir(),
    env: process.env,
  });
  child.unref();
  return child.pid;
}

export async function stopDaemon() {
  const pid = await readDaemonPid();
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    for (let i = 0; i < 30 && pidAlive(pid); i += 1) await sleep(100);
  }
  if (pid && !pidAlive(pid)) await fsp.rm(files.pid(), { force: true });
  return pid;
}

async function acquirePidFile() {
  await ensureDir(stateDir());
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fsp.writeFile(files.pid(), String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const pid = await readDaemonPid();
      if (pid && pid !== process.pid && pidAlive(pid)) return false;
      await fsp.rm(files.pid(), { force: true });
    }
  }
  return false;
}

/** A headless worker the daemon still answers for: not ended, not closed, recently active. */
export function listeningWorker(session, now = Date.now()) {
  return Boolean(session?.headless && !session.ended && !session.closed && now - (session.updatedAt ?? 0) < HEADLESS_LISTEN_MS);
}

async function hasLiveClients() {
  const state = await readState();
  if (Object.values(state.sessions).some((session) => hasLiveWaiter(session) || listeningWorker(session))) return true;
  if (Object.keys(state.spawns ?? {}).length) return true;
  if (Object.values(state.pending).some((item) => !item.sent || item.resolved === true)) return true;
  const dir = path.dirname(files.approval("x", "req"));
  const names = await fsp.readdir(dir).catch(() => []);
  let live = false;
  for (const name of names) {
    const file = path.join(dir, name);
    if (name.endsWith(".res.json")) {
      const info = await fsp.stat(file).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 86_400_000) await fsp.rm(file, { force: true });
      continue;
    }
    if (!name.endsWith(".req.json")) continue;
    const request = await readJson(file, null);
    if (request && pidAlive(request.pid)) live = true;
    else if (!request || Date.now() - (request.createdAt ?? 0) > 86_400_000) await fsp.rm(file, { force: true });
  }
  return live;
}

export async function appendInbox(sessionId, entry) {
  await withLock(async () => {
    await ensureDir(path.dirname(files.inbox(sessionId)));
    await fsp.appendFile(files.inbox(sessionId), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  });
}

// ----------------------------------------------------------------- questions

/**
 * Ask an AskUserQuestion in Telegram with one button per option and wait.
 * During `graceSec` it only watches: the owner may answer in the app, or leave
 * the Mac (then it sends at once). Returns the answers object, or null when the
 * question was answered in the app, timed out or was cancelled.
 */
export async function requestAnswer(settings, ctx, html, questions, { graceSec = 0, silent = false, waitSec = QUESTION_WAIT_SEC, pollMs = 500, presenceEveryMs = 10_000 } = {}) {
  const requestId = newRequestId();
  const reqFile = files.approval(requestId, "req");
  const resFile = files.approval(requestId, "res");
  const request = { kind: "question", sessionId: ctx.sessionId, html, questions, pid: process.pid, createdAt: Date.now(), messageIds: [] };
  await writeJsonAtomic(reqFile, request);
  let pendingId = null;
  let sent = null;
  const pendingAlive = async () => Boolean((await readState()).pending[pendingId]);
  const close = async (behavior, note) => {
    if (!(await createExclusive(resFile, { behavior, at: Date.now() }))) return false;
    if (sent?.messageIds?.length) {
      await editNotification(settings, "editMessageText", {
        chat_id: settings.chatId,
        message_id: sent.messageIds.at(-1),
        text: `${html}\n\n${note}`,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }).catch((error) => logLine(`edit question: ${error.message}`));
    }
    return true;
  };
  const onSignal = () => {
    close("cancelled", OUTCOME_TEXT.cancelled).finally(() => process.exit(0));
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  try {
    await ensureDaemon();
    // A held item: the daemon never sends it, and an answer in the app removes it.
    pendingId = await addPending({ kind: "approval", ctx, parts: [html], toolName: "AskUserQuestion", hold: true });
    const graceEnd = Date.now() + graceSec * 1000;
    let checkedAt = Date.now();
    while (Date.now() < graceEnd) {
      if (!(await pendingAlive())) return null;
      if (Date.now() - checkedAt >= presenceEveryMs) {
        checkedAt = Date.now();
        const presence = await detectPresence({ idleThresholdSec: settings.presenceIdleSec, claude: true }).catch(() => ({ present: true }));
        if (!presence.present) break;
      }
      await sleep(pollMs);
    }
    if (!(await pendingAlive())) return null;
    sent = await deliver(settings, ctx, [html], {
      ping: true,
      replyMarkup: questionKeyboard(requestId, questions),
      silent: silent || isQuietTime(settings.quietHours),
    });
    await writeJsonAtomic(reqFile, { ...request, messageIds: sent.messageIds });
    await updateState((state) => {
      const item = state.pending[pendingId];
      if (!item) return;
      delete item.hold;
      item.sent = true;
      item.requestId = requestId;
      item.messageIds = sent.messageIds;
    });
    const deadline = Date.now() + waitSec * 1000;
    while (Date.now() < deadline) {
      const outcome = await readJson(resFile, null);
      if (outcome) return outcome.behavior === "answer" ? outcome.answers : null;
      if (!(await pendingAlive())) {
        await close("app", OUTCOME_TEXT.app);
        return null;
      }
      await sleep(pollMs);
    }
    if (await close("timeout", OUTCOME_TEXT.timeout)) return null;
    const outcome = await readJson(resFile, null);
    return outcome?.behavior === "answer" ? outcome.answers : null;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    if (pendingId) await removePending(pendingId).catch(() => {});
    for (const kind of ["req", "res", "sel"]) await fsp.rm(files.approval(requestId, kind), { force: true }).catch(() => {});
  }
}

export function questionDecision(toolInput, answers) {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: { ...toolInput, answers } },
    },
  };
}

async function liveQuestion(requestId) {
  const request = await readJson(files.approval(requestId, "req"), null);
  if (!request || request.kind !== "question" || !pidAlive(request.pid)) return null;
  if (await readJson(files.approval(requestId, "res"), null)) return null;
  return request;
}

async function saveSelections(settings, requestId, request, selections, messageId) {
  if (allAnswered(request.questions, selections)) {
    const answers = answersFrom(request.questions, selections);
    if (!(await createExclusive(files.approval(requestId, "res"), { behavior: "answer", answers, at: Date.now() }))) return "late";
    await editNotification(settings, "editMessageText", {
      chat_id: settings.chatId,
      message_id: messageId,
      text: `${request.html}\n\n${answeredText(request.questions, selections)}`,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch((error) => logLine(`edit answered question: ${error.message}`));
    return "answered";
  }
  await writeJsonAtomic(files.approval(requestId, "sel"), selections);
  await editNotification(settings, "editMessageReplyMarkup", {
    chat_id: settings.chatId,
    message_id: messageId,
    reply_markup: questionKeyboard(requestId, request.questions, selections),
  }).catch((error) => logLine(`edit question keyboard: ${error.message}`));
  return "partial";
}

async function handleQuestionPress(settings, route) {
  const toast = (text) =>
    telegram(settings.token, "answerCallbackQuery", { callback_query_id: route.callbackId, text }).catch(() => {});
  const request = await liveQuestion(route.requestId);
  if (!request) return toast(L("Вопрос уже закрыт", "Question already closed"));
  const selections = applyPress(request.questions, await readJson(files.approval(route.requestId, "sel"), {}), route.qi, route.choice);
  const result = await saveSelections(settings, route.requestId, request, selections, route.messageId);
  return toast(
    result === "answered" ? L("Ответ передан", "Answer sent") : result === "late" ? L("Уже отвечено", "Already answered") : L("Отмечено", "Selected"),
  );
}

/** Free text in the session's topic, or a reply to a question, answers the open question. */
async function answerQuestionWithText(settings, route) {
  let names;
  try {
    names = await fsp.readdir(path.dirname(files.approval("x", "req")));
  } catch {
    return false;
  }
  const open = [];
  for (const name of names.filter((n) => n.endsWith(".req.json"))) {
    const requestId = name.slice(0, -".req.json".length);
    const request = await liveQuestion(requestId);
    if (request?.messageIds?.length) open.push({ requestId, request });
  }
  const match =
    (route.replyTo != null && open.find((q) => q.request.messageIds.includes(route.replyTo))) ||
    open.filter((q) => q.request.sessionId === route.sessionId).sort((a, b) => b.request.createdAt - a.request.createdAt)[0];
  if (!match) return false;
  const selections = applyText(match.request.questions, await readJson(files.approval(match.requestId, "sel"), {}), route.text);
  await saveSelections(settings, match.requestId, match.request, selections, match.request.messageIds.at(-1));
  await telegram(settings.token, "setMessageReaction", {
    chat_id: settings.chatId,
    message_id: route.messageId,
    reaction: [{ type: "emoji", emoji: "👌" }],
  }, { timeoutMs: 5000 }).catch(() => {});
  return true;
}

async function handleCallback(settings, route) {
  const answer = (text) =>
    telegram(settings.token, "answerCallbackQuery", { callback_query_id: route.callbackId, text })
      .catch(() => {});
  const request = await readJson(files.approval(route.requestId, "req"), null);
  if (!request || !pidAlive(request.pid)) return answer(L("Запрос уже закрыт", "Request already closed"));
  if (!(await createExclusive(files.approval(route.requestId, "res"), { behavior: route.behavior, at: Date.now() }))) {
    return answer(L("Уже решено", "Already decided"));
  }
  await answer(route.behavior === "allow" ? L("Разрешено", "Allowed") : L("Отклонено", "Denied"));
  await editNotification(settings, "editMessageText", {
    chat_id: route.chatId,
    message_id: route.messageId,
    // Say where the owner pressed: a Discord token is an object with a channel.
    text: `${request.html}\n\n${OUTCOME_TEXT[settings.token?.channel ? `${route.behavior}-discord` : route.behavior]}`,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  }).catch((error) => logLine(`edit after button: ${error.message}`));
}

const clock = (ms) => new Date(ms).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

const MODE_LABEL = { smart: L("умный", "smart"), always: L("всегда", "always"), never: L("никогда", "never") };
const STATUS_LABEL = {
  waiting: L("ждёт ответа", "waiting for a reply"),
  active: L("активна", "active"),
  ended: L("завершена", "ended"),
  "notify-only": L("только уведомления (Codex)", "notifications only (Codex)"),
};

export function describePresence(presence) {
  if (presence.reason === "locked") return L("экран заблокирован", "screen locked");
  if (presence.idleSec == null) return L("не определено — считаю, что вас нет", "unknown — assuming you are away");
  const idle = presence.idleSec < 90
    ? L(`${Math.round(presence.idleSec)} с`, `${Math.round(presence.idleSec)} s`)
    : L(`${Math.round(presence.idleSec / 60)} мин`, `${Math.round(presence.idleSec / 60)} min`);
  return presence.present
    ? L(`за компьютером (без действий ${idle})`, `at the computer (idle ${idle})`)
    : L(`отошли (без действий ${idle})`, `away (idle ${idle})`);
}

export function statusText(settings, state, presence, now = Date.now()) {
  const mode = effectiveMode(settings, state.meta, now);
  const lines = [L("<b>Статус</b>", "<b>Status</b>")];
  lines.push(
    L(
      `Режим: ${MODE_LABEL[mode.mode] ?? mode.mode}${mode.overridden ? ` (до ${clock(mode.overrideUntil)})` : " (из настроек)"}`,
      `Mode: ${MODE_LABEL[mode.mode] ?? mode.mode}${mode.overridden ? ` (until ${clock(mode.overrideUntil)})` : " (from settings)"}`,
    ),
  );
  lines.push(L(`Пауза: ${mode.muteUntil ? `до ${clock(mode.muteUntil)}` : "нет"}`, `Paused: ${mode.muteUntil ? `until ${clock(mode.muteUntil)}` : "no"}`));
  lines.push(L(`Вы: ${describePresence(presence)}`, `You: ${describePresence(presence)}`));
  const topics = state.meta.topics?.chatId === settings.chatId ? state.meta.topics : null;
  const topicsText = topics ? TOPIC_REASON_TEXT[topics.reason] ?? topics.reason : L("ещё не проверялись", "not checked yet");
  lines.push(L(
    `Чат: ${isPrivateChatId(settings.chatId) ? "личный" : "группа"}, темы ${topicsText}`,
    `Chat: ${isPrivateChatId(settings.chatId) ? "private" : "group"}, topics ${topicsText}`,
  ));
  const bossId = resolveBossId(state);
  const dormant = bossId ? null : dormantBossId(state);
  const bossText = bossId
    ? `${escapeHtml(state.sessions[bossId].title ?? L("Босс", "Boss"))}${hasLiveWaiter(state.sessions[bossId])
      ? L(" — ждёт сообщений в General", " — waiting for messages in General")
      : L(" — занят или не слушает", " — busy or not listening")}`
    : dormant && settings.bossRevive
      ? L("приложение его не держит — разбужу по сообщению в General", "not running in the app — a message in General will wake it")
      : L("не запущен", "not running");
  lines.push(L(`Босс: ${bossText}`, `Boss: ${bossText}`));
  const sessions = Object.entries(state.sessions)
    .map(([id, session]) => describeSession(id, session, pidAlive, resolveBossId(state)))
    .filter((session) => session.status !== "ended")
    .sort((a, b) => (b.lastPostAt ?? 0) - (a.lastPostAt ?? 0))
    .slice(0, 15);
  lines.push("", sessions.length ? L("<b>Сессии</b>", "<b>Sessions</b>") : L("Активных сессий нет.", "No active sessions."));
  for (const session of sessions) {
    const project = session.project && session.project !== session.title ? ` · ${escapeHtml(session.project)}` : "";
    const muted = `${session.headless ? L(", без окна", ", headless") : ""}${session.muted ? L(", заглушена", ", muted") : ""}`;
    lines.push(`• ${escapeHtml(session.title)}${project} — ${STATUS_LABEL[session.status] ?? session.status}${muted}`);
  }
  lines.push("", L(
    "<i>/away — присылать всё сразу, /here — умный режим, /mute 30m — пауза</i>",
    "<i>/away — send everything now, /here — smart mode, /mute 30m — pause</i>",
  ));
  return lines.join("\n");
}

async function handleCommand(settings, route, presenceNow) {
  const reply = (text) => {
    const params = { chat_id: settings.chatId, text, parse_mode: "HTML", disable_notification: true };
    if (route.threadId) params.message_thread_id = route.threadId;
    return sendHtml(settings.token, "sendMessage", params).catch(() => {});
  };
  const now = Date.now();
  const halfDay = 12 * 3600_000;
  if (route.name === "away") {
    await updateState((state) => {
      state.meta.override = { mode: "always", until: now + halfDay };
    });
    return reply(L(
      `Понял, вы не у компьютера. Присылаю всё сразу до ${clock(now + halfDay)} или до команды /here.`,
      `Got it, you are away. Sending everything until ${clock(now + halfDay)} or until /here.`,
    ));
  }
  if (route.name === "here") {
    await updateState((state) => {
      state.meta.override = { mode: "smart", until: now + halfDay };
      delete state.meta.muteUntil;
    });
    return reply(L(
      "Умный режим: пока вы за компьютером, пишу сюда, только если вы не ответили в приложении.",
      "Smart mode: while you are at the computer, I post here only if you did not answer in the app.",
    ));
  }
  if (route.name === "mute") {
    const ms = parseMuteDuration(route.arg);
    if (ms == null) return reply(L("Не понял срок. Примеры: /mute 30m, /mute 2h, /mute off", "Unknown duration. Examples: /mute 30m, /mute 2h, /mute off"));
    await updateState((state) => {
      if (ms === 0) delete state.meta.muteUntil;
      else state.meta.muteUntil = now + ms;
    });
    return reply(ms === 0
      ? L("Пауза снята.", "Pause off.")
      : L(`Пауза до ${clock(now + ms)}. Снять раньше: /mute off`, `Paused until ${clock(now + ms)}. To end it early: /mute off`));
  }
  const presence = await presenceNow();
  return reply(statusText(settings, await readState(), presence, now));
}

export async function handleUpdate(settings, update, { presenceNow = async () => ({ present: false }) } = {}) {
  const state = await readState();
  const sessions = settings.token?.channel ? Object.fromEntries(Object.entries(state.sessions).map(([id, session]) =>
    [id, { ...session, topicId: session.discordTopic?.channel === settings.chatId ? session.discordTopic.id : null,
      lastMessageIds: session.discordMessageIds ?? [] }])) : state.sessions;
  const route = routeUpdate(update, {
    chatId: settings.chatId,
    ownerUserId: settings.ownerUserId,
    sessions,
    // A stopped boss still owns General: its messages resume it headless.
    bossId: resolveBossId(state) ?? (settings.bossRevive ? dormantBossId(state) : null),
  });
  if (route.type === "no-boss") {
    return telegram(settings.token, "sendMessage", {
      chat_id: settings.chatId,
      text: L("Босс сейчас не запущен — откройте сессию «Босс» в приложении.", "The boss is not running — open the “Boss” session in the app."),
      reply_parameters: { message_id: route.messageId },
      disable_notification: true,
    }).catch(() => {});
  }
  if (route.type === "callback") return handleCallback(settings, route);
  if (route.type === "question") return handleQuestionPress(settings, route);
  if (route.type === "spawn") return (await import("./workers.mjs")).handleSpawnPress(settings, route);
  if (route.type === "button") {
    const session = route.sessionId ? state.sessions[route.sessionId] : null;
    const toast = (text) =>
      telegram(settings.token, "answerCallbackQuery", { callback_query_id: route.callbackId, text }).catch(() => {});
    if (!session || session.ended) return toast(L("Сессия уже завершена", "Session already ended"));
    await appendInbox(route.sessionId, {
      kind: "button",
      data: route.data,
      buttonText: route.text,
      messageId: route.messageId,
      at: Date.now(),
    });
    if (isTurnAnswerData(route.data)) {
      // Keep the choice visible and stop a second press: one inert button with the answer.
      await editNotification(settings, "editMessageReplyMarkup", {
        chat_id: settings.chatId,
        message_id: route.messageId,
        reply_markup: { inline_keyboard: [[{ text: `✅ ${route.text}`.slice(0, 64), callback_data: "x" }]] },
      }).catch((error) => logLine(`mark answer: ${error.message}`));
    }
    if (session.headless) {
      await (await import("./workers.mjs")).kickWorker(route.sessionId);
      return toast(L("Передано в сессию", "Sent to the session"));
    }
    return toast(hasLiveWaiter(session)
      ? L("Передано в сессию", "Sent to the session")
      : L("Сессия занята — передам, когда освободится", "Session busy — will deliver when it is free"));
  }
  if (route.type === "callback-unknown") {
    return telegram(settings.token, "answerCallbackQuery", { callback_query_id: route.callbackId }).catch(() => {});
  }
  if (route.type === "command") return handleCommand(settings, route, presenceNow);
  if (route.type === "topic-closed" || route.type === "topic-reopened") {
    return updateState((next) => {
      const session = next.sessions[route.sessionId];
      if (session) session.closed = route.type === "topic-closed";
    });
  }
  if (route.type !== "message") return undefined;

  const session = state.sessions[route.sessionId];
  const notice = (text) => {
    const params = { chat_id: settings.chatId, text, disable_notification: true };
    if (route.threadId) params.message_thread_id = route.threadId;
    else params.reply_parameters = { message_id: route.messageId };
    return telegram(settings.token, "sendMessage", params).catch(() => {});
  };
  const reviveBoss = Boolean(settings.bossRevive && session?.ended && route.sessionId === dormantBossId(state));
  if (session?.ended && !reviveBoss) return notice(L("Эта сессия уже завершена, сообщение не доставлено.", "This session has ended. Message not delivered."));
  if (session?.host === "Codex") return notice(L("Из Telegram можно отвечать только сессиям Claude Code.", "You can reply from Telegram only to Claude Code sessions."));
  if (session?.muted) return notice(L("Сессия заглушена в панели настроек, сообщение не доставлено.", "Session muted in the settings panel. Message not delivered."));
  if (!settings.chatReplies) return notice(L("Ответы из Telegram выключены в настройках.", "Replies from Telegram are off in settings."));
  if (await answerQuestionWithText(settings, route)) return undefined;
  await appendInbox(route.sessionId, {
    text: route.text,
    messageId: route.messageId,
    replyTo: route.replyTo ?? null,
    at: Date.now(),
  });
  // A stopped boss, or a boss already resumed headless (its run is in progress).
  const headlessBoss = reviveBoss || Boolean(session?.revive && !hasLiveWaiter(session));
  if (session?.headless || headlessBoss) {
    // Accepted: the daemon resumes the worker now, or after its current run.
    await telegram(settings.token, "setMessageReaction", {
      chat_id: settings.chatId,
      message_id: route.messageId,
      reaction: [{ type: "emoji", emoji: "👀" }],
    }, { timeoutMs: 5000 }).catch(() => {});
    const workers = await import("./workers.mjs");
    if (session?.headless) await workers.kickWorker(route.sessionId);
    else await workers.wakeBoss(settings, route.sessionId);
    return undefined;
  }
  if (!hasLiveWaiter(session)) {
    return notice(L(
      "⏳ Сессия сейчас занята. Передам сообщение, как только она закончит текущий ответ.",
      "⏳ Session busy. The message will be delivered when it finishes the current reply.",
    ));
  }
  return undefined;
}

const BOT_COMMANDS = [
  { command: "status", description: L("Режим, присутствие и сессии", "Mode, presence and sessions") },
  { command: "away", description: L("Я не у компьютера: присылать всё сразу", "I am away: send everything now") },
  { command: "here", description: L("Умный режим: писать, только если не отвечаю", "Smart mode: post only if I do not answer") },
  { command: "mute", description: L("Пауза: /mute 30m, /mute 2h, /mute off", "Pause: /mute 30m, /mute 2h, /mute off") },
];

/**
 * Gateway handler for the daemon: owner messages and button presses from General
 * or a known session channel go through `handleUpdate`, one at a time.
 * `telegramToken`/`telegramChatId` let edits reach the Telegram copy in "both" mode.
 */
export function discordInbound(settings, discord, presenceNow, report) {
  const telegramEnabled = !settings.token?.channel;
  const inbound = { ...discord, notificationTarget: settings.notificationTarget,
    telegramToken: telegramEnabled ? settings.token : "", telegramChatId: telegramEnabled ? settings.chatId : "" };
  let queue = Promise.resolve();
  return async (update, data) => {
    const message = update.message ?? update.callback_query.message;
    // Discord requires an acknowledgement within three seconds.
    const callback = `/interactions/${data.id}/${data.token}/callback`;
    if (message.is_topic_message) {
      const { sessions } = await readState();
      if (!Object.values(sessions).some((s) => s.discordTopic?.channel === discord.chatId &&
          s.discordTopic.id === message.message_thread_id)) {
        // Slash commands show up in every channel of the server: say where they work.
        if (update.slashCommand) {
          await discordApi(discord.token, "POST", callback, { type: 4, data: { flags: 64,
            content: L(`Команды работают в <#${discord.chatId}> и в каналах сессий.`, `Commands work in <#${discord.chatId}> and in session channels.`) } });
        }
        return;
      }
    }
    if (update.callback_query) await discordApi(discord.token, "POST", callback, { type: 6 });
    if (update.slashCommand) {
      await discordApi(discord.token, "POST", callback, { type: 4, data: { content: `✅ ${message.text}`, flags: 64 } });
    }
    queue = queue.then(() => handleUpdate(inbound, update, { presenceNow })).catch(report);
    await queue;
  };
}


/** "AI Forge", or "AI Forge · в работе: 3" while sessions post; "" turns it off. */
export function discordActivity(settings, state, now = Date.now()) {
  const base = settings.discordActivity;
  if (!base) return "";
  const working = workingSessions(state, now);
  return working ? L(`${base} · в работе: ${working}`, `${base} · working: ${working}`) : base;
}

/** Claude Code sessions that posted in the last 30 minutes. */
// Claude Code writes the transcript while a session works, its subagents included,
// so a transcript written in the last 90 s means the session is working. This also
// catches sessions whose hooks predate turn tracking. Refreshed by the daemon tick.
const TRANSCRIPT_ACTIVE_MS = 90_000;
let activeTranscriptIds = new Set();

/**
 * Scan ~/.claude/projects for transcripts written recently: "<session id>" for a
 * session, "<session id>/<agent file>" for each of its running subagents.
 */
export async function refreshActiveTranscripts(now = Date.now(), root = path.join(os.homedir(), ".claude", "projects")) {
  const ids = new Set();
  const fresh = async (file) => now - (await fsp.stat(file)).mtimeMs < TRANSCRIPT_ACTIVE_MS;
  const projects = await fsp.readdir(root).catch(() => []);
  await Promise.all(projects.map(async (project) => {
    const dir = path.join(root, project);
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      try {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          if (await fresh(path.join(dir, entry.name))) ids.add(entry.name.slice(0, -6));
        } else if (entry.isDirectory()) {
          const sub = path.join(dir, entry.name, "subagents");
          for (const file of await fsp.readdir(sub).catch(() => [])) {
            // Every running subagent is a worker of its own: "<session>/<agent file>".
            if (await fresh(path.join(sub, file))) ids.add(`${entry.name}/${file}`);
          }
        }
      } catch { /* a file can vanish between readdir and stat */ }
    }
  }));
  activeTranscriptIds = ids;
  return ids;
}

export function workingSessions(state, now = Date.now(), alive = pidAlive, active = activeTranscriptIds) {
  // A session works while a turn is in progress: from UserPromptSubmit (or a wake-up
  // from the chat) to Stop, or while its transcript is being written. Child sessions
  // count like any other; a headless worker also counts while its claude -p run is
  // alive. A turn with no Stop for hours is stale.
  const ids = new Set([...active].filter((id) => !state.sessions?.[id.split("/")[0]]?.ended));
  for (const id of Object.entries(state.meta?.turns ?? {})
    .filter(([id, at]) => now - at < TURN_STALE_MS && !state.sessions?.[id]?.ended)
    .map(([id]) => id)) ids.add(id);
  for (const [id, session] of Object.entries(state.sessions ?? {})) {
    if (session.headless && session.run && alive(session.run.pid)) ids.add(id);
  }
  return ids.size;
}

const TURN_STALE_MS = 3 * 3600_000;

/** Record that a session started (true) or finished (false) a turn. */
export async function markTurn(sessionId, active, now = Date.now()) {
  if (!sessionId) return;
  const sid = safeSessionId(sessionId);
  await updateState((state) => {
    const turns = (state.meta.turns ??= {});
    if (active) turns[sid] = now;
    else delete turns[sid];
    for (const [id, at] of Object.entries(turns)) if (now - at >= TURN_STALE_MS) delete turns[id];
  });
}

/** /status, /away, /here, /mute as guild slash commands; refreshed at most daily. */
async function registerSlashCommands(discord, applicationId) {
  const { guild } = discord.token;
  if (!guild || !applicationId) return;
  const meta = (await readState()).meta;
  if (meta.discordCommands?.guild === guild && Date.now() - meta.discordCommands.at < 86_400_000) return;
  await discordApi(discord.token, "PUT", `/applications/${applicationId}/guilds/${guild}/commands`, slashCommands(BOT_COMMANDS));
  await updateState((state) => { state.meta.discordCommands = { guild, at: Date.now() }; });
}

export async function runDaemon({ idleMs = DAEMON_IDLE_MS, tickMs = 5000, presenceEveryMs = 15_000 } = {}) {
  const settings = await loadSettings();
  if (!settings.token || !settings.chatId) return;
  if (!(await acquirePidFile())) return;
  const startedAt = Date.now();
  let stopping = false;
  let discordLink = null;
  let transcriptsAt = 0;
  let richPresence = null;
  let richPresenceImage = "";
  const release = async () => {
    if ((await readDaemonPid()) === process.pid) await fsp.rm(files.pid(), { force: true });
  };
  const exit = () => {
    stopping = true;
    discordLink?.close();
    richPresence?.close();
    logLine(`daemon ${process.pid} exiting`)
      .then(release)
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", exit);
  process.on("SIGINT", exit);
  await logLine(`daemon ${process.pid} started`);

  let presence = { present: false, reason: "unknown", idleSec: null };
  let presenceAt = 0;
  const presenceNow = async () => {
    if (Date.now() - presenceAt >= presenceEveryMs) {
      presence = await detectPresence({ idleThresholdSec: settings.presenceIdleSec, claude: true });
      presenceAt = Date.now();
    }
    return presence;
  };

  const meta = (await readState()).meta;
  const discord = settings.notificationTarget === "telegram" ? null : discordSettings(settings);
  const telegramEnabled = !settings.token?.channel;
  if (discord) {
    // Count working agents before the first status goes out, not one tick later.
    await refreshActiveTranscripts().catch(() => {});
    transcriptsAt = Date.now();
    const report = (error) => { void logLine(`Discord: ${error.message}`); };
    discordLink = connectDiscord(discord.token, discordInbound(settings, discord, presenceNow, report), report, {
      activity: discordActivity(settings, await readState()),
      onReady: async ({ applicationId }) => {
        await registerSlashCommands(discord, applicationId).catch(report);
        // The owner's own profile: "Playing <application name>" through the local Discord app.
        if (settings.discordRichPresence && applicationId && !richPresence) {
          const me = await botUser(discord.token).catch(() => null);
          if (me?.avatar) richPresenceImage = `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=512`;
          richPresence = connectRichPresence(applicationId, {
            onState: (stateText) => { void logLine(`Discord Rich Presence: ${stateText}`); },
          });
          richPresence.set(richPresenceActivity({ working: workingSessions(await readState()), startedAt, imageUrl: richPresenceImage }));
        }
      },
    });
  }
  if (telegramEnabled && Date.now() - (meta.commandsSetAt ?? 0) > 86_400_000) {
    telegram(settings.token, "setMyCommands", { commands: BOT_COMMANDS })
      .then(() => updateState((state) => { state.meta.commandsSetAt = Date.now(); }))
      .catch(() => {});
  }

  // Ticker: grace timers, catch-up on leaving the Mac, resolved edits, idle exit.
  const ticker = (async () => {
    let lastLive = Date.now();
    while (!stopping) {
      try {
        if ((await readDaemonPid()) !== process.pid) return exit(); // another daemon took over
        const current = await presenceNow();
        await processPending(settings, current);
        await (await import("./workers.mjs")).tickWorkers(settings);
        if (Date.now() - transcriptsAt > 15_000) {
          transcriptsAt = Date.now();
          await refreshActiveTranscripts().catch(() => {});
        }
        const now = await readState();
        discordLink?.setActivity(discordActivity(settings, now));
        richPresence?.set(richPresenceActivity({ working: workingSessions(now), startedAt, imageUrl: richPresenceImage }));
        if (!telegramEnabled) await writeJsonAtomic(files.daemon(), { pid: process.pid, startedAt, lastPollAt: Date.now() });
        if (await hasLiveClients()) lastLive = Date.now();
        else if (Date.now() - lastLive > idleMs) return exit();
      } catch (error) {
        await logLine(`tick: ${error.message}`);
      }
      await sleep(tickMs);
    }
    return undefined;
  })();

  if (!telegramEnabled) return ticker;

  // Poller: the only getUpdates consumer for this token.
  let offset = (await readJson(files.offset(), {})).offset ?? 0;
  let backoff = 1000;
  let conflicts = 0;
  while (!stopping) {
    await writeJsonAtomic(files.daemon(), { pid: process.pid, startedAt, lastPollAt: Date.now() });
    let updates;
    try {
      updates = await telegram(settings.token, "getUpdates", {
        offset,
        timeout: 50,
        allowed_updates: ["message", "callback_query"],
      }, { timeoutMs: 65_000 });
      conflicts = 0;
      backoff = 1000;
    } catch (error) {
      if (error?.status === 409) {
        conflicts += 1;
        await logLine(`getUpdates conflict ${conflicts}: ${error.description}`);
        if (conflicts >= 5) break;
        await sleep(5000 * conflicts);
      } else {
        await logLine(`getUpdates: ${error.message}`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
      continue;
    }
    for (const update of updates) {
      try {
        await handleUpdate(settings, update, { presenceNow });
      } catch (error) {
        await logLine(`update ${update.update_id}: ${error.message}`);
      }
      offset = update.update_id + 1;
    }
    if (updates.length) await writeJsonAtomic(files.offset(), { offset });
  }
  exit();
  await ticker;
}

// ------------------------------------------------------------ admin helpers

export async function forgetSession(settings, sessionId, { deleteTopic = false } = {}) {
  const sid = safeSessionId(sessionId);
  const removed = await updateState((state) => {
    const session = state.sessions[sid];
    delete state.sessions[sid];
    for (const item of Object.values(state.pending)) {
      if (item.sessionId === sid) delete state.pending[item.id];
    }
    if (state.meta.bossSessionId === sid) delete state.meta.bossSessionId;
    return session ?? null;
  });
  await fsp.rm(files.inbox(sid), { force: true });
  let topicDeletedOk = false;
  const discord = discordSettings(settings);
  if (deleteTopic && discord && removed?.discordTopic?.channel === discord.chatId) {
    await telegram(discord.token, "deleteForumTopic", { message_thread_id: removed.discordTopic.id });
    topicDeletedOk = true;
  }
  if (deleteTopic && removed?.topicId && settings.token) {
    await telegram(settings.token, "deleteForumTopic", {
      chat_id: settings.chatId,
      message_thread_id: removed.topicId,
    });
    topicDeletedOk = true;
    await updateState((state) => {
      for (const [key, value] of Object.entries(state.meta.topicsByTitle ?? {})) {
        if (Number(value.topicId) === Number(removed.topicId)) delete state.meta.topicsByTitle[key];
      }
    });
  }
  return { removed: Boolean(removed), topicDeleted: topicDeletedOk };
}

export async function setSessionMuted(sessionId, muted) {
  const sid = safeSessionId(sessionId);
  return updateState((state) => {
    const session = state.sessions[sid];
    if (!session) return false;
    session.muted = Boolean(muted);
    return true;
  });
}

export function describeSession(id, session, alive = pidAlive, bossId = null) {
  let status = "active";
  if (session.host === "Codex") status = "notify-only";
  const running = Boolean(session.run && alive(session.run.pid));
  if (session.ended) status = "ended";
  else if (hasLiveWaiter(session, alive)) status = "waiting";
  else if (session.headless) status = running ? "active" : "waiting";
  return {
    id,
    title: session.title ?? id,
    project: session.project ?? "",
    host: session.host ?? "",
    status,
    muted: Boolean(session.muted),
    closed: Boolean(session.closed),
    hasTopic: session.topicId != null || session.discordTopic != null,
    topicId: session.topicId ?? null,
    waiting: hasLiveWaiter(session, alive) || (Boolean(session.headless) && !session.ended && !running),
    isBoss: id === bossId,
    parent: session.parent ?? null,
    headless: Boolean(session.headless),
    lastPostAt: session.lastPostAt ?? null,
  };
}


/** Chats that wrote to the bot recently (for /start detection). Stops the daemon first to avoid 409. */
export async function findChats(token, { waitSec = 0 } = {}) {
  await stopDaemon();
  const updates = await telegram(
    token,
    "getUpdates",
    { timeout: waitSec, allowed_updates: ["message"] },
    { timeoutMs: (waitSec + 10) * 1000 },
  );
  const chats = new Map();
  for (const update of updates) {
    const chat = update?.message?.chat ?? update?.channel_post?.chat;
    if (chat?.id != null) {
      chats.set(String(chat.id), {
        id: String(chat.id),
        label: chat.username ? `@${chat.username}` : chat.first_name ?? chat.title ?? "",
        type: chat.type,
      });
    }
  }
  return [...chats.values()];
}

export const TOPICS_HINT =
  L(
    "Темы выключены. Включите их в @BotFather: откройте настройки бота (Bot Settings) и включите режим тем — Threaded Mode. После этого новые сессии получат отдельные темы.",
    "Topics are off. Turn them on in @BotFather: open the bot settings (Bot Settings) and turn on Threaded Mode. New sessions then get their own topics.",
  );

/** Groups the bot is in, from recent updates (message, my_chat_member). Stops the daemon first. */
export async function findGroups(token) {
  await stopDaemon();
  const updates = await telegram(token, "getUpdates", {
    timeout: 0,
    allowed_updates: ["message", "my_chat_member"],
  });
  const groups = new Map();
  const migrated = new Set();
  for (const update of updates) {
    const message = update?.message;
    const chat = message?.chat ?? update?.my_chat_member?.chat;
    if (message?.migrate_to_chat_id) migrated.add(String(chat?.id));
    if (!chat || chat.type === "private" || chat.type === "channel") continue;
    groups.set(String(chat.id), { id: String(chat.id), label: chat.title ?? "", type: chat.type });
  }
  for (const id of migrated) groups.delete(id);
  return [...groups.values()];
}
