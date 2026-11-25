// Markdown -> Telegram HTML, path shortening and message splitting.
import os from "node:os";
import path from "node:path";

import { redactSecrets } from "./common.mjs";
import { L } from "./i18n.mjs";

export const MESSAGE_LIMIT = 4000; // Telegram allows 4096 chars after entities; keep a margin.
export const MAX_PARTS = 4;
export const TRUNCATED_NOTICE = L("… (обрезано, полный ответ в приложении)", "… (truncated, full reply in the app)");

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

export function decodeHtml(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

export function htmlToPlain(html) {
  return decodeHtml(String(html).replace(/<[^>]*>/g, ""));
}

/** Length Telegram counts: text after entity parsing, in UTF-16 code units. */
export function visibleLength(html) {
  return htmlToPlain(html).length;
}

/** Slice without splitting a surrogate pair. */
export function safeSlice(text, end) {
  let cut = Math.min(end, text.length);
  const code = text.charCodeAt(cut - 1);
  if (cut > 0 && cut < text.length && code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

export function truncateText(text, max) {
  const value = String(text);
  if (value.length <= max) return value;
  return `${safeSlice(value, max - 1)}…`;
}

/** Repository name for a working directory; Claude Code worktrees map to their repo. */
export function projectName(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return "";
  const normalized = cwd.replace(/[\\/]+$/, "");
  const worktree = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+$/.exec(normalized);
  return path.basename(worktree ? worktree[1] : normalized) || normalized;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace the absolute working directory with the project name and home with "~". */
export function shortenPaths(text, cwd, home = os.homedir()) {
  let result = String(text);
  if (typeof cwd === "string" && cwd.length > 1) {
    const root = cwd.replace(/[\\/]+$/, "");
    result = result.replace(
      new RegExp(`${escapeRegExp(root)}(?=[\\\\/]|\\b|$)`, "g"),
      projectName(root),
    );
  }
  if (home && home.length > 1) {
    result = result.replace(new RegExp(`${escapeRegExp(home)}(?=[\\\\/])`, "g"), "~");
  }
  return result;
}

/** Drop XML-ish wrapper tags such as <pr-created>url</pr-created>, keeping inner text. */
export function stripUnknownTags(text) {
  let result = String(text);
  for (let i = 0; i < 5; i += 1) {
    const next = result.replace(
      /<([A-Za-z][\w.:-]*)(?:\s[^<>]*)?>([\s\S]*?)<\/\1\s*>/g,
      "$2",
    );
    if (next === result) break;
    result = next;
  }
  // Standalone hyphenated tags (<system-note/>, </foo-bar>) are never prose.
  return result.replace(/<\/?[A-Za-z][\w.]*-[\w.:-]*(?:\s[^<>]*)?\/?>/g, "");
}

const SLOT = /(\d+)/g;

function isBalanced(html) {
  const stack = [];
  for (const match of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    if (match[1]) {
      if (stack.pop() !== match[2]) return false;
    } else stack.push(match[2]);
  }
  return stack.length === 0;
}

/** Inline Markdown on one line of prose. Always returns balanced HTML. */
export function inlineMarkdown(text) {
  const slots = [];
  const keep = (html) => `${slots.push(html) - 1}`;
  let value = String(text).replace(/[]/g, "");
  value = value.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`));
  value = value.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, url) =>
    /^https?:\/\//i.test(url)
      ? keep(`<a href="${escapeAttribute(url)}">${escapeHtml(label)}</a>`)
      : label,
  );
  const plain = escapeHtml(value);
  let html = plain
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, "$1<b>$2</b>")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "<s>$1</s>")
    .replace(/(^|[^\p{L}\p{N}*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\p{L}\p{N}*])/gu, "$1<i>$2</i>")
    .replace(/(^|[^\p{L}\p{N}_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\p{L}\p{N}_])/gu, "$1<i>$2</i>");
  if (!isBalanced(html)) html = plain;
  return html.replace(SLOT, (_, index) => slots[Number(index)]);
}

function preBlock(code, language) {
  const lang = /^[\w+#.-]{1,32}$/.test(language ?? "") ? language : "";
  const body = escapeHtml(code);
  return lang
    ? `<pre><code class="language-${lang}">${body}</code></pre>`
    : `<pre>${body}</pre>`;
}

/** Convert Markdown to a list of self-contained, balanced HTML blocks. */
export function markdownToBlocks(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/.exec(line);
    if (fence) {
      const marker = fence[1];
      const code = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      blocks.push({ type: "pre", code: code.join("\n"), lang: fence[2] });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i])) rows.push(lines[i].trim());
        i += 1;
      }
      blocks.push({ type: "pre", code: rows.join("\n"), lang: "" });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(inlineMarkdown(lines[i].replace(/^\s*>\s?/, "")));
        i += 1;
      }
      blocks.push({ type: "text", html: `<blockquote>${quoted.join("\n")}</blockquote>` });
      continue;
    }
    i += 1;
    let html;
    let match;
    if ((match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line))) {
      html = `<b>${inlineMarkdown(match[1])}</b>`;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html = "──────────";
    } else if ((match = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line))) {
      html = `${match[1]}${match[2] === " " ? "☐" : "☑"} ${inlineMarkdown(match[3])}`;
    } else if ((match = /^(\s*)[-*+]\s+(.*)$/.exec(line))) {
      html = `${match[1]}• ${inlineMarkdown(match[2])}`;
    } else {
      html = inlineMarkdown(line);
    }
    blocks.push({ type: "text", html });
  }
  // Collapse runs of blank lines and drop leading/trailing ones.
  const isBlank = (block) => block.type === "text" && block.html.trim() === "";
  const kept = [];
  for (const block of blocks) {
    if (isBlank(block) && (kept.length === 0 || isBlank(kept.at(-1)))) continue;
    kept.push(block);
  }
  while (kept.length && isBlank(kept.at(-1))) kept.pop();
  return kept;
}

export function blocksToHtml(blocks) {
  return blocks.map((block) => (block.type === "pre" ? preBlock(block.code, block.lang) : block.html)).join("\n");
}

export function markdownToTelegramHtml(markdown) {
  return blocksToHtml(markdownToBlocks(stripUnknownTags(markdown)));
}

function hardSplit(text, max) {
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let piece = safeSlice(rest, max);
    const newline = piece.lastIndexOf("\n");
    if (newline > max / 2) piece = piece.slice(0, newline + 1);
    chunks.push(piece);
    rest = rest.slice(piece.length);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Break blocks that would not fit into one message on their own. */
function fitBlocks(blocks, budget) {
  const result = [];
  for (const block of blocks) {
    if (block.type === "pre") {
      if (block.code.length + 1 <= budget) {
        result.push(block);
        continue;
      }
      for (const piece of hardSplit(block.code, budget - 1)) {
        result.push({ type: "pre", code: piece.replace(/\n$/, ""), lang: block.lang });
      }
      continue;
    }
    if (visibleLength(block.html) <= budget) {
      result.push(block);
      continue;
    }
    for (const piece of hardSplit(htmlToPlain(block.html), budget)) {
      result.push({ type: "text", html: escapeHtml(piece) });
    }
  }
  return result;
}

function blockHtml(block) {
  return block.type === "pre" ? preBlock(block.code, block.lang) : block.html;
}

function blockLength(block) {
  return block.type === "pre" ? block.code.length : visibleLength(block.html);
}

/**
 * Render a header and a Markdown body into Telegram HTML messages.
 * Each message is balanced HTML within the limit; extra parts are truncated.
 */
export function renderMessages({
  header,
  body = "",
  footer = "",
  label = "",
  cwd,
  limit = MESSAGE_LIMIT,
  maxParts = MAX_PARTS,
}) {
  const source = shortenPaths(redactSecrets(String(body ?? "")), cwd)
    .replace(/^\s*ACTION_REQUIRED:\s*/u, "")
    .trim();
  const headerLength = header ? visibleLength(header) + 2 : 0;
  const footerLength = footer ? visibleLength(footer) + 2 : 0;
  const continuation = (n, total) => `<i>${escapeHtml(label)} · ${n}/${total}</i>`;
  const continuationLength = visibleLength(continuation(9, 9)) + 1;
  const budget = limit - Math.max(headerLength, continuationLength) - footerLength;
  const blocks = fitBlocks(markdownToBlocks(stripUnknownTags(source)), budget);

  const parts = [];
  let current = [];
  let used = 0;
  for (const block of blocks) {
    const size = blockLength(block) + 1;
    if (current.length && used + size > budget) {
      parts.push(current);
      current = [];
      used = 0;
    }
    current.push(block);
    used += size;
  }
  if (current.length || parts.length === 0) parts.push(current);

  let truncated = false;
  if (parts.length > maxParts) {
    parts.length = maxParts;
    truncated = true;
    const last = parts[maxParts - 1];
    const notice = TRUNCATED_NOTICE.length + 2;
    let total = last.reduce((sum, block) => sum + blockLength(block) + 1, 0);
    while (last.length > 1 && total + notice > budget) {
      total -= blockLength(last.pop()) + 1;
    }
    if (total + notice > budget) {
      const plain = htmlToPlain(blockHtml(last[0]));
      last[0] = { type: "text", html: escapeHtml(safeSlice(plain, budget - notice - 1)) };
    }
  }

  return parts.map((blocksOfPart, index) => {
    const lines = [];
    if (index === 0) {
      if (header) lines.push(header);
    } else lines.push(continuation(index + 1, parts.length));
    const content = blocksOfPart.map(blockHtml).join("\n");
    if (content.trim()) lines.push(index === 0 && header ? `\n${content}` : content);
    if (truncated && index === parts.length - 1) lines.push(`\n<i>${escapeHtml(TRUNCATED_NOTICE)}</i>`);
    if (footer && index === parts.length - 1) lines.push(`\n${footer}`);
    return lines.join("\n");
  });
}

const KIND_EMOJI = { approval: "🔐", action: "🔔", turn: "💬", question: "❓" };

export function buildHeader({ kind, title, project, host }) {
  const pieces = [`<b>${escapeHtml(title || project || L("Сессия", "Session"))}</b>`];
  if (project && project !== title) pieces.push(escapeHtml(project));
  if (host) pieces.push(escapeHtml(host));
  return `${KIND_EMOJI[kind] ?? "🔔"} ${pieces.join(" · ")}`;
}
