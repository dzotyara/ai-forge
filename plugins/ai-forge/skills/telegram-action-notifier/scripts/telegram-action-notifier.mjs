import { writeSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  REPLY_PREFIX,
  TOPIC_REASON_TEXT,
  addPending,
  buildKeyboard,
  claimBoss,
  deliver,
  editNotification,
  describeSession,
  findSession,
  isTelegramPrompt,
  logLine,
  markSessionEnded,
  markTurn,
  permissionDecision,
  pidAlive,
  questionDecision,
  requestAnswer,
  readState,
  requestApproval,
  resolveBossId,
  resolvePending,
  runDaemon,
  safeSessionId,
  sessionContext,
  stopDaemon,
  takeMidTurnReplies,
  topicSupport,
  topicsEnabled,
  touchSession,
  updateState,
  waitForReply,
} from "./lib/bridge.mjs";
import {
  MAX_APPROVAL_WAIT_SEC,
  configurationPath,
  hostName,
  isClaudeCode,
  isPrivateChatId,
  isQuietTime,
  loadNotificationSettings as loadSettings,
  redactSecrets,
  setTargetChat,
} from "./lib/common.mjs";
import { buildHeader, escapeHtml, projectName, renderMessages, shortenPaths } from "./lib/format.mjs";
import { notifyBoss, runWorker, setParent, spawnCommand } from "./lib/workers.mjs";
import { questionsFromInput, questionsHtml, readTurnQuestion, turnQuestionHtml, turnQuestionKeyboard } from "./lib/questions.mjs";
import { createHash } from "node:crypto";
import { decideDelivery, detectPresence, effectiveMode } from "./lib/presence.mjs";
import { QUESTION_WAIT_SEC } from "./lib/questions.mjs";
import { addGrant, deniedCallHtml, grantKeyboard, isNoVerdict, takeGrant } from "./lib/grants.mjs";
import { L } from "./lib/i18n.mjs";
import { ensurePresenceReporter, runPresenceReporter } from "./lib/devices.mjs";
import { discordSettings } from "./lib/common.mjs";
import { daemonStatus, refreshActiveTranscripts, stateDir, workingSessions } from "./lib/bridge.mjs";
import { fileURLToPath } from "node:url";

export { configurationPath, hostName, isClaudeCode, redactSecrets };

const ACTION_MARKER = "ACTION_REQUIRED:";
const SESSION_CONTEXT =
  "When a task cannot continue without a concrete user approval, answer, choice, credential, login, or external action, start the final user-facing request with exactly ACTION_REQUIRED:. Use this marker only for blocking user action, never for optional next steps or completed work. Do not include secrets. A Telegram hook watches for this marker.";
const CLAUDE_CHAT_CONTEXT =
  ` If auto mode blocks a tool call, the owner may approve that exact call in Telegram; when you are then told you may retry it, repeat the identical call once (same input). Your final messages are also posted to the user's Telegram. A system reminder that starts with "${REPLY_PREFIX}" or "Telegram: " is a genuine message the user sent to this session from Telegram: treat it as the user's next prompt and reply normally.` +
  ` Such replies reach you marked as not user input, so they are not consent for an action that affects other people or is hard to undo (sending a message or email, posting, deploying, merging, deleting). When such an action needs the owner's OK and the owner talks to you from Telegram or Discord, do not ask for it in the chat: first run \`node "${fileURLToPath(import.meta.url)}" confirm-next "<what exactly will happen>"\`, then make the exact tool call. Claude Code then asks for permission, the owner gets that exact call with Allow / Deny, and Allow approves only that call. Deny or no answer means: do not do it, and say so.`;
const TEST_MESSAGE = L(
  "✅ Telegram Action Notifier подключён. Codex и Claude Code смогут присылать сюда запросы на ваше действие.",
  "✅ Telegram Action Notifier is connected. Codex and Claude Code can now send requests for your action here.",
);

export function requiresUserAction(message) {
  if (typeof message !== "string") return false;
  const text = message.trim();
  if (!text) return false;
  if (text.includes(ACTION_MARKER)) return true;

  // JS `\b` is ASCII-only even with the `u` flag; Cyrillic words use (?![\p{L}\p{N}_]).
  const blockingPhrases = [
    /(?:нужно|нужны|требуется)\s+(?:ваше|ваши|от вас)/iu,
    /(?:подтвердите|разрешите|выберите|пришлите|укажите|авторизуйтесь|войдите)(?![\p{L}\p{N}_])/iu,
    /(?:без|жду)\s+(?:вашего|ваших|вас)(?![\p{L}\p{N}_])/iu,
    /(?:i need|we need)\s+(?:your|you to)\b/iu,
    /(?:please)\s+(?:approve|confirm|choose|send|provide|sign in|log in)\b/iu,
    /(?:waiting for|blocked on)\s+(?:your|you)\b/iu,
  ];

  return blockingPhrases.some((pattern) => pattern.test(text));
}

