import type { InvocationCurrentTurnSteerReceipt, InvocationCurrentTurnSteerRequest } from "../../shared/types";
import type { InvocationRunOwner } from "../store/invocation-owner-core";

type MaybePromise<T> = T | Promise<T>;
export interface InvocationCurrentTurnPort {
  currentTurn(chatId: string): MaybePromise<{ runId: string } | null>;
  steerCurrentTurn(input: InvocationCurrentTurnSteerRequest): MaybePromise<InvocationCurrentTurnSteerReceipt>;
  currentTurnSteerReceipt(chatId: string, intentId: string): MaybePromise<InvocationCurrentTurnSteerReceipt | null>;
}
export type InvocationOwnerControlMethod = "invoke.currentTurn" | "invoke.steerCurrentTurn" | "invoke.currentTurnSteerReceipt";

export interface InvocationOwnerRouterPorts {
  owners: {
    getActiveOwner(chatId: string): MaybePromise<InvocationRunOwner | null>;
    getRunOwner(chatId: string, runId: string): MaybePromise<InvocationRunOwner | null>;
  };
  inbox: {
    validateCurrentTurnSteer(input: InvocationCurrentTurnSteerRequest): void;
    existingCurrentTurnSteer(input: InvocationCurrentTurnSteerRequest): MaybePromise<InvocationCurrentTurnSteerReceipt | null>;
    getCurrentTurnSteer(chatId: string, intentId: string): MaybePromise<InvocationCurrentTurnSteerReceipt | null>;
  };
  localOwnerId: string;
  local: InvocationCurrentTurnPort;
  remote: {
    dispatch(owner: InvocationRunOwner, method: InvocationOwnerControlMethod,
      params: { chatId: string } | InvocationCurrentTurnSteerRequest | { chatId: string; intentId: string }): MaybePromise<unknown>;
  };
}

export function invocationOwnerUnavailable(): Error & { code: "invocation_owner_unavailable" } {
  return Object.assign(new Error("invocation_owner_unavailable"), { code: "invocation_owner_unavailable" as const });
}

function assertLookup(chatId: string, intentId?: string): void {
  if (typeof chatId !== "string" || !chatId.trim() || chatId.length > 256 || /[\u0000-\u001f]/.test(chatId)
    || (intentId !== undefined && (typeof intentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(intentId)))) {
    throw Object.assign(new Error("invocation_current_turn_steer_invalid"), { code: "invocation_current_turn_steer_invalid" });
  }
}

function assertOwner(owner: InvocationRunOwner | null, chatId: string, runId?: string): InvocationRunOwner {
  if (!owner || owner.chatId !== chatId || (runId !== undefined && owner.runId !== runId)
    || !owner.ownerId || !owner.leaseId || (owner.state !== "active" && owner.state !== "settling")) {
    throw invocationOwnerUnavailable();
  }
  return owner;
}

function checkedReceipt(value: unknown, chatId: string, intentId: string, runId?: string): InvocationCurrentTurnSteerReceipt {
  const row = value as InvocationCurrentTurnSteerReceipt | null;
  if (!row || row.chatId !== chatId || row.intentId !== intentId || typeof row.runId !== "string" || !row.runId
    || (runId !== undefined && row.runId !== runId) || typeof row.messageId !== "string" || !row.messageId
    || typeof row.promptHash !== "string" || !/^[a-f0-9]{64}$/.test(row.promptHash)
    || !["queued", "dispatching", "applied", "rejected", "uncertain"].includes(row.status)
    || (row.code !== undefined && typeof row.code !== "string")) throw invocationOwnerUnavailable();
  return { chatId: row.chatId, intentId: row.intentId, runId: row.runId,
    messageId: row.messageId, promptHash: row.promptHash, status: row.status,
    ...(row.code !== undefined ? { code: row.code } : {}) };
}

/** Routing never claims a mailbox item or invents another execution owner.
 * Only the exact leased owner may reconcile pending receipts. */
export function createInvocationOwnerRouter(ports: InvocationOwnerRouterPorts): InvocationCurrentTurnPort {
  if (!ports.localOwnerId) throw invocationOwnerUnavailable();
  async function dispatch(owner: InvocationRunOwner, method: InvocationOwnerControlMethod,
    params: Parameters<InvocationOwnerRouterPorts["remote"]["dispatch"]>[2]): Promise<unknown> {
    try { return await ports.remote.dispatch(owner, method, params); }
    catch { throw invocationOwnerUnavailable(); }
  }
  async function pendingReceipt(row: InvocationCurrentTurnSteerReceipt): Promise<InvocationCurrentTurnSteerReceipt> {
    if (row.status === "applied" || row.status === "rejected" || row.status === "uncertain") return row;
    const owner = assertOwner(await ports.owners.getRunOwner(row.chatId, row.runId), row.chatId, row.runId);
    const receipt = owner.ownerId === ports.localOwnerId
      ? await ports.local.currentTurnSteerReceipt(row.chatId, row.intentId)
      : await dispatch(owner, "invoke.currentTurnSteerReceipt", { chatId: row.chatId, intentId: row.intentId });
    return checkedReceipt(receipt, row.chatId, row.intentId, row.runId);
  }
  return {
    async currentTurn(chatId) {
      assertLookup(chatId);
      const found = await ports.owners.getActiveOwner(chatId);
      if (!found) return null;
      const owner = assertOwner(found, chatId);
      const current = owner.ownerId === ports.localOwnerId
        ? await ports.local.currentTurn(chatId)
        : await dispatch(owner, "invoke.currentTurn", { chatId });
      if (current === null) return null;
      if (!current || typeof current !== "object" || !("runId" in current) || current.runId !== owner.runId) {
        throw invocationOwnerUnavailable();
      }
      return { runId: owner.runId };
    },
    async steerCurrentTurn(input) {
      ports.inbox.validateCurrentTurnSteer(input);
      if (Object.keys(input).some(key => !["chatId", "intentId", "expectedRunId", "text"].includes(key))) {
        throw Object.assign(new Error("invocation_current_turn_steer_invalid"), { code: "invocation_current_turn_steer_invalid" });
      }
      assertLookup(input.chatId, input.intentId);
      const existing = await ports.inbox.existingCurrentTurnSteer(input);
      if (existing) return pendingReceipt(checkedReceipt(existing, input.chatId, input.intentId, input.expectedRunId));
      const owner = assertOwner(await ports.owners.getActiveOwner(input.chatId), input.chatId, input.expectedRunId);
      const receipt = owner.ownerId === ports.localOwnerId
        ? await ports.local.steerCurrentTurn(input)
        : await dispatch(owner, "invoke.steerCurrentTurn", input);
      return checkedReceipt(receipt, input.chatId, input.intentId, input.expectedRunId);
    },
    async currentTurnSteerReceipt(chatId, intentId) {
      assertLookup(chatId, intentId);
      const row = await ports.inbox.getCurrentTurnSteer(chatId, intentId);
      return row ? pendingReceipt(checkedReceipt(row, chatId, intentId)) : null;
    },
  };
}
