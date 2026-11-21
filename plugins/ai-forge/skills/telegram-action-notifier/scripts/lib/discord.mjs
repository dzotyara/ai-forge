// Discord Bot API adapter for the shared notification and reply state machine.
//
// The bridge speaks the Telegram Bot API. A Discord "token" is an object
// { secret, channel, owner[, guild, category] }; `telegram()` in common.mjs
// hands such calls to `discordCall`, which maps them onto Discord REST.
// Inbound Gateway events become Telegram-shaped updates (`discordUpdate`).
import { readFile } from "node:fs/promises";
import process from "node:process";

import { decodeHtml } from "./format.mjs";
import { L } from "./i18n.mjs";

export const discordId = (value) => typeof value === "string" && /^\d{17,20}$/.test(value);
const ref = (channel, message) => `${channel}:${message}`;
const styles = { primary: 1, success: 3, danger: 4 };
const FENCE = "```";

// Discord rejects a message whose buttons repeat a custom_id; Telegram allows it.
// Repeats get an invisible suffix that `discordUpdate` strips again.
const DUPLICATE_MARK = "⁣";
const stripMark = (id) => String(id ?? "").replace(/⁣\d+$/, "");

export const CATEGORY_NAME = "AI Forge";
export const GENERAL_NAME = "⚒・forge";
const LEGACY_CATEGORY_NAMES = ["AI Factory", "myskills"];
const LEGACY_GENERAL_NAMES = ["🔥・general", "🏭・general", "general"];
const GENERAL_TOPIC = L(
  "Босс, запросы на запуск и общие уведомления. Напишите сюда — сообщение получит Босс. Команды: /status, /away, /here, /mute.",
  "Boss, launch requests and general notifications. Write here to message the Boss. Commands: /status, /away, /here, /mute.",
);

export const DEFAULT_ACTIVITY = "AI Forge";

// Approvals whose hook runs on another device carry REMOTE_MARK; the daemon that
// gets the press appends DECISION_MARK with the owner's choice.
export const REMOTE_LINE = "-# ai-forge remote";
const REMOTE_MARK = /^-# ai-forge remote$/m;
const DECISION_MARK = /^-# ai-forge decision=(allow|deny)$/m;
export const remoteDecision = (content) => DECISION_MARK.exec(String(content ?? ""))?.[1] ?? null;

// Gateway close codes that stop reconnecting, with what the owner should do.
const FATAL_CLOSE = {
  4004: L("Discord не принял токен бота. Подключите Discord в панели заново.", "Discord rejected the bot token. Connect Discord again in the panel."),
  4010: L("Discord Gateway: неверный shard (4010).", "Discord Gateway: invalid shard (4010)."),
  4011: L("Discord Gateway: нужен sharding (4011).", "Discord Gateway: sharding required (4011)."),
  4012: L("Discord Gateway: неверная версия API (4012).", "Discord Gateway: invalid API version (4012)."),
  4013: L("Discord Gateway: неверные intents (4013).", "Discord Gateway: invalid intents (4013)."),
  4014: L(
    "Включите Message Content Intent: Developer Portal → Bot → Privileged Gateway Intents. Затем перезапустите службу.",
    "Turn on Message Content Intent: Developer Portal → Bot → Privileged Gateway Intents. Then restart the service.",
  ),
};
const NO_CONTENT_NOTICE = L(
  "Message Content Intent выключен: кнопки, команды и статус работают, а текстовые ответы из Discord бот не видит. " +
    "Включите его: Developer Portal → Bot → Privileged Gateway Intents, затем перезапустите службу.",
  "Message Content Intent is off: buttons, commands and status work, but the bot cannot see text replies from Discord. " +
    "Turn it on: Developer Portal → Bot → Privileged Gateway Intents, then restart the service.",
);
const GUILDS = 1, GUILD_MESSAGES = 512, MESSAGE_CONTENT = 32768;
const MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19); // GATEWAY_MESSAGE_CONTENT(_LIMITED)
const ASSETS = new URL("../../assets/", import.meta.url);

