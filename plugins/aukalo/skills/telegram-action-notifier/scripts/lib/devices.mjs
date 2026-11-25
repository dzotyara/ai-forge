// Working agents across devices. Every device keeps one message in the private
// "📡・presence" Discord channel with its counts (Claude Code agents, Codex sessions)
// and a timestamp; the daemon adds the counts of devices fresher than two minutes.
// Only REST is used here: a second device never opens its own Gateway connection,
// so it never competes with the daemon for button presses.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { discordApi, discordId } from "./discord.mjs";
import { L } from "./i18n.mjs";

export const PRESENCE_CHANNEL = "📡・presence";
export const DEVICE_STALE_MS = 120_000;
const ACTIVE_MS = 90_000;
const MARK = "aukalo ";

const codexSessions = () => path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"), "sessions");

/**
 * Codex sessions on this device written to in the last 90 s. Rollouts live in
 * sessions/YYYY/MM/DD. A resumed session keeps writing to the day it was created.
 */
export async function codexWorking(now = Date.now(), root = codexSessions()) {
  let count = 0;
  const entries = await fsp.readdir(root, { withFileTypes: true, recursive: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
    const stat = await fsp.stat(path.join(entry.parentPath, entry.name)).catch(() => null);
    if (stat && now - stat.mtimeMs < ACTIVE_MS) count += 1;
  }
  return count;
}

const deviceFile = (stateDir) => path.join(stateDir, "device.json");

export async function readDevice(stateDir) {
  try {
    return JSON.parse(await fsp.readFile(deviceFile(stateDir), "utf8"));
  } catch {
    return {};
  }
}

async function writeDevice(stateDir, device) {
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${deviceFile(stateDir)}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(device), { mode: 0o600 });
  await fsp.rename(tmp, deviceFile(stateDir));
}

export const deviceName = () => os.hostname().replace(/\.local$/, "");

/** The human line plus a machine-readable tail that other devices parse. */
export function deviceLine({ id, name, claude, codex, at }) {
  const data = JSON.stringify({ d: id, n: name, c: claude, x: codex, at });
  return `🖥 **${name}** · Claude Code: ${claude} · Codex: ${codex} · <t:${Math.floor(at / 1000)}:R>\n-# ${MARK}${data}`;
}

export function parseDevice(content) {
  const match = /(?:aukalo|ai-forge) (\{.*\})\s*$/m.exec(String(content ?? ""));
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    return typeof data.d === "string" && Number.isFinite(data.at) ? data : null;
  } catch {
    return null;
  }
}

/** Find or create the private presence channel under the Aukalo category. */
async function presenceChannel(discord, device) {
  if (discordId(device.channel)) return device.channel;
  const { guild, category } = discord.token;
  if (!guild || !category) return null;
  const channels = await discordApi(discord.token, "GET", `/guilds/${guild}/channels`);
  const found = channels.find((c) => c.type === 0 && c.parent_id === category && c.name === PRESENCE_CHANNEL);
  if (found) return found.id;
  const parent = channels.find((c) => c.id === category);
  const created = await discordApi(discord.token, "POST", `/guilds/${guild}/channels`, {
    name: PRESENCE_CHANNEL, type: 0, parent_id: category,
    topic: L("Служебный канал Aukalo: сколько агентов работает на каждом устройстве.",
      "Aukalo service channel: how many agents each device is running."),
    permission_overwrites: parent?.permission_overwrites ?? [],
  });
  return created.id;
}

/** Publish this device's counts (one message per device, edited in place). */
export async function reportDevice(discord, stateDir, { claude = 0, codex = 0 }, now = Date.now()) {
  const device = await readDevice(stateDir);
  device.id ||= randomUUID().slice(0, 8);
  device.channel = await presenceChannel(discord, device);
  if (!device.channel) return null;
  const content = deviceLine({ id: device.id, name: deviceName(), claude, codex, at: now });
  try {
    if (discordId(device.message)) {
      await discordApi(discord.token, "PATCH", `/channels/${device.channel}/messages/${device.message}`,
        { content, allowed_mentions: { parse: [] } });
    } else {
      const sent = await discordApi(discord.token, "POST", `/channels/${device.channel}/messages`,
        { content, allowed_mentions: { parse: [] }, flags: 4096 });
      device.message = sent.id;
    }
  } catch (error) {
    if (error.status !== 404) throw error;
    // The message or the channel was deleted: start over on the next report.
    delete device.message;
    delete device.channel;
  }
  await writeDevice(stateDir, device);
  return device;
}

/** Counts reported by other devices in the last two minutes. */
export async function otherDevices(discord, stateDir, now = Date.now()) {
  const device = await readDevice(stateDir);
  if (!discordId(device.channel)) return [];
  const messages = await discordApi(discord.token, "GET", `/channels/${device.channel}/messages?limit=50`);
  return messages.map((message) => parseDevice(message.content))
    .filter((data) => data && data.d !== device.id && now - data.at < DEVICE_STALE_MS);
}

/** Totals for the status: this device plus fresh other devices; hosts that have work. */
export function fleetTotals(own, others) {
  const claude = own.claude + others.reduce((sum, d) => sum + (Number(d.c) || 0), 0);
  const codex = own.codex + others.reduce((sum, d) => sum + (Number(d.x) || 0), 0);
  const hosts = [claude ? "Claude Code" : null, codex ? "Codex" : null].filter(Boolean);
  return { working: claude + codex, hosts: hosts.join(" · ") || "Claude Code", devices: others.length + 1 };
}

const reporterPid = (stateDir) => path.join(stateDir, "presence.pid");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/** Start the background reporter on a device without the daemon (Codex hooks call this). */
export async function ensurePresenceReporter(stateDir, entryScript) {
  const pid = Number(await fsp.readFile(reporterPid(stateDir), "utf8").catch(() => ""));
  if (pid && alive(pid)) return pid;
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [entryScript, "presence"], {
    detached: true, stdio: "ignore", cwd: os.homedir(), env: process.env,
  });
  child.unref();
  return child.pid;
}

/**
 * The reporter loop: every 20 s publish this device's counts. It steps aside when
 * the daemon runs here (the daemon reports itself) and exits after 30 idle minutes.
 */
export async function runPresenceReporter({ discord, stateDir, claudeWorking = async () => 0,
  daemonAlive = async () => false, tickMs = 20_000, idleMs = 30 * 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const pidFile = reporterPid(stateDir);
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fsp.writeFile(pidFile, String(process.pid), { mode: 0o600 });
  let lastWork = Date.now();
  try {
    for (;;) {
      if (await daemonAlive()) return "daemon";
      const counts = { claude: await claudeWorking(), codex: await codexWorking() };
      if (counts.claude + counts.codex) lastWork = Date.now();
      await reportDevice(discord, stateDir, counts).catch(() => {});
      if (Date.now() - lastWork > idleMs) return "idle";
      await sleep(tickMs);
    }
  } finally {
    if (Number(await fsp.readFile(pidFile, "utf8").catch(() => "")) === process.pid) await fsp.rm(pidFile, { force: true });
  }
}
