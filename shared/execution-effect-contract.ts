/** Requiredness belongs to the accepted task contract, not to a worker's
 * completion claim. `unspecified` preserves the conservative legacy boundary. */
export type ExternalEffectRequirement = "required" | "not-required" | "unspecified";
export type ExternalEffectState = "not-attempted" | "withheld" | "attempted" | "uncertain" | "verified";
export const EXTERNAL_EFFECT_STATES: readonly ExternalEffectState[] = ["not-attempted", "withheld", "attempted", "uncertain", "verified"];
/** Merging work may strengthen an obligation, never erase it. */
export function combineExternalEffectRequirements(requirements: readonly (ExternalEffectRequirement | undefined)[]): ExternalEffectRequirement {
  if (requirements.includes("required")) return "required";
  return requirements.length > 0 && requirements.every(value => value === "not-required") ? "not-required" : "unspecified";
}
export type ExecutionRecoveryAction = "continue-work" | "request-authority" | "inspect-effect" | "reconcile-effect" | "retry-preparation" | "wait-capacity" | "repair-contract" | "none";
export interface ExternalEffectAssessment {
  requirement: ExternalEffectRequirement;
  state: ExternalEffectState;
  satisfied: boolean;
  /** Effect obligation needs follow-up; this is not a packet or Goal completion gate. */
  requiresFollowup: boolean;
  code: "effect_not_required" | "effect_verified" | "effect_required_not_attempted" | "effect_authority_withheld"
    | "effect_requirement_unspecified" | "effect_outcome_uncertain" | "effect_witness_missing" | "effect_authority_unverified";
  recovery: ExecutionRecoveryAction;
}

/** `requirement`, `authorization`, and verifiedEffectRefs are host inputs.
 * Model claims may describe state, but can neither waive a required effect nor
 * manufacture observation. No prose matching or automatic effect replay. */
export function assessExternalEffect(input: {
  requirement: ExternalEffectRequirement;
  claimedState: ExternalEffectState;
  authorization: "granted" | "withheld" | "unspecified";
  effectRef?: string | null;
  verifiedEffectRefs?: ReadonlySet<string>;
}): ExternalEffectAssessment {
  const observed = Boolean(input.effectRef && input.verifiedEffectRefs?.has(input.effectRef));
  const state = observed ? "verified" : input.claimedState === "verified" ? "uncertain" : input.claimedState;
  const result = (code: ExternalEffectAssessment["code"], recovery: ExecutionRecoveryAction, satisfied = false): ExternalEffectAssessment => ({
    requirement: input.requirement, state, satisfied, requiresFollowup: !satisfied, code, recovery,
  });
  if (observed) return input.authorization === "granted"
    ? result("effect_verified", "none", true)
    : result("effect_authority_unverified", "reconcile-effect");
  if (input.effectRef) return result("effect_witness_missing", "inspect-effect");
  if (input.claimedState === "verified") return result("effect_witness_missing", "inspect-effect");
  if (state === "attempted" || state === "uncertain") return result("effect_outcome_uncertain", "inspect-effect");
  if (input.requirement === "not-required") return result("effect_not_required", "none", true);
  if (input.requirement === "unspecified") return result("effect_requirement_unspecified", "repair-contract");
  if (state === "withheld" || input.authorization !== "granted") return result("effect_authority_withheld", "request-authority");
  return result("effect_required_not_attempted", "continue-work");
}

export interface ExecutionFailureCause {
  phase: "admission" | "preparation" | "execution" | "effect" | "verification";
  code: string;
  stepId?: string;
  providerCode?: string;
  httpStatus?: number;
  retryAfterMs?: number;
  retryAfterHint?: string;
  causeCodes?: readonly string[];
  delivery?: "not-dispatched" | "dispatched" | "unknown";
  requiredPermission?: "read" | "write" | "full";
  actualPermission?: "read" | "write" | "full";
  blockedBy?: readonly string[];
  recovery: ExecutionRecoveryAction;
}
/** Read machine fields only, including wrappers' original causes. Never infer
 * an HTTP status, authority, or delivery state from an error's prose. */