/** Approval body: tool, reason and (for file tools) the shortened file path. Never the raw command. */
export function approvalBody(event, { buttons = false } = {}) {
  const host = hostName();
  const tool = typeof event?.tool_name === "string" && event.tool_name ? event.tool_name : "unknown tool";
  const description =
    typeof event?.tool_input?.description === "string" && event.tool_input.description.trim()
      ? event.tool_input.description.trim()
      : L(`${host} запрашивает разрешение на действие.`, `${host} is asking for permission to act.`);
  const lines = [`${L("Нужно разрешение", "Permission needed")}: <code>${escapeHtml(tool)}</code>`];
  lines.push(`<blockquote>${escapeHtml(shortenPaths(redactSecrets(description), event?.cwd))}</blockquote>`);
  const file = event?.tool_input?.file_path ?? event?.tool_input?.notebook_path;
  if (typeof file === "string" && file) {
    lines.push(`${L("Файл", "File")}: <code>${escapeHtml(shortenPaths(file, event?.cwd))}</code>`);
  }
  lines.push(
    buttons
      ? L("<i>Ответьте кнопкой ниже или в приложении.</i>", "<i>Answer with a button below or in the app.</i>")
      : L(
        `<i>Откройте ${escapeHtml(host)} и подтвердите или отклоните запрос.</i>`,
        `<i>Open ${escapeHtml(host)} to approve or deny the request.</i>`,
      ),
  );
  return lines.join("\n");
}

/**
 * Render the Telegram message parts for a hook event (HTML, already split).
 * `title` defaults to the project name.
 */
export function buildMessageParts(event, { title, kind, buttons = false } = {}) {
  const type = event?.hook_event_name;
  const cwd = typeof event?.cwd === "string" ? event.cwd : "";
  const project = projectName(cwd);
  const sessionTitle = title || project || L("Сессия", "Session");
  const host = hostName();
  if (type === "PermissionRequest") {
    const header = buildHeader({ kind: "approval", title: sessionTitle, project, host });
    return [`${header}\n\n${approvalBody(event, { buttons })}`];
  }
  if (type === "Stop") {
    const blocking = requiresUserAction(event?.last_assistant_message);
    const header = buildHeader({ kind: kind ?? (blocking ? "action" : "turn"), title: sessionTitle, project, host });
    return renderMessages({ header, body: event?.last_assistant_message ?? "", cwd, label: sessionTitle });
  }
  return [];
}

