import "./lang-en.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { FAKE_TOKEN, isolatedHome } from "./helpers.mjs";

const env = isolatedHome({ chatId: "-1001234567890", extra: { ownerUserId: "55", topics: false } });
delete process.env.CLAUDE_PLUGIN_ROOT;
delete process.env.CLAUDE_CODE_SESSION_ID;
mkdirSync(env.state, { recursive: true });

const files = await import("../skills/telegram-action-notifier/scripts/lib/files.mjs");
const entry = await import("../skills/telegram-action-notifier/scripts/telegram-action-notifier.mjs");
const { FILE_LIMITS, formatSize, mediaKind } = files;
const MiB = 1024 * 1024;

const DISCORD_TOKEN = "MTAwMDAwMDAwMDAwMDAwMDAw.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789";
const CHANNEL = "123456789012345672";
const OWNER = "123456789012345671";
const GUILD = "123456789012345675";

function configure(extra = {}) {
  writeFileSync(path.join(env.dir, "config.json"), JSON.stringify({
    botToken: FAKE_TOKEN, chatId: "-1001234567890", ownerUserId: "55", topics: false, ...extra,
  }), { mode: 0o600 });
}
const discordConfig = { discordToken: DISCORD_TOKEN, discordChannel: CHANNEL, discordOwner: OWNER };

const work = mkdtempSync(path.join(os.tmpdir(), "send-file-test-"));
test.after(() => rmSync(work, { recursive: true, force: true }));
function make(name, content = "aukalo send-file test") {
  const file = path.join(work, name);
  writeFileSync(file, content);
  return file;
}
/** A big file without the disk space: a hole of `bytes`. */
function sparse(name, bytes) {
  const file = make(name, "x");
  truncateSync(file, bytes);
  return file;
}

/** Record every request; `handler(call)` returns a Response. Telegram answers ok by default. */
function mockNetwork(t, handler = () => null) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const parsed = new URL(url);
    const fields = {};
    if (init.body instanceof FormData) {
      for (const [key, value] of init.body.entries()) {
        fields[key] = typeof value === "string" ? value : { name: value.name, size: value.size };
      }
    }
    const call = {
      host: parsed.host, route: parsed.pathname, method: parsed.pathname.split("/").pop(),
      multipart: init.body instanceof FormData, fields, init,
      json: typeof init.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const custom = await handler(call);
    if (custom) return custom;
    if (parsed.host === "discord.com") return Response.json({ id: "123456789012345690" });
    return Response.json({ ok: true, result: { message_id: 11 } });
  });
  return calls;
}
const uploads = (calls) => calls.filter((call) => call.multipart);

/** Run `send-file` the way a session does and return what it printed. */
async function sendFile(args, { session = "Release notes" } = {}) {
  let out = "";
  let err = "";
  const log = console.log;
  const error = console.error;
  console.log = (...parts) => { out += `${parts.join(" ")}\n`; };
  console.error = (...parts) => { err += `${parts.join(" ")}\n`; };
  process.exitCode = 0;
  try {
    await entry.run(["send-file", "--to", session, ...args]);
  } finally {
    console.log = log;
    console.error = error;
  }
  const code = process.exitCode;
  process.exitCode = 0;
  return { out, err, code };
}