export function readExecutionFailureCause(error: unknown, input: {
  phase: ExecutionFailureCause["phase"]; stepId?: string; fallbackCode?: string;
  delivery?: ExecutionFailureCause["delivery"];
}): ExecutionFailureCause {
  const seen = new Set<object>(), queue: unknown[] = [error], codes: string[] = [];
  let providerCode: string | undefined, httpStatus: number | undefined, retryAfterMs: number | undefined;
  let retryAfterHint: string | undefined, delivery = input.delivery, throttled = false;
  let requiredPermission: ExecutionFailureCause["requiredPermission"], actualPermission: ExecutionFailureCause["actualPermission"];
  const code = (value: unknown): string | undefined => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : undefined;
  const permission = (value: unknown) => value === "read" || value === "write" || value === "full" ? value : undefined;
  for (let count = 0; queue.length && count < 12; count += 1) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const row = value as Record<string, unknown>;
    const ownCode = code(row.code);
    if (ownCode && !codes.includes(ownCode)) codes.push(ownCode);
    providerCode ??= code(row.providerCode);
    const status = row.httpStatus ?? row.statusCode ?? row.status;
    if (httpStatus === undefined && typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) httpStatus = status;
    if (retryAfterMs === undefined && typeof row.retryAfterMs === "number" && Number.isFinite(row.retryAfterMs) && row.retryAfterMs >= 0) retryAfterMs = row.retryAfterMs;
    // A runtime failure (InvocationRuntimeFailure) types throttling as kind "rate_limit" and carries its wait as `retryAfterAt`.
    if (row.kind === "rate_limit") throttled = true;
    if (retryAfterHint === undefined && typeof row.retryAfterHint === "string") retryAfterHint = row.retryAfterHint.slice(0, 256);
    if (retryAfterHint === undefined && typeof row.retryAfterAt === "string") retryAfterHint = row.retryAfterAt.slice(0, 256);
    if (!delivery && (row.turnDelivery === "not-dispatched" || row.delivery === "not-dispatched")) delivery = "not-dispatched";
    if (!delivery && (row.turnDelivery === "accepted" || row.delivery === "dispatched")) delivery = "dispatched";
    requiredPermission ??= permission(row.requiredPermission ?? row.expectedPermission);
    actualPermission ??= permission(row.actualPermission);
    queue.push(row.cause, row.failure, row.detail, row.cleanupFailure);
  }
  const rootCode = codes[0] ?? providerCode ?? input.fallbackCode ?? "execution_failure_unclassified";
  const recovery: ExecutionRecoveryAction = (httpStatus === 429 && delivery === "not-dispatched") || (throttled && delivery !== "dispatched") ? "wait-capacity"
    : input.phase === "preparation" && delivery === "not-dispatched" && httpStatus !== undefined && httpStatus >= 500
      ? "retry-preparation"
      : input.phase === "admission" ? "repair-contract" : "none";
  return { phase: input.phase, code: rootCode, ...(input.stepId ? { stepId: input.stepId } : {}),
    ...(providerCode ? { providerCode } : {}), ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), ...(retryAfterHint ? { retryAfterHint } : {}),
    ...(codes.length > 1 ? { causeCodes: codes.slice(1) } : {}), delivery: delivery ?? "unknown",
    ...(requiredPermission ? { requiredPermission } : {}), ...(actualPermission ? { actualPermission } : {}), recovery };
}
export interface ExecutionFailureReport {
  schemaVersion: "agentlas.execution-failure.v1";
  /** Aggregate diagnosis only: partial may mean pending effects on successful steps. */
  outcome: "failed" | "partial" | "blocked";
  causes: readonly ExecutionFailureCause[];
  effects: readonly ExternalEffectAssessment[];
}
/** Structured tool/result data for the primary model. Preserve exact upstream
 * codes; a wrapper label is not a substitute for a cause. This emits no prompt. */
export function executionFailureReport(input: Omit<ExecutionFailureReport, "schemaVersion" | "effects"> & {
  effects?: readonly ExternalEffectAssessment[];
}): ExecutionFailureReport {
  return { schemaVersion: "agentlas.execution-failure.v1", outcome: input.outcome,
    causes: input.causes.map((cause) => ({ ...cause, ...(cause.blockedBy ? { blockedBy: [...cause.blockedBy] } : {}),
      ...(cause.causeCodes ? { causeCodes: [...cause.causeCodes] } : {}) })),
    effects: (input.effects ?? []).map((effect) => ({ ...effect })) };
}