/** Backward-compatible single-string form. */
export function buildTelegramMessage(event) {
  return buildMessageParts(event).join("\n\n");
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

/** One-off message to the configured chat (configure test, UI test button). */
export async function sendTelegram(text, { strict = false } = {}) {
  const settings = await loadSettings();
  if (!settings.token || !settings.chatId) {
    if (strict) {
      throw new Error(
        "Configure Telegram or Discord in configure.mjs --ui before testing notifications.",
      );
    }
    return false;
  }
  await deliver(settings, {}, [escapeHtml(text.slice(0, 4000))]);
  return true;
}

/** Presence, mode and the delivery decision for one outbound event. */
async function decide(kind, settings, session, meta) {
  const presence = await detectPresence({
    idleThresholdSec: settings.presenceIdleSec,
    claude: isClaudeCode(),
  });
  const mode = effectiveMode(settings, meta);
  return decideDelivery({
    kind,
    presence,
    mode: mode.mode,
    muteUntil: mode.muteUntil,
    quietHours: settings.quietHours,
    notify: settings.notify,
    approvalGraceSec: settings.approvalGraceSec,
    actionGraceSec: settings.actionGraceSec,
    // A headless worker has no app window: its turns always go to Telegram.
    viaTelegram: Boolean(session?.replyToTelegram || session?.headless),
  });
}

/** A `claude -p` worker started by `spawn` (env set by the runner; state as a fallback). */
const isHeadless = (session) => process.env.TELEGRAM_BRIDGE_HEADLESS === "1" || Boolean(session?.headless);

async function onStop(event, settings) {
  if (event.session_id) await markTurn(event.session_id, false).catch(() => {});
  const message = event.last_assistant_message;
  if (typeof message !== "string" || !message.trim()) return;
  const ctx = await sessionContext(event, hostName());
  // A finished turn settles whatever the previous turn was waiting for.
  await resolvePending(ctx.sessionId, { kinds: ["approval"], edit: true });
  await resolvePending(ctx.sessionId, { kinds: ["action"], edit: false });
  if (ctx.sessionId) await touchSession(ctx); // known to /status, the boss and the panel even when quiet
  const state = await readState();
  const session = ctx.sessionId ? state.sessions[ctx.sessionId] : null;
  if (session?.muted) return;
  // The app's next-step question is not in the message text: read it from the transcript.
  const question = isClaudeCode() ? await readTurnQuestion(event.transcript_path) : null;
  const blocking = requiresUserAction(message) || Boolean(question);
  if (!blocking && session?.closed) return;
  const kind = blocking ? "action" : "turn";
  const decision = await decide(kind, settings, session, state.meta);
  // A turn started from Telegram answers there once; the flag is then spent.
  if (session?.replyToTelegram) {
    await updateState((next) => {
      if (next.sessions[ctx.sessionId]) next.sessions[ctx.sessionId].replyToTelegram = false;
    });
  }
  if (decision.action === "skip") return;
  const parts = buildMessageParts(event, { title: ctx.title, kind });
  let replyMarkup;
  if (question) {
    const html = turnQuestionHtml(question);
    if (parts.length && parts.at(-1).length + html.length + 2 <= 4000) parts[parts.length - 1] += `\n\n${html}`;
    else parts.push(html);
    replyMarkup = turnQuestionKeyboard(question) ?? undefined;
  }
  if (decision.action === "delay") {
    await addPending({ kind, ctx, parts, silent: decision.silent, delaySec: decision.delaySec, replyMarkup });
    return;
  }
  const sent = await deliver(settings, ctx, parts, { silent: decision.silent, replyMarkup, ping: blocking });
  if (blocking && ctx.sessionId) {
    await addPending({ kind, ctx, parts, sent: true, messageIds: sent.messageIds });
  }
}

async function onPermissionRequest(event, settings) {
  const ctx = await sessionContext(event, hostName());
  const state = await readState();
  const session = ctx.sessionId ? state.sessions[ctx.sessionId] : null;
  if (session?.muted) return;
  const toolName = typeof event.tool_name === "string" ? event.tool_name : null;
  if (isHeadless(session)) {
    // In claude -p nobody answers a prompt: no decision means "denied". Verified on
    // 2.1.317: this hook fires in -p and its "allow" decision approves the call.
    if (settings.workerPermissions === "auto") return;
    const decision = await decide("approval", settings, { ...session, headless: true }, state.meta);
    if (decision.action === "skip") return;
    const [html] = buildMessageParts(event, { title: ctx.title, buttons: true });
    const behavior = await requestApproval(settings, ctx, html, MAX_APPROVAL_WAIT_SEC, {
      toolName,
      timeoutOutcome: "timeout-denied",
    });
    if (behavior) process.stdout.write(JSON.stringify(permissionDecision(behavior)));
    return;
  }
  const decision = await decide("approval", settings, session, state.meta);
  if (decision.action === "skip") return;
  const questions = toolName === "AskUserQuestion" && isClaudeCode() ? questionsFromInput(event.tool_input) : null;
  if (questions) {
    // A question with options: send them as buttons (after the grace period while the owner is at the Mac).
    const header = buildHeader({ kind: "question", title: ctx.title, project: projectName(event.cwd ?? ""), host: hostName() });
    const answers = await requestAnswer(settings, ctx, questionsHtml(header, questions), questions, {
      graceSec: decision.action === "delay" ? decision.delaySec : 0,
      silent: decision.silent,
    });
    if (answers) process.stdout.write(JSON.stringify(questionDecision(event.tool_input, answers)));
    return;
  }
  // Buttons whenever this hook can decide (Claude Code). The app dialog runs in
  // parallel and is not blocked by the hook: whoever answers first decides. At the
  // Mac the buttons wait `approvalGraceSec` (or until you step away) first.
  // Codex: its hook can decide too (Codex 0.166+). No daemon here receives presses,
  // so the request goes to Discord and the daemon on another device records the answer.
  const remote = !isClaudeCode() && settings.notificationTarget !== "telegram" && Boolean(discordSettings(settings)) &&
    settings.codexApprovalWaitSec > 0;
  const buttons = (isClaudeCode() && settings.approvalWaitSec > 0) || remote;
  let [html] = buildMessageParts(event, { title: ctx.title, buttons });
  // Armed with confirm-next: show what the owner is confirming above the buttons.
  if (session?.confirmWhat && Date.now() - session.confirmWhat.at < 120_000) {
    html += `\n\n✋ <b>${L("Подтвердите", "Confirm")}:</b> ${escapeHtml(session.confirmWhat.what)}`;
    await updateState((next) => { if (next.sessions[ctx.sessionId]) delete next.sessions[ctx.sessionId].confirmWhat; });
  }
  if (decision.action === "delay" && !buttons) {
    await addPending({ kind: "approval", ctx, parts: [html], toolName, silent: decision.silent, delaySec: decision.delaySec });
    return;
  }
  if (!buttons) {
    const sent = await deliver(settings, ctx, [html], { silent: decision.silent, ping: true });
    if (ctx.sessionId) {
      await addPending({ kind: "approval", ctx, parts: [html], toolName, sent: true, messageIds: sent.messageIds });
    }
    return;
  }
  const behavior = await requestApproval(settings, ctx, html, remote ? settings.codexApprovalWaitSec : settings.approvalWaitSec, {
    toolName,
    graceSec: decision.action === "delay" ? decision.delaySec : 0,
    silent: decision.silent,
    remote,
  });
  if (behavior) process.stdout.write(JSON.stringify(permissionDecision(behavior)));
}

/**
 * Auto mode blocked a tool call: show the exact call in Telegram with
 * «Разрешить один раз». A press stores a one-time grant and tells the model it
 * may retry; the retry is approved by onPreToolUse. No press: the denial stands.
 */
async function onPermissionDenied(event, settings) {
  if (!isClaudeCode() || !event.session_id || typeof event.tool_name !== "string") return;
  if (!settings.telegramDenials || isNoVerdict(event.reason)) return;
  const ctx = await sessionContext(event, hostName());
  const state = await readState();
  const session = state.sessions[ctx.sessionId];
  if (session?.muted || session?.closed) return;
  const decision = await decide("approval", settings, { ...session, headless: true }, state.meta);
  if (decision.action === "skip") return;
  const header = buildHeader({ kind: "approval", title: ctx.title, project: projectName(event.cwd ?? ""), host: hostName() });
  const html = `${header}\n\n${deniedCallHtml(event)}`;
  const behavior = await requestApproval(settings, ctx, html, QUESTION_WAIT_SEC, {
    toolName: event.tool_name,
    timeoutOutcome: "timeout-denied",
    keyboard: grantKeyboard,
  });
  if (behavior !== "allow") return;
  await addGrant(ctx.sessionId, event.tool_name, event.tool_input);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionDenied", retry: true } }));
}

/** The retry of a call the owner approved in Telegram: allow it once. */
const CONFIRM_TTL_MS = 15 * 60_000;
const isConfirmCall = (event) =>
  event.tool_name === "Bash" && /\bconfirm-next\b/.test(String(event.tool_input?.command ?? ""));

/**
 * The session armed `confirm-next`: take it for this call (not for the arming call
 * itself). Returns what the owner is asked to confirm, or null.
 */
export async function takeConfirmNext(sessionId, event, now = Date.now()) {
  if (isConfirmCall(event)) return null;
  return updateState((state) => {
    const session = state.sessions[sessionId];
    const armed = session?.confirmNext;
    if (!armed) return null;
    delete session.confirmNext;
    if (now - armed.at > CONFIRM_TTL_MS) return null;
    session.confirmWhat = { what: armed.what, at: now };
    return armed;
  });
}

async function onPreToolUse(event) {
  if (!isClaudeCode() || !event.session_id || typeof event.tool_name !== "string") return;
  // An action the owner must confirm: force Claude Code to ask, whatever the rules
  // allow. The PermissionRequest hook then sends the exact call with Allow / Deny.
  const armed = await takeConfirmNext(safeSessionId(event.session_id), event);
  if (armed) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: L(`Нужно подтверждение владельца: ${armed.what}`, `Owner confirmation needed: ${armed.what}`),
      },
    }));
    return;
  }
  if (!(await takeGrant(safeSessionId(event.session_id), event.tool_name, event.tool_input))) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: L(
        "Владелец разрешил этот вызов один раз в Telegram или Discord",
        "The owner allowed this call once in Telegram or Discord",
      ),
    },
  }));
}

