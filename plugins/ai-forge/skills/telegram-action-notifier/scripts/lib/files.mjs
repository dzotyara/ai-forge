// Send local files to the owner: what may be sent, how it is shown, and what each
// destination accepts. The caller names every file; nothing is expanded or searched.
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { deliverTo, logLine } from "./bridge.mjs";
import { TelegramError, configurationPath, discordSettings, loadSettings, redactSecrets } from "./common.mjs";
import { discordApi } from "./discord.mjs";
import { renderMessages } from "./format.mjs";

const MiB = 1024 * 1024;

/**
 * Upload limits, in one place. Checked against the official documentation on 2026-11-23:
 * - Telegram Bot API (cloud server): sendDocument, sendVideo and sendAudio take files up to 50 MB,
 *   sendPhoto up to 10 MB; a caption is 0-1024 characters. A local Bot API server allows 2000 MB,
 *   but this bridge talks to api.telegram.org. The docs say "MB"; MiB is used here, and a stricter
 *   answer from the server is still reported as an error for that file.
 *   https://core.telegram.org/bots/api#sending-files
 * - Discord: "The file upload size limit applies to each file in a request. The default limit is
 *   20 MiB for all users" and depends on the server's Boost level. The API exposes the level as
 *   guild.premium_tier; the per-level sizes (level 2: 50 MB, level 3: 100 MB) are from the Server
 *   Boosting FAQ. A message may carry at most 25 MiB in total (the request limit).
 *   https://discord.com/developers/docs/reference#uploading-files
 *   https://discord.com/developers/docs/resources/message#create-message
 *   https://support.discord.com/hc/en-us/articles/360028038352-Server-Boosting-FAQ
 */
export const FILE_LIMITS = {
  telegram: {
    label: "Telegram",
    bytes: { document: 50 * MiB, video: 50 * MiB, audio: 50 * MiB, animation: 50 * MiB, photo: 10 * MiB },
    caption: 1024,
    source: "https://core.telegram.org/bots/api#sending-files",
  },
  discord: {
    label: "Discord",
    defaultBytes: 20 * MiB,
    byBoostLevel: { 0: 20 * MiB, 1: 20 * MiB, 2: 50 * MiB, 3: 100 * MiB },
    caption: 2000,
    source: "https://discord.com/developers/docs/reference#uploading-files",
  },
};

/** Telegram shows these as media; everything else is a document. */
const KINDS = {
  photo: [".jpg", ".jpeg", ".png"],
  video: [".mp4", ".m4v", ".mov"],
  audio: [".mp3", ".m4a"],
  animation: [".gif"],
};
const TELEGRAM_METHOD = {
  photo: ["sendPhoto", "photo"],
  video: ["sendVideo", "video"],
  audio: ["sendAudio", "audio"],
  animation: ["sendAnimation", "animation"],
  document: ["sendDocument", "document"],
};
/** Telegram rejects a photo it can't use (size ratio, dimensions): the same file goes as a document. */
const PHOTO_REJECTED = /PHOTO_INVALID_DIMENSIONS|IMAGE_PROCESS_FAILED|PHOTO_SAVE_FILE_INVALID|PHOTO_EXT_INVALID|PHOTO_CROP_SIZE_SMALL/i;

