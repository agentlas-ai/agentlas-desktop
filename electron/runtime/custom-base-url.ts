import { performance } from "node:perf_hooks";
import { getDb } from "../store/db";

export const DEFAULT_CUSTOM_BASE_URL = "https://api.openai.com/v1";

/** A missing setting is a default; an unreadable setting must never become one. */
export function readCustomBaseUrl(): string | null {
  const read = (): string | null => {
    const row = getDb().prepare("SELECT value FROM meta WHERE key = 'custom_base_url'").get() as
      | { value?: unknown }
      | undefined;
    if (row?.value == null) return null;
    if (typeof row.value !== "string") throw new TypeError("Invalid custom base URL setting");
    return row.value.trim().replace(/\/$/, "") || null;
  };
  const startedAt = performance.now();
  try {
    return read();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code : undefined;
    // SQLite already waits for its configured busy timeout. Retry an immediate
    // lock once, but never repeat a long wait before any key or request.
    if (typeof code === "string" && /^SQLITE_(BUSY|LOCKED)(_|$)/.test(code)
      && performance.now() - startedAt < 250) return read();
    throw error;
  }
}
