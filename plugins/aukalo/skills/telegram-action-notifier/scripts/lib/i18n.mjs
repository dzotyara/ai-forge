// Interface language. English by default; "language": "ru" in config.json switches to Russian.
// AUKALO_LANG=en|ru overrides it (tests run in Russian through tests/lang-ru.mjs).
// Read once per process: the panel restarts the daemon when the language changes.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const LANGUAGES = ["en", "ru"];
let cached;

export function lang() {
  if (cached) return cached;
  const forced = process.env.AUKALO_LANG ?? process.env.AI_FORGE_LANG;
  if (LANGUAGES.includes(forced)) return (cached = forced);
  try {
    const base = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
    const config = JSON.parse(readFileSync(path.join(base, "telegram-action-notifier", "config.json"), "utf8"));
    cached = LANGUAGES.includes(config.language) ? config.language : "en";
  } catch {
    cached = "en";
  }
  return cached;
}

/** The text in the interface language: L("Разрешено", "Allowed"). */
export const L = (ru, en) => (lang() === "ru" ? ru : en);

/** Forget the cached language (tests, and the panel right after a change). */
export function resetLang() {
  cached = undefined;
}
