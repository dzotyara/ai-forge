import "./lang-ru.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { codexWorking, deviceLine, fleetTotals, otherDevices, parseDevice, readDevice, reportDevice, runPresenceReporter }
  from "../skills/telegram-action-notifier/scripts/lib/devices.mjs";

const guild = "123456789012345601", category = "123456789012345602", channel = "123456789012345603";
const discord = { token: { secret: "s", owner: "123456789012345604", channel: "123456789012345605", guild, category } };

test("Codex sessions written in the last 90 s count, older ones don't", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-"));
  const now = new Date();
  const dir = path.join(root, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "rollout-a.jsonl"), "{}");
  writeFileSync(path.join(dir, "rollout-b.jsonl"), "{}");
  utimesSync(path.join(dir, "rollout-b.jsonl"), new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
  const oldDay = path.join(root, "2024", "01", "01");
  mkdirSync(oldDay, { recursive: true });
  writeFileSync(path.join(oldDay, "rollout-resumed.jsonl"), "{}");
  writeFileSync(path.join(oldDay, "unrelated.jsonl"), "{}");
  assert.equal(await codexWorking(Date.now(), root), 2);
});

test("a device line round-trips and totals add fresh devices", () => {
  const line = deviceLine({ id: "dev1", name: "laptop", claude: 2, codex: 1, at: 1_700_000_000_000 });
  assert.match(line, /Claude Code: 2 · Codex: 1/);
  assert.deepEqual(parseDevice(line), { d: "dev1", n: "laptop", c: 2, x: 1, at: 1_700_000_000_000 });
  assert.equal(parseDevice("just text"), null);
  // A device that still runs a version from before the rename.
  assert.equal(parseDevice('🖥 **old** · Claude Code: 1 · Codex: 0\n-# ai-forge {"d":"dev2","n":"old","c":1,"x":0,"at":1}').d, "dev2");
  assert.deepEqual(fleetTotals({ claude: 3, codex: 0 }, [{ c: 0, x: 2 }]), { working: 5, hosts: "Claude Code · Codex", devices: 2 });
  assert.deepEqual(fleetTotals({ claude: 0, codex: 0 }, []), { working: 0, hosts: "Claude Code", devices: 1 });
});

test("a device creates the presence channel once, then edits its own message; others are read back", async (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "state-"));
  const calls = [];
  const now = Date.now();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const route = new URL(url).pathname.replace("/api/v10", "") + new URL(url).search;
    calls.push([options.method, route]);
    if (route === `/guilds/${guild}/channels` && options.method === "GET") return Response.json([{ id: category, type: 4, permission_overwrites: [{ id: guild, type: 0, allow: "0", deny: "1024" }] }]);
    if (route === `/guilds/${guild}/channels`) return Response.json({ id: channel });
    if (route.startsWith(`/channels/${channel}/messages?`)) {
      return Response.json([
        { content: deviceLine({ id: "other", name: "pc", claude: 0, codex: 2, at: now - 10_000 }) },
        { content: deviceLine({ id: "old", name: "x", claude: 5, codex: 5, at: now - 600_000 }) },
        { content: deviceLine({ id: (await readDevice(stateDir)).id, name: "me", claude: 1, codex: 0, at: now }) },
      ]);
    }
    return Response.json({ id: "123456789012345606" });
  });
  await reportDevice(discord, stateDir, { claude: 1, codex: 0 }, now);
  await reportDevice(discord, stateDir, { claude: 2, codex: 0 }, now);
  assert.deepEqual(calls.map(([m, r]) => `${m} ${r}`), [
    `GET /guilds/${guild}/channels`, `POST /guilds/${guild}/channels`, `POST /channels/${channel}/messages`,
    `PATCH /channels/${channel}/messages/123456789012345606`,
  ]);
  const others = await otherDevices(discord, stateDir, now);
  assert.deepEqual(others.map((d) => d.d), ["other"], "self and stale devices are left out");
});

test("the reporter steps aside when the daemon runs here", async (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "state-"));
  t.mock.method(globalThis, "fetch", async () => Response.json({ id: "123456789012345606" }));
  assert.equal(await runPresenceReporter({ discord, stateDir, daemonAlive: async () => true }), "daemon");
  let ticks = 0;
  const result = await runPresenceReporter({ discord: { token: { ...discord.token, guild: "", category: "" } }, stateDir,
    idleMs: -1, sleep: async () => { ticks += 1; } });
  assert.equal(result, "idle");
});
