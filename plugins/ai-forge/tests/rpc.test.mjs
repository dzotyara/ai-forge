import "./lang-ru.mjs";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { connectRichPresence, decodeFrames, encodeFrame, ipcPaths, richPresenceActivity } from "../skills/telegram-action-notifier/scripts/lib/rpc.mjs";

test("frames round-trip and split across chunks", () => {
  const both = Buffer.concat([encodeFrame(1, { a: 1 }), encodeFrame(3, { b: "я" })]);
  const [first, rest] = decodeFrames(both.subarray(0, 20));
  assert.deepEqual(first, [{ op: 1, data: { a: 1 } }]);
  const [second, empty] = decodeFrames(Buffer.concat([rest, both.subarray(20)]));
  assert.deepEqual(second, [{ op: 3, data: { b: "я" } }]);
  assert.equal(empty.length, 0);
  assert.ok(ipcPaths({ TMPDIR: "/t" }, "darwin").includes("/t/discord-ipc-0"));
});

test("Rich Presence: handshake, activity after READY, pong, clears on close, waits for Discord", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rpc-"));
  const file = path.join(dir, "discord-ipc-0");
  const seen = [];
  let client;
  const server = net.createServer((socket) => {
    client = socket;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      let frames;
      [frames, buffer] = decodeFrames(Buffer.concat([buffer, chunk]));
      for (const frame of frames) {
        seen.push(frame);
        if (frame.op === 0) {
          socket.write(encodeFrame(1, { cmd: "DISPATCH", evt: "READY", data: {} }));
          socket.write(encodeFrame(3, { ping: 1 }));
        }
      }
    });
  });
  const presence = connectRichPresence("123456789012345678", { paths: [file], retryMs: 30 });
  presence.set(richPresenceActivity({ working: 2, startedAt: 1_000_000 }));
  await new Promise((resolve) => setTimeout(resolve, 60)); // Discord is not running yet
  assert.equal(seen.length, 0);
  await new Promise((resolve) => server.listen(file, resolve));
  try {
    const until = Date.now() + 2000;
    while (seen.filter((f) => f.op === 1).length < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen[0], { op: 0, data: { v: 1, client_id: "123456789012345678" } });
    const activity = seen.find((f) => f.op === 1).data;
    assert.equal(activity.cmd, "SET_ACTIVITY");
    assert.equal(activity.args.pid, process.pid);
    assert.deepEqual(activity.args.activity, { details: "Агентов в работе: 2", state: "Claude Code", timestamps: { start: 1000 },
      buttons: [{ label: "⭐ AI Forge на GitHub", url: "https://github.com/dzotyara/ai-forge" }] });
    assert.ok(seen.some((f) => f.op === 4), "pong");
    presence.set(richPresenceActivity({ working: 2, startedAt: 1_000_000 }));
    presence.close();
    await new Promise((r) => setTimeout(r, 50));
    const sets = seen.filter((f) => f.op === 1);
    assert.equal(sets.length, 2, "an unchanged activity is not resent; close clears it");
    assert.equal(sets[1].data.args.activity, null);
  } finally {
    client?.destroy();
    server.close();
  }
});
