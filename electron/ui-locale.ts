// Main-process UI locale snapshot without importing the Electron bootstrap.
// Utility modules and tests can read this state without starting main.ts.
import fs from "node:fs";
import { userDataPath } from "./runtime-paths";

let locale: "ko" | "en" = "en";
let setHere = false;
let saved: { checkedAt: number; mtimeMs: number; value: "ko" | "en" } | null = null;
const FILE = "ui-locale.json";
const RECHECK_MS = 2_000;

/**
 * The owner's language. Main sets it from the screen; a process that never receives that choice (the background service,
 * which runs Hope's personal turns since the One domain moved there) reads the last value Main saved. Before, the
 * service always answered "en", so Hope replied in English to a Korean owner (production 1.2.95, 2026-10-11).
 */
export function currentUiLocale(): "ko" | "en" {
  if (setHere) return locale;
  const now = Date.now();
  if (saved && now - saved.checkedAt < RECHECK_MS) return saved.value;
  try {
    const file = userDataPath(FILE);
    const mtimeMs = fs.statSync(file).mtimeMs;
    if (!saved || saved.mtimeMs !== mtimeMs) {
      const value = (JSON.parse(fs.readFileSync(file, "utf8")) as { locale?: unknown }).locale === "ko" ? "ko" : "en";
      saved = { checkedAt: now, mtimeMs, value };
    } else saved.checkedAt = now;
    return saved.value;
  } catch {
    return locale;
  }
}

export function setCurrentUiLocale(next: "ko" | "en"): void {
  locale = next;
  setHere = true;
  try {
    const file = userDataPath(FILE);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ locale: next }), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch { /* No user data directory (tests, tools): the in-process value still applies. */ }
}