test("limits live in one table and match the documentation", () => {
  assert.equal(FILE_LIMITS.telegram.bytes.document, 50 * MiB);
  assert.equal(FILE_LIMITS.telegram.bytes.video, 50 * MiB);
  assert.equal(FILE_LIMITS.telegram.bytes.photo, 10 * MiB);
  assert.equal(FILE_LIMITS.telegram.caption, 1024);
  assert.equal(FILE_LIMITS.discord.defaultBytes, 20 * MiB);
  assert.equal(FILE_LIMITS.discord.byBoostLevel[2], 50 * MiB);
  assert.equal(FILE_LIMITS.discord.byBoostLevel[3], 100 * MiB);
  assert.match(FILE_LIMITS.telegram.source, /^https:\/\/core\.telegram\.org\//);
  assert.match(FILE_LIMITS.discord.source, /^https:\/\/discord\.com\/developers\//);
  assert.equal(formatSize(38.2 * MiB), "38.2 MiB");
  assert.equal(formatSize(20 * MiB), "20 MiB");
  assert.equal(formatSize(4096), "4 KiB");
});

test("images are photos, videos video, mp3 audio, the rest documents", () => {
  const kinds = {
    "a.jpg": "photo", "A.JPEG": "photo", "a.png": "photo", "a.mp4": "video", "a.MOV": "video", "a.mp3": "audio",
    "a.m4a": "audio", "a.gif": "animation", "a.txt": "document", "a.pdf": "document", "a.svg": "document",
    "a.webm": "document", "a.wav": "document", "README": "document", "a.mp4.txt": "document",
  };
  for (const [name, kind] of Object.entries(kinds)) assert.equal(mediaKind(name), kind, name);
});

test("argument parsing: paths, caption, --, unknown options, missing paths", async (t) => {
  configure();
  const calls = mockNetwork(t);
  const first = make("one.txt");
  const second = make("--odd.txt");
  assert.match((await sendFile([])).err, /Usage: send-file/);
  assert.match((await sendFile(["--bogus", first])).err, /Unknown option --bogus/);
  assert.match((await sendFile([first, "--caption"])).err, /--caption needs a value/);
  assert.equal(calls.length, 0, "nothing sent for a bad command line");

  const run = await sendFile(["--caption", "two files", first, "--", second]);
  assert.equal(run.code, 0, run.err);
  const sent = uploads(calls);
  assert.deepEqual(sent.map((call) => call.fields.document.name), ["one.txt", "--odd.txt"]);
  assert.equal(sent[0].fields.caption, "Release notes: two files", "outside a topic the session title leads; the caption goes with the first file only");
  assert.equal(sent[1].fields.caption, undefined);
});

test("a missing file, a directory, an empty file and the bridge's own config are refused before anything is sent", async (t) => {
  configure();
  const calls = mockNetwork(t);
  const good = make("good.txt");
  const empty = make("empty.txt", "");
  const link = path.join(work, "to-config");
  symlinkSync(path.join(env.dir, "config.json"), link);
  const run = await sendFile([good, path.join(work, "nope.txt"), work, empty, path.join(env.dir, "config.json"), link]);
  assert.equal(run.code, 1);
  assert.match(run.err, /Nothing was sent/);
  assert.match(run.err, /nope\.txt: no such file/);
  assert.match(run.err, new RegExp(`${work.replace(/[/.]/g, "\\$&")}: is a directory`));
  assert.match(run.err, /empty\.txt: is empty/);
  assert.match(run.err, /config\.json: is part of the Aukalo configuration/);
  assert.match(run.err, /to-config: is part of the Aukalo configuration/, "a symlink to the config is followed and refused");
  assert.doesNotMatch(run.err, /good\.txt/, "a valid file is not listed as a problem");
  assert.equal(calls.length, 0, "the valid file is not sent either");
  assert.doesNotMatch(run.err + run.out, new RegExp(FAKE_TOKEN));
});

test("Telegram: each kind goes through its method, photo caption and topic included", async (t) => {
  configure({ messageThreadId: "77" });
  const calls = mockNetwork(t);
  const run = await sendFile([
    "--caption", "contact sheet", make("sheet.jpg"), make("clip.mp4"), make("voice.mp3"), make("notes.txt"),
  ]);
  assert.equal(run.code, 0, run.err);
  const sent = uploads(calls);
  assert.deepEqual(sent.map((call) => call.method), ["sendPhoto", "sendVideo", "sendAudio", "sendDocument"]);
  assert.deepEqual(sent.map((call) => Object.keys(call.fields).find((key) => key.match(/^(photo|video|audio|document)$/))),
    ["photo", "video", "audio", "document"]);
  assert.ok(sent.every((call) => call.host === "api.telegram.org" && call.route.startsWith(`/bot${FAKE_TOKEN}/`)));
  assert.ok(sent.every((call) => call.fields.chat_id === "-1001234567890" && call.fields.message_thread_id === "77"));
  assert.equal(sent[0].fields.caption, "Release notes: contact sheet");
  assert.equal(sent[1].fields.caption, undefined);
  assert.match(run.out, /sheet\.jpg \(\d+ B\)\n {2}telegram: sent as photo/);
  assert.match(run.out, /Delivered: all 4 file\(s\) to telegram\./);
  assert.doesNotMatch(run.out + run.err, new RegExp(FAKE_TOKEN), "the token never reaches the output");
});

test("Telegram: over 50 MB is refused with the file, its size and the limit; nothing is uploaded", async (t) => {
  configure();
  const calls = mockNetwork(t);
  const run = await sendFile([sparse("big.mp4", 51 * MiB)]);
  assert.equal(run.code, 1);
  assert.match(run.out, /big\.mp4 \(51 MiB\)/);
  assert.match(run.out, /telegram: NOT sent: big\.mp4 is 51 MiB, over the Telegram limit of 50 MiB \(https:\/\/core\.telegram\.org\/bots\/api#sending-files\)/);
  assert.match(run.out, /Not delivered everywhere: 0 of 1/);
  assert.equal(calls.length, 0);
});

test("Telegram: a photo over 10 MB goes as a document, over 50 MB is refused", async (t) => {
  configure();
  const calls = mockNetwork(t);
  const run = await sendFile([sparse("huge.png", 12 * MiB)]);
  assert.equal(run.code, 0, run.err);
  assert.deepEqual(uploads(calls).map((call) => call.method), ["sendDocument"]);
  assert.match(run.out, /sent as document \(over the 10 MiB photo limit\)/);
});

test("Telegram refuses a photo's dimensions: the same file is resent as a document", async (t) => {
  configure();
  const calls = mockNetwork(t, (call) => call.method === "sendPhoto"
    ? Response.json({ ok: false, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" }, { status: 400 }) : null);
  const run = await sendFile(["--caption", "wide", make("wide.png")]);
  assert.equal(run.code, 0, run.err);
  assert.deepEqual(uploads(calls).map((call) => call.method), ["sendPhoto", "sendDocument"]);
  assert.equal(uploads(calls)[1].fields.caption, "Release notes: wide");
  assert.match(run.out, /sent as document \(Telegram refused it as a photo\)/);
});

test("Discord: one attachment per message, caption as content, the owner is never mentioned", async (t) => {
  configure({ notificationTarget: "discord", ...discordConfig });
  const calls = mockNetwork(t);
  const run = await sendFile(["--caption", "ping <@123456789012345671> @everyone", make("clip.mp4"), make("notes.txt")]);
  assert.equal(run.code, 0, run.err);
  const sent = uploads(calls);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((call) => call.host === "discord.com" && call.route === `/api/v10/channels/${CHANNEL}/messages`));
  const payload = JSON.parse(sent[0].fields.payload_json);
  assert.equal(payload.content, "Release notes: ping <@123456789012345671> @everyone");
  assert.deepEqual(payload.allowed_mentions, { parse: [], replied_user: false });
  assert.deepEqual(payload.attachments, [{ id: 0, filename: "clip.mp4" }]);
  assert.equal(payload.flags & 4096, 4096, "quiet: no notification sound");
  assert.equal(sent[0].fields["files[0]"].name, "clip.mp4");
  assert.equal(JSON.parse(sent[1].fields.payload_json).content, "", "the caption is sent once");
  assert.equal(sent[0].init.headers.Authorization, `Bot ${DISCORD_TOKEN}`);
  assert.match(run.out, /clip\.mp4 \(\d+ B\)\n {2}discord: sent as video/);
  assert.doesNotMatch(run.out + run.err, new RegExp(DISCORD_TOKEN));
});

test("Discord: over the default 20 MiB is refused when the Boost level is not higher", async (t) => {
  configure({ notificationTarget: "discord", ...discordConfig, discordGuild: GUILD, discordCategory: "123456789012345676" });
  const calls = mockNetwork(t, (call) => call.route === `/api/v10/guilds/${GUILD}` ? Response.json({ id: GUILD, premium_tier: 1 }) : null);
  const run = await sendFile([sparse("clip.mp4", 21 * MiB)]);
  assert.equal(run.code, 1);
  assert.match(run.out, /discord: NOT sent: clip\.mp4 is 21 MiB, over the Discord limit of 20 MiB for this server \(Boost level 1\) \(https:\/\/discord\.com\/developers\/docs\/reference#uploading-files\)/);
  assert.equal(uploads(calls).length, 0);
});

test("Discord: a Boost level 2 server takes 50 MiB, level 3 takes 100 MiB", async (t) => {
  configure({ notificationTarget: "discord", ...discordConfig, discordGuild: GUILD, discordCategory: "123456789012345676" });
  let tier = 2;
  const calls = mockNetwork(t, (call) => call.route === `/api/v10/guilds/${GUILD}` ? Response.json({ id: GUILD, premium_tier: tier }) : null);
  assert.equal((await sendFile([sparse("forty.mp4", 40 * MiB)])).code, 0);
  assert.equal(uploads(calls).length, 1);
  assert.equal((await sendFile([sparse("sixty.mp4", 60 * MiB)])).code, 1);
  assert.equal(uploads(calls).length, 1, "60 MiB is over level 2");
  tier = 3;
  assert.equal((await sendFile([sparse("sixty.mp4", 60 * MiB)])).code, 0);
  assert.equal(uploads(calls).length, 2);
});

test("Discord: unknown Boost level falls back to the documented default", async (t) => {
  configure({ notificationTarget: "discord", ...discordConfig, discordGuild: GUILD, discordCategory: "123456789012345676" });
  mockNetwork(t, (call) => call.route === `/api/v10/guilds/${GUILD}` ? new Response(null, { status: 403 }) : null);
  const run = await sendFile([sparse("clip.mp4", 25 * MiB)]);
  assert.equal(run.code, 1);
  assert.match(run.out, /over the Discord limit of 20 MiB \(default; server Boost level unknown\)/);
});

test("both: a 30 MiB video reaches Telegram only, and the report says exactly that", async (t) => {
  configure({ notificationTarget: "both", ...discordConfig });
  const calls = mockNetwork(t);
  const run = await sendFile(["--caption", "render", sparse("render.mp4", 30 * MiB)]);
  assert.equal(run.code, 1, "not delivered everywhere");
  assert.match(run.out, /telegram: sent as video/);
  assert.match(run.out, /discord: NOT sent: render\.mp4 is 30 MiB, over the Discord limit of 20 MiB/);
  assert.match(run.out, /Not delivered everywhere: 1 of 2 file deliveries succeeded \(telegram and discord\)\./);
  assert.deepEqual(uploads(calls).map((call) => call.host), ["api.telegram.org"]);
  const json = JSON.parse((await sendFile(["--json", sparse("render.mp4", 30 * MiB)])).out);
  assert.equal(json.ok, false);
  assert.deepEqual(json.results.map(({ destination, ok }) => [destination, ok]), [["telegram", true], ["discord", false]]);
});

test("both: a small file goes to both; a Discord outage is reported as Discord's failure, not as success", async (t) => {
  configure({ notificationTarget: "both", ...discordConfig });
  const calls = mockNetwork(t);
  const ok = await sendFile([make("a.txt")]);
  assert.equal(ok.code, 0, ok.err);
  // The two destinations send in parallel: the order of the requests is not fixed.
  assert.deepEqual(uploads(calls).map((call) => call.host).sort(), ["api.telegram.org", "discord.com"]);
  assert.match(ok.out, /telegram: sent as document\n {2}discord: sent as document/);

  mockNetwork(t, (call) => call.host === "discord.com" ? new Response("{}", { status: 500 }) : null);
  const down = await sendFile([make("b.txt")]);
  assert.equal(down.code, 1);
  assert.match(down.out, /telegram: sent as document/);
  assert.match(down.out, /discord: NOT sent: Discord: HTTP 500/);
});

test("a server that says 'too large' is reported with the file, its size and the limit", async (t) => {
  configure();
  mockNetwork(t, () => Response.json({ ok: false, description: "Request Entity Too Large" }, { status: 413 }));
  const run = await sendFile([make("a.txt")]);
  assert.equal(run.code, 1);
  assert.match(run.out, /telegram: NOT sent: Telegram rejected a\.txt \(\d+ B\) as too large \(https:\/\/core\.telegram\.org/);
});

test("a caption too long for Telegram's 1024 follows the file as a message, in full", async (t) => {
  configure();
  const calls = mockNetwork(t);
  const caption = "word ".repeat(300).trim();
  const run = await sendFile(["--caption", caption, make("a.txt")]);
  assert.equal(run.code, 0, run.err);
  assert.equal(uploads(calls).length, 1);
  assert.equal(uploads(calls)[0].fields.caption, undefined);
  const text = calls.filter((call) => call.method === "sendMessage");
  assert.equal(text.length, 1);
  assert.equal(text[0].json.text, `Release notes: ${caption}`);
});

test("a secret in a caption or an error is redacted; the token never appears in the output", async (t) => {
  configure();
  const calls = mockNetwork(t, () => Response.json({ ok: false, description: `Bad Request: bot ${FAKE_TOKEN} blocked` }, { status: 400 }));
  const run = await sendFile(["--caption", `token=${FAKE_TOKEN}`, make("a.txt")]);
  assert.equal(run.code, 1);
  assert.doesNotMatch(run.out + run.err, new RegExp(FAKE_TOKEN));
  assert.doesNotMatch(calls[0].fields.caption ?? "", new RegExp(FAKE_TOKEN));
  assert.match(run.out, /REDACTED/);
});

test("a destination selected in settings but not configured is an error; with both, the other one still works", async (t) => {
  configure({ notificationTarget: "discord" });
  const calls = mockNetwork(t);
  const none = await sendFile([make("a.txt")]);
  assert.equal(none.code, 1);
  assert.match(none.err, /Discord is selected in "Where to send" but not configured\. Nothing was sent\./);
  configure({ notificationTarget: "both" });
  const one = await sendFile([make("a.txt")]);
  assert.equal(one.code, 0, one.err);
  assert.match(one.out, /discord: not configured, skipped/);
  assert.equal(uploads(calls).length, 1);
});

test("without --to the calling session is used; an unknown one asks for --to", async (t) => {
  configure();
  mockNetwork(t);
  const log = console.error;
  let err = "";
  console.error = (...parts) => { err += parts.join(" "); };
  try {
    process.env.CLAUDE_CODE_SESSION_ID = "unregistered-session";
    process.exitCode = 0;
    await entry.run(["send-file", make("a.txt")]);
  } finally {
    console.error = log;
    delete process.env.CLAUDE_CODE_SESSION_ID;
  }
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  assert.match(err, /not known to Aukalo yet: pass --to/);
});

test("the session context tells a Claude Code session the exact command and the limits", async () => {
  process.env.CLAUDE_PLUGIN_ROOT = "/plugins/aukalo";
  let out = "";
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk === "string") { out += chunk; return true; }
    return write.call(this, chunk, ...rest);
  };
  try {
    await entry.handleEvent({ hook_event_name: "SessionStart" });
  } finally {
    process.stdout.write = write;
    delete process.env.CLAUDE_PLUGIN_ROOT;
  }
  const context = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(context, /telegram-action-notifier\.mjs" send-file \[--caption "<text>"\] <path>\.\.\./);
  assert.match(context, /Telegram 50 MiB, 10 MiB for a photo; Discord 20 MiB/);
  assert.match(context, /never say a file was sent when it printed NOT sent/);
});
