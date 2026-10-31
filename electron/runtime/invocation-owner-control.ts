import { invocationService } from "../invocation/service";
import { invocationProcessOwner, invocationRunOwners } from "../store/invocation-run-owners";
import { existingCurrentTurnSteer, getCurrentTurnSteer, settleCurrentTurnSteer, validateCurrentTurnSteer } from "../store/current-turn-steers";
import { createInvocationOwnerRouter, invocationOwnerUnavailable } from "./invocation-owner-router";
import type { InvocationRunOwner } from "../store/invocation-owner-core";
import type { InvocationOwnerBrokerMethod } from "../daemon/invocation-owner-broker";
import type { InvocationOwnerControlRequest } from "../daemon/invocation-owner-client";
import type { InvocationSteerResult, McpInvocationRequest } from "../../shared/types";
import { createHash } from "node:crypto";
import type { WorkSessionHostClaim } from "../work/session-host";

let remoteDispatch: ((owner: InvocationRunOwner, method: InvocationOwnerBrokerMethod, params: unknown) => Promise<unknown>) | null = null;

export function configureInvocationOwnerTransport(dispatch: NonNullable<typeof remoteDispatch>): void {
  remoteDispatch = dispatch;
}

/** Next-turn queue transport is distinct from steering text into a running turn.
 * Its request is constructed by a trusted host dispatcher, never a model tool's
 * JSON permission fields. The existing inbox owns durable identity/deduplication. */
export interface InvocationOwnerNextTurn {
  chatId: string;
  intentId: string;
  request: McpInvocationRequest;
}
export type InvocationOwnerNextTurnReceipt = InvocationSteerResult & { workSessionHost?: WorkSessionHostClaim };
export function validateInvocationOwnerNextTurn(value: unknown): InvocationOwnerNextTurn {
  const input = value as InvocationOwnerNextTurn | null;
  const request = input?.request;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["chatId", "intentId", "request"].includes(key))
    || typeof input.chatId !== "string" || !input.chatId || input.chatId.length > 256
    || typeof input.intentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.intentId)
    || !request || typeof request !== "object" || Array.isArray(request)
    || request.chatId !== input.chatId || request.runId !== undefined
    || typeof request.userPrompt !== "string" || !request.userPrompt.trim()
    || request.steeringMode !== "queue"
    || !["read", "write", "full"].includes(String(request.permissions))) throw invocationOwnerUnavailable();
  return input;
}
export function createInvocationOwnerNextTurnRouter(ports: {
  owner(chatId: string): InvocationRunOwner | null;
  localOwnerId(): string;
  localHost(): WorkSessionHostClaim;
  local: Pick<typeof invocationService, "steerFromOwner" | "ownerSteerReceipt">;
  remote(owner: InvocationRunOwner, input: InvocationOwnerNextTurn): Promise<unknown>;
}) {
  return async (request: McpInvocationRequest, intentId: string): Promise<InvocationOwnerNextTurnReceipt> => {
    const input = validateInvocationOwnerNextTurn({ chatId: request.chatId, intentId, request });
    // Shared-store read succeeds after a lost remote ACK even if the former
    // owner has since ended. Existing request comparison remains authoritative.
    const existing = ports.local.ownerSteerReceipt(request.chatId, intentId);
    const retained = existing ? ports.local.steerFromOwner(request, intentId) : undefined;
    const owner = ports.owner(request.chatId);
    if (retained && (!owner || owner.state === "released")) return retained;
    if (!owner || owner.state === "released" || owner.ownerId === ports.localOwnerId()) {
      if (retained) return { ...retained, ...(retained.activeRunId === owner!.runId || retained.runId === owner!.runId
        ? { workSessionHost: ports.localHost() } : {}) };
      return { ...ports.local.steerFromOwner(request, intentId), workSessionHost: ports.localHost() };
    }
    if (owner.chatId !== request.chatId || (owner.state !== "active" && owner.state !== "settling")) throw invocationOwnerUnavailable();
    const receipt = await ports.remote(owner, input) as InvocationOwnerNextTurnReceipt | null;
    if (!receipt || receipt.accepted !== true || receipt.chatId !== request.chatId || receipt.intentId !== intentId
      || receipt.interruptsCurrent !== false || receipt.promptHash !== createHash("sha256").update(request.userPrompt).digest("hex")
      || !["queued", "draining", "started", "failed", "cancelled", "held"].includes(String(receipt.status))
      || (!retained && !receipt.workSessionHost)
      || (receipt.workSessionHost && (receipt.workSessionHost.ownerId !== owner.ownerId || receipt.workSessionHost.ownerKind !== owner.ownerKind
        || !Number.isSafeInteger(receipt.workSessionHost.pid) || receipt.workSessionHost.pid <= 0))) throw invocationOwnerUnavailable();
    return receipt;
  };
}
export const steerInvocationOwnerNextTurn = createInvocationOwnerNextTurnRouter({
  owner: chatId => invocationRunOwners.getActiveOwner(chatId), localOwnerId: () => invocationProcessOwner().ownerId,
  localHost: () => ({ ...invocationProcessOwner(), pid: process.pid }),
  local: invocationService,
  remote: (owner, input) => {
    if (!remoteDispatch) throw invocationOwnerUnavailable();
    return remoteDispatch(owner, "invoke.ownerSteer", input);
  },
});

