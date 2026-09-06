import type {
  ToolApprovalDecision,
  ToolApprovalDurableConsentReceipt,
  ToolApprovalRequestEvent,
  ToolApprovalResolutionReceipt,
} from "./types";

/**
 * A decision action is deterministic for the exact runtime request and choice.
 * Retrying the same UI intent therefore cannot accidentally become a new action.
 */
export function toolApprovalActionId(
  requestId: string,
  decision: ToolApprovalDecision,
): string {
  return `tool-approval-action:v1:${requestId}:${decision}`;
}

export function isToolApprovalResolutionReceipt(
  value: unknown,
): value is ToolApprovalResolutionReceipt {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ToolApprovalResolutionReceipt>;
  return (
    typeof row.ok === "boolean"
    && row.receiptVersion === 1
    && typeof row.requestId === "string"
    && (row.requestedDecision === null || isToolApprovalDecision(row.requestedDecision))
    && (row.resolvedDecision === null || isToolApprovalDecision(row.resolvedDecision))
    && (row.actionId === null || typeof row.actionId === "string")
    && ["resolved", "replayed", "pending", "expired", "conflict", "not_found", "invalid_action"].includes(String(row.status))
    && typeof row.pending === "boolean"
    && (row.decidedAt === null || typeof row.decidedAt === "string")
    && (row.durableConsent === undefined || isToolApprovalDurableConsentReceipt(row.durableConsent))
  );
}

function isToolApprovalDurableConsentReceipt(
  value: unknown,
): value is ToolApprovalDurableConsentReceipt {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ToolApprovalDurableConsentReceipt>;
  return (row.status === "persisted" || row.status === "failed" || row.status === "unavailable")
    && (row.code === undefined
      || row.code === "missing-binding"
      || row.code === "missing-persister"
      || row.code === "storage-failure"
      || row.code === "storage-receipt-missing");
}

function isToolApprovalDecision(value: unknown): value is ToolApprovalDecision {
  return value === "allow_once"
    || value === "allow_session"
    || value === "allow_always"
    || value === "deny";
}

export interface ToolApprovalDecisionApi {
  resolveToolApproval: (
    id: string,
    decision: ToolApprovalDecision,
    actionId: string,
  ) => Promise<unknown>;
  getToolApprovalResolution: (id: string) => Promise<unknown>;
  listToolApprovals: () => Promise<ToolApprovalRequestEvent[]>;
}

export type ToolApprovalDecisionResult =
  | { state: "resolved"; receipt: ToolApprovalResolutionReceipt }
  | { state: "pending"; receipt: ToolApprovalResolutionReceipt | null }
  | { state: "terminal"; receipt: ToolApprovalResolutionReceipt }
  | { state: "unknown"; receipt: ToolApprovalResolutionReceipt | null };

function exactResolution(
  receipt: ToolApprovalResolutionReceipt,
  requestId: string,
  decision: ToolApprovalDecision,
  actionId: string,
): boolean {
  return receipt.ok === true
    && receipt.requestId === requestId
    && receipt.resolvedDecision === decision
    && receipt.actionId === actionId
    && (receipt.status === "resolved" || receipt.status === "replayed")
    && receipt.pending === false
    && typeof receipt.decidedAt === "string";
}

function terminalResolution(
  receipt: ToolApprovalResolutionReceipt,
  requestId: string,
): boolean {
  return receipt.requestId === requestId
    && receipt.pending === false
    && (receipt.status === "expired" || receipt.status === "conflict");
}

/**
 * Re-read Main's exact ledger and live queue. This never resends the decision.
 * A missing card without an exact ledger row is outcome_unknown, not success.
 */
export async function reconcileToolApprovalDecision(
  api: ToolApprovalDecisionApi,
  requestId: string,
  decision: ToolApprovalDecision,
  actionId = toolApprovalActionId(requestId, decision),
): Promise<ToolApprovalDecisionResult> {
  let first: ToolApprovalResolutionReceipt | null = null;
  try {
    const value = await api.getToolApprovalResolution(requestId);
    first = isToolApprovalResolutionReceipt(value) ? value : null;
    if (first && exactResolution(first, requestId, decision, actionId)) {
      return { state: "resolved", receipt: first };
    }
    if (first && terminalResolution(first, requestId)) {
      return { state: "terminal", receipt: first };
    }
  } catch {
    // The pending-list read below is a separate authoritative projection.
  }

  let stillPending = false;
  try {
    const pending = await api.listToolApprovals();
    stillPending = Array.isArray(pending) && pending.some((item) => (
      item?.id === requestId && item.mode === "live"
    ));
    if (stillPending) return { state: "pending", receipt: first };
  } catch {
    return { state: "unknown", receipt: first };
  }

  // The request can time out between the first ledger read and pending read.
  // Read the ledger once more before declaring the terminal outcome unknown.
  try {
    const value = await api.getToolApprovalResolution(requestId);
    const second = isToolApprovalResolutionReceipt(value) ? value : null;
    if (second && exactResolution(second, requestId, decision, actionId)) {
      return { state: "resolved", receipt: second };
    }
    if (second && terminalResolution(second, requestId)) {
      return { state: "terminal", receipt: second };
    }
    return { state: "unknown", receipt: second ?? first };
  } catch {
    return { state: "unknown", receipt: first };
  }
}

/**
 * Submit once, then reconcile rather than blindly sending again whenever the
 * mutation receipt is false, malformed, rejected, or lost in transport.
 */
export async function commitToolApprovalDecision(
  api: ToolApprovalDecisionApi,
  requestId: string,
  decision: ToolApprovalDecision,
): Promise<ToolApprovalDecisionResult> {
  const actionId = toolApprovalActionId(requestId, decision);
  try {
    const value = await api.resolveToolApproval(requestId, decision, actionId);
    if (isToolApprovalResolutionReceipt(value)) {
      if (exactResolution(value, requestId, decision, actionId)) {
        return { state: "resolved", receipt: value };
      }
      if (terminalResolution(value, requestId)) {
        return { state: "terminal", receipt: value };
      }
    }
  } catch {
    // The runtime may have applied the decision before the IPC response was lost.
  }
  return reconcileToolApprovalDecision(api, requestId, decision, actionId);
}