async function onUserPromptSubmit(event) {
  if (!event.session_id) return;
  const sessionId = safeSessionId(event.session_id);
  await markTurn(sessionId, true).catch(() => {});
  const fromTelegram = isTelegramPrompt(event.prompt);
  // Answered: cancel timers; mark sent messages "решено в приложении" unless the answer came from Telegram.
  await resolvePending(sessionId, { edit: !fromTelegram });
  const state = await readState();
  if (!fromTelegram && state.sessions[sessionId]?.replyToTelegram) {
    await updateState((next) => {
      if (next.sessions[sessionId]) next.sessions[sessionId].replyToTelegram = false;
    });
  }
}

async function onPostToolUse(event, settings) {
  if (!event.session_id || typeof event.tool_name !== "string") return;
  const sessionId = safeSessionId(event.session_id);
  await resolvePending(sessionId, {
    kinds: ["approval"],
    toolName: event.tool_name,
    edit: true,
  });
  // A message from the chat while the turn is still running: hand it over now.
  // Only to the main agent: a subagent's tool call carries the same session id
  // plus agent_id/agent_type, and the message would end up in the subagent.
  if (!isClaudeCode() || event.agent_id || event.agent_type) return;
  const replies = await takeMidTurnReplies(settings, sessionId).catch(() => "");
  if (!replies) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: replies },
  }));
}

