import assert from "node:assert/strict";
import test from "node:test";

import {
  MESSAGE_LIMIT,
  TRUNCATED_NOTICE,
  inlineMarkdown,
  markdownToTelegramHtml,
  projectName,
  renderMessages,
  safeSlice,
  shortenPaths,
  stripUnknownTags,
  visibleLength,
} from "../skills/telegram-action-notifier/scripts/lib/format.mjs";

const balanced = (html) => {
  const stack = [];
  for (const [, close, name] of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    if (close) { if (stack.pop() !== name) return false; } else stack.push(name);
  }
  return stack.length === 0;
};

test("escapes HTML special characters in prose", () => {
  assert.equal(inlineMarkdown("a < b && c > d"), "a &lt; b &amp;&amp; c &gt; d");
  assert.equal(markdownToTelegramHtml("<script>alert(1)</script>"), "alert(1)");
  assert.equal(markdownToTelegramHtml("x <b onclick=1> y"), "x &lt;b onclick=1&gt; y");
});

test("bold, italic, strike and inline code", () => {
  assert.equal(inlineMarkdown("**жирный** и *курсив* и _тоже_ и ~~нет~~"), "<b>жирный</b> и <i>курсив</i> и <i>тоже</i> и <s>нет</s>");
  assert.equal(inlineMarkdown("`a **b** <c>`"), "<code>a **b** &lt;c&gt;</code>");
  assert.equal(inlineMarkdown("snake_case_name and 2 * 3 * 4"), "snake_case_name and 2 * 3 * 4");
});

test("unbalanced emphasis falls back to escaped text", () => {
  const html = inlineMarkdown("**a *b** c*");
  assert.ok(balanced(html));
  assert.equal(html, "**a *b** c*");
});

test("fenced code blocks keep the language and escape the content", () => {
  const html = markdownToTelegramHtml("Пример:\n```js\nif (a < b && c) {}\n```\nконец");
  assert.equal(html, 'Пример:\n<pre><code class="language-js">if (a &lt; b &amp;&amp; c) {}</code></pre>\nконец');
  assert.equal(markdownToTelegramHtml("```\nraw\n```"), "<pre>raw</pre>");
  // Only the language word is used; the rest of the fence line cannot inject attributes.
  assert.equal(markdownToTelegramHtml('```js" onload="x\ncode\n```'), '<pre><code class="language-js">code</code></pre>');
});

test("links: http(s) become anchors, others keep only the label", () => {
  assert.equal(
    inlineMarkdown('[PR](https://github.com/a/b/pull/1?x=1&y="2")'),
    '<a href="https://github.com/a/b/pull/1?x=1&amp;y=&quot;2&quot;">PR</a>',
  );
  assert.equal(inlineMarkdown("[файл](src/app.js)"), "файл");
  assert.equal(inlineMarkdown("[x](javascript:alert)"), "x");
});

test("headings, bullets, task lists, quotes and tables", () => {
  const html = markdownToTelegramHtml("# Итог\n- один\n  * два\n- [x] готово\n> цитата\n| a | b |\n|---|---|\n| 1 | 2 |");
  assert.equal(
    html,
    "<b>Итог</b>\n• один\n  • два\n☑ готово\n<blockquote>цитата</blockquote>\n<pre>| a | b |\n| 1 | 2 |</pre>",
  );
});

test("strips XML-ish wrapper tags but keeps their text and generic-looking prose", () => {
  assert.equal(stripUnknownTags("Готово: <pr-created>https://github.com/a/b/pull/7</pr-created>"), "Готово: https://github.com/a/b/pull/7");
  assert.equal(stripUnknownTags("<system-reminder/>ok"), "ok");
  assert.equal(markdownToTelegramHtml("Array<string> works"), "Array&lt;string&gt; works");
});

test("shortens absolute paths to the project name", () => {
  const cwd = "/Users/me/Projects/myskills";
  assert.equal(shortenPaths(`см. ${cwd}/README.md и ${cwd}`, cwd, "/Users/me"), "см. myskills/README.md и myskills");
  assert.equal(shortenPaths("/Users/me/other/x.txt", cwd, "/Users/me"), "~/other/x.txt");
  assert.equal(projectName("/Users/me/Projects/myskills/.claude/worktrees/feat-x"), "myskills");
});

test("safeSlice never splits a surrogate pair", () => {
  const text = "ab😀cd";
  assert.equal(safeSlice(text, 3), "ab");
  assert.equal(safeSlice(text, 4), "ab😀");
});

test("long bodies split into balanced parts within the limit", () => {
  const body = Array.from({ length: 400 }, (_, i) => `- пункт **${i}** со смайликом 😀 и \`code_${i}\``).join("\n")
    + "\n```py\n" + "print('x')\n".repeat(600) + "```";
  const parts = renderMessages({ header: "💬 <b>T</b>", body, label: "T" });
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(visibleLength(part) <= MESSAGE_LIMIT, `part too long: ${visibleLength(part)}`);
    assert.ok(balanced(part), "unbalanced part");
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(part), false);
  }
  assert.match(parts[1], /^<i>T · 2\//);
});

test("very long bodies are truncated with a notice", () => {
  const parts = renderMessages({ header: "H", body: "слово ".repeat(20_000), label: "L", maxParts: 2 });
  assert.equal(parts.length, 2);
  assert.ok(parts[1].includes(TRUNCATED_NOTICE));
  assert.ok(visibleLength(parts[1]) <= MESSAGE_LIMIT);
});

test("renderMessages redacts secrets and drops the action marker", () => {
  const token = ["123456789", "ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd"].join(":");
  const [part] = renderMessages({ header: "H", body: `ACTION_REQUIRED: токен ${token}`, label: "L" });
  assert.equal(part.includes("ABCDEFGHIJ"), false);
  assert.equal(part.includes("ACTION_REQUIRED"), false);
});
