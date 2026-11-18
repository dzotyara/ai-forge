// Discord Rich Presence on the owner's own profile: "Playing <application name>".
//
// The Discord desktop app listens on a local socket (discord-ipc-0..9). A client
// says which application it is (handshake), then sets an activity for its pid.
// Frames: int32 LE opcode, int32 LE length, then JSON. Nothing leaves this Mac
// except through the Discord app itself. No token is used.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

const OP = { handshake: 0, frame: 1, close: 2, ping: 3, pong: 4 };

/** Socket paths Discord may use, most likely first. */
export function ipcPaths(env = process.env, platform = process.platform) {
  if (platform === "win32") return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  const bases = [env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, os.tmpdir(), "/tmp"].filter(Boolean);
  const dirs = [];
  for (const base of new Set(bases)) {
    // Flatpak and Snap builds of Discord put the socket in a subdirectory.
    dirs.push(base, path.join(base, "app/com.discordapp.Discord"), path.join(base, "snap.discord"));
  }
  return dirs.flatMap((dir) => Array.from({ length: 10 }, (_, i) => path.join(dir, `discord-ipc-${i}`)));
}

export function encodeFrame(op, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** Split a byte stream into frames; returns [frames, rest]. */
export function decodeFrames(buffer) {
  const frames = [];
  let rest = buffer;
  while (rest.length >= 8) {
    const length = rest.readInt32LE(4);
    if (rest.length < 8 + length) break;
    let data = null;
    try { data = JSON.parse(rest.subarray(8, 8 + length).toString("utf8")); } catch { /* skip a broken frame */ }
    frames.push({ op: rest.readInt32LE(0), data });
    rest = rest.subarray(8 + length);
  }
  return [frames, rest];
}

const openSocket = (file) => new Promise((resolve, reject) => {
  const socket = net.createConnection(file);
  socket.once("connect", () => resolve(socket));
  socket.once("error", reject);
});

async function firstSocket(paths) {
  for (const file of paths) {
    try { return await openSocket(file); } catch { /* not this one */ }
  }
  return null;
}

/**
 * Keep the owner's Discord profile showing an activity while the daemon runs.
 * Reconnects when Discord starts later or restarts. Returns { set(activity), close() };
 * set(null) clears it.
 */
export function connectRichPresence(clientId, { paths = ipcPaths(), retryMs = 15_000, onState = () => {} } = {}) {
  let socket = null;
  let ready = false;
  let stopped = false;
  let retry;
  let activity = null;
  let buffer = Buffer.alloc(0);

  const send = (op, payload) => { if (socket && !socket.destroyed) socket.write(encodeFrame(op, payload)); };
  const push = () => {
    if (!ready) return;
    send(OP.frame, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity }, nonce: randomUUID() });
  };
  const schedule = () => {
    if (!stopped) retry = setTimeout(connect, retryMs);
  };
  async function connect() {
    socket = await firstSocket(paths);
    if (!socket) return schedule();
    if (stopped) return socket.destroy();
    socket.on("data", (chunk) => {
      let frames;
      [frames, buffer] = decodeFrames(Buffer.concat([buffer, chunk]));
      for (const { op, data } of frames) {
        if (op === OP.ping) send(OP.pong, data);
        if (op === OP.frame && data?.evt === "READY") {
          ready = true;
          onState("ready");
          push();
        }
        if (op === OP.frame && data?.evt === "ERROR") onState(`error: ${data.data?.message ?? "unknown"}`);
        if (op === OP.close) onState(`closed: ${data?.message ?? ""}`);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      ready = false;
      buffer = Buffer.alloc(0);
      schedule();
    });
    send(OP.handshake, { v: 1, client_id: String(clientId) });
  }
  connect();
  return {
    set(next) {
      if (JSON.stringify(next) === JSON.stringify(activity)) return;
      activity = next;
      push();
    },
    close() {
      stopped = true;
      clearTimeout(retry);
      if (ready) {
        activity = null;
        push();
      }
      socket?.end();
    },
  };
}

export const REPO_URL = "https://github.com/dzotyara/ai-forge";

/**
 * The activity for the owner's profile: working sessions, how long the forge runs,
 * and a button to the repository (Discord shows buttons to other people, not to you).
 */
export function richPresenceActivity({ working, startedAt, imageUrl }) {
  return {
    details: working ? `Сессий в работе: ${working}` : "Ждёт задач",
    state: "Claude Code",
    timestamps: { start: Math.floor(startedAt / 1000) },
    ...(imageUrl ? { assets: { large_image: imageUrl, large_text: "AI Forge" } } : {}),
    buttons: [{ label: "⭐ AI Forge на GitHub", url: REPO_URL }],
  };
}