/** Extra SessionStart context for a headless worker: who it is and how it reports. */
export function headlessContext(session) {
  if (!session) return "";
  if (session.boss) {
    return " This is the Boss session, created headless (claude -p) by the bridge because no Boss was running. The app session tools are unavailable: start children with `spawn`. Your final message is posted to General; tool permissions are decided in Telegram or Discord. Follow the boss skill.";
  }
  if (session.revive) {
    return " This is the Boss session, resumed headless (claude -p) because its app process stopped. The app session tools are unavailable on this run: start children with `spawn`. Your final message is posted to General; tool permissions are decided in Telegram. Keep following the boss skill.";
  }
  const parent = session.parent ? ` Your parent session is «${session.parent}».` : "";
  return ` This session is a headless worker (claude -p) titled «${session.title}».${parent} It has no app window and no app session tools: your final message is posted to its Telegram topic, the owner's replies resume you, and tool permissions are decided in Telegram. Follow the team skill.`;
}

async function onSessionStart(event) {
  const claude = isClaudeCode();
  let extra = "";
  if (claude && event.session_id && process.env.TELEGRAM_BRIDGE_HEADLESS === "1") {
    const state = await readState().catch(() => null);
    extra = headlessContext(state?.sessions[safeSessionId(event.session_id)]);
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: claude ? SESSION_CONTEXT + CLAUDE_CHAT_CONTEXT + extra : SESSION_CONTEXT,
      },
    }),
  );
  if (claude && event.session_id) {
    try {
      // SessionStart has a 3 s budget: read only the transcript tail here.
      const ctx = await sessionContext(event, hostName(), { fullScan: false });
      await touchSession(ctx, { ended: false });
    } catch {
      // Registration is best effort; never delay the session.
    }
  }
}

async function onWaitReply() {
  // Two-way chat is Claude Code only (asyncRewake); Codex exits at once.
  if (!isClaudeCode()) return 0;
  const raw = await readStdin();
  if (!raw.trim()) return 0;
  const event = JSON.parse(raw);
  const result = await waitForReply(event);
  if (result.code === 2) writeSync(2, result.text);
  return result.code;
}

// ------------------------------------------------------------------ CLI

/** Minimal argv parser: --flag, --option value, everything else positional. */
export function parseCliArgs(args, { flags = [], options = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--") || arg === "--") {
      out._.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (flags.includes(name)) out[name] = true;
    else if (options.includes(name)) {
      if (i + 1 >= args.length) throw new Error(`--${name} needs a value`);
      out[name] = args[(i += 1)];
    } else throw new Error(`Unknown option --${name}`);
  }
  return out;
}

/** Session context for a CLI target; an unknown title gets a stable placeholder session. */
async function cliTarget(target) {
  const state = await readState();
  const sessionId = findSession(state, target);
  if (sessionId) {
    const s = state.sessions[sessionId];
    return { sessionId, title: s.title ?? target, project: s.project ?? "", cwd: s.cwd ?? "", host: s.host ?? "Claude Code" };
  }
  if (String(target).toLowerCase() === "boss") return { ...bossContext(state), sessionId: null };
  const id = `title-${createHash("sha256").update(String(target).trim().toLowerCase()).digest("hex").slice(0, 16)}`;
  return { sessionId: id, title: String(target).trim(), project: "", cwd: "", host: "Claude Code" };
}

