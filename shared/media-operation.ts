export const MEDIA_OPERATION_SCHEMA_VERSION = "agentlas.media-operation.v1" as const;

export type MediaOperationModality = "image" | "video" | "audio";
export type MediaOperationLifecycle =
  | "submit_intent"
  | "submitting"
  | "provider_accepted"
  | "running"
  | "verifying"
  | "succeeded"
  | "failed"
  | "outcome_unknown";
export type MediaCancellationState = "none" | "requested" | "confirmed" | "unconfirmed";
export type MediaSubmitRecovery = "idempotency_key" | "client_request_lookup" | "none";
export type MediaStatusLookup = "provider_operation_id" | "client_request_key" | "none";
export type MediaCancellationCapability = "provider" | "local_only";

export interface MediaProviderCapabilities {
  submitRecovery: MediaSubmitRecovery;
  statusLookup: MediaStatusLookup;
  cancellation: MediaCancellationCapability;
}

export interface MediaOperationResult {
  path: string;
  sha256: string;
  receipt: unknown;
}

export interface MediaOperationRecord {
  schemaVersion: typeof MEDIA_OPERATION_SCHEMA_VERSION;
  id: string;
  modality: MediaOperationModality;
  providerId: string;
  modelId: string;
  clientRequestKey: string;
  inputDigest: string;
  intent: unknown;
  spendLimitUsd: number | null;
  capabilities: MediaProviderCapabilities;
  lifecycle: MediaOperationLifecycle;
  providerOperationId: string | null;
  providerCheckpoint: unknown | null;
  providerStatus: string | null;
  cancellation: MediaCancellationState;
  cancelRequestedAt: string | null;
  cancelConfirmedAt: string | null;
  result: MediaOperationResult | null;
  failureCode: string | null;
  failureMessage: string | null;
  pollAttempts: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MediaOperationEvent {
  operationId: string;
  sequence: number;
  fromLifecycle: MediaOperationLifecycle | null;
  toLifecycle: MediaOperationLifecycle;
  cancellation: MediaCancellationState;
  reasonCode: string;
  detail: unknown | null;
  createdAt: string;
}

export interface MediaOperationIntent {
  id: string;
  modality: MediaOperationModality;
  providerId: string;
  modelId: string;
  clientRequestKey: string;
  inputDigest: string;
  intent: unknown;
  spendLimitUsd?: number | null;
  capabilities: MediaProviderCapabilities;
}

export type MediaRecoveryDecision =
  | "resume_unsubmitted_intent"
  | "lookup_client_request"
  | "quarantine_outcome_unknown"
  | "poll_provider_operation"
  | "none";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export function isMediaOperationLifecycle(value: unknown): value is MediaOperationLifecycle {
  return ["submit_intent", "submitting", "provider_accepted", "running", "verifying", "succeeded", "failed", "outcome_unknown"].includes(String(value));
}

export function isMediaCancellationState(value: unknown): value is MediaCancellationState {
  return ["none", "requested", "confirmed", "unconfirmed"].includes(String(value));
}

export function validateMediaOperationIntent(input: MediaOperationIntent): MediaOperationIntent {
  if (!SAFE_ID.test(input.id) || !SAFE_ID.test(input.providerId) || !SAFE_ID.test(input.modelId)
    || !SAFE_ID.test(input.clientRequestKey) || !SHA256.test(input.inputDigest)) {
    throw new Error("media_operation_identity_invalid");
  }
  if (!["image", "video", "audio"].includes(input.modality)) throw new Error("media_operation_modality_invalid");
  if (input.spendLimitUsd !== undefined && input.spendLimitUsd !== null
    && (!Number.isFinite(input.spendLimitUsd) || input.spendLimitUsd < 0)) throw new Error("media_operation_spend_limit_invalid");
  if (!["idempotency_key", "client_request_lookup", "none"].includes(input.capabilities.submitRecovery)
    || !["provider_operation_id", "client_request_key", "none"].includes(input.capabilities.statusLookup)
    || !["provider", "local_only"].includes(input.capabilities.cancellation)) {
    throw new Error("media_operation_capabilities_invalid");
  }
  JSON.stringify(input.intent);
  return input;
}

export function mediaRecoveryDecision(operation: MediaOperationRecord): MediaRecoveryDecision {
  if (operation.lifecycle === "submit_intent") return "resume_unsubmitted_intent";
  if (operation.lifecycle === "submitting" && !operation.providerOperationId) {
    return operation.capabilities.submitRecovery === "client_request_lookup"
      && operation.capabilities.statusLookup === "client_request_key"
      ? "lookup_client_request"
      : "quarantine_outcome_unknown";
  }
  if (["provider_accepted", "running"].includes(operation.lifecycle) && operation.providerOperationId
    && operation.capabilities.statusLookup === "provider_operation_id") return "poll_provider_operation";
  return "none";
}
