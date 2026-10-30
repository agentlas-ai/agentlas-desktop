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
  /** Once chosen, the harness run is fixed; a retry cannot become a new queued run. */
  currentTurnRunId?: string;
  /** A new explicit roster needs fresh Main preflight authority, never inherited grants. */
  requiresReprepare?: boolean;
  /** Renderer roster choices for restoring a known-unsent draft, including One-only []. */
  agentIds?: string[];
  /** Stop pauses automatic delivery without changing the captured gesture. */
  autoDeliveryPaused?: boolean;
  /** Only new current-turn captures opt into v2; absent means legacy delivery. */
  followupCustodyVersion?: 2;
  /** Saved before composer ownership is released. An ambiguous save never arms delivery. */
  capturePending?: boolean;
  /** Unchanged plain composer copy, used only when confirming an ambiguous capture. */
  composerText?: string;
  /** Main acknowledged intake, but exact message/resource custody is not yet proven. */
  deliveryObserved?: boolean;
};
const PREFIX = "agentlas.one-followup-outbox.v1:";
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** A transient read must not turn an otherwise preserved gesture into a failure.
 * Never retry a write: its result may already have been applied. */
function readStorageWithRetry(storage: StoragePort, key: string): string | null {
  try { return storage.getItem(key); } catch { return storage.getItem(key); }
}
/** Stage one explicitly identified composer gesture. Equality of text, model or
 * attachments never merges two independent owner actions. Recovery passes the
 * exact staged object back, retaining its existing intentId. */
export function bindOneFollowupCapture(_storage: StoragePort, intent: OneFollowupIntent): OneFollowupIntent {
  if (intent.followupCustodyVersion !== 2 || !intent.currentTurnRunId) throw new Error("one_followup_capture_version_required");
  return { ...JSON.parse(JSON.stringify(intent)) as OneFollowupIntent, capturePending: true };
}

function gestureKey({ autoDeliveryPaused: _paused, capturePending: _pending, deliveryObserved: _observed, ...gesture }: OneFollowupIntent): string {
  return JSON.stringify(gesture);
}

/** Only call after the unchanged composer copy has been released. Preserve a
 * Stop that arrived after capture by reading and changing only capture metadata. */
export function releaseOneFollowupCapture(storage: StoragePort, intent: OneFollowupIntent): OneFollowupIntent {
  const items = readOneFollowupOutbox(storage, intent.chatId);
  const saved = items.find(item => item.intentId === intent.intentId);
  if (!saved || gestureKey(saved) !== gestureKey(intent)) throw new Error("one_followup_identity_conflict");
  const released = { ...saved, capturePending: false };
  writeOutbox(storage, intent.chatId, items.map(item => item.intentId === intent.intentId ? released : item));
  return released;
}

/** The code of a text the running turn never took and Main carried WHOLE into the chat's next turn (carried-owner-followups.ts: the
 * rows are settled rejected / owner_control_next_turn in the transaction that persists that turn, which reuses the owner's message
 * row). The receipt says "rejected" for the running turn; the text is delivered, so there is nothing left for the owner to continue. */
export const FOLLOWUP_CARRIED_TO_NEXT_TURN_CODE = "owner_control_next_turn";

/** Acceptance alone does not prove the exact user row and attachments are durable. */
export function followupReceiptCanRetire(receipt: { receiptVersion?: number; status?: string; messageCustody?: string; messageId?: string; code?: string } | null | undefined): boolean {
  return receipt?.receiptVersion === 2 && receipt.messageCustody === "exact" && !!receipt.messageId
    && (receipt.status === "applied" || receipt.status === "started"
      || (receipt.status === "rejected" && receipt.code === FOLLOWUP_CARRIED_TO_NEXT_TURN_CODE));
}

/** A missing IPC reply must release the delivery coordinator. The original
 * request can still be accepted by Main, so callers retry its existing ID. */
export async function waitForOneFollowupDelivery<T>(pending: Promise<T>, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("one_followup_delivery_timeout")), timeoutMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function readOneFollowupOutbox(storage: StoragePort, chatId: string): OneFollowupIntent[] {
  const raw = readStorageWithRetry(storage, `${PREFIX}${chatId}`);
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
  const identity = ({ autoDeliveryPaused: _paused, capturePending: _pending, deliveryObserved: _observed, ...gesture }: OneFollowupIntent) => JSON.stringify(gesture);
  if (existing && identity(existing) !== identity(intent)) throw new Error("one_followup_identity_conflict");
  if (existing) return;
  if (items.length >= 64) throw new Error("one_followup_outbox_full");
  const serialized = JSON.stringify([...items, intent]);
  const key = `${PREFIX}${intent.chatId}`;
  storage.setItem(key, serialized);
  if (readStorageWithRetry(storage, key) !== serialized) throw new Error("one_followup_not_persisted");
}

function writeOutbox(storage: StoragePort, chatId: string, items: OneFollowupIntent[]): void {
  const key = `${PREFIX}${chatId}`;
  const serialized = JSON.stringify(items);
  storage.setItem(key, serialized);
  if (readStorageWithRetry(storage, key) !== serialized) throw new Error("one_followup_not_persisted");
}

/** Metadata only: never rewrite the identity or execution choices of an intent. */
export function pauseOneFollowupOutbox(storage: StoragePort, chatId: string): void {
  const items = readOneFollowupOutbox(storage, chatId);
  if (items.length) writeOutbox(storage, chatId, items.map(item => ({ ...item, autoDeliveryPaused: true })));
}

/** Stop automatic delivery of one intent (e.g. its run's owner is gone); the text stays for the owner. */
export function pauseOneFollowupIntent(storage: StoragePort, chatId: string, intentId: string): void {
  const items = readOneFollowupOutbox(storage, chatId);
  if (items.some(item => item.intentId === intentId && !item.autoDeliveryPaused)) {
    writeOutbox(storage, chatId, items.map(item => item.intentId === intentId ? { ...item, autoDeliveryPaused: true } : item));
  }
}

/** Stop automatic re-entry after an acknowledged intake without exact cleanup proof. */
export function observeOneFollowupIntent(storage: StoragePort, chatId: string, intentId: string): void {
  const items = readOneFollowupOutbox(storage, chatId);
  writeOutbox(storage, chatId, items.map(item => item.intentId === intentId
    ? { ...item, autoDeliveryPaused: true, deliveryObserved: true } : item));
}

/** An explicit owner action resumes this same identity; it does not author a new message. */
export function resumeOneFollowupIntent(storage: StoragePort, chatId: string, intentId: string): void {
  const items = readOneFollowupOutbox(storage, chatId);
  if (!items.some(item => item.intentId === intentId)) throw new Error("one_followup_missing");
  writeOutbox(storage, chatId, items.map(item => item.intentId === intentId ? { ...item, autoDeliveryPaused: false, ...(item.followupCustodyVersion === 2 ? { capturePending: false } : {}) } : item));
}

export function removeOneFollowupIntent(storage: StoragePort, chatId: string, intentId: string): void {
  const items = readOneFollowupOutbox(storage, chatId).filter(item => item.intentId !== intentId);
  const key = `${PREFIX}${chatId}`;
  const serialized = items.length ? JSON.stringify(items) : null;
  if (serialized) storage.setItem(key, serialized);
  else storage.removeItem(key);
  if (readStorageWithRetry(storage, key) !== serialized) throw new Error("one_followup_not_persisted");
}