/** In a session topic the topic name says who speaks; elsewhere show a header. */
async function cliHeader(settings, ctx) {
  const state = await readState();
  const inTopic = ctx.sessionId && resolveBossId(state) !== ctx.sessionId && settings.topics && (await topicsEnabled(settings));
  return inTopic ? "" : buildHeader({ kind: "turn", title: ctx.title, project: ctx.project, host: "" });
}

function bossContext(state) {
  const bossId = resolveBossId(state);
  const session = bossId ? state.sessions[bossId] : null;
  return {
    sessionId: bossId,
    title: session?.title ?? L("Босс", "Boss"),
    project: session?.project ?? "",
    cwd: session?.cwd ?? "",
    host: session?.host ?? "Claude Code",
  };
}

const CLI = {
  /** set-chat <id>: point the bridge at a chat or group (keeps the owner id). */
  async "set-chat"([id]) {
    await stopDaemon();
    const result = await setTargetChat(id);
    console.log(`Chat set to ${result.chatId} (${isPrivateChatId(result.chatId) ? "private chat" : "group"}).`);
    if (!result.ownerUserId) {
      console.log("Owner user id is unknown: the bot will ignore everyone in the group. Set ownerUserId in the config or use the settings page.");
    }
    const settings = await loadSettings();
    const topics = await topicSupport(settings, { fresh: true });
    console.log(`Topics: ${TOPIC_REASON_TEXT[topics.reason] ?? topics.reason}`);
  },

  /** claim-boss [session_id]: bind the boss explicitly (default: the calling session). */
  /** confirm-next "<what>": the next tool call of this session must be approved by the owner. */
  async "confirm-next"(args) {
    const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
    if (!sessionId) throw new Error("CLAUDE_CODE_SESSION_ID is not set here.");
    const what = args.join(" ").trim().slice(0, 300) || L("действие", "an action");
    await updateState((state) => {
      const sid = safeSessionId(sessionId);
      const session = (state.sessions[sid] ??= { updatedAt: Date.now() });
      session.confirmNext = { what, at: Date.now() };
    });
    console.log(JSON.stringify({ armed: true, what }));
  },

  async "claim-boss"([id]) {
    const sessionId = id || process.env.CLAUDE_CODE_SESSION_ID;
    if (!sessionId) throw new Error("Pass a session id; CLAUDE_CODE_SESSION_ID is not set here.");
    console.log(`Boss session: ${await claimBoss(sessionId)}`);
  },

  /** sessions [--json]: known sessions for the boss. */
  async sessions(args) {
    const state = await readState();
    const bossId = resolveBossId(state);
    const list = Object.entries(state.sessions)
      .map(([sid, session]) => describeSession(sid, session, pidAlive, bossId))
      .sort((a, b) => (b.lastPostAt ?? 0) - (a.lastPostAt ?? 0));
    if (args.includes("--json")) {
      console.log(JSON.stringify(list.map(({ id, title, project, host, status, waiting, topicId, isBoss, muted, parent, headless }) => ({
        id, title, project, host, status, waiting, topic: topicId, isBoss, muted, parent, headless,
      })), null, 2));
      return;
    }
    for (const it of list) {
      const tags = `${it.isBoss ? "  [boss]" : ""}${it.headless ? "  [headless]" : ""}${it.parent ? `  [parent: ${it.parent}]` : ""}`;
      console.log(`${it.id}  ${it.status.padEnd(11)} ${it.title}${it.project ? ` · ${it.project}` : ""}${tags}`);
    }
  },

  /**
   * spawn --cwd <dir> --title <t> [--parent <title>] [--model <id>] [--effort <lvl>]
   *       [--permission-mode <mode>] [--no-confirm] "<brief>"
   * Starts a headless `claude -p` worker, or asks the owner in General first.
   */
  async spawn(args) {
    const opts = parseCliArgs(args, {
      flags: ["no-confirm"],
      options: ["cwd", "title", "parent", "model", "effort", "permission-mode"],
    });
    const settings = await loadSettings();
    if (!settings.token || !settings.chatId) throw new Error("Telegram is not configured.");
    const state = await readState();
    const caller = process.env.CLAUDE_CODE_SESSION_ID ? state.sessions[safeSessionId(process.env.CLAUDE_CODE_SESSION_ID)] : null;
    const result = await spawnCommand(settings, { ...opts, brief: opts._.join(" "), requestedBy: caller?.title });
    if (result.note) console.error(result.note);
    console.log(JSON.stringify(result));
  },

  /** set-parent <title>: make the calling session a child of <title> ("" clears). */
  async "set-parent"(args) {
    const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
    if (!sessionId) throw new Error("CLAUDE_CODE_SESSION_ID is not set here: run this from inside a session.");
    if (!args.length) throw new Error('Usage: set-parent "<parent title>" (or "" to clear)');
    const result = await setParent(sessionId, args.join(" "));
    if (result.parent && !result.parentKnown) console.error(`Note: no session titled «${result.parent}» is known yet.`);
    console.log(JSON.stringify(result));
  },

  /** notify-boss "<text>": wake the Boss with a short report from this session. */
  async "notify-boss"(args) {
    const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
    if (!sessionId) throw new Error("CLAUDE_CODE_SESSION_ID is not set here: run this from inside a session.");
    const result = await notifyBoss(sessionId, args.join(" "));
    if (result.error === "no-boss") throw new Error("No Boss session is running.");
    if (result.error === "self") throw new Error("This session is the Boss.");
    if (result.error === "rate") throw new Error(`Rate limit: one message per 30 s. Retry in ${result.retryInSec} s.`);
    console.log("Sent to the Boss.");
  },

  /** run-worker <session_id>: internal, started detached by spawn and the daemon. */
  async "run-worker"([id]) {
    if (!id) throw new Error("Usage: run-worker <session_id>");
    try {
      await runWorker(id);
    } catch (error) {
      await logLine(`run-worker ${id}: ${error?.message ?? error}`);
      throw error;
    }
  },

  /** alert "<text>": post into General with sound, through smart delivery. */
  async alert(args) {
    const text = args.join(" ").trim();
    if (!text) throw new Error('Usage: alert "<text>"');
    const settings = await loadSettings();
    if (!settings.token || !settings.chatId) throw new Error("Telegram is not configured.");
    const state = await readState();
    const ctx = bossContext(state);
    const presence = await detectPresence({ idleThresholdSec: settings.presenceIdleSec, claude: true });
    const mode = effectiveMode(settings, state.meta);
    const decision = decideDelivery({
      kind: "action",
      presence,
      mode: mode.mode,
      muteUntil: mode.muteUntil,
      quietHours: settings.quietHours,
      actionGraceSec: settings.actionGraceSec,
    });
    const boss = L("Босс", "Boss");
    const header = buildHeader({ kind: "action", title: boss, host: "" });
    const parts = renderMessages({ header, body: text, label: boss });
    if (decision.action === "skip") return console.log("Not sent: delivery is off or paused.");
    if (decision.action === "delay") {
      await addPending({ kind: "alert", ctx, parts, silent: decision.silent, delaySec: decision.delaySec });
      return console.log(`The user is at the Mac: queued, sent in ${decision.delaySec}s unless they reply in the app.`);
    }
    await deliver(settings, ctx, parts, { silent: decision.silent, ping: true });
    return console.log("Sent.");
  },

  /**
   * post --to <title|boss|sessionId> [--silent] [--buttons '<json>'] [--reply-to <id>] "<text>"
   * Prints {"messageId", "topicId"}. Creates the topic if needed.
   */
  async post(args) {
    const opts = parseCliArgs(args, { flags: ["silent"], options: ["to", "session", "buttons", "reply-to"] });
    const text = opts._.join(" ").trim();
    const target = opts.to ?? opts.session;
    if (!target || !text) throw new Error('Usage: post --to <title|boss|id> [--silent] [--buttons JSON] [--reply-to ID] "<text>"');
    const replyMarkup = opts.buttons ? buildKeyboard(opts.buttons) : undefined;
    const settings = await loadSettings();
    if (!settings.token || !settings.chatId) throw new Error("Telegram is not configured.");
    const ctx = await cliTarget(target);
    const header = await cliHeader(settings, ctx);
    const parts = renderMessages({ header, body: text, cwd: ctx.cwd, label: ctx.title });
    const sent = await deliver(settings, ctx, parts, {
      silent: Boolean(opts.silent) || isQuietTime(settings.quietHours),
      replyMarkup,
      replyTo: opts["reply-to"],
      // Buttons ask the owner something: mention them in Discord.
      ping: Boolean(replyMarkup) && !opts.silent,
    });
    console.log(JSON.stringify({ messageId: sent.messageIds.at(-1) ?? null, topicId: sent.threadId ?? null }));
  },

  /** edit --to <target> --message <id> [--buttons JSON | --no-buttons] "<text>" */
  async edit(args) {
    const opts = parseCliArgs(args, { flags: ["no-buttons"], options: ["to", "session", "message", "buttons"] });
    const text = opts._.join(" ").trim();
    const target = opts.to ?? opts.session;
    if (!target || !opts.message || !text) throw new Error('Usage: edit --to <target> --message <id> [--buttons JSON|--no-buttons] "<text>"');
    const settings = await loadSettings();
    const ctx = await cliTarget(target);
    const header = await cliHeader(settings, ctx);
    const [html] = renderMessages({ header, body: text, cwd: ctx.cwd, label: ctx.title, maxParts: 1 });
    const params = {
      chat_id: settings.chatId,
      message_id: String(opts.message).includes(":") ? opts.message : Number(opts.message),
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    };
    // Without --buttons the keyboard is removed (Telegram drops it on edit).
    if (opts.buttons) params.reply_markup = buildKeyboard(opts.buttons);
    await editNotification(settings, "editMessageText", params);
    const state = await readState();
    console.log(JSON.stringify({ messageId: params.message_id, topicId: ctx.sessionId ? state.sessions[ctx.sessionId]?.topicId ?? null : null }));
  },
};

