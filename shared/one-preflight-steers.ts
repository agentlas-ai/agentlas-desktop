import type { McpInvocationRequest, RuntimeSelection } from "./types";
import { normalizeRuntimeSelectionInput } from "./runtime-selection";

/** Immutable gesture choices. If present, omitted keys use normal defaults, not mutable parent choices. */
export type OnePreflightSteerRequest = Pick<McpInvocationRequest,
  "runtimeSelection" | "permissions" | "onePermissionMode" | "planMode" | "goalMode" | "fastMode" | "sessionRouting" | "locale">;

export const ONE_PREFLIGHT_STEER_REQUEST_KEYS = ["runtimeSelection", "permissions", "onePermissionMode",
  "planMode", "goalMode", "fastMode", "sessionRouting", "locale"] as const;

/** Selection data never carries prepared grants, roster authority, a workspace, or a run identity. */
export function normalizeOnePreflightSteerRequest(value: unknown): OnePreflightSteerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("one_preflight_invalid_request");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !(ONE_PREFLIGHT_STEER_REQUEST_KEYS as readonly string[]).includes(key))) {
    throw new Error("one_preflight_unsupported_request_field");
  }
  const result: OnePreflightSteerRequest = {};
  if (input.runtimeSelection !== undefined) result.runtimeSelection = normalizeRuntimeSelectionInput(input.runtimeSelection, { roles: ["orchestrator"], allowInherit: false });
  for (const key of ["planMode", "goalMode", "fastMode", "sessionRouting"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") throw new Error("one_preflight_invalid_request");
    result[key] = input[key];
  }
  for (const [key, allowed] of [["permissions", ["read", "write", "full"]],
    ["onePermissionMode", ["auto", "read", "write", "full"]], ["locale", ["ko", "en"]]] as const) {
    const entry = input[key];
    if (entry === undefined) continue;
    if (typeof entry !== "string" || !(allowed as readonly string[]).includes(entry)) throw new Error("one_preflight_invalid_request");
    Object.assign(result, { [key]: entry });
  }
  return result;
}

export interface OnePreflightSubmissionInput {
  submissionId: string;
  chatId: string;
  userPrompt: string;
  runtimeSelection?: RuntimeSelection;
}

export interface OnePreflightSubmissionReceipt {
  submissionId: string;
  chatId: string;
  state: "open" | "reserved" | "bound" | "held" | "cancelled";
  parentRunId: string | null;
  createdAt: string;
}

export interface OnePreflightSteerInput {
  steerId: string;
  submissionId: string;
  chatId: string;
  userPrompt: string;
  request?: OnePreflightSteerRequest;
}

/** Exact recovery key; a chat's bounded display list is not a receipt lookup. */
export interface OnePreflightSteerLookupInput {
  steerId: string;
  submissionId: string;
  chatId: string;
}

export interface OnePreflightSteerReceipt {
  steerId: string;
  submissionId: string;
  chatId: string;
  userPrompt: string;
  request?: OnePreflightSteerRequest;
  status: "queued" | "claimed" | "attached" | "held" | "cancelled";
  parentRunId: string | null;
  createdAt: string;
}
