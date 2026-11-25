// Questions with answer options, delivered to Telegram as buttons.
//
// Two sources:
//  1. AskUserQuestion: a PermissionRequest hook. A press answers the tool directly
//     through `allow` + `updatedInput.answers` (documented in the Claude Code hooks reference).
//  2. The app's next-step box (`mcp__ccd_turn__wrap_up` with `ask` + `actions`): it is not
//     part of the final message text, so the Stop hook reads it from the transcript and
//     adds the question and buttons. A press is sent to the session as the owner's reply.

import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import { escapeHtml } from "./format.mjs";
import { L } from "./i18n.mjs";

export const QUESTION_WAIT_SEC = 12 * 3600 - 300; // the PermissionRequest hook timeout in hooks.json is 43200
const TAIL_BYTES = 512 * 1024;

// Labels for the app's own action buttons, which carry no text of their own.
export const APP_ACTION_LABELS = {
  commit: L("Закоммитить", "Commit"),
  create_pr: L("Создать PR", "Create PR"),
  merge: L("Влить PR", "Merge PR"),
  fix_ci: L("Починить CI", "Fix CI"),
  address_comments: L("Ответить на комментарии", "Address comments"),
  resolve_conflicts: L("Разрешить конфликты", "Resolve conflicts"),
  verify: L("Проверить", "Verify"),
  archive: L("В архив", "Archive"),
  new_session: L("Новая сессия", "New session"),
};

// ------------------------------------------------------------- next-step box

const isWrapUp = (name) => typeof name === "string" && /(^|__)wrap_up$/.test(name);

/** A real prompt from the owner (not a tool result, not a hook/meta line). */
function isOwnerPrompt(entry) {
  if (entry?.type !== "user" || entry.isMeta) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return content.trim().length > 0;
  return Array.isArray(content) && content.some((c) => c?.type === "text") && !content.some((c) => c?.type === "tool_result");
}

/** The question and its options from the latest next-step box of the current turn, or null. */
export function questionFromLines(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (isOwnerPrompt(entry)) return null; // the turn started here and had no question
    if (entry?.type !== "assistant") continue;
    const call = (entry.message?.content ?? []).findLast?.((c) => c?.type === "tool_use" && isWrapUp(c.name));
    if (!call) continue;
    const ask = typeof call.input?.ask === "string" ? call.input.ask.trim() : "";
    if (!ask) return null;
    const options = (Array.isArray(call.input.actions) ? call.input.actions : [])
      .map((a) => (typeof a?.label === "string" && a.label.trim() ? a.label.trim() : APP_ACTION_LABELS[a?.action] ?? ""))
      .filter(Boolean)
      .slice(0, 4);
    return { ask, options };
  }
  return null;
}

