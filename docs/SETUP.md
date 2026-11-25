# Setup guide

From zero to approving Claude Code from your phone in about five minutes.

**English** · [Русский](SETUP.ru.md)

The quickest route is the setup wizard: open the panel (step 2) and it walks you through everything below with links and checks. This page is the same path in full detail, plus troubleshooting.

## 1. Install the plugin

You need [Claude Code](https://claude.com/claude-code) and Node.js 22 or newer (`node -v`).

```bash
claude plugin marketplace add dzotyara/aukalo
```

```bash
claude plugin install aukalo@aukalo
```

## 2. Open the settings panel

```bash
node "$(ls -d ~/.claude/plugins/cache/aukalo/aukalo/*/ | tail -1)configure.mjs" --ui
```

A local page opens on `127.0.0.1` with a one-time key in the link. On a fresh install the **First-time setup** wizard is on top. Pick **Discord**, **Telegram** or **Both**. You can reopen the wizard any time with **Setup wizard** under the title.

## 3a. Discord

1. **Create an application.** In the [Discord Developer Portal](https://discord.com/developers/applications) press **New Application** and name it, for example *Aukalo*.
2. **Get the bot token.** Open the **Bot** tab and press **Reset Token**, then copy the token.
3. **Turn on Message Content.** On the same tab turn on **Message Content Intent** and press **Save Changes**. Without it the bot sees buttons and slash commands, but not your text replies.
4. **Add the bot to your server.** Paste the token into the wizard: it builds an invite link with the right permissions (Manage Channels, Manage Server, View Channel, Send Messages, Read Message History, Add Reactions). Open it, pick your server and press **Authorize**. No server yet? Press **+** in Discord and create one, just for you.
5. **Copy your user ID.** In Discord open **Settings → Advanced** and turn on **Developer Mode**. Then right-click yourself and choose **Copy User ID**.
6. **Connect.** Paste the ID and press **Connect Discord**. The bot creates an `Aukalo` category with a `📣・aukalo` channel. It sets its avatar and the server icon if they are empty, and switches the server to "Only @mentions" notifications.

## 3b. Telegram

1. **Create a bot.** Send `/newbot` to [@BotFather](https://t.me/BotFather), pick a name and copy the token. Paste it into the wizard and press **Check**.
2. **Create a group with topics.** Create a group and turn on **Topics** in its settings. Add the bot and make it an admin with **Manage topics**.
3. **Find the group.** Post any message in the group and press **Find the group** in the wizard.
4. **Tell the bot who you are.** Open a private chat with the bot, press **Start** and then **Find me** in the wizard. The bot obeys only you.

A private chat instead of a group works too: in @BotFather turn on Threaded Mode for the bot so sessions get their own topics.

## 4. Choose where to send, and test

In the wizard pick **Discord**, **Telegram** or **Telegram and Discord**, then press **Send a test**. The message should arrive in a few seconds.

Start a new Claude Code session, or run `/reload-plugins` in one that is already open. From now on permission requests, questions and "I need you" turns come to the chat with buttons.

## 5. Optional

- **Language:** **Notifications → Language** switches the bot and the panel between English and Russian.
- **Quiet hours:** **Notifications → Quiet hours**, for example 23:00–08:00.
- **The Boss:** name any Claude Code session "Boss" and it takes `📣・aukalo`. If there is none, the first message there creates one.
- **Codex:** install the plugin in Codex too. Its permission requests come to Discord with Allow / Deny.

```bash
codex plugin marketplace add dzotyara/aukalo --ref main
```

```bash
codex plugin add aukalo@aukalo
```

## Troubleshooting

| What you see | What to do |
|---|---|
| "Discord Gateway: 4014" or "Message Content Intent is off" in the panel | Turn on **Message Content Intent** in the Developer Portal → Bot, press **Save Changes**, then **Connect Discord** again |
| The bot didn't create channels | It needs **Manage Channels** on your server: open the invite link from the wizard again |
| The bot or the server still shows an old picture | Press **Refresh look** in the panel's **Service** section: it puts the current Aukalo artwork on the bot, the server and the Telegram group |
| No server icon | Give the bot **Manage Server**, or set the icon yourself |
| Telegram "No groups found" | Post a new message in the group after adding the bot, then press **Find the group** again |
| "The session is working" in the chat | The session is in the middle of a turn: it sees your message at its next step (next tool call) |
| "This session isn't running in the app" | Open the session in Claude; the message is delivered at once |
| Buttons do nothing | Make sure the background service runs: **Service** section in the panel, or press **Restart** |
| A message says "decide in the app" | No one pressed a button before the wait ran out (`approvalWaitSec`); the app prompt still works |

Still stuck? [Open an issue](https://github.com/dzotyara/aukalo/issues) with what you see in the panel's **Service** section.