function components(markup) {
  const seen = new Map();
  const unique = (id) => {
    const count = seen.get(id) ?? 0;
    seen.set(id, count + 1);
    return count ? `${id}${DUPLICATE_MARK}${count}` : id;
  };
  const buttons = markup?.inline_keyboard?.flat() ?? [];
  if (buttons.length > 25) {
    const rows = [];
    for (let i = 0; i < Math.min(buttons.length, 125); i += 25) {
      rows.push({ type: 1, components: [{ type: 3, custom_id: `choice:${i}`,
        placeholder: L("Выберите ответ", "Choose an answer"), options: buttons.slice(i, i + 25).map((button) => ({
          label: button.text.slice(0, 100), value: unique(button.callback_data),
        })),
      }] });
    }
    return rows;
  }
  const keyboard = markup?.inline_keyboard ?? [];
  const groups = keyboard.length <= 5 && keyboard.every((row) => row.length <= 5)
    ? keyboard
    : Array.from({ length: Math.ceil(buttons.length / 5) }, (_, i) => buttons.slice(i * 5, i * 5 + 5));
  return groups.map((group) => ({ type: 1, components: group.map((button) => ({
    type: 2, style: styles[button.style] ?? 2, label: button.text.slice(0, 80),
    custom_id: unique(button.callback_data), disabled: button.callback_data === "x",
  })) }));
}