/** Dispatch one hook event (stdin JSON already parsed). */
export async function handleEvent(event) {
  const settings = await loadSettings();
  // Codex has no daemon: its hooks keep a small reporter alive so other devices
  // (and the Discord status) see how many Codex sessions work here.
  if (!isClaudeCode() && settings.notificationTarget !== "telegram" && discordSettings(settings)) {
    await ensurePresenceReporter(stateDir(), fileURLToPath(import.meta.url)).catch(() => {});
  }

  if (event.hook_event_name === "SessionStart") {
    await onSessionStart(event);
    return;
  }
  if (event.hook_event_name === "SessionEnd") {
    await markSessionEnded(event.session_id);
    await markTurn(event.session_id, false).catch(() => {});
    return;
  }
  if (event.hook_event_name === "UserPromptSubmit") {
    await onUserPromptSubmit(event);
    return;
  }
  if (event.hook_event_name === "PostToolUse") {
    await onPostToolUse(event, settings);
    return;
  }
  if (event.hook_event_name === "PreToolUse") {
    await onPreToolUse(event);
    return;
  }
  if (!settings.token || !settings.chatId) return;
  if (event.hook_event_name === "Stop") await onStop(event, settings);
  else if (event.hook_event_name === "PermissionRequest" && (isClaudeCode() || settings.codexApprovalNotifications)) {
    await onPermissionRequest(event, settings);
  } else if (event.hook_event_name === "PermissionDenied") await onPermissionDenied(event, settings);
}

