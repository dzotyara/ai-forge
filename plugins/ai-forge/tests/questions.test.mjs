import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { isolatedHome, mockTelegram } from "./helpers.mjs";

const env = isolatedHome({ chatId: "-100500", extra: { ownerUserId: "77" } });
process.env.CLAUDE_PLUGIN_ROOT = "/plugins/telegram-action-notifier";
mkdirSync(env.state, { recursive: true });
writeFileSync(path.join(env.state, "daemon.pid"), String(process.pid)); // no real daemon

const q = await import("../skills/telegram-action-notifier/scripts/lib/questions.mjs");
const bridge = await import("../skills/telegram-action-notifier/scripts/lib/bridge.mjs");
const { loadSettings } = await import("../skills/telegram-action-notifier/scripts/lib/common.mjs");

const line = (value) => JSON.stringify(value);
const prompt = (text) => line({ type: "user", message: { role: "user", content: text } });
const toolResult = () => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
const wrapUp = (input) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "mcp__ccd_turn__wrap_up", input }] } });
const text = (value) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: value }] } });

test("next-step question: read from the current turn with labels and app actions", () => {
  const found = q.questionFromLines([
    prompt("обнови плагин"),
    wrapUp({ recap: "r", ask: "Влить PR #6?", actions: [{ label: "Да, влей" }, { action: "create_pr" }, { label: "" }] }),
    toolResult(),
    text("Готово."),
  ]);
  assert.deepEqual(found, { ask: "Влить PR #6?", options: ["Да, влей", "Создать PR"] });
});

test("next-step question: none when the box has no ask or belongs to an earlier turn", () => {
  assert.equal(q.questionFromLines([prompt("a"), wrapUp({ recap: "r" }), text("x")]), null);
  assert.equal(q.questionFromLines([wrapUp({ recap: "r", ask: "old?" }), prompt("new turn"), text("x")]), null);
});

test("next-step keyboard: one button per option, data w:<i>", () => {
  const kb = q.turnQuestionKeyboard({ ask: "?", options: ["Да", "Нет"] });
  assert.deepEqual(kb.inline_keyboard.map((row) => row[0].callback_data), ["u:w:0", "u:w:1"]);
  assert.equal(q.turnQuestionKeyboard({ ask: "?", options: [] }), null);
  assert.equal(q.isTurnAnswerData("w:1"), true);
  assert.equal(q.isTurnAnswerData("r:sl:1"), false);
});

test("a next-step button reaches the session as the owner's own reply", () => {
  const out = bridge.formatReplies([{ kind: "button", data: "w:0", buttonText: "Да, обнови", messageId: 5 }]);
  assert.equal(out, `${bridge.REPLY_PREFIX} Да, обнови`);
  const other = bridge.formatReplies([{ kind: "button", data: "d:x", buttonText: "Прочитано", messageId: 5 }]);
  assert.match(other, /^Telegram: кнопка/);
});

const INPUT = {
  questions: [
    { question: "Какой цвет?", header: "Цвет", multiSelect: false, options: [{ label: "Красный", description: "тёплый" }, { label: "Синий" }] },
    { question: "Что добавить?", header: "Опции", multiSelect: true, options: [{ label: "Тесты" }, { label: "Доки" }, { label: "CI" }] },
  ],
};

test("AskUserQuestion: keyboard, presses, multi-select and answers", () => {
  const questions = q.questionsFromInput(INPUT);
  const kb = q.questionKeyboard("0123456789abcdef", questions);
  for (const row of kb.inline_keyboard) for (const b of row) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
  assert.equal(kb.inline_keyboard.at(-1)[0].callback_data, "q:0123456789abcdef:1:ok");

  let sel = q.applyPress(questions, {}, 0, "1");
  assert.deepEqual(sel[0], { picks: ["Синий"], done: true });
  sel = q.applyPress(questions, sel, 1, "0");
  sel = q.applyPress(questions, sel, 1, "2");
  sel = q.applyPress(questions, sel, 1, "0"); // toggled off
  assert.equal(q.allAnswered(questions, sel), false);
  sel = q.applyPress(questions, sel, 1, "ok");
  assert.equal(q.allAnswered(questions, sel), true);
  assert.deepEqual(q.answersFrom(questions, sel), { "Какой цвет?": "Синий", "Что добавить?": "CI" });
  assert.match(q.questionsHtml("H", questions), /<b>1\. Цвет<\/b>: Какой цвет\?/);
});

