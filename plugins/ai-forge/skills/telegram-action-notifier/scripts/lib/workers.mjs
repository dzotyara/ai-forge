// Headless workers: `claude -p` sessions started by `spawn` and resumed by the
// daemon when the owner writes in their topic. Also the hierarchy helpers
// (set-parent, notify-boss).
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  appendInbox,
  deliver,
  editNotification,
  ensureDaemon,
  findSession,
  formatReplies,
  inboxFile,
  listeningWorker,
  logLine,
  mirrorId,
  pidAlive,
  readState,
  dormantBossId,
  resolveBossId,
  runFile,
  safeSessionId,
  takeInbox,
  updateState,
} from "./bridge.mjs";
import { EFFORTS, WORKER_MODES, isModelId, isQuietTime, loadNotificationSettings as loadSettings, redactSecrets, telegram } from "./common.mjs";
import { escapeHtml, projectName, truncateText } from "./format.mjs";
import { L } from "./i18n.mjs";

const ENTRY_SCRIPT = fileURLToPath(new URL("../telegram-action-notifier.mjs", import.meta.url));

/** Replaceable in tests. */
export const deps = { spawn: nodeSpawn };

export const NOTIFY_INTERVAL_MS = 30_000;
export const SPAWN_TTL_MS = 24 * 3600_000;
const MAX_RUNS_PER_RUNNER = 20;
const MAX_BRIEF = 20_000;

// Variables of the calling Claude Code session that must not leak into a worker.
const SESSION_ENV =
  /^(CLAUDECODE$|CLAUDE_CODE_(?!USE_|OAUTH_TOKEN$)|CLAUDE_AGENT_SDK_|CLAUDE_PREVIEW_|CLAUDE_PLUGIN_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PROJECT_DIR$|CLAUDE_ENV_FILE$)/;

export function workerEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) if (!SESSION_ENV.test(key)) out[key] = value;
  out.TELEGRAM_BRIDGE_HEADLESS = "1";
  return out;
}

export function claudeBinary(settings) {
  if (settings?.claudePath) return settings.claudePath;
  const local = path.join(os.homedir(), ".local", "bin", "claude");
  return fs.existsSync(local) ? local : "claude";
}

const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * Validate `spawn` options against the owner's config. A session may pick a
 * model, effort and a permission mode, but never one that skips the owner's
 * permission choice (bypassPermissions never; auto only with workerPermissions "auto").
 */