export function mediaKind(name) {
  const ext = path.extname(String(name)).toLowerCase();
  return Object.keys(KINDS).find((kind) => KINDS[kind].includes(ext)) ?? "document";
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MiB) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KiB`;
  return `${(bytes / MiB).toFixed(1).replace(/\.0$/, "")} MiB`;
}

const realOrResolved = async (target) => realpath(target).catch(() => path.resolve(target));

/**
 * One path the caller named: it must be an existing, readable, non-empty regular file.
 * A directory is refused, never walked. The bridge's own configuration and state
 * (bot tokens) are refused even when named.
 */
export async function inspectFile(arg, { cwd = process.cwd() } = {}) {
  const full = path.resolve(cwd, String(arg));
  let info;
  try {
    info = await stat(full);
  } catch (error) {
    throw new Error(`${arg}: ${error?.code === "ENOENT" ? "no such file" : "cannot be read"}`);
  }
  if (info.isDirectory()) throw new Error(`${arg}: is a directory; name each file to send`);
  if (!info.isFile()) throw new Error(`${arg}: is not a regular file`);
  if (info.size === 0) throw new Error(`${arg}: is empty`);
  try {
    await access(full, constants.R_OK);
  } catch {
    throw new Error(`${arg}: is not readable`);
  }
  const real = await realOrResolved(full);
  const guarded = await realOrResolved(path.dirname(configurationPath()));
  if (real === guarded || real.startsWith(guarded + path.sep)) {
    throw new Error(`${arg}: is part of the AI Forge configuration (bot tokens); refusing to send it`);
  }
  const name = path.basename(full);
  return { path: full, name, size: info.size, kind: mediaKind(name) };
}

/** Every named file or none: all problems are listed at once and nothing is sent. */
export async function inspectFiles(args, options) {
  const files = [];
  const problems = [];
  for (const arg of args) {
    try {
      files.push(await inspectFile(arg, options));
    } catch (error) {
      problems.push(error.message);
    }
  }
  if (problems.length) throw new Error(`Nothing was sent.\n${problems.join("\n")}`);
  return files;
}

/** Where the settings say files go. A destination that is selected but not configured is left out. */
export function destinationsFor(settings) {
  const target = settings.notificationTarget;
  const list = [];
  const skipped = [];
  if (target !== "discord") {
    if (settings.token && settings.chatId) list.push({ name: "telegram", settings });
    else skipped.push("telegram");
  }
  if (target !== "telegram") {
    const discord = discordSettings(settings);
    if (discord) list.push({ name: "discord", settings: discord });
    else skipped.push("discord");
  }
  if (!list.length) {
    throw new Error(
      `${target === "both" ? "Telegram and Discord are" : `${FILE_LIMITS[target]?.label ?? target} is`} selected in "Where to send" but not configured. Nothing was sent.`,
    );
  }
  return { list, skipped };
}

const refusal = (file, limits, limit, note = "") =>
  `${file.name} is ${formatSize(file.size)}, over the ${limits.label} limit of ${formatSize(limit)}${note} (${limits.source})`;

/** Discord's per-file limit for this server: its Boost level when it can be read, else the default. */
async function discordLimit(bot) {
  const limits = FILE_LIMITS.discord;
  if (bot.guild) {
    try {
      const level = Number((await discordApi(bot, "GET", `/guilds/${bot.guild}`))?.premium_tier) || 0;
      return { bytes: limits.byBoostLevel[level] ?? limits.defaultBytes, note: ` for this server (Boost level ${level})` };
    } catch {
      // The level is unknown: the documented default applies.
    }
  }
  return { bytes: limits.defaultBytes, note: " (default; server Boost level unknown)" };
}

/** What may be sent where: the Telegram method and field, or why this destination refuses the file. */
async function plan(destination, file) {
  if (destination.name === "telegram") {
    const limits = FILE_LIMITS.telegram;
    let kind = file.kind;
    let note = "";
    if (kind === "photo" && file.size > limits.bytes.photo) {
      kind = "document"; // over the photo limit: same file, full quality, as a document
      note = ` (over the ${formatSize(limits.bytes.photo)} photo limit)`;
    }
    if (file.size > limits.bytes[kind]) return { refused: refusal(file, limits, limits.bytes[kind]) };
    return { kind, note, method: TELEGRAM_METHOD[kind][0], field: TELEGRAM_METHOD[kind][1] };
  }
  const limits = FILE_LIMITS.discord;
  if (file.size <= limits.defaultBytes) return { kind: file.kind, note: "", field: "files[0]" };
  const { bytes, note } = await discordLimit(destination.settings.token);
  if (file.size > bytes) return { refused: refusal(file, limits, bytes, note) };
  return { kind: file.kind, note: "", field: "files[0]" };
}

function failureText(error, file, destination) {
  const limits = FILE_LIMITS[destination];
  if (error?.status === 413 || /too large|entity too large|file is too big/i.test(String(error?.description ?? error?.message))) {
    return `${limits.label} rejected ${file.name} (${formatSize(file.size)}) as too large (${limits.source})`;
  }
  return redactSecrets(String(error?.message ?? error));
}

/** One file to one destination. Never throws: the outcome is the result. */
async function sendOne(destination, file, { ctx, silent, caption }) {
  const limits = FILE_LIMITS[destination.name];
  const result = { destination: destination.name, file: file.name, size: file.size, ok: false };
  try {
    const chosen = await plan(destination, file);
    if (chosen.refused) return { ...result, error: chosen.refused };
    const inline = caption && Array.from(caption).length <= limits.caption;
    const deliver = (kind) => {
      const [method, field] = destination.name === "telegram" ? TELEGRAM_METHOD[kind] : [null, "files[0]"];
      return deliverTo(destination.settings, ctx, inline ? [caption] : [], {
        silent, file: { path: file.path, name: file.name, size: file.size, method, field },
      });
    };
    let sentAs = chosen.kind;
    let sent;
    try {
      sent = await deliver(chosen.kind);
    } catch (error) {
      const retry = destination.name === "telegram" && chosen.kind === "photo" && error instanceof TelegramError &&
        PHOTO_REJECTED.test(error.description) && file.size <= limits.bytes.document;
      if (!retry) throw error;
      sentAs = "document";
      sent = await deliver("document");
    }
    const out = { ...result, ok: true, as: sentAs, note: sentAs === chosen.kind ? chosen.note : " (Telegram refused it as a photo)", messageId: String(sent.messageIds.at(-1) ?? "") };
    // A caption too long to ride along follows as an ordinary message.
    if (caption && !inline) {
      const parts = renderMessages({ header: "", body: caption, cwd: ctx.cwd, label: ctx.title });
      await deliverTo(destination.settings, ctx, parts, { silent });
    }
    return { ...out, captionAttached: Boolean(caption) };
  } catch (error) {
    const message = failureText(error, file, destination.name);
    await logLine(`send-file ${destination.name}: ${message}`).catch(() => {});
    return { ...result, error: message };
  }
}

/**
 * Send the named files to every destination "Where to send" selects.
 * The caption goes with the first file each destination accepts.
 * Returns { ok, results, skipped, files }; ok only when every file reached every destination.
 */
export async function sendFiles({ paths, caption = "", ctx, silent = false, cwd = process.cwd(), settings = null }) {
  const files = await inspectFiles(paths, { cwd });
  const { list, skipped } = destinationsFor(settings ?? await loadSettings());
  const text = redactSecrets(String(caption ?? "")).trim();
  const perDestination = await Promise.all(list.map(async (destination) => {
    const results = [];
    let pending = text;
    for (const file of files) {
      const result = await sendOne(destination, file, { ctx, silent, caption: pending });
      if (result.ok && pending) pending = "";
      results.push(result);
    }
    return results;
  }));
  const results = perDestination.flat();
  return {
    ok: results.every((result) => result.ok),
    results, skipped, destinations: list.map((destination) => destination.name),
    files: files.map(({ name, size }) => ({ name, size })),
  };
}

/** Plain-language outcome, one block per file: which destination got it and which did not, and why. */
export function formatReport(report) {
  const lines = [];
  for (const file of report.files) {
    lines.push(`${file.name} (${formatSize(file.size)})`);
    for (const result of report.results.filter((item) => item.file === file.name && item.size === file.size)) {
      lines.push(result.ok
        ? `  ${result.destination}: sent as ${result.as}${result.note ?? ""}`
        : `  ${result.destination}: NOT sent: ${result.error}`);
    }
  }
  for (const name of report.skipped) lines.push(`${name}: not configured, skipped`);
  const delivered = report.results.filter((result) => result.ok).length;
  const where = report.destinations.join(" and ");
  lines.push(report.ok
    ? `Delivered: all ${report.files.length} file(s) to ${where}.`
    : `Not delivered everywhere: ${delivered} of ${report.results.length} file deliveries succeeded (${where}).`);
  return lines.join("\n");
}
