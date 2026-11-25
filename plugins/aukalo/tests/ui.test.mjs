import "./lang-ru.mjs";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { FAKE_TOKEN, isolatedHome, mockTelegram } from "./helpers.mjs";

const env = isolatedHome({ chatId: "-1001234567890", extra: { ownerUserId: "4242" } });
const ui = await import("../skills/telegram-action-notifier/scripts/lib/ui.mjs");
mkdirSync(env.state, { recursive: true });

const SECRET = "test-secret-0123456789";
const server = http.createServer();
let port = 0;
server.on("request", ui.createUiHandler({ secret: SECRET, getPort: () => port }));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
port = server.address().port;
test.after(() => server.close());

const tg = mockTelegram((method, params) => {
  if (method === "getMe") return { id: 123456789, username: "MyTestBot", has_topics_enabled: false };
  if (method === "getChat") return { id: -1001234567890, title: "Fabric", type: "supergroup", is_forum: true };
  if (method === "getChatMember") return { status: "administrator", can_manage_topics: true };
  if (method === "getUpdates") return [];
  return true;
});
test.after(() => tg.restore());

function request(pathname, { method = "GET", key = SECRET, host = `127.0.0.1:${port}`, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        host,
        ...(key ? { "x-panel-key": key } : {}),
        ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

test("API rejects requests without the secret or with a wrong one", async () => {
  assert.equal((await request("/api/state", { key: null })).status, 403);
  assert.equal((await request("/api/state", { key: "wrong" })).status, 403);
  assert.equal((await request("/api/settings", { method: "POST", key: null, body: { notify: "all" } })).status, 403);
});

test("DNS-rebinding guard: wrong Host header is rejected even with the secret", async () => {
  assert.equal((await request("/api/state", { host: "evil.example:80" })).status, 403);
  assert.equal((await request("/api/state", { host: `localhost:${port}` })).status, 403);
  assert.equal((await request(`/?k=${SECRET}`, { host: "evil.example" })).status, 403);
});

test("foreign Origin is rejected", async () => {
  assert.equal((await request("/api/state", { headers: { origin: "https://evil.example" } })).status, 403);
});

test("the page needs ?k=<secret>", async () => {
  assert.equal((await request("/", { key: null })).status, 403);
  const page = await request(`/?k=${SECRET}`, { key: null });
  assert.equal(page.status, 200);
  assert.match(page.text, /Куда отправлять/);
  assert.match(page.headers["content-security-policy"], /default-src 'none'/);
  assert.equal(page.headers["referrer-policy"], "no-referrer");
});

test("state never contains the token, only a masked hint and the bot name", async () => {
  const res = await request("/api/state");
  assert.equal(res.status, 200);
  assert.equal(res.text.includes(FAKE_TOKEN), false);
  assert.equal(res.text.includes(FAKE_TOKEN.split(":")[1]), false);
  const state = JSON.parse(res.text);
  assert.equal(state.bot.username, "MyTestBot");
  assert.match(state.bot.tokenHint, /^123456789:••••/);
  assert.equal(state.chat.kind, "group");
  assert.equal(state.chat.title, "Fabric");
  assert.equal(state.chat.ownerUserId, "4242");
  assert.equal(state.topics.enabled, true);
});

test("token save: format check, getMe validation, 0600 write, no echo", async () => {
  assert.equal((await request("/api/token", { method: "POST", body: { token: "nope" } })).status, 400);
  const badTg = mockTelegram(() => ({ error: "Unauthorized", status: 401 }));
  const newToken = ["987654321", "BBAnotherFakeTokenForTests_abcdefghijk"].join(":");
  try {
    const rejected = await request("/api/token", { method: "POST", body: { token: newToken } });
    assert.equal(rejected.status, 400);
  } finally {
    badTg.restore();
  }
  const configFile = path.join(env.dir, "config.json");
  assert.equal(JSON.parse(readFileSync(configFile, "utf8")).botToken, FAKE_TOKEN);

  const ok = await request("/api/token", { method: "POST", body: { token: newToken } });
  assert.equal(ok.status, 200);
  assert.equal(ok.text.includes(newToken), false);
  assert.equal(JSON.parse(readFileSync(configFile, "utf8")).botToken, newToken);
  assert.equal(statSync(configFile).mode & 0o777, 0o600);
  const state = await request("/api/state");
  assert.equal(state.text.includes(newToken.split(":")[1]), false);
  // restore for other tests
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, "utf8")), botToken: FAKE_TOKEN }), { mode: 0o600 });
});

test("settings validation", async () => {
  assert.deepEqual(ui.validateSettings({ notify: "action", approvalWaitSec: 0, quietHours: { from: "23:00", to: "08:00" } }).value, {
    notify: "action",
    approvalWaitSec: 0,
    quietHours: { from: "23:00", to: "08:00" },
  });
  assert.ok(ui.validateSettings({ approvalWaitSec: 12 * 3600 }).error);
  assert.ok(ui.validateSettings({ approvalWaitSec: "60" }).error);
  assert.ok(ui.validateSettings({ deliveryMode: "sometimes" }).error);
  assert.ok(ui.validateSettings({ quietHours: { from: "8:00", to: "9:00" } }).error);
  assert.ok(ui.validateSettings({ botToken: "x" }).error, "token cannot be set through settings");
  assert.ok(ui.validateSettings({ presenceIdleSec: 5 }).error);
  assert.equal(ui.validateSettings({ quietHours: null }).value.quietHours, null);

  const bad = await request("/api/settings", { method: "POST", body: { chatReplies: "yes" } });
  assert.equal(bad.status, 400);
  const good = await request("/api/settings", { method: "POST", body: { deliveryMode: "always", chatReplies: false, actionGraceSec: 60 } });
  assert.equal(good.status, 200);
  const saved = JSON.parse(readFileSync(path.join(env.dir, "config.json"), "utf8"));
  assert.equal(saved.deliveryMode, "always");
  assert.equal(saved.chatReplies, false);
  assert.equal(saved.actionGraceSec, 60);
  assert.equal(saved.ownerUserId, "4242");
});

test("POST requires JSON content type", async () => {
  const res = await request("/api/test", { method: "POST", headers: { "content-type": "text/plain" } });
  assert.equal(res.status, 415);
});

test("unknown API routes are 404 (after auth)", async () => {
  assert.equal((await request("/api/nope")).status, 404);
  assert.equal((await request("/api/nope", { key: null })).status, 403);
});

test("process env is untouched by the panel", () => {
  assert.equal(process.env.TELEGRAM_BOT_TOKEN, undefined);
});