test("AskUserQuestion: free text answers the first open question", () => {
  const questions = q.questionsFromInput(INPUT);
  const sel = q.applyText(questions, {}, "Зелёный");
  assert.deepEqual(q.answersFrom(questions, sel)["Какой цвет?"], "Зелёный");
  assert.equal(q.questionsFromInput({ questions: [{ question: "x", options: [] }] }), null);
});

test("routeUpdate: an owner's question press is routed, a stranger's is ignored", () => {
  const update = (from) => ({
    callback_query: { id: "c1", from: { id: from }, data: "q:0123456789abcdef:0:1", message: { message_id: 9, chat: { id: -100500 } } },
  });
  const route = bridge.routeUpdate(update(77), { chatId: "-100500", ownerUserId: "77" });
  assert.deepEqual([route.type, route.requestId, route.qi, route.choice], ["question", "0123456789abcdef", 0, "1"]);
  assert.equal(bridge.routeUpdate(update(5), { chatId: "-100500", ownerUserId: "77" }).type, "ignore");
});

test("requestAnswer: buttons go out, a press answers, the hook returns allow + answers", async () => {
  let pressed = false;
  const tg = mockTelegram((method) => {
    if (method === "getMe") return { has_topics_enabled: false };
    if (method === "sendMessage") return { message_id: 71 };
    return true;
  });
  try {
    await bridge.updateState((state) => { state.meta = {}; });
    const settings = await loadSettings();
    const ctx = { sessionId: "ask1", title: "T", project: "p", cwd: "/p", host: "Claude Code" };
    const questions = q.questionsFromInput({ questions: [INPUT.questions[0]] });
    const press = async () => {
      while (!tg.calls.some((c) => c.method === "sendMessage")) await new Promise((r) => setTimeout(r, 10));
      const send = tg.calls.find((c) => c.method === "sendMessage");
      const data = send.params.reply_markup.inline_keyboard.flat()[1].callback_data;
      await bridge.handleUpdate(settings, {
        callback_query: { id: "c2", from: { id: 77 }, data, message: { message_id: 71, chat: { id: -100500 } } },
      });
      pressed = true;
    };
    const [answers] = await Promise.all([
      bridge.requestAnswer(settings, ctx, "❓ <b>T</b>", questions, { waitSec: 5, pollMs: 20 }),
      press(),
    ]);
    assert.equal(pressed, true);
    assert.deepEqual(answers, { "Какой цвет?": "Синий" });
    const decision = bridge.questionDecision({ questions: INPUT.questions.slice(0, 1) }, answers);
    assert.equal(decision.hookSpecificOutput.decision.behavior, "allow");
    assert.deepEqual(decision.hookSpecificOutput.decision.updatedInput.answers, { "Какой цвет?": "Синий" });
    const edit = tg.calls.find((c) => c.method === "editMessageText");
    assert.match(edit.params.text, /✅ <b>Синий<\/b>/);
    assert.equal(Object.keys((await bridge.readState()).pending).length, 0);
  } finally {
    tg.restore();
  }
});

test("requestAnswer: answered in the app during the grace period sends nothing", async () => {
  const tg = mockTelegram(() => true);
  try {
    const settings = await loadSettings();
    const ctx = { sessionId: "ask2", title: "T", project: "p", cwd: "/p", host: "Claude Code" };
    const questions = q.questionsFromInput({ questions: [INPUT.questions[0]] });
    const app = async () => {
      // Answer only once the held item exists: resolving earlier finds nothing to resolve.
      while (!Object.values((await bridge.readState()).pending).some((item) => item.sessionId === "ask2")) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await bridge.resolvePending("ask2", { kinds: ["approval"], toolName: "AskUserQuestion", edit: true });
    };
    const [answers] = await Promise.all([
      bridge.requestAnswer(settings, ctx, "❓", questions, { graceSec: 3, waitSec: 5, pollMs: 20, presenceEveryMs: 60_000 }),
      app(),
    ]);
    assert.equal(answers, null);
    assert.equal(tg.calls.some((c) => c.method === "sendMessage"), false);
  } finally {
    tg.restore();
  }
});