/** Shared client ingress; it never reconciles another process's pending row. */
export const invocationCurrentTurnControl = {
  currentTurn: (chatId: string) => router().currentTurn(chatId),
  steerCurrentTurn: (input: Parameters<typeof invocationService.steerCurrentTurn>[0]) => router().steerCurrentTurn(input),
  currentTurnSteerReceipt: (chatId: string, intentId: string) => router().currentTurnSteerReceipt(chatId, intentId),
};

export async function cancelInvocationOwnerRun(runId: string): Promise<"requested" | "already-requested" | "not-found"> {
  const local = invocationService.cancel(runId);
  if (local !== "not-found") return local;
  const owner = invocationRunOwners.getOwnerByRunId(runId);
  if (!owner || owner.ownerId === invocationProcessOwner().ownerId) return "not-found";
  if (owner.state === "released" || !remoteDispatch) throw invocationOwnerUnavailable();
  const result = await remoteDispatch(owner, "invoke.cancel", { chatId: owner.chatId, runId });
  if (result === "requested" || result === "already-requested" || result === "not-found") return result;
  if (result && typeof result === "object" && "runId" in result && result.runId === runId
    && "status" in result && (result.status === "requested" || result.status === "already-requested")) return result.status;
  throw invocationOwnerUnavailable();
}

/** The control names a Goal this chat no longer runs, so the turn there is not its to stop. */
const GOAL_CONTROL_REFUSALS = new Set(["goal_control_binding_changed", "goal_control_scope_mismatch", "goal_control_not_started"]);

/**
 * A Goal's Stop reaches the turn wherever it runs: stopGoal only sees the runs in this process's memory, so a turn the background service
 * held kept working under a Goal that read paused. The owner row is read before the stop, so a turn started after it is never touched.
 */
export function createGoalStopRouter(ports: {
  otherHostOwner(chatId: string): InvocationRunOwner | null;
  stop(chatId: string, goalId: string, action: "pause" | "delete"): void;
  deliver(owner: InvocationRunOwner): void;
}) {
  return (chatId: string, goalId: string, action: "pause" | "delete"): void => {
    let other: InvocationRunOwner | null = null;
    try { other = ports.otherHostOwner(chatId); } catch { /* The local stop never waits on this read. */ }
    try { ports.stop(chatId, goalId, action); }
    catch (error) {
      if (other && !(error instanceof Error && GOAL_CONTROL_REFUSALS.has(error.message))) ports.deliver(other);
      throw error;
    }
    if (other) ports.deliver(other);
  };
}

/** Bounded and never throws: the Goal is already stopped in the ledger, so a cancel that cannot land only lets that one turn end by itself. */
export async function deliverGoalStop(owner: InvocationRunOwner, ports: {
  current(owner: InvocationRunOwner): InvocationRunOwner | null;
  dispatch(owner: InvocationRunOwner, params: { chatId: string; runId: string }): Promise<unknown>;
  wait(ms: number): Promise<void>;
}): Promise<void> {
  for (const delayMs of [0, 500, 2_000]) {
    if (delayMs) await ports.wait(delayMs);
    try {
      const current = ports.current(owner);
      // Another lease is a newer turn; a released one has ended.
      if (!current || current.leaseId !== owner.leaseId || current.state === "released") return;
      await ports.dispatch(current, { chatId: owner.chatId, runId: owner.runId });
      return;
    } catch { /* The next attempt reads the owner again. */ }
  }
  console.warn("[invocation] a Goal stop did not reach the other host", { chatId: owner.chatId, runId: owner.runId, ownerKind: owner.ownerKind });
}