export async function discordApi(bot, method, route, body) {
  const response = await fetch(`https://discord.com/api/v10${route}`, {
    method, headers: { Authorization: `Bot ${bot.secret}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  }).catch(() => { throw new Error(L("Discord: ошибка сети", "Discord: network error")); });
  if (!response.ok) throw Object.assign(new Error(`Discord: HTTP ${response.status}`), { status: response.status });
  return response.status === 204 ? null : response.json();
}

// The bot's own user; it never changes for a token, so one request per process.
const identities = new Map();
export function botUser(bot) {
  if (!identities.has(bot.secret)) {
    identities.set(bot.secret, discordApi(bot, "GET", "/users/@me").catch((error) => {
      identities.delete(bot.secret);
      throw error;
    }));
  }
  return identities.get(bot.secret);
}

const VIEW_CHANNEL = "1024";
const PERSONAL_ACCESS = "68672"; // View Channel, Send Messages, Read History, Add Reactions.

function privateChannelPermissions(guild, owner, botId) {
  return [
    { id: guild, type: 0, allow: "0", deny: VIEW_CHANNEL },
    ...[botId, owner].map((id) => ({ id, type: 1, allow: PERSONAL_ACCESS, deny: "0" })),
  ];
}

async function imageDataUri(name) {
  return `data:image/png;base64,${(await readFile(new URL(name, ASSETS))).toString("base64")}`;
}

/**
 * Give the bot and the server the AI Forge look, only where nothing is set yet:
 * a picture the owner chose is never replaced. Returns warnings, never throws.
 */
export async function brandDiscord(bot, guild, identity, { force = false } = {}) {
  const warnings = [];
  const app = await discordApi(bot, "GET", "/applications/@me").catch(() => null);
  if (app && !(app.flags & MESSAGE_CONTENT_FLAGS)) warnings.push(FATAL_CLOSE[4014]);
  if (force || !identity.avatar) {
    const look = { avatar: await imageDataUri("discord-avatar.png") };
    if (force) look.banner = await imageDataUri("discord-banner.png");
    await discordApi(bot, "PATCH", "/users/@me", look)
      .catch((error) => warnings.push(error.status === 429
        ? L(
          "Discord временно не даёт сменить аватар бота: попробуйте подключить ещё раз через час.",
          "Discord does not allow changing the bot avatar right now. Try connecting again in an hour.",
        )
        : L(`Аватар бота не обновлён (${error.message}).`, `Bot avatar not updated (${error.message}).`)));
  }
  const server = await discordApi(bot, "GET", `/guilds/${guild}`).catch(() => null);
  // Server default "Only @mentions": the bot pings the owner when it needs them.
  if (server && server.default_message_notifications !== 1) {
    await discordApi(bot, "PATCH", `/guilds/${guild}`, { default_message_notifications: 1 })
      .catch((error) => warnings.push(L(
        `Уведомления сервера не переключены на «только упоминания» (${error.message}).`,
        `Server notifications not switched to “Only @mentions” (${error.message}).`,
      )));
  }
  if (server && (force || !server.icon)) {
    await discordApi(bot, "PATCH", `/guilds/${guild}`, { icon: await imageDataUri("discord-server-icon.png") })
      .catch((error) => warnings.push(error.status === 403
        ? L(
          "Иконку сервера не поставил: дайте боту право Manage Server и подключите ещё раз.",
          "Server icon not set: give the bot the Manage Server permission and connect again.",
        )
        : L(`Иконка сервера не обновлена (${error.message}).`, `Server icon not updated (${error.message}).`)));
  }
  return warnings;
}

/**
 * "Refresh look" in the settings panel: put the current AI Forge artwork on an
 * already connected bot and server (avatar, profile banner, server icon), and
 * rename the main channel to the current name if it still has an old one.
 */
export async function refreshDiscordLook(bot) {
  const identity = await botUser(bot);
  const warnings = await brandDiscord(bot, bot.guild, identity, { force: true });
  if (discordId(bot.channel)) {
    const channel = await discordApi(bot, "GET", `/channels/${bot.channel}`).catch(() => null);
    if (channel && channel.name !== GENERAL_NAME && LEGACY_GENERAL_NAMES.includes(channel.name)) {
      await discordApi(bot, "PATCH", `/channels/${bot.channel}`, { name: GENERAL_NAME })
        .catch((error) => warnings.push(L(`Канал не переименован (${error.message}).`, `Channel not renamed (${error.message}).`)));
    }
  }
  return warnings;
}

// Only the configured owner and bot can see these channels under normal role permissions.
export async function setupDiscord(secret, requestedGuild, owner, previous = {}) {
  const bot = { secret };
  const [identity, guilds] = await Promise.all([botUser(bot), discordApi(bot, "GET", "/users/@me/guilds")]);
  const guild = requestedGuild || (guilds.length === 1 ? guilds[0].id : "");
  if (!guilds.some((item) => item.id === guild)) {
    throw new Error(guilds.length
      ? L("Укажите ID сервера, на который добавлен бот.", "Enter the ID of the server the bot was added to.")
      : L("Сначала добавьте бота на сервер Discord.", "Add the bot to a Discord server first."));
  }
  if (identity.id === owner) throw new Error(L("Укажите свой ID пользователя вместо ID бота.", "Enter your user ID, not the bot ID."));
  const member = await discordApi(bot, "GET", `/guilds/${guild}/members/${owner}`);
  if (member.user?.bot) throw new Error(L("Укажите ID вашей учётной записи.", "Enter the ID of your own account."));
  const route = `/guilds/${guild}/channels`;
  const channels = await discordApi(bot, "GET", route);
  const permissions = privateChannelPermissions(guild, owner, identity.id);
  const privateForOwner = (channel) => channel.permission_overwrites?.length === permissions.length &&
    permissions.every((entry) => channel.permission_overwrites.some((other) =>
      other.id === entry.id && other.type === entry.type && other.allow === entry.allow && other.deny === entry.deny));
  // Reuse what an earlier setup made (by id, then by current or old name), renaming old names once.
  const pick = (type, names, extra = () => true) =>
    channels.find((c) => c.type === type && previous[type === 4 ? "discordCategory" : "discordChannel"] === c.id &&
      privateForOwner(c) && extra(c)) ??
    channels.find((c) => c.type === type && names.includes(c.name) && privateForOwner(c) && extra(c));
  const refresh = async (channel, patch) => {
    const changed = Object.entries(patch).filter(([key, value]) => channel[key] !== value);
    if (!changed.length) return channel;
    return discordApi(bot, "PATCH", `/channels/${channel.id}`, Object.fromEntries(changed)).catch(() => channel);
  };
  const oldCategory = pick(4, [CATEGORY_NAME, ...LEGACY_CATEGORY_NAMES]);
  const category = oldCategory
    ? await refresh(oldCategory, { name: CATEGORY_NAME })
    : await discordApi(bot, "POST", route, { name: CATEGORY_NAME, type: 4, permission_overwrites: permissions });
  const oldGeneral = pick(0, [GENERAL_NAME, ...LEGACY_GENERAL_NAMES], (c) => c.parent_id === category.id);
  const general = oldGeneral
    ? await refresh(oldGeneral, { name: GENERAL_NAME, topic: GENERAL_TOPIC })
    : await discordApi(bot, "POST", route, {
      name: GENERAL_NAME, type: 0, parent_id: category.id, topic: GENERAL_TOPIC, permission_overwrites: permissions,
    });
  const warnings = await brandDiscord(bot, guild, identity);
  return {
    settings: { discordGuild: guild, discordCategory: category.id, discordChannel: general.id, discordOwner: owner, discordToken: secret },
    warnings,
  };
}

const threadName = (name) => Array.from(name).slice(0, 90).join("");

export function channelName(name) {
  const slug = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "session";
  return threadName(`🤖・${slug}`);
}

function discordMarkdown(html) {
  return decodeHtml(html
    .replace(/<a href="([^"]+)">([\s\S]*?)<\/a>/g, (_match, url, label) => `${label} (&lt;${url}&gt;)`)
    .replace(/<pre>(?:<code class="language-([\w+-]+)">)?([\s\S]*?)(?:<\/code>)?<\/pre>/g,
      (_match, language, body) => `\n${FENCE}${language ?? ""}\n${body}\n${FENCE}\n`)
    .replace(/<\/?b>/g, "**")
    .replace(/<\/?i>/g, "*")
    .replace(/<\/?s>/g, "~~")
    .replace(/<\/?code>/g, "`")
    .replace(/<blockquote>([\s\S]*?)<\/blockquote>/g, (_match, quote) =>
      quote.split("\n").map((line) => `&gt; ${line}`).join("\n"))
    .replace(/<[^>]*>/g, ""));
}

/** Split into 2000-character messages; a code block cut in two is closed and reopened. */
function contentParts(text) {
  const parts = [];
  let rest = text;
  let fence = "";
  while (rest.length + fence.length > 2000) {
    const budget = rest.includes(FENCE) || fence ? 1996 - fence.length : 2000;
    const newline = rest.lastIndexOf("\n", budget - 1);
    const limit = newline > 1000 ? newline + 1 : budget;
    const end = /[\uD800-\uDBFF]/.test(rest[limit - 1]) ? limit - 1 : limit;
    const part = rest.slice(0, end);
    const opening = fence;
    for (const match of part.matchAll(/^```[\w+-]{0,30}\n/gm)) fence = fence ? "" : match[0];
    parts.push(opening + part + (fence ? `\n${FENCE}` : ""));
    rest = rest.slice(end);
  }
  if (rest) parts.push(fence + rest);
  return parts;
}

export async function discordCall(bot, method, params) {
  const [messageChannel, messageId] = String(params.message_id ?? "").split(":");
  const channel = params.message_thread_id || bot.channel;
  const messagePath = discordId(messageChannel) && discordId(messageId)
    ? `/channels/${messageChannel}/messages/${messageId}` : null;
  const text = params.parse_mode === "HTML" ? discordMarkdown(params.text) : params.text;
  const allowedMentions = { parse: [], replied_user: false };
  switch (method) {
    case "createForumTopic": {
      if (bot.guild && bot.category) {
        const identity = await botUser(bot);
        const created = await discordApi(bot, "POST", `/guilds/${bot.guild}/channels`, {
          name: channelName(params.name), type: 0, parent_id: bot.category,
          ...(params.description ? { topic: params.description.slice(0, 1024) } : {}),
          permission_overwrites: privateChannelPermissions(bot.guild, bot.owner, identity.id),
        });
        return { message_thread_id: created.id };
      }
      const thread = await discordApi(bot, "POST", `/channels/${bot.channel}/threads`, {
        name: threadName(params.name), type: 11, auto_archive_duration: 1440,
      });
      return { message_thread_id: thread.id };
    }
    case "editForumTopic": return discordApi(bot, "PATCH", `/channels/${params.message_thread_id}`,
      bot.category ? { name: channelName(params.name) } : { name: threadName(params.name), archived: false });
    case "deleteForumTopic": return discordApi(bot, "DELETE", `/channels/${params.message_thread_id}`);
    case "sendMessage": {
      const [replyChannel, replyId] = String(params.reply_parameters?.message_id ?? "").split(":");
      // Quiet by default: only a message that needs the owner mentions them, and only that
      // mention may notify (and not during quiet hours, when disable_notification is set).
      const ping = Boolean(params.ping) && discordId(bot.owner);
      const parts = contentParts(ping ? `<@${bot.owner}> ${text ?? ""}` : text ?? "");
      let message;
      for (const [index, content] of parts.entries()) {
        const last = index === parts.length - 1;
        const notify = ping && index === 0 && !params.disable_notification;
        message = await discordApi(bot, "POST", `/channels/${channel}/messages`, {
          content, flags: 4 | (notify ? 0 : 4096),
          allowed_mentions: ping && index === 0 ? { parse: [], users: [bot.owner], replied_user: false } : allowedMentions,
          components: last ? components(params.reply_markup) : [],
          ...(index === 0 && replyChannel === channel && discordId(replyId)
            ? { message_reference: { message_id: replyId, fail_if_not_exists: false } } : {}),
        });
      }
      return { message_id: ref(channel, message.id) };
    }
    case "editMessageText":
    case "editMessageReplyMarkup":
      if (!messagePath) return null;
      return discordApi(bot, "PATCH", messagePath, {
        ...(text === undefined ? {} : { content: contentParts(text).at(-1), allowed_mentions: allowedMentions }),
        components: components(params.reply_markup),
      });
    case "setMessageReaction": {
      const emoji = params.reaction?.[0]?.emoji;
      if (messagePath && emoji) return discordApi(bot, "PUT", `${messagePath}/reactions/${encodeURIComponent(emoji)}/@me`);
      return null;
    }
    case "getMessage": {
      if (!messagePath) return null;
      const message = await discordApi(bot, "GET", messagePath);
      return { content: message?.content ?? "", components: message?.components ?? [] };
    }
    case "recordRemoteDecision": {
      // An approval whose hook waits on another device: write the outcome into the
      // message itself, where that hook reads it (see requestApproval's `remote`).
      if (!messagePath) return { ok: false };
      const message = await discordApi(bot, "GET", messagePath);
      const content = String(message?.content ?? "");
      if (!REMOTE_MARK.test(content) || DECISION_MARK.test(content)) return { ok: false };
      const body = content.replace(`<@${bot.owner}> `, "");
      await discordApi(bot, "PATCH", messagePath, {
        content: `${body}\n\n${discordMarkdown(params.outcome ?? "")}\n-# ai-forge decision=${params.behavior}`,
        allowed_mentions: allowedMentions, components: [],
      });
      return { ok: true };
    }
    case "removeOwnerMention": {
      // The question was settled elsewhere: drop the leading @owner ping, keep text and buttons.
      if (!messagePath) return null;
      const message = await discordApi(bot, "GET", messagePath);
      const prefix = `<@${bot.owner}> `;
      if (!message?.content?.startsWith(prefix)) return null;
      return discordApi(bot, "PATCH", messagePath, { content: message.content.slice(prefix.length), allowed_mentions: allowedMentions });
    }
    case "answerCallbackQuery": {
      // The daemon already acknowledged the press; Telegram's toast becomes a reply only the owner sees.
      const hook = String(params.callback_query_id ?? "");
      if (!params.text || !/^\d{17,20}\/[\w.-]+$/.test(hook)) return null;
      return discordApi(bot, "POST", `/webhooks/${hook}`, { content: params.text, flags: 64, allowed_mentions: allowedMentions });
    }
    default: throw new Error(`Unsupported Discord operation: ${method}`);
  }
}

/** Telegram-style bot commands as Discord slash commands (guild scope: they appear at once). */
export function slashCommands(commands) {
  return commands.map(({ command, description }) => ({
    name: command, description: description.slice(0, 100), type: 1,
    ...(command === "mute" ? { options: [{ type: 3, name: L("срок", "duration"), description: L("30m, 2h или off", "30m, 2h or off"), required: true }] } : {}),
  }));
}

export function discordUpdate(bot, event, data) {
  if (event !== "INTERACTION_CREATE" && event !== "MESSAGE_CREATE") return null;
  const interaction = event === "INTERACTION_CREATE";
  if (interaction && data.type !== 2 && data.type !== 3) return null;
  const author = interaction ? data.member?.user ?? data.user : data.author;
  const channel = interaction ? data.channel?.id ?? data.channel_id : data.channel_id;
  if (!author || author.bot || author.id !== bot.owner || !discordId(channel)) return null;
  const where = { chat: { id: bot.channel }, from: { id: author.id },
    ...(channel !== bot.channel ? { message_thread_id: channel, is_topic_message: true } : {}) };
  if (interaction && data.type === 2) {
    // A slash command reads like the same text command typed in the channel.
    const arg = (data.data?.options ?? []).map((option) => String(option.value ?? "")).join(" ").trim();
    return { message: { ...where, text: `/${data.data?.name ?? ""}${arg ? ` ${arg}` : ""}`, message_id: ref(channel, data.id) },
      slashCommand: true };
  }
  const original = interaction ? data.message : data;
  if (!original || !discordId(original.id)) return null;
  // Without the Message Content intent the text arrives empty: nothing to route.
  if (!interaction && !String(original.content ?? "").trim()) return null;
  const message = { ...where, text: original.content, message_id: ref(channel, original.id) };
  const reply = original.message_reference;
  if (discordId(reply?.message_id)) message.reply_to_message = { message_id: ref(reply.channel_id ?? channel, reply.message_id) };
  if (!interaction) return { message };
  message.reply_markup = { inline_keyboard: (original.components ?? []).map((row) =>
    (row.components ?? []).flatMap((component) => component.options?.map((option) => ({
      text: option.label, callback_data: stripMark(option.value),
    })) ?? [{ text: component.label, callback_data: stripMark(component.custom_id) }])) };
  const choice = stripMark(data.data?.values?.[0] ?? data.data?.custom_id);
  // "<application>/<interaction token>": answerCallbackQuery replies through this follow-up webhook.
  const callbackId = discordId(data.application_id) && data.token ? `${data.application_id}/${data.token}` : data.id;
  return { callback_query: { id: callbackId, data: choice, from: message.from, message } };
}

const presenceOf = (activity) => ({
  since: null, afk: false, status: "online",
  activities: activity ? [{ name: activity, type: 0 }] : [],
});

/**
 * Gateway connection. Returns { close, setActivity }: setActivity("AI Factory")
 * shows "Playing AI Forge" under the bot; it is resent after every reconnect.
 */
export function connectDiscord(bot, onUpdate, onError, { activity = DEFAULT_ACTIVITY, onReady = () => {} } = {}) {
  let stopped = false;
  let socket;
  let retry;
  let heartbeat;
  let sequence = null;
  let session;
  let attempts = 0;
  let currentActivity = activity;
  let intents = GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT;
  const send = (op, d) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op, d })); };
  const connect = () => {
    socket = new WebSocket(`${session?.url ?? "wss://gateway.discord.gg"}/?v=10&encoding=json`);
    let acknowledged = true;
    const beat = () => {
      if (!acknowledged) return socket.close(4000, "Heartbeat timeout");
      acknowledged = false;
      send(1, sequence);
    };
    socket.addEventListener("message", async ({ data }) => {
      try {
        const packet = JSON.parse(data);
        if (packet.s != null) sequence = packet.s;
        if (packet.op === 10) {
          heartbeat = setInterval(beat, packet.d.heartbeat_interval);
          if (session) send(6, { token: bot.secret, session_id: session.id, seq: sequence });
          else send(2, { token: bot.secret, intents, presence: presenceOf(currentActivity),
            properties: { os: process.platform, browser: "ai-forge", device: "ai-forge" } });
        }
        if (packet.op === 1) send(1, sequence);
        if (packet.op === 11) acknowledged = true;
        if (packet.op === 7 || packet.op === 9) {
          if (packet.op === 9 && !packet.d) { session = null; sequence = null; }
          socket.close(4000, "Reconnect");
        }
        if (packet.t === "READY") {
          session = { id: packet.d.session_id, url: packet.d.resume_gateway_url };
          attempts = 0;
          await onReady({ applicationId: packet.d.application?.id ?? packet.d.user?.id });
        }
        if (packet.t === "RESUMED") {
          attempts = 0;
          send(3, presenceOf(currentActivity));
        }
        const update = discordUpdate(bot, packet.t, packet.d);
        if (update) await onUpdate(update, packet.d);
      } catch (error) { onError(error); }
    });
    socket.addEventListener("close", ({ code }) => {
      clearInterval(heartbeat);
      if ([4007, 4009].includes(code)) { session = null; sequence = null; }
      if (code === 4014 && intents & MESSAGE_CONTENT && !stopped) {
        // Buttons, slash commands and the status do not need message text: keep them working.
        intents &= ~MESSAGE_CONTENT;
        session = null; sequence = null;
        onError(new Error(NO_CONTENT_NOTICE));
        retry = setTimeout(connect, 0);
      } else if (FATAL_CLOSE[code]) {
        onError(new Error(FATAL_CLOSE[code]));
      } else if (!stopped) {
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 30_000));
      }
    });
  };
  connect();
  return {
    close() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      socket.close();
    },
    setActivity(name) {
      if (name === currentActivity) return;
      currentActivity = name;
      send(3, presenceOf(name));
    },
  };
}
