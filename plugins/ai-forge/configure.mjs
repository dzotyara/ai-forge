import process from "node:process";
import readline from "node:readline/promises";

import {
  configurationPath,
  redactSecrets,
  sendTelegram,
} from "./skills/telegram-action-notifier/scripts/telegram-action-notifier.mjs";
import {
  TOPIC_REASON_TEXT,
  findChats,
  stopDaemon,
  topicSupport,
} from "./skills/telegram-action-notifier/scripts/lib/bridge.mjs";
import {
  isPrivateChatId,
  loadSettings,
  saveConfiguration,
  setTargetChat,
} from "./skills/telegram-action-notifier/scripts/lib/common.mjs";

async function readHidden(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run this configurator in an interactive terminal.");
  }

  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();

  return new Promise((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Configuration cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (character === "\b" || character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };

    process.stdin.on("data", onData);
  });
}

async function telegramRequest(token, method) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      { signal: controller.signal },
    );
    if (!response.ok) {
      throw new Error(`Telegram returned HTTP ${response.status}.`);
    }
    const payload = await response.json();
    if (!payload.ok) throw new Error("Telegram rejected the request.");
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const token = await readHidden("Telegram bot token (input is hidden): ");
  if (!token) throw new Error("Bot token cannot be empty.");

  let bot;
  try {
    bot = await telegramRequest(token, "getMe");
  } catch {
    throw new Error("Could not validate the bot token. Check the token and network.");
  }
  console.log(`Connected to @${bot.username}.`);

  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // The bridge daemon is the only getUpdates consumer; pause it while we read.
    await stopDaemon();
    await terminal.question(
      "Send /start to the bot now, then press Enter here...",
    );

    let chats;
    try {
      chats = await findChats(token);
    } catch {
      throw new Error(
        "Could not read bot updates. If the bot uses a webhook, provide TELEGRAM_CHAT_ID manually instead.",
      );
    }

    if (chats.length === 0) {
      throw new Error(
        "No chats found. Send /start directly to the bot and run the configurator again.",
      );
    }

    let chatId;
    if (chats.length === 1) {
      chatId = String(chats[0].id);
    } else {
      console.log("Available chats:");
      for (const chat of chats) console.log(`  ${chat.id}  ${chat.label}`);
      chatId = (await terminal.question("Chat ID to use: ")).trim();
    }

    if (!/^-?\d+$/.test(chatId)) {
      throw new Error("Chat ID must be an integer.");
    }

    // Merge: other settings (notify, approvalWaitSec, ...) survive a re-run.
    // In group mode the private chat found here identifies the owner instead.
    const configPath = configurationPath();
    const previous = await loadSettings();
    const groupMode = previous.chatId && !isPrivateChatId(previous.chatId) && isPrivateChatId(chatId);
    await saveConfiguration({ botToken: token });
    if (groupMode) await saveConfiguration({ ownerUserId: chatId });
    else await setTargetChat(chatId);

    await sendTelegram(
      "✅ Telegram Action Notifier подключён. Codex и Claude Code смогут присылать сюда запросы на ваше действие.",
      { strict: true },
    );

    console.log(`Configuration saved to ${configPath}`);
    if (groupMode) console.log(`Group mode kept (${previous.chatId}); owner set to ${chatId}.`);
    const topics = await topicSupport(await loadSettings(), { fresh: true });
    console.log(`Topics (has_topics_enabled=${bot.has_topics_enabled === true}): ${TOPIC_REASON_TEXT[topics.reason] ?? topics.reason}`);
    if (!topics.enabled) console.log("Until then messages go to the plain chat; reply to a bot message to answer a session.");
    console.log(
      "Test message sent. Restart Codex or Claude Code. In Codex, review and trust the plugin hooks in Settings > Hooks.",
    );
  } finally {
    terminal.close();
  }
}

try {
  if (process.argv.includes("--ui")) {
    const { startUi } = await import("./skills/telegram-action-notifier/scripts/lib/ui.mjs");
    await startUi();
  } else {
    await main();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[telegram-action-notifier] ${redactSecrets(message)}`);
  process.exitCode = 1;
}
