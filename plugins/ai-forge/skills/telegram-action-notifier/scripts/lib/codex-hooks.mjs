import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configurationPath } from "./common.mjs";
import { L } from "./i18n.mjs";

/** Opt-in fallback for Codex builds that omit the installed plugin hooks. */
export async function registerCodexHooks(codexDir = path.resolve(configurationPath(), "../..")) {
  const source = new URL("../../../../hooks/codex-hooks.json", import.meta.url);
  const entry = fileURLToPath(new URL("../telegram-action-notifier.mjs", import.meta.url));
  const definition = JSON.parse(await readFile(source, "utf8"));
  const quoted = process.platform === "win32"
    ? `"${entry.replaceAll("\\", "/")}"`
    : "'" + entry.replaceAll("'", "'\\''") + "'";
  for (const [event, groups] of Object.entries(definition.hooks)) {
    for (const { hooks } of groups) {
      for (const handler of hooks) {
        handler.command = `node ${quoted}`;
        handler.statusMessage = `AI Forge: ${event}`;
      }
    }
  }

  const destination = path.join(codexDir, "hooks.json");
  await mkdir(codexDir, { recursive: true });
  try {
    await writeFile(destination, JSON.stringify(definition, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(L(
      `${destination} уже существует. Добавьте хуки вручную, сохранив текущие записи.`,
      `${destination} already exists. Add the hooks manually to preserve its existing entries.`,
    ));
  }
  return destination;
}
