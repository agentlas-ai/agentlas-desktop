import type { McpInvocationRequest } from "../../shared/types";

/** Local preservation is separate from Main's authoritative acceptance receipt. */
export type OneFollowupIntent = {
  intentId: string;
  chatId: string;
  userPrompt: string;
  createdAt: string;
  request: McpInvocationRequest;
  submissionId?: string;
  waitingParentRunId?: string;
  /** A new explicit roster needs fresh Main preflight authority, never inherited grants. */
  requiresReprepare?: boolean;
  /** Renderer roster choices for restoring a known-unsent draft, including One-only []. */
  agentIds?: string[];
  /** Stop pauses automatic delivery without changing the captured gesture. */
  autoDeliveryPaused?: boolean;
};
const PREFIX = "agentlas.one-followup-outbox.v1:";
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readOneFollowupOutbox(storage: StoragePort, chatId: string): OneFollowupIntent[] {
  const raw = storage.getItem(`${PREFIX}${chatId}`);
  if (!raw) return [];
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values)) throw new Error("one_followup_outbox_invalid");
  return values.map((value: OneFollowupIntent) => {
    if (!value || value.chatId !== chatId || typeof value.intentId !== "string"
      || typeof value.userPrompt !== "string" || typeof value.createdAt !== "string"
      || value.request?.chatId !== chatId || value.request?.userPrompt !== value.userPrompt) {
      throw new Error("one_followup_outbox_invalid");
    }
    return value;
  });
}

export function saveOneFollowupIntent(storage: StoragePort, intent: OneFollowupIntent): void {
  const items = readOneFollowupOutbox(storage, intent.chatId);
  const existing = items.find(item => item.intentId === intent.intentId);
  const identity = ({ autoDeliveryPaused: _paused, ...gesture }: OneFollowupIntent) => JSON.stringify(gesture);
  if (existing && identity(existing) !== identity(intent)) throw new Error("one_followup_identity_conflict");
  if (existing) return;
  if (items.length >= 64) throw new Error("one_followup_outbox_full");
  const serialized = JSON.stringify([...items, intent]);
  const key = `${PREFIX}${intent.chatId}`;
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) throw new Error("one_followup_not_persisted");
}

function writeOutbox(storage: StoragePort, chatId: string, items: OneFollowupIntent[]): void {
  const key = `${PREFIX}${chatId}`;
  const serialized = JSON.stringify(items);
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) throw new Error("one_followup_not_persisted");
}

/** Metadata only: never rewrite the identity or execution choices of an intent. */
export function pauseOneFollowupOutbox(storage: StoragePort, chatId: string): void {
  const items = readOneFollowupOutbox(storage, chatId);
  if (items.length) writeOutbox(storage, chatId, items.map(item => ({ ...item, autoDeliveryPaused: true })));
}

/** An explicit owner action resumes this same identity; it does not author a new message. */
export function resumeOneFollowupIntent(storage: StoragePort, chatId: string, intentId: string): void {
  const items = readOneFollowupOutbox(storage, chatId);
  if (!items.some(item => item.intentId === intentId)) throw new Error("one_followup_missing");
  writeOutbox(storage, chatId, items.map(item => item.intentId === intentId ? { ...item, autoDeliveryPaused: false } : item));
}

export function removeOneFollowupIntent(storage: StoragePort, chatId: string, intentId: string): void {
  const items = readOneFollowupOutbox(storage, chatId).filter(item => item.intentId !== intentId);
  const key = `${PREFIX}${chatId}`;
  const serialized = items.length ? JSON.stringify(items) : null;
  if (serialized) storage.setItem(key, serialized);
  else storage.removeItem(key);
  if (storage.getItem(key) !== serialized) throw new Error("one_followup_not_persisted");
}
