// Test helpers: an isolated CODEX_HOME and a recording fetch mock (no network).
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const FAKE_TOKEN = ["123456789", "AAFakeTokenForTestsOnly_0123456789abc"].join(":");

export function isolatedHome({ chatId = "4242", extra = {} } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "tan-test-"));
  process.env.CODEX_HOME = home;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_MESSAGE_THREAD_ID;
  const dir = path.join(home, "telegram-action-notifier");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ botToken: FAKE_TOKEN, chatId, ...extra }), { mode: 0o600 });
  return { home, dir, state: path.join(dir, "state") };
}

/** Replace global fetch. `handler(method, params)` returns a result or { error, status }. */
export function mockTelegram(handler = () => true) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = String(url).split("/").pop();
    const params = init.body ? JSON.parse(init.body) : {};
    calls.push({ method, params });
    const out = await handler(method, params, calls);
    if (out && out.error) {
      return { ok: false, status: out.status ?? 400, json: async () => ({ ok: false, description: out.error }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: out }) };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
