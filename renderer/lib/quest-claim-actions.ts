import type { QuestClaimResult } from "@shared/types";

const CLAIM_INTENT_RE = /^questclaim_[A-Za-z0-9_-]{16,120}$/u;
const STORAGE_PREFIX = "agentlas.quest-claim-intent.v1:";

function storageKey(workspaceId: string, questId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(workspaceId)}:${encodeURIComponent(questId)}`;
}

function randomClaimIntent(): string | null {
  try {
    const random = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replaceAll("-", "")
      : Array.from(
          crypto.getRandomValues(new Uint8Array(18)),
          (value) => value.toString(16).padStart(2, "0"),
        ).join("");
    const intent = `questclaim_${random}`;
    return CLAIM_INTENT_RE.test(intent) ? intent : null;
  } catch {
    return null;
  }
}

export function storedQuestClaimIntent(workspaceId: string, questId: string): string | null {
  if (!workspaceId.trim() || !questId.trim()) return null;
  try {
    const value = window.localStorage.getItem(storageKey(workspaceId, questId));
    return value && CLAIM_INTENT_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** A reward mutation cannot start unless its stable action identity is durable. */
export function getOrCreateQuestClaimIntent(workspaceId: string, questId: string): string | null {
  const existing = storedQuestClaimIntent(workspaceId, questId);
  if (existing) return existing;
  const intent = randomClaimIntent();
  if (!intent) return null;
  try {
    const key = storageKey(workspaceId, questId);
    window.localStorage.setItem(key, intent);
    return window.localStorage.getItem(key) === intent ? intent : null;
  } catch {
    return null;
  }
}

export function clearQuestClaimIntent(
  workspaceId: string,
  questId: string,
  expectedIntent: string,
): void {
  try {
    const key = storageKey(workspaceId, questId);
    if (window.localStorage.getItem(key) === expectedIntent) window.localStorage.removeItem(key);
  } catch {
    // Retaining a completed intent is safe: its next use only replays the same
    // exact server ledger entry and cannot pay the quest twice.
  }
}

export function exactCompletedQuestClaim(
  result: QuestClaimResult,
  questId: string,
  claimIntentId: string,
): result is QuestClaimResult & {
  ok: true;
  receiptVersion: 1;
  status: "completed";
  rewardCredits: number;
  claimedAt: string;
  replayed: boolean;
} {
  return result.ok === true
    && result.receiptVersion === 1
    && result.status === "completed"
    && result.questId === questId
    && result.claimIntentId === claimIntentId
    && Number.isSafeInteger(result.rewardCredits)
    && (result.rewardCredits ?? 0) > 0
    && typeof result.claimedAt === "string"
    && Number.isFinite(Date.parse(result.claimedAt))
    && typeof result.replayed === "boolean";
}
