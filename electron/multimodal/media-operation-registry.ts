import { createHash } from "node:crypto";
import {
  mediaRecoveryDecision,
  type MediaCancellationState,
  type MediaOperationIntent,
  type MediaOperationRecord,
  type MediaOperationResult,
  type MediaProviderCapabilities,
  type MediaRecoveryDecision,
} from "../../shared/media-operation";
import {
  createMediaOperationIntent,
  getMediaOperation,
  listRecoverableMediaOperations,
  patchMediaOperation,
} from "../store/media-operations";

export interface MediaProviderObservation {
  state: "pending" | "succeeded" | "failed" | "cancelled" | "not_found";
  providerStatus: string;
  providerOperationId?: string;
  providerCheckpoint?: unknown;
  failureCode?: string;
  failureMessage?: string;
}

export interface MediaProviderRecoveryAdapter {
  providerId: string;
  lookupByOperationId?: (providerOperationId: string) => Promise<MediaProviderObservation>;
  lookupByClientRequestKey?: (clientRequestKey: string) => Promise<MediaProviderObservation>;
  cancel?: (providerOperationId: string) => Promise<"confirmed" | "unconfirmed">;
}

export interface MediaReconciliationReceipt {
  operationId: string;
  decision: MediaRecoveryDecision | "cancel_provider" | "cancel_local_only";
  status: "unchanged" | "updated" | "deferred";
  operation: MediaOperationRecord;
}

const CURRENT_VIDEO_ADAPTER_CAPABILITIES: Record<string, MediaProviderCapabilities> = {
  runway: { submitRecovery: "none", statusLookup: "provider_operation_id", cancellation: "local_only" },
  luma: { submitRecovery: "none", statusLookup: "provider_operation_id", cancellation: "local_only" },
  veo: { submitRecovery: "none", statusLookup: "provider_operation_id", cancellation: "local_only" },
  seedance: { submitRecovery: "none", statusLookup: "provider_operation_id", cancellation: "local_only" },
  kling: { submitRecovery: "none", statusLookup: "provider_operation_id", cancellation: "local_only" },
  grok: { submitRecovery: "none", statusLookup: "none", cancellation: "local_only" },
};

