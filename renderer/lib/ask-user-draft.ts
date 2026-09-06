import type { AskUserRequestEvent } from "@/lib/types";

/**
 * Free-text answers belong to the renderer tab that is displaying the question.
 * sessionStorage survives a reload of that tab while keeping drafts isolated
 * from other tabs and from the rest of the app's persistent data.
 */
const STORAGE_PREFIX = "agentlas.ask-user-draft.v1:";
const STORAGE_VERSION = 1;

interface StoredAskUserDraft {
  version: typeof STORAGE_VERSION;
  requestId: string;
  chatId: string | null;
  createdAt: number;
  expiresAt: number;
  fingerprint: string;
  updatedAt: number;
  value: string;
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

function fingerprint(request: AskUserRequestEvent): string {
  const options = request.options.map((option) => [option.label, option.description ?? ""]);
  return hash(JSON.stringify([
    request.question,
    request.askedBy,
    request.allowFreeText,
    options,
  ]));
}

function key(request: AskUserRequestEvent): string {
  const chatId = request.chatId ?? "";
  return `${STORAGE_PREFIX}${encodeURIComponent(chatId)}:${encodeURIComponent(request.requestId)}`;
}

function normalizedChatId(request: AskUserRequestEvent): string | null {
  return request.chatId ?? null;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStoredDraft(value: unknown): value is StoredAskUserDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<StoredAskUserDraft>;
  return draft.version === STORAGE_VERSION
    && typeof draft.requestId === "string"
    && (typeof draft.chatId === "string" || draft.chatId === null)
    && isFiniteTimestamp(draft.createdAt)
    && isFiniteTimestamp(draft.expiresAt)
    && typeof draft.fingerprint === "string"
    && isFiniteTimestamp(draft.updatedAt)
    && typeof draft.value === "string";
}

function remove(storageArea: Storage, storageKey: string): void {
  try {
    storageArea.removeItem(storageKey);
  } catch {
    // Storage can become unavailable between getItem and removeItem. The
    // in-memory draft remains the source of truth for the current render.
  }
}

function prune(storageArea: Storage, now: number): void {
  const staleKeys: string[] = [];
  try {
    const keys: string[] = [];
    for (let index = 0; index < storageArea.length; index += 1) {
      const storageKey = storageArea.key(index);
      if (storageKey?.startsWith(STORAGE_PREFIX)) keys.push(storageKey);
    }
    for (const storageKey of keys) {
      const raw = storageArea.getItem(storageKey);
      if (!raw) {
        staleKeys.push(storageKey);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (!isStoredDraft(parsed) || parsed.expiresAt <= now || parsed.value.length === 0) {
        staleKeys.push(storageKey);
      }
    }
    for (const storageKey of staleKeys) remove(storageArea, storageKey);
  } catch {
    // Best-effort cleanup must never block typing or answering a question.
  }
}

/** Read the request-bound draft, if it is still valid for this question. */
export function loadAskUserDraft(request: AskUserRequestEvent, now = Date.now()): string | null {
  if (!request.allowFreeText) return null;
  const storageArea = storage();
  if (!storageArea) return null;
  const storageKey = key(request);
  if (request.expiresAt <= now) {
    remove(storageArea, storageKey);
    return null;
  }
  try {
    const raw = storageArea.getItem(storageKey);
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!isStoredDraft(parsed)
      || parsed.requestId !== request.requestId
      || parsed.chatId !== normalizedChatId(request)
      || parsed.createdAt !== request.createdAt
      || parsed.expiresAt !== request.expiresAt
      || parsed.fingerprint !== fingerprint(request)
      || parsed.expiresAt <= now) {
      remove(storageArea, storageKey);
      return null;
    }
    return parsed.value;
  } catch {
    return null;
  }
}

/** Save the current input without making storage availability a UI dependency. */
export function saveAskUserDraft(
  request: AskUserRequestEvent,
  value: string,
  now = Date.now(),
): boolean {
  const storageArea = storage();
  if (!storageArea || !request.allowFreeText) return false;
  const storageKey = key(request);
  if (request.expiresAt <= now) {
    remove(storageArea, storageKey);
    return false;
  }
  if (value.length === 0) {
    remove(storageArea, storageKey);
    return true;
  }
  const draft: StoredAskUserDraft = {
    version: STORAGE_VERSION,
    requestId: request.requestId,
    chatId: normalizedChatId(request),
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    fingerprint: fingerprint(request),
    updatedAt: now,
    value,
  };
  try {
    storageArea.setItem(storageKey, JSON.stringify(draft));
    prune(storageArea, now);
    return true;
  } catch {
    // The current input remains usable in memory, but an older persisted value
    // must not come back after reload when storage rejected this update.
    remove(storageArea, storageKey);
    return false;
  }
}

/** Remove a draft after a successful answer, dismissal, or expiry. */
export function clearAskUserDraft(request: AskUserRequestEvent): void {
  const storageArea = storage();
  if (storageArea) remove(storageArea, key(request));
}
