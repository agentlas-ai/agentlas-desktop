const TASTE_INTENT_RE = /^taste_[A-Za-z0-9_-]{24,120}$/u;
const UNLOCK_INTENT_RE = /^unlock_[A-Za-z0-9_-]{24,120}$/u;
const START_INTENT_RE = /^prompt_start_[A-Za-z0-9_-]{24,120}$/u;
const START_KEY_PREFIX = "agentlas.prompt-start-intent.v1:";

function randomIntent(prefix: "taste" | "unlock" | "prompt_start"): string | null {
  try {
    const random = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replaceAll("-", "")
      : Array.from(crypto.getRandomValues(new Uint8Array(18)), (value) => value.toString(16).padStart(2, "0")).join("");
    return `${prefix}_${random}`;
  } catch {
    return null;
  }
}

function unlockStorageKey(slug: string): string {
  return `agentlas.prompt-unlock-intent.v1:${encodeURIComponent(slug)}`;
}

export function storedPromptUnlockIntent(slug: string): string | null {
  try {
    const value = window.localStorage.getItem(unlockStorageKey(slug));
    return value && UNLOCK_INTENT_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Paid open is also persist-before-send: a lost response must replay one exact body. */
export function getOrCreatePromptUnlockIntent(slug: string): string | null {
  const existing = storedPromptUnlockIntent(slug);
  if (existing) return existing;
  const intent = randomIntent("unlock");
  if (!intent) return null;
  try {
    window.localStorage.setItem(unlockStorageKey(slug), intent);
    return window.localStorage.getItem(unlockStorageKey(slug)) === intent ? intent : null;
  } catch {
    return null;
  }
}

/** Renderer-side exact receipt guard before body/action state becomes visible. */
export function exactPromptUnlockBody(
  result: HubPromptOpenResult,
  slug: string,
  unlockIntentId: string,
): string | null {
  if (result.ok !== true
    || result.receiptVersion !== 1
    || result.slug !== slug
    || result.unlockIntentId !== unlockIntentId
    || result.unlocked !== true
    || typeof result.body !== "string") return null;
  if (result.status === "not_required") {
    return result.alreadyUnlocked === true && result.isOwner === true ? result.body : null;
  }
  if (result.status === "already_unlocked") {
    return result.alreadyUnlocked === true && result.isOwner === false ? result.body : null;
  }
  if (result.status !== "completed"
    || typeof result.alreadyUnlocked !== "boolean"
    || result.isOwner !== false
    || typeof result.replayed !== "boolean"
    || result.charged !== 0
    || typeof result.completedAt !== "string"
    || !Number.isFinite(Date.parse(result.completedAt))) return null;
  return result.body;
}

function tasteStorageKey(slug: string): string {
  return `agentlas.prompt-taste-intent.v1:${encodeURIComponent(slug)}`;
}

export function storedPromptTasteIntent(slug: string): string | null {
  try {
    const value = window.localStorage.getItem(tasteStorageKey(slug));
    return value && TASTE_INTENT_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Persist-before-send: failure means the one-time mutation must not start. */
export function getOrCreatePromptTasteIntent(slug: string): string | null {
  const existing = storedPromptTasteIntent(slug);
  if (existing) return existing;
  const intent = randomIntent("taste");
  if (!intent) return null;
  try {
    window.localStorage.setItem(tasteStorageKey(slug), intent);
    return window.localStorage.getItem(tasteStorageKey(slug)) === intent ? intent : null;
  } catch {
    return null;
  }
}

export function clearPromptTasteIntent(slug: string, expectedIntent: string): void {
  try {
    if (window.localStorage.getItem(tasteStorageKey(slug)) === expectedIntent) {
      window.localStorage.removeItem(tasteStorageKey(slug));
    }
  } catch {
    // A stale intent is safe: a later exact replay cannot consume a second taste.
  }
}

async function sha256(value: string): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null;
  }
}

type StoredPromptStartIntent = {
  intentId: string;
  promptDigest: string;
  seedOnly: boolean;
};

function promptStartStorageKey(slug: string, promptDigest: string, seedOnly: boolean): string {
  return `${START_KEY_PREFIX}${encodeURIComponent(slug)}:${promptDigest}:${seedOnly ? "draft" : "send"}`;
}

export async function getOrCreatePromptStartIntent(input: {
  slug: string;
  body: string;
  seedOnly: boolean;
}): Promise<StoredPromptStartIntent | null> {
  const promptDigest = await sha256(input.body);
  if (!promptDigest) return null;
  const key = promptStartStorageKey(input.slug, promptDigest, input.seedOnly);
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredPromptStartIntent>;
      if (START_INTENT_RE.test(parsed.intentId ?? "")
        && parsed.promptDigest === promptDigest
        && parsed.seedOnly === input.seedOnly) {
        return parsed as StoredPromptStartIntent;
      }
      window.localStorage.removeItem(key);
    }
    const intentId = randomIntent("prompt_start");
    if (!intentId) return null;
    const record: StoredPromptStartIntent = { intentId, promptDigest, seedOnly: input.seedOnly };
    const canonical = JSON.stringify(record);
    window.localStorage.setItem(key, canonical);
    return window.localStorage.getItem(key) === canonical ? record : null;
  } catch {
    return null;
  }
}

/** Called by the exact destination chat only after it consumes the prompt seed. */
export function completePromptStartIntent(intentId: string): void {
  if (!START_INTENT_RE.test(intentId)) return;
  try {
    const remove: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(START_KEY_PREFIX)) continue;
      try {
        const value = JSON.parse(window.localStorage.getItem(key) ?? "null") as Partial<StoredPromptStartIntent> | null;
        if (value?.intentId === intentId) remove.push(key);
      } catch {
        remove.push(key);
      }
    }
    for (const key of remove) window.localStorage.removeItem(key);
  } catch {
    // Retaining a completed intent can only reopen the same exact chat; it
    // cannot create a duplicate or bind a different prompt payload.
  }
}
import type { HubPromptOpenResult } from "@shared/types";
