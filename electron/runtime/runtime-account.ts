/**
 * Which provider account a subscription CLI is signed in to right now, as an opaque fingerprint (never an email or an id).
 *
 * Why: a usage limit belongs to the account that hit it, not to "claude-code". The durable retry window (store/runtime-retry.ts)
 * was keyed by the runtime alone, so after the owner switched the Claude CLI to another account every turn was still refused
 * until the old account's reset time, restart or not (window until 03:00). The retry resource now carries this
 * fingerprint, so a window recorded for one account simply does not match another.
 *
 * Only the runtimes whose local sign-in files name an account are covered: claude-code, codex and kimi, through the same
 * readers the usage account watch uses (usage/*.ts). antigravity, grok, cursor, ACP agents and every API/local backend have no
 * local account read here; for them the person's way out is the one probe a refusal still allows (RUNTIME_RETRY_PROBE_GAP_MS).
 * An unreadable identity is "unknown" (undefined), and unknown never changes a key, so nothing is unlocked on a guess.
 *
 * The read is a small file read, and candidate enumeration asks for it many times, so one answer is kept per kind for a
 * moment. At most one entry per kind (bounded), dropped at once when the usage account watch sees the account change.
 */
const CACHE_MS = 2_000;
const cache = new Map<string, { at: number; value: string | undefined }>();
let override: ((kind: string) => string | undefined) | null = null;

function readIdentity(kind: string): string | undefined {
  if (override) return override(kind);
  try {
    if (kind === "claude-code") return (require("../usage/claude") as typeof import("../usage/claude")).currentClaudeUsageAccountFingerprint();
    if (kind === "codex") return (require("../usage/codex") as typeof import("../usage/codex")).currentCodexUsageAccountFingerprint();
    if (kind === "kimi") return (require("../usage/kimi") as typeof import("../usage/kimi")).currentKimiUsageCredentialFingerprint();
  } catch { /* an unreadable identity is unknown, never a reason to fail a call */ }
  return undefined;
}

/** The signed-in account's fingerprint for this runtime kind, or undefined when the runtime reports none (or it cannot be read). */
export function runtimeAccountFingerprint(kind: string, now = Date.now()): string | undefined {
  if (!override) {
    const hit = cache.get(kind);
    if (hit && now - hit.at >= 0 && now - hit.at < CACHE_MS) return hit.value;
  }
  let value: string | undefined;
  try { value = readIdentity(kind); } catch { value = undefined; }
  if (!override) cache.set(kind, { at: now, value });
  return value;
}

/** The account changed (the usage account watch saw it): the next read goes to the files. */
export function forgetRuntimeAccountCache(): void { cache.clear(); }

/** True only when both the recorded and the current account are known and differ. Unknown on either side never means "changed". */
export function runtimeAccountChanged(kind: string | undefined, recorded: string | undefined): boolean {
  if (!kind || !recorded) return false;
  const current = runtimeAccountFingerprint(kind);
  return current !== undefined && current !== recorded;
}

/** Test only: replace the identity reader (null restores the real one). */
export function setRuntimeAccountReaderForTest(reader: ((kind: string) => string | undefined) | null): void {
  override = reader; cache.clear();
}
