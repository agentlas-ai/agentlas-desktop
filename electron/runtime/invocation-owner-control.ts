import { invocationService } from "../invocation/service";
import { invocationProcessOwner, invocationRunOwners } from "../store/invocation-run-owners";
import { existingCurrentTurnSteer, getCurrentTurnSteer, validateCurrentTurnSteer } from "../store/current-turn-steers";
import { createInvocationOwnerRouter, invocationOwnerUnavailable } from "./invocation-owner-router";
import type { InvocationRunOwner } from "../store/invocation-owner-core";
import type { InvocationOwnerBrokerMethod } from "../daemon/invocation-owner-broker";
import type { InvocationOwnerControlRequest } from "../daemon/invocation-owner-client";

let remoteDispatch: ((owner: InvocationRunOwner, method: InvocationOwnerBrokerMethod, params: unknown) => Promise<unknown>) | null = null;

export function configureInvocationOwnerTransport(dispatch: NonNullable<typeof remoteDispatch>): void {
  remoteDispatch = dispatch;
}

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

function router() {
  return createInvocationOwnerRouter({ owners: invocationRunOwners, localOwnerId: invocationProcessOwner().ownerId,
    inbox: { existingCurrentTurnSteer, getCurrentTurnSteer, validateCurrentTurnSteer }, local: invocationService,
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
  if (input.method === "invoke.currentTurn") return invocationService.currentTurn(owner.chatId);
  if (input.method === "invoke.steerCurrentTurn") return invocationService.steerCurrentTurn(input.params as Parameters<typeof invocationService.steerCurrentTurn>[0]);
  if (input.method === "invoke.currentTurnSteerReceipt" && typeof params.intentId === "string") {
    const receipt = getCurrentTurnSteer(owner.chatId, params.intentId);
    if (receipt && receipt.runId !== owner.runId) throw invocationOwnerUnavailable();
    return invocationService.currentTurnSteerReceipt(owner.chatId, params.intentId);
  }
  throw new Error("invocation_owner_control_invalid");
}