export function currentVideoAdapterCapabilities(providerId: string): MediaProviderCapabilities {
  const capabilities = CURRENT_VIDEO_ADAPTER_CAPABILITIES[providerId];
  if (!capabilities) throw new Error("media_provider_unsupported");
  return { ...capabilities };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("media_input_non_finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("media_input_not_json");
}

export function mediaInputDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function registerMediaOperation(input: MediaOperationIntent): MediaOperationRecord {
  return createMediaOperationIntent(input);
}

function update(id: string, patch: Parameters<typeof patchMediaOperation>[0]["patch"], reasonCode: string, detail?: unknown): MediaOperationRecord {
  const current = getMediaOperation(id);
  if (!current) throw new Error("media_operation_not_found");
  return patchMediaOperation({ id, expectedVersion: current.version, patch, reasonCode, detail });
}

export function markMediaSubmitting(id: string): MediaOperationRecord {
  return update(id, { lifecycle: "submitting" }, "submit_started");
}

export function recordMediaProviderAccepted(input: {
  id: string;
  providerOperationId: string;
  providerCheckpoint?: unknown;
  providerStatus?: string;
}): MediaOperationRecord {
  return update(input.id, {
    lifecycle: "provider_accepted",
    providerOperationId: input.providerOperationId,
    providerCheckpoint: input.providerCheckpoint ?? null,
    providerStatus: input.providerStatus ?? "accepted",
  }, "provider_accepted");
}

export function recordMediaProviderProgress(input: {
  id: string;
  providerStatus: string;
  providerCheckpoint?: unknown;
}): MediaOperationRecord {
  return update(input.id, {
    lifecycle: "running",
    providerStatus: input.providerStatus,
    ...(input.providerCheckpoint === undefined ? {} : { providerCheckpoint: input.providerCheckpoint }),
    incrementPollAttempts: true,
  }, "provider_progress");
}

export function recordMediaVerifying(id: string, providerCheckpoint?: unknown): MediaOperationRecord {
  return update(id, {
    lifecycle: "verifying",
    ...(providerCheckpoint === undefined ? {} : { providerCheckpoint }),
  }, "output_verification_started");
}

export function recordMediaSucceeded(id: string, result: MediaOperationResult): MediaOperationRecord {
  return update(id, { lifecycle: "succeeded", result, providerStatus: "succeeded" }, "output_verified");
}

export function recordMediaFailed(id: string, failureCode: string, failureMessage: string): MediaOperationRecord {
  const current = getMediaOperation(id);
  if (!current) throw new Error("media_operation_not_found");
  if (current.lifecycle === "succeeded" || current.lifecycle === "failed") return current;
  return patchMediaOperation({ id, expectedVersion: current.version, patch: {
    lifecycle: "failed", failureCode, failureMessage,
  }, reasonCode: "operation_failed", detail: { failureCode } });
}

export function recordMediaOutcomeUnknown(id: string, failureMessage: string): MediaOperationRecord {
  const current = getMediaOperation(id);
  if (!current) throw new Error("media_operation_not_found");
  if (current.lifecycle === "outcome_unknown") return current;
  if (!["submitting", "provider_accepted", "running"].includes(current.lifecycle)) {
    throw new Error(`media_operation_transition_invalid:${current.lifecycle}:outcome_unknown`);
  }
  return patchMediaOperation({ id, expectedVersion: current.version, patch: {
    lifecycle: "outcome_unknown", failureCode: "submit_outcome_unknown", failureMessage,
  }, reasonCode: "submit_outcome_quarantined" });
}

export function requestMediaCancellation(id: string): MediaOperationRecord {
  const current = getMediaOperation(id);
  if (!current) throw new Error("media_operation_not_found");
  if (current.lifecycle === "succeeded" || current.lifecycle === "failed") return current;
  if (current.cancellation !== "none") return current;
  const now = new Date().toISOString();
  if (current.lifecycle === "submit_intent") {
    return patchMediaOperation({ id, expectedVersion: current.version, patch: {
      lifecycle: "failed", cancellation: "confirmed", cancelRequestedAt: now,
      cancelConfirmedAt: now, failureCode: "cancelled_before_submit", failureMessage: "Cancelled before provider submission.",
    }, reasonCode: "cancelled_before_submit" });
  }
  return patchMediaOperation({ id, expectedVersion: current.version, patch: {
    cancellation: "requested", cancelRequestedAt: now,
  }, reasonCode: "cancellation_requested" });
}

export function settleMediaCancellation(id: string, cancellation: Extract<MediaCancellationState, "confirmed" | "unconfirmed">): MediaOperationRecord {
  const current = getMediaOperation(id);
  if (!current) throw new Error("media_operation_not_found");
  if (current.cancellation === cancellation || current.cancellation === "confirmed") return current;
  return patchMediaOperation({ id, expectedVersion: current.version, patch: {
    cancellation,
    ...(cancellation === "confirmed" ? { cancelConfirmedAt: new Date().toISOString() } : {}),
  }, reasonCode: cancellation === "confirmed" ? "cancellation_confirmed" : "cancellation_unconfirmed" });
}

function applyObservation(operation: MediaOperationRecord, observation: MediaProviderObservation): MediaOperationRecord {
  if (observation.state === "pending") {
    if (!operation.providerOperationId && !observation.providerOperationId) {
      return patchMediaOperation({ id: operation.id, expectedVersion: operation.version, patch: {
        lifecycle: "outcome_unknown", providerStatus: observation.providerStatus,
        failureCode: "provider_identity_missing", failureMessage: "Client request lookup found work without a recoverable provider operation id.",
        incrementPollAttempts: true,
      }, reasonCode: "provider_identity_missing" });
    }
    return patchMediaOperation({ id: operation.id, expectedVersion: operation.version, patch: {
      lifecycle: operation.providerOperationId ? "running" : "provider_accepted",
      ...(observation.providerOperationId ? { providerOperationId: observation.providerOperationId } : {}),
      providerStatus: observation.providerStatus,
      ...(observation.providerCheckpoint === undefined ? {} : { providerCheckpoint: observation.providerCheckpoint }),
      incrementPollAttempts: true,
    }, reasonCode: "provider_reconciled_running" });
  }
  if (observation.state === "succeeded") {
    return patchMediaOperation({ id: operation.id, expectedVersion: operation.version, patch: {
      lifecycle: "verifying", providerStatus: observation.providerStatus,
      ...(observation.providerCheckpoint === undefined ? {} : { providerCheckpoint: observation.providerCheckpoint }),
      incrementPollAttempts: true,
    }, reasonCode: "provider_reconciled_complete" });
  }
  if (observation.state === "cancelled") {
    return patchMediaOperation({ id: operation.id, expectedVersion: operation.version, patch: {
      lifecycle: "failed", cancellation: "confirmed", cancelConfirmedAt: new Date().toISOString(),
      providerStatus: observation.providerStatus, failureCode: "provider_cancelled", failureMessage: "The provider confirmed cancellation.",
      incrementPollAttempts: true,
    }, reasonCode: "provider_reconciled_cancelled" });
  }
  if (observation.state === "failed") {
    return patchMediaOperation({ id: operation.id, expectedVersion: operation.version, patch: {
      lifecycle: "failed", providerStatus: observation.providerStatus,
      failureCode: observation.failureCode ?? "provider_failed",
      failureMessage: observation.failureMessage ?? "The provider reported a failed media operation.",
      incrementPollAttempts: true,
    }, reasonCode: "provider_reconciled_failed" });
  }
  return patchMediaOperation({ id: operation.id, expectedVersion: operation.version, patch: {
    lifecycle: "outcome_unknown", providerStatus: observation.providerStatus,
    failureCode: "provider_operation_not_found", failureMessage: "The provider could not find the operation; it was not resubmitted.",
    incrementPollAttempts: true,
  }, reasonCode: "provider_reconciled_not_found" });
}

export async function reconcileMediaOperation(operationId: string, adapter?: MediaProviderRecoveryAdapter): Promise<MediaReconciliationReceipt> {
  let operation = getMediaOperation(operationId);
  if (!operation) throw new Error("media_operation_not_found");
  if (operation.cancellation === "requested") {
    if (operation.capabilities.cancellation === "provider" && operation.providerOperationId && adapter?.cancel) {
      const cancellation = await adapter.cancel(operation.providerOperationId);
      operation = settleMediaCancellation(operation.id, cancellation);
      return { operationId, decision: "cancel_provider", status: "updated", operation };
    }
    operation = settleMediaCancellation(operation.id, "unconfirmed");
    return { operationId, decision: "cancel_local_only", status: "updated", operation };
  }
  const decision = mediaRecoveryDecision(operation);
  if (decision === "resume_unsubmitted_intent") return { operationId, decision, status: "deferred", operation };
  if (decision === "quarantine_outcome_unknown") {
    operation = patchMediaOperation({ id: operation.id, expectedVersion: operation.version, patch: {
      lifecycle: "outcome_unknown", failureCode: "submit_outcome_unknown",
      failureMessage: "Provider acceptance is unknown; this operation was not resubmitted.",
    }, reasonCode: "submit_outcome_quarantined" });
    return { operationId, decision, status: "updated", operation };
  }
  if (decision === "lookup_client_request") {
    if (!adapter?.lookupByClientRequestKey) return { operationId, decision, status: "deferred", operation };
    operation = applyObservation(operation, await adapter.lookupByClientRequestKey(operation.clientRequestKey));
    return { operationId, decision, status: "updated", operation };
  }
  if (decision === "poll_provider_operation") {
    if (!adapter?.lookupByOperationId || !operation.providerOperationId) return { operationId, decision, status: "deferred", operation };
    operation = applyObservation(operation, await adapter.lookupByOperationId(operation.providerOperationId));
    return { operationId, decision, status: "updated", operation };
  }
  return { operationId, decision, status: "unchanged", operation };
}

export function recoverableMediaOperations(): MediaOperationRecord[] {
  return listRecoverableMediaOperations();
}