export async function readTurnQuestion(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;
  let handle;
  try {
    handle = await fsp.open(transcriptPath, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // a cut first line
    return questionFromLines(lines.filter(Boolean));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function turnQuestionHtml(question) {
  const hint = question.options.length
    ? L("\n<i>Кнопка — ваш ответ в чате. Деплой, отправку и другие действия наружу сессия подтвердит отдельным запросом с Allow / Deny.</i>",
      "\n<i>A button is your reply in the chat. A deploy, a message or another outward action gets its own request with Allow / Deny.</i>")
    : L("\n<i>Ответьте сообщением в этой теме.</i>", "\n<i>Reply with a message in this topic.</i>");
  return `❓ <b>${escapeHtml(question.ask)}</b>${hint}`;
}

/** Buttons for the next-step box: data "w:<i>"; a press reaches the session as the owner's reply. */
export function turnQuestionKeyboard(question) {
  if (!question?.options?.length) return null;
  return {
    inline_keyboard: question.options.map((label, i) => [
      { text: label.slice(0, 60), callback_data: `u:w:${i}`, ...(i === 0 ? { style: "primary" } : {}) },
    ]),
  };
}

export const isTurnAnswerData = (data) => /^w:\d$/.test(String(data ?? ""));

// ------------------------------------------------------------ AskUserQuestion

/** Validated questions from an AskUserQuestion tool input, or null. */
export function questionsFromInput(input) {
  const list = Array.isArray(input?.questions) ? input.questions : null;
  if (!list?.length) return null;
  const questions = list.slice(0, 4).map((q) => ({
    question: typeof q?.question === "string" ? q.question : "",
    header: typeof q?.header === "string" ? q.header : "",
    multiSelect: Boolean(q?.multiSelect),
    options: (Array.isArray(q?.options) ? q.options : [])
      .filter((o) => typeof o?.label === "string" && o.label.trim())
      .slice(0, 8)
      .map((o) => ({ label: o.label.trim(), description: typeof o.description === "string" ? o.description : "" })),
  }));
  return questions.every((q) => q.question && q.options.length) ? questions : null;
}

export function questionsHtml(header, questions) {
  const blocks = questions.map((q, qi) => {
    const number = questions.length > 1 ? `${qi + 1}. ` : "";
    const title = q.header ? `<b>${number}${escapeHtml(q.header)}</b>: ${escapeHtml(q.question)}` : `<b>${number}${escapeHtml(q.question)}</b>`;
    const options = q.options.map((o) => `• <b>${escapeHtml(o.label)}</b>${o.description ? ` — ${escapeHtml(o.description)}` : ""}`);
    const multi = q.multiSelect
      ? L("\n<i>Можно выбрать несколько, затем «Готово».</i>", "\n<i>You can pick several, then “Done”.</i>")
      : "";
    return `${title}\n${options.join("\n")}${multi}`;
  });
  return `${header}\n\n${blocks.join("\n\n")}\n\n${L(
    "<i>Выберите кнопкой или ответьте своим текстом реплаем на это сообщение.</i>",
    "<i>Pick a button, or reply to this message with your own text.</i>",
  )}`;
}

/** selections: { [qi]: { picks: string[], done: boolean } } */
export function questionKeyboard(requestId, questions, selections = {}) {
  const rows = [];
  questions.forEach((q, qi) => {
    const sel = selections[qi] ?? { picks: [], done: false };
    const prefix = questions.length > 1 ? `${qi + 1} · ` : "";
    const buttons = q.options.map((o, oi) => {
      const picked = sel.picks.includes(o.label);
      const mark = q.multiSelect ? (picked ? "☑ " : "☐ ") : picked ? "✓ " : "";
      return { text: `${prefix}${mark}${o.label}`.slice(0, 60), callback_data: `q:${requestId}:${qi}:${oi}` };
    });
    const short = buttons.every((b) => b.text.length <= 18);
    for (let i = 0; i < buttons.length; i += short ? 2 : 1) rows.push(buttons.slice(i, i + (short ? 2 : 1)));
    if (q.multiSelect) rows.push([{ text: `${prefix}${L("Готово", "Done")}`, callback_data: `q:${requestId}:${qi}:ok`, style: "success" }]);
  });
  return { inline_keyboard: rows };
}

export const QUESTION_CALLBACK = /^q:([0-9a-f]{16}):(\d):(\d|ok)$/;

/** Apply one press. Returns the new selections; never mutates the input. */
export function applyPress(questions, selections, qi, choice) {
  const q = questions[qi];
  if (!q) return selections;
  const next = structuredClone(selections ?? {});
  const sel = (next[qi] ??= { picks: [], done: false });
  if (sel.done && !q.multiSelect) return next;
  if (choice === "ok") {
    if (q.multiSelect && sel.picks.length) sel.done = true;
    return next;
  }
  const label = q.options[Number(choice)]?.label;
  if (!label) return next;
  if (q.multiSelect) {
    sel.picks = sel.picks.includes(label) ? sel.picks.filter((p) => p !== label) : [...sel.picks, label];
  } else {
    sel.picks = [label];
    sel.done = true;
  }
  return next;
}

/** Free text answers the first open question. */
export function applyText(questions, selections, text) {
  const next = structuredClone(selections ?? {});
  const reply = String(text).trim();
  const open = questions.map((_, i) => i).filter((i) => !next[i]?.done);
  if (!open.length) return next;
  if (open.length === 1) {
    next[open[0]] = { picks: [reply], done: true };
    return next;
  }
  // Several open questions and a text reply: it answers the whole card, so the
  // session gets the text at once instead of the card waiting for the rest.
  const note = L(`Ответил текстом вместо выбора: «${reply}»`, `Replied with text instead of choosing: "${reply}"`);
  for (const i of open) next[i] = { picks: [note], done: true };
  return next;
}

export const allAnswered = (questions, selections) => questions.every((_, i) => selections?.[i]?.done);

export function answersFrom(questions, selections) {
  const answers = {};
  questions.forEach((q, i) => {
    answers[q.question] = (selections?.[i]?.picks ?? []).join(", ");
  });
  return answers;
}

export function answeredText(questions, selections) {
  const lines = questions.map((q, i) => `✅ ${questions.length > 1 ? `${escapeHtml(q.header || q.question)}: ` : ""}<b>${escapeHtml((selections?.[i]?.picks ?? []).join(", "))}</b>`);
  return lines.join("\n");
}

export const newRequestId = () => randomBytes(8).toString("hex");