export async function run(argv = process.argv.slice(2)) {
  const command = argv.find((arg) => !arg.startsWith("-"));
  const isTest = argv.includes("--test");

  if (CLI[argv[0]]) {
    try {
      await CLI[argv[0]](argv.slice(1));
    } catch (error) {
      console.error(`[telegram-action-notifier] ${redactSecrets(error?.message ?? String(error))}`);
      process.exitCode = 1;
    }
    return;
  }

  try {
    if (isTest) {
      await sendTelegram(TEST_MESSAGE, { strict: true });
      console.log("Telegram test message sent.");
      return;
    }
    if (command === "daemon") {
      await runDaemon();
      process.exit(0);
    }
    if (command === "presence") {
      const discord = discordSettings(await loadSettings());
      if (discord) {
        await runPresenceReporter({
          discord,
          stateDir: stateDir(),
          claudeWorking: async () => {
            await refreshActiveTranscripts();
            return workingSessions(await readState());
          },
          daemonAlive: async () => (await daemonStatus()).running,
        });
      }
      process.exit(0);
    }
    if (command === "wait-reply") {
      let code = 0;
      try {
        code = await onWaitReply();
      } catch (error) {
        console.error(`[telegram-action-notifier] ${redactSecrets(error?.message ?? String(error))}`);
      }
      process.exit(code);
    }
    if (command === "ui") {
      const { startUi } = await import("./lib/ui.mjs");
      await startUi();
      return;
    }

    const raw = await readStdin();
    if (!raw.trim()) return;
    await handleEvent(JSON.parse(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[telegram-action-notifier] ${redactSecrets(message)}`);
    if (isTest) process.exitCode = 1;
  }
}

const directEntry = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;
if (directEntry) await run();