export const stopInvocationGoal = createGoalStopRouter({
  otherHostOwner: (chatId) => {
    const owner = invocationRunOwners.getActiveOwner(chatId);
    return owner && owner.ownerId !== invocationProcessOwner().ownerId && (owner.state === "active" || owner.state === "settling") ? owner : null;
  },
  stop: (chatId, goalId, action) => { if (action === "pause") invocationService.pauseGoal(chatId, goalId); else invocationService.deleteGoal(chatId, goalId); },
  deliver: (owner) => { void deliverGoalStop(owner, {
    current: (expected) => invocationRunOwners.getRunOwner(expected.chatId, expected.runId),
    dispatch: (target, params) => {
      if (!remoteDispatch) throw invocationOwnerUnavailable();
      return remoteDispatch(target, "invoke.cancel", params);
    },
    wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
  }); },
});

function router() {
  return createInvocationOwnerRouter({ owners: invocationRunOwners, localOwnerId: invocationProcessOwner().ownerId,
    inbox: { existingCurrentTurnSteer, getCurrentTurnSteer, validateCurrentTurnSteer, settleCurrentTurnSteer }, local: invocationService,
    remote: { dispatch: (owner, method, params) => {
      if (!remoteDispatch) throw invocationOwnerUnavailable();
      return remoteDispatch(owner, method, params);
    } } });
}

/** Exact peer-to-owner callback. This process alone has the AbortController
 * and native brain handles; the broker transports only typed directions. */
export function handleInvocationOwnerControl(input: InvocationOwnerControlRequest): unknown {
  if (input.method === "invoke.cancel") {
    const live = invocationService.liveRunOwner(input.runId);
    const params = input.params as { chatId?: unknown; runId?: unknown } | null;
    if (!live || input.ownerId !== invocationProcessOwner().ownerId || input.ownerId !== live.ownerId
      || input.leaseId !== live.leaseId || input.chatId !== live.chatId
      || params?.chatId !== live.chatId || params.runId !== live.runId) throw invocationOwnerUnavailable();
    return invocationService.cancel(live.runId);
  }
  const owner = invocationRunOwners.getRunOwner(input.chatId, input.runId);
  if (!owner || owner.ownerId !== invocationProcessOwner().ownerId || owner.ownerId !== input.ownerId
    || owner.leaseId !== input.leaseId || (owner.state !== "active" && owner.state !== "settling")) {
    throw invocationOwnerUnavailable();
  }
  const params = input.params as { chatId?: unknown; expectedRunId?: unknown; intentId?: unknown; runId?: unknown } | null;
  if (!params || params.chatId !== owner.chatId || (params.expectedRunId !== undefined && params.expectedRunId !== owner.runId)) {
    throw invocationOwnerUnavailable();
  }
  if (input.method === "invoke.ownerSteer") {
    const next = validateInvocationOwnerNextTurn(input.params);
    const receipt = invocationService.steerFromOwner(next.request, next.intentId);
    return { ...receipt, ...(receipt.activeRunId === owner.runId || receipt.runId === owner.runId
      ? { workSessionHost: { ...invocationProcessOwner(), pid: process.pid } } : {}) } satisfies InvocationOwnerNextTurnReceipt;
  }
  if (input.method === "invoke.currentTurn") return invocationService.currentTurn(owner.chatId);
  if (input.method === "invoke.steerCurrentTurn") return invocationService.steerCurrentTurn(input.params as Parameters<typeof invocationService.steerCurrentTurn>[0]);
  if (input.method === "invoke.currentTurnSteerReceipt" && typeof params.intentId === "string") {
    const receipt = getCurrentTurnSteer(owner.chatId, params.intentId);
    if (receipt && receipt.runId !== owner.runId) throw invocationOwnerUnavailable();
    return invocationService.currentTurnSteerReceipt(owner.chatId, params.intentId);
  }
  throw new Error("invocation_owner_control_invalid");
}