export function resolveWorkerSpec(settings, opts) {
  const defaults = settings.workerDefaults;
  const title = oneLine(opts.title);
  if (!title) throw new Error("--title is required");
  if (title.length > 100) throw new Error("--title must be at most 100 characters");
  if (!opts.cwd) throw new Error("--cwd is required");
  const cwd = path.resolve(String(opts.cwd));
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--cwd is not a directory: ${cwd}`);
  const model = opts.model ?? defaults.model;
  if (!isModelId(model)) throw new Error(`Bad --model: ${model}`);
  const effort = opts.effort ?? defaults.effort;
  if (!EFFORTS.includes(effort)) throw new Error(`--effort must be one of ${EFFORTS.join(", ")}`);
  let permissionMode = opts["permission-mode"] ?? defaults.permissionMode;
  if (!WORKER_MODES.includes(permissionMode)) {
    throw new Error(`--permission-mode must be one of ${WORKER_MODES.join(", ")}`);
  }
  if (settings.workerPermissions === "auto") {
    if (permissionMode !== "plan") permissionMode = "auto";
  } else if (permissionMode === "auto") {
    throw new Error('--permission-mode auto needs workerPermissions "auto" in the config');
  }
  const brief = String(opts.brief ?? "").trim();
  if (!brief) throw new Error("The brief (task text) is required");
  if (brief.length > MAX_BRIEF) throw new Error(`The brief must be at most ${MAX_BRIEF} characters`);
  const parent = oneLine(opts.parent).slice(0, 100) || null;
  return { title, cwd, project: projectName(cwd), parent, model, effort, permissionMode, brief };
}

/** argv for one `claude -p` run: the first run names the session, later runs resume it. */
export function buildWorkerArgs(sessionId, session, job) {
  const args = ["-p"];
  if (job.resume) args.push("--resume", sessionId);
  else args.push("--session-id", sessionId, "--name", session.title);
  args.push(
    "--model", session.model,
    "--effort", session.effort,
    "--permission-mode", session.permissionMode,
    "--output-format", "json",
  );
  if (job.allowedTools?.length) args.push("--allowedTools", job.allowedTools.join(","));
  args.push("--", job.prompt); // "--": a Telegram text may start with "-"
  return args;
}

/** Start the detached runner for a worker (it drains the queue, one run at a time). */
export function launchRunner(sessionId) {
  const child = deps.spawn(process.execPath, [ENTRY_SCRIPT, "run-worker", sessionId], {
    detached: true,
    stdio: "ignore",
    cwd: os.homedir(),
    env: workerEnv(),
  });
  child.unref?.();
  return child.pid;
}

/** Record a headless session and launch its first run. Returns the session id. */
export async function startWorker(spec, { sessionId = randomUUID() } = {}) {
  const now = Date.now();
  await updateState((state) => {
    const session = {
      createdAt: now,
      updatedAt: now,
      title: spec.title,
      project: spec.project,
      cwd: spec.cwd,
      host: "Claude Code",
      headless: true,
      model: spec.model,
      effort: spec.effort,
      permissionMode: spec.permissionMode,
      job: { prompt: spec.brief, resume: false },
    };
    if (spec.parent) session.parent = spec.parent;
    if (spec.requestedBy) session.requestedBy = spec.requestedBy;
    state.sessions[sessionId] = session;
  });
  launchRunner(sessionId);
  await ensureDaemon();
  return sessionId;
}

/** Owner wrote to a worker: resume now, or leave it queued behind the running resume. */
export async function kickWorker(sessionId) {
  const session = (await readState()).sessions[sessionId];
  if (!session?.headless) return "not-headless";
  if (session.run && pidAlive(session.run.pid)) return "queued";
  launchRunner(sessionId);
  return "started";
}

const hasInbox = async (sid) => ((await fsp.stat(inboxFile(sid)).catch(() => null))?.size ?? 0) > 0;

// The Boss runs on Opus 5.5 at high effort (skills/boss/SKILL.md).
export const BOSS_REVIVE = { model: "claude-opus-5-5", effort: "high" };

/**
 * A message for a Boss whose app process stopped: resume that same session
 * headless (`claude -p --resume`) in its folder. The runner drains its inbox,
 * the Stop hook posts the reply to General, and the next app turn takes over
 * again. Never starts a second process while the app or a runner holds it.
 */
export async function wakeBoss(settings, sessionId) {
  const sid = safeSessionId(sessionId);
  const permissionMode = settings.workerPermissions === "auto" ? "auto" : settings.workerDefaults.permissionMode;
  const outcome = await updateState((state) => {
    const session = state.sessions[sid];
    if (!session || session.headless || session.host === "Codex") return "not-boss";
    if (session.run && pidAlive(session.run.pid)) return "queued";
    if (!session.ended) {
      delete session.revive; // the app runs it again: its waiter takes the inbox
      return "live";
    }
    session.revive = { ...BOSS_REVIVE, permissionMode, at: Date.now() };
    return "start";
  });
  if (outcome !== "start") return outcome;
  launchRunner(sid);
  await logLine(`boss ${sid}: app process stopped, resuming headless`);
  return "started";
}

/** Run claude, stdout/stderr to per-session files. Resolves { code, json, stderr, error }. */
export async function execClaude(bin, args, { cwd, sessionId }) {
  const outPath = runFile(sessionId, "out.json");
  const errPath = runFile(sessionId, "err.log");
  await fsp.mkdir(path.dirname(outPath), { recursive: true, mode: 0o700 });
  const out = await fsp.open(outPath, "w", 0o600);
  const err = await fsp.open(errPath, "w", 0o600);
  let outcome;
  try {
    outcome = await new Promise((resolve) => {
      const child = deps.spawn(bin, args, { cwd, stdio: ["ignore", out.fd, err.fd], env: workerEnv() });
      child.on("error", (error) => resolve({ code: -1, error: error.message }));
      child.on("exit", (code) => resolve({ code }));
    });
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
  const stdout = await fsp.readFile(outPath, "utf8").catch(() => "");
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  const stderr = await fsp.readFile(errPath, "utf8").catch(() => "");
  return { ...outcome, json, stderr };
}

/** A failed run has no Stop hook to speak for it: say so in the worker's topic. */
async function reportFailure(settings, sessionId, session, result) {
  const failed = result.code !== 0 || !result.json || result.json.is_error;
  if (!failed || !settings.token || !settings.chatId) return;
  const reason = result.error
    || (result.json?.is_error && typeof result.json.result === "string" && result.json.result)
    || result.stderr.trim().split("\n").filter(Boolean).at(-1)
    || L(`код ${result.code}`, `exit code ${result.code}`);
  const html = `⚠️ <b>${L("Запуск не удался", "Launch failed")}</b>\n<code>${escapeHtml(truncateText(redactSecrets(String(reason)), 400))}</code>`;
  const ctx = { sessionId, title: session.title, project: session.project, cwd: session.cwd, host: "Claude Code" };
  await deliver(settings, ctx, [html]).catch((error) => logLine(`worker ${sessionId} report: ${error.message}`));
}

/**
 * The runner (`run-worker <id>`): claim the session, run its pending job, then
 * keep resuming with queued Telegram messages until the inbox is empty.
 * Only one runner per session: a live claim makes later runners exit.
 */
export async function runWorker(sessionId, { exec = execClaude } = {}) {
  const sid = safeSessionId(sessionId);
  const settings = await loadSettings();
  const claimed = await updateState((state) => {
    const session = state.sessions[sid];
    if (!session?.headless && !session?.revive) return null;
    if (session.run && session.run.pid !== process.pid && pidAlive(session.run.pid)) return null;
    session.run = { pid: process.pid, since: Date.now() };
    const job = session.job ?? null;
    delete session.job;
    return { job };
  });
  if (!claimed) return 0;
  let runs = 0;
  try {
    let job = claimed.job;
    while (runs < MAX_RUNS_PER_RUNNER) {
      const current = (await readState()).sessions[sid];
      if (!current) break;
      // A revived Boss runs only while its app process is stopped; once the app
      // opens it again (SessionStart clears `ended`), the app's waiter takes the inbox.
      if (!current.headless && !(current.revive && current.ended)) break;
      if (!job) {
        const entries = await takeInbox(sid);
        if (!entries.length) break;
        job = { prompt: formatReplies(entries), resume: true };
        await updateState((state) => {
          if (state.sessions[sid]) state.sessions[sid].replyToTelegram = true;
        });
      }
      const session = (await readState()).sessions[sid];
      if (!session) break;
      const spec = session.headless ? session : { ...session, ...session.revive };
      runs += 1;
      const result = await exec(claudeBinary(settings), buildWorkerArgs(sid, spec, job), { cwd: session.cwd, sessionId: sid });
      await logLine(`worker ${sid} run ${runs}: exit ${result.code}`);
      await reportFailure(settings, sid, session, result);
      job = null;
    }
  } finally {
    await updateState((state) => {
      const session = state.sessions[sid];
      if (session?.run?.pid === process.pid) {
        delete session.run;
        delete session.revive;
      }
    });
  }
  // A message that arrived while this runner was finishing would wait forever: pick it up.
  if (await hasInbox(sid)) {
    const session = (await readState()).sessions[sid];
    if (session?.headless) launchRunner(sid);
    else if (session?.ended) await wakeBoss(settings, sid);
  }
  return runs;
}

// ---------------------------------------------------------------- spawn confirm

const quoted = (text) => L(`«${text}»`, `“${text}”`);
const spawnFacts = (spec) =>
  `${quoted(escapeHtml(spec.title))} · ${escapeHtml(spec.project || "—")} · ${escapeHtml(spec.model)}`;
const briefQuote = (spec) =>
  `<blockquote>${escapeHtml(truncateText(oneLine(redactSecrets(spec.brief)), 300))}</blockquote>`;

export function spawnQuestion(spec) {
  const details = [
    spec.parent ? `${L("родитель", "parent")} ${quoted(escapeHtml(spec.parent))}` : "",
    `effort ${escapeHtml(spec.effort)}`,
    escapeHtml(spec.permissionMode),
    spec.requestedBy ? `${L("просит", "requested by")} ${quoted(escapeHtml(spec.requestedBy))}` : "",
  ].filter(Boolean).join(" · ");
  return `🚀 <b>${L("Запустить сессию", "Start session")} ${spawnFacts(spec)}?</b>\n${briefQuote(spec)}\n<i>${details}</i>`;
}

export function spawnOutcome(spec, outcome, reason = "") {
  if (outcome === "started") return `▶️ <b>${L("Запущена сессия", "Started session")} ${spawnFacts(spec)}</b>\n${briefQuote(spec)}`;
  if (outcome === "cancelled") return L(`✕ <b>Отменено:</b> сессия ${spawnFacts(spec)}`, `✕ <b>Cancelled:</b> session ${spawnFacts(spec)}`);
  if (outcome === "expired") return L(`⌛ <i>Запрос устарел:</i> сессия ${spawnFacts(spec)}`, `⌛ <i>Request expired:</i> session ${spawnFacts(spec)}`);
  return `⚠️ <b>${L("Не удалось запустить", "Could not start")}</b> ${spawnFacts(spec)}\n<code>${escapeHtml(truncateText(redactSecrets(reason), 300))}</code>`;
}

export function spawnKeyboard(requestId) {
  return {
    inline_keyboard: [[
      { text: L("▶️ Запустить", "▶️ Start"), callback_data: `s:${requestId}:go`, style: "success" },
      { text: L("✕ Отмена", "✕ Cancel"), callback_data: `s:${requestId}:no` },
    ]],
  };
}

/** A message to General (or the fixed thread), outside any session topic. */
async function postGeneral(settings, html, { silent = false, replyMarkup, ping = false } = {}) {
  const sent = await deliver(settings, {}, [html], { silent: silent || isQuietTime(settings.quietHours), replyMarkup, ping });
  return { message_id: sent.messageIds.at(-1) };
}

/** Ask the owner in General; only their press starts the worker (through the daemon). */
export async function requestSpawn(settings, spec) {
  const requestId = randomBytes(6).toString("hex");
  await updateState((state) => {
    state.spawns[requestId] = { id: requestId, spec, createdAt: Date.now(), messageId: null };
  });
  let message;
  try {
    message = await postGeneral(settings, spawnQuestion(spec), { replyMarkup: spawnKeyboard(requestId), ping: true });
  } catch (error) {
    await updateState((state) => {
      delete state.spawns[requestId];
    });
    throw error;
  }
  await updateState((state) => {
    if (state.spawns[requestId]) state.spawns[requestId].messageId = message.message_id;
  });
  await ensureDaemon();
  return { requestId, messageId: message.message_id };
}

/**
 * `spawn`: start now when the owner chose spawnConfirm "never", else ask in
 * Telegram. --no-confirm cannot override "telegram".
 */
export async function spawnCommand(settings, opts) {
  const spec = resolveWorkerSpec(settings, opts);
  if (opts.requestedBy) spec.requestedBy = oneLine(opts.requestedBy).slice(0, 100);
  if (settings.spawnConfirm === "never") {
    const sessionId = await startWorker(spec);
    await postGeneral(settings, spawnOutcome(spec, "started"), { silent: true })
      .catch((error) => logLine(`spawn notice: ${error.message}`));
    return { status: "started", sessionId, title: spec.title };
  }
  const { requestId } = await requestSpawn(settings, spec);
  return {
    status: "awaiting-confirmation",
    requestId,
    title: spec.title,
    ...(opts["no-confirm"] ? { note: '--no-confirm ignored: the owner requires confirmation in Telegram (spawnConfirm "telegram")' } : {}),
  };
}

/** Daemon: the owner pressed ▶️ or ✕ under a spawn request. The first press wins. */
export async function handleSpawnPress(settings, route) {
  const toast = (text) =>
    telegram(settings.token, "answerCallbackQuery", { callback_query_id: route.callbackId, text }).catch(() => {});
  const otherId = await mirrorId(route.messageId);
  const request = await updateState((state) => {
    const item = state.spawns[route.requestId];
    if (!item || (item.messageId != null &&
        String(item.messageId) !== String(route.messageId) && String(item.messageId) !== String(otherId))) return null;
    delete state.spawns[route.requestId];
    return item;
  });
  if (!request) return toast(L("Запрос уже закрыт", "Request already closed"));
  const edit = (html) =>
    editNotification(settings, "editMessageText", {
      chat_id: route.chatId,
      message_id: route.messageId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch((error) => logLine(`edit spawn: ${error.message}`));
  if (Date.now() - request.createdAt > SPAWN_TTL_MS) {
    await edit(spawnOutcome(request.spec, "expired"));
    return toast(L("Запрос устарел", "Request expired"));
  }
  if (!route.go) {
    await edit(spawnOutcome(request.spec, "cancelled"));
    return toast(L("Отменено", "Cancelled"));
  }
  try {
    await startWorker(request.spec);
  } catch (error) {
    await edit(spawnOutcome(request.spec, "failed", error.message));
    return toast(L("Не удалось запустить", "Could not start"));
  }
  await edit(spawnOutcome(request.spec, "started"));
  return toast(L("Запускаю", "Starting"));
}

/** Daemon tick: deliver queued messages to idle workers, expire old spawn requests. */
export async function tickWorkers(settings, now = Date.now()) {
  const state = await readState();
  for (const [sid, session] of Object.entries(state.sessions)) {
    if (!listeningWorker(session, now)) continue;
    if (session.run && pidAlive(session.run.pid)) continue;
    const queued = Boolean(session.job) || (await fsp.stat(inboxFile(sid)).then((info) => info.size > 0).catch(() => false));
    if (queued) launchRunner(sid);
  }
  for (const request of Object.values(state.spawns)) {
    if (now - request.createdAt <= SPAWN_TTL_MS) continue;
    await updateState((next) => {
      delete next.spawns[request.id];
    });
    if (request.messageId) {
      await editNotification(settings, "editMessageText", {
        chat_id: settings.chatId,
        message_id: request.messageId,
        text: spawnOutcome(request.spec, "expired"),
        parse_mode: "HTML",
      }).catch(() => {});
    }
  }
}

// ------------------------------------------------------------------ hierarchy

/** `set-parent <title>`: the calling session becomes a child of <title>; "" clears it. */
export async function setParent(sessionId, parent) {
  const sid = safeSessionId(sessionId);
  const value = oneLine(parent).slice(0, 100);
  return updateState((state) => {
    const now = Date.now();
    const session = (state.sessions[sid] ??= { createdAt: now, updatedAt: now, host: "Claude Code" });
    if (value) session.parent = value;
    else delete session.parent;
    return { sessionId: sid, parent: session.parent ?? null, parentKnown: value ? Boolean(findSession(state, value)) : null };
  });
}

/**
 * `notify-boss "<text>"`: append to the Boss inbox; its waiter wakes it with
 * «Сессия «<title>» сообщает: <text>». At most one message per 30 s per session.
 */
export async function notifyBoss(sessionId, text, { now = Date.now() } = {}) {
  const sid = safeSessionId(sessionId);
  const body = truncateText(String(text ?? "").trim(), 1500);
  if (!body) throw new Error('Usage: notify-boss "<text>"');
  const revive = (await loadSettings()).bossRevive;
  const result = await updateState((state) => {
    const live = resolveBossId(state);
    const bossId = live ?? (revive ? dormantBossId(state) : null);
    if (!bossId) return { error: "no-boss" };
    if (bossId === sid) return { error: "self" };
    const stamps = (state.meta.notifyAt ??= {});
    for (const [key, at] of Object.entries(stamps)) if (now - at > 86_400_000) delete stamps[key];
    const last = stamps[sid] ?? 0;
    if (now - last < NOTIFY_INTERVAL_MS) {
      return { error: "rate", retryInSec: Math.ceil((NOTIFY_INTERVAL_MS - (now - last)) / 1000) };
    }
    stamps[sid] = now;
    return {
      bossId,
      from: state.sessions[sid]?.title ?? L("Сессия", "Session"),
      headless: Boolean(state.sessions[bossId]?.headless),
      dormant: !live,
    };
  });
  if (result.error) return result;
  await appendInbox(result.bossId, { kind: "notify", from: result.from, fromId: sid, text: body, at: now });
  if (result.headless) await kickWorker(result.bossId);
  else if (result.dormant) await wakeBoss(await loadSettings(), result.bossId);
  return { ok: true, bossId: result.bossId };
}
