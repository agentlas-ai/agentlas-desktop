import type { AgentRuntimeOverride, RuntimeStatus } from "../../shared/types";
import { createHash } from "node:crypto";

/**
 * A parent LLM assigns provider-neutral capacity. Deterministic host code only
 * validates an exact runtime/model pair against the host's execution inventory.
 * It never infers difficulty from task words or manufactures provider model IDs.
 */
export type WorkloadModelTier = "economy" | "balanced" | "frontier";
export type WorkloadEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type WorkloadPhase = "plan" | "delegate" | "synthesize";
export type WorkloadModelClass =
  | "auto"
  | "haiku"
  | "luna"
  | "flash"
  | "mini"
  | "sonnet"
  | "terra"
  | "tera"
  | "composer"
  | "opus"
  | "sol"
  | "grok";

export interface WorkloadRequirements {
  inputTokens: number;
  expectedOutputTokens: number;
  toolRequired: boolean;
  multimodalRequired: boolean;
}

export interface WorkloadHostPolicy {
  pinnedModelId?: string;
  maxTier?: WorkloadModelTier;
  maxEffort?: WorkloadEffort;
  requiredCapabilities?: string[];
}

export interface WorkloadAllocation {
  schema: "agentlas.workload-allocation.v1";
  /** Opaque ID copied by the parent model from the live runtime inventory. */
  runtimeId?: string;
  /** Exact model ID copied by the parent model from that runtime's live inventory. */
  modelId?: string;
  tier: WorkloadModelTier;
  /** Optional concrete family chosen by the parent model, never an invented provider ID. */
  modelClass?: WorkloadModelClass;
  effort: WorkloadEffort;
  phase: WorkloadPhase;
  requirements: WorkloadRequirements;
  /** True only when the parent supplied every typed requirement field. */
  requirementsVerified: boolean;
  reasonCodes: string[];
  /** Short observable justification, never hidden reasoning or the task prompt. */
  rationale: string;
}

export interface WorkloadResolution {
  allocation: WorkloadAllocation;
  /** Host validation result, kept outside the model-authored allocation object. */
  requirementsVerified: boolean;
  runtime: RuntimeStatus;
  /** Actual inventory identity after host fallback/validation, never copied from rejected parent data. */
  resolvedRuntimeId: string | null;
  /** Actual host-authored cost tier when known. */
  resolvedTier: WorkloadModelTier | null;
  source: "ai-assigned" | "manual-override" | "safe-fallback";
  resolutionCodes: string[];
}

export interface WorkloadRuntimeInventoryEntry {
  runtimeId: string;
  kind: RuntimeStatus["kind"];
  backend: RuntimeStatus["backend"];
  models: string[];
  efforts: WorkloadEffort[];
  modelProfiles: Record<string, {
    costTier: WorkloadModelTier | null;
    contextWindow: number | null;
    capabilities: string[];
    supportsTools: boolean | null;
    supportsMultimodal: boolean | null;
    efforts: WorkloadEffort[] | null;
  }>;
}

const TIER_ALIASES: Record<WorkloadModelTier, string[]> = {
  economy: ["haiku", "luna", "flash", "mini"],
  balanced: ["sonnet", "terra", "tera", "composer"],
  frontier: ["opus", "sol", "grok"],
};
const EFFORTS: WorkloadEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const PHASES: WorkloadPhase[] = ["plan", "delegate", "synthesize"];
const MAX_REASON_CODES = 8;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
}

export function normalizeWorkloadTier(value: unknown): WorkloadModelTier | null {
  const raw = cleanText(value, 40).toLowerCase();
  if (raw === "economy" || raw === "balanced" || raw === "frontier") return raw;
  for (const [tier, aliases] of Object.entries(TIER_ALIASES) as Array<[WorkloadModelTier, string[]]>) {
    if (aliases.includes(raw)) return tier;
  }
  return null;
}

function normalizeModelClass(value: unknown): WorkloadModelClass | null {
  const raw = cleanText(value, 24).toLowerCase() as WorkloadModelClass;
  if (raw === "auto") return raw;
  return (Object.values(TIER_ALIASES).flat() as string[]).includes(raw) ? raw : null;
}

function normalizeRuntimeId(value: unknown): string | null {
  const raw = cleanText(value, 32);
  return /^runtime-\d+$/.test(raw) ? raw : null;
}

function normalizeModelId(value: unknown): string | null {
  const raw = cleanText(value, 180);
  return raw ? raw : null;
}

function normalizeEffort(value: unknown): WorkloadEffort | null {
  const raw = cleanText(value, 20).toLowerCase() as WorkloadEffort;
  return EFFORTS.includes(raw) ? raw : null;
}

function normalizePhase(value: unknown): WorkloadPhase | null {
  const raw = cleanText(value, 20).toLowerCase() as WorkloadPhase;
  return PHASES.includes(raw) ? raw : null;
}

function normalizeReasonCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const code = cleanText(item, 120).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (code && !out.includes(code)) out.push(code);
    if (out.length >= MAX_REASON_CODES) break;
  }
  return out;
}

function boundedNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(10_000_000, Math.floor(value)))
    : 0;
}

function normalizeRequirements(value: unknown): { requirements: WorkloadRequirements; valid: boolean } {
  const obj = asObject(value);
  const inputTokens = obj.inputTokens ?? obj.input_tokens;
  const expectedOutputTokens = obj.expectedOutputTokens ?? obj.expected_output_tokens;
  const toolRequired = obj.toolRequired ?? obj.tool_required;
  const multimodalRequired = obj.multimodalRequired ?? obj.multimodal_required;
  const valid =
    typeof inputTokens === "number" && Number.isInteger(inputTokens) && inputTokens >= 0 && inputTokens <= 10_000_000 &&
    typeof expectedOutputTokens === "number" && Number.isInteger(expectedOutputTokens) && expectedOutputTokens >= 0 && expectedOutputTokens <= 10_000_000 &&
    typeof toolRequired === "boolean" && typeof multimodalRequired === "boolean";
  return {
    requirements: {
      inputTokens: boundedNonNegativeInt(inputTokens),
      expectedOutputTokens: boundedNonNegativeInt(expectedOutputTokens),
      toolRequired: toolRequired === true,
      multimodalRequired: multimodalRequired === true,
    },
    valid,
  };
}

function normalizeCapabilityList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) return null;
  const capabilities = value
    .map((entry) => cleanText(entry, 48).toLowerCase())
    .filter((entry) => /^[a-z0-9][a-z0-9._-]{0,47}$/.test(entry));
  if (capabilities.length !== value.length) return null;
  return [...new Set(capabilities)].slice(0, 32);
}

function normalizeHostPolicy(value: unknown): { policy: WorkloadHostPolicy; valid: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { policy: {}, valid: false };
  const obj = asObject(value);
  const allowedKeys = new Set(["pinnedModelId", "maxTier", "maxEffort", "requiredCapabilities"]);
  const unknownKey = Object.keys(obj).some((key) => !allowedKeys.has(key));
  const pinnedModelId = obj.pinnedModelId === undefined ? undefined : normalizeModelId(obj.pinnedModelId);
  const maxTier = obj.maxTier === undefined ? undefined : normalizeWorkloadTier(obj.maxTier);
  const maxEffort = obj.maxEffort === undefined ? undefined : normalizeEffort(obj.maxEffort);
  const requiredCapabilities = normalizeCapabilityList(obj.requiredCapabilities);
  const valid =
    !unknownKey &&
    (obj.pinnedModelId === undefined || Boolean(pinnedModelId)) &&
    (obj.maxTier === undefined || Boolean(maxTier)) &&
    (obj.maxEffort === undefined || Boolean(maxEffort)) &&
    requiredCapabilities !== null;
  return {
    policy: {
      ...(pinnedModelId ? { pinnedModelId } : {}),
      ...(maxTier ? { maxTier } : {}),
      ...(maxEffort ? { maxEffort } : {}),
      ...(requiredCapabilities?.length ? { requiredCapabilities } : {}),
    },
    valid,
  };
}

function effectiveHostPolicy(explicit?: WorkloadHostPolicy): { policy: WorkloadHostPolicy; valid: boolean } {
  if (explicit) return normalizeHostPolicy(explicit);
  const raw = process.env.AGENTLAS_MODEL_ALLOCATION_POLICY_JSON?.trim();
  if (!raw) return { policy: {}, valid: true };
  try {
    return normalizeHostPolicy(JSON.parse(raw));
  } catch {
    return { policy: {}, valid: false };
  }
}

export function defaultWorkloadAllocation(
  phase: WorkloadPhase,
  reasonCode = "missing-ai-allocation",
): WorkloadAllocation {
  const emptyRequirements = normalizeRequirements(null);
  return {
    schema: "agentlas.workload-allocation.v1",
    tier: "balanced",
    effort: phase === "synthesize" ? "high" : "medium",
    phase,
    requirements: emptyRequirements.requirements,
    requirementsVerified: false,
    reasonCodes: [reasonCode],
    rationale: "Safe non-frontier fallback because no valid parent allocation was available.",
  };
}

/** Accepts tier names and the user-facing model-family aliases (tera included). */
export function normalizeWorkloadAllocation(
  value: unknown,
  expectedPhase: WorkloadPhase,
): WorkloadAllocation {
  const obj = asObject(value);
  const runtimeId = normalizeRuntimeId(obj.runtimeId ?? obj.runtime_id);
  const modelId = normalizeModelId(obj.modelId ?? obj.model_id ?? obj.exactModelId ?? obj.exact_model_id);
  const modelClass = normalizeModelClass(obj.modelClass ?? obj.model_class ?? obj.model);
  const tier = normalizeWorkloadTier(obj.tier ?? obj.modelTier ?? obj.model_tier ?? modelClass);
  const effort = normalizeEffort(obj.effort);
  const phase = normalizePhase(obj.phase);
  if (!tier || !effort || !phase || phase !== expectedPhase) {
    return defaultWorkloadAllocation(expectedPhase, "invalid-ai-allocation");
  }
  const requirementResult = normalizeRequirements(obj.requirements ?? obj.features);
  const reasonCodes = normalizeReasonCodes(obj.reasonCodes ?? obj.reason_codes);
  return {
    schema: "agentlas.workload-allocation.v1",
    ...(runtimeId ? { runtimeId } : {}),
    ...(modelId ? { modelId } : {}),
    tier,
    ...(modelClass && (modelClass === "auto" || TIER_ALIASES[tier].includes(modelClass)) ? { modelClass } : {}),
    effort,
    phase: expectedPhase,
    requirements: requirementResult.requirements,
    requirementsVerified: requirementResult.valid,
    reasonCodes: [
      ...(reasonCodes.length > 0 ? reasonCodes : ["ai-assigned"]),
      ...(requirementResult.valid ? [] : ["invalid-requirements"]),
    ].slice(0, MAX_REASON_CODES),
    rationale: cleanText(obj.rationale, 240) || "Parent AI assigned capacity for this phase.",
  };
}

function liveModelInventory(runtime: RuntimeStatus): string[] {
  const safe = (runtime.allocationModels ?? [])
    .map((model) => cleanText(model, 180))
    .filter((model) => /^[A-Za-z0-9][A-Za-z0-9._:+/() -]{0,179}$/.test(model));
  return [...new Set(safe)];
}

function safeModelProfile(runtime: RuntimeStatus, modelId: string) {
  const raw = runtime.allocationModelProfiles?.[modelId];
  if (!raw) return null;
  const costTier = normalizeWorkloadTier(raw.costTier);
  const capabilities = normalizeCapabilityList(raw.capabilities) ?? [];
  const efforts = raw.efforts === undefined
    ? null
    : Array.isArray(raw.efforts) && raw.efforts.length <= EFFORTS.length
      ? EFFORTS.filter((effort) => raw.efforts?.some((entry) => normalizeEffort(entry) === effort))
      : null;
  const contextWindow = typeof raw.contextWindow === "number" && Number.isFinite(raw.contextWindow)
    ? Math.max(0, Math.floor(raw.contextWindow))
    : null;
  return {
    costTier,
    contextWindow,
    capabilities,
    supportsTools: typeof raw.supportsTools === "boolean" ? raw.supportsTools : null,
    supportsMultimodal: typeof raw.supportsMultimodal === "boolean" ? raw.supportsMultimodal : null,
    efforts,
  };
}

/** Value-safe inventory shown to the parent LLM. It intentionally has no paths, account IDs, prompts or secrets. */
export function workloadRuntimeInventory(runtimes: RuntimeStatus[]): WorkloadRuntimeInventoryEntry[] {
  return runtimes.map((runtime, index) => {
    const models = liveModelInventory(runtime);
    return {
      runtimeId: `runtime-${index + 1}`,
      kind: runtime.kind,
      backend: runtime.backend,
      models,
      efforts: supportedEfforts(runtime),
      modelProfiles: Object.fromEntries(models.flatMap((modelId) => {
        const profile = safeModelProfile(runtime, modelId);
        return profile ? [[modelId, profile]] : [];
      })),
    };
  });
}

function runtimeForInventoryId(
  runtimes: RuntimeStatus[],
  runtimeId: string | undefined,
): RuntimeStatus | null {
  if (!runtimeId) return null;
  const match = /^runtime-(\d+)$/.exec(runtimeId);
  if (!match) return null;
  return runtimes[Number(match[1]) - 1] ?? null;
}

function inventoryIdForRuntime(runtimes: RuntimeStatus[], runtime: RuntimeStatus): string | null {
  let index = runtimes.indexOf(runtime);
  if (index < 0) {
    index = runtimes.findIndex((candidate) =>
      candidate.kind === runtime.kind && candidate.backend === runtime.backend && candidate.source === runtime.source,
    );
  }
  return index >= 0 ? `runtime-${index + 1}` : null;
}

function resolvedTierForRuntime(runtime: RuntimeStatus): WorkloadModelTier | null {
  return runtime.model ? safeModelProfile(runtime, runtime.model)?.costTier ?? null : null;
}

function supportedEfforts(runtime: RuntimeStatus, modelId?: string): WorkloadEffort[] {
  if (modelId) {
    const modelEfforts = safeModelProfile(runtime, modelId)?.efforts;
    if (modelEfforts !== null && modelEfforts !== undefined) return modelEfforts;
  }
  if (runtime.efforts) {
    return runtime.efforts
      .map((entry) => normalizeEffort(entry.id))
      .filter((effort): effort is WorkloadEffort => Boolean(effort));
  }
  if (!modelId) {
    const union = new Set<WorkloadEffort>();
    let foundHostProfile = false;
    for (const candidate of liveModelInventory(runtime)) {
      const modelEfforts = safeModelProfile(runtime, candidate)?.efforts;
      if (modelEfforts === null || modelEfforts === undefined) continue;
      foundHostProfile = true;
      for (const effort of modelEfforts) union.add(effort);
    }
    if (foundHostProfile) return EFFORTS.filter((effort) => union.has(effort));
  }
  // Codex exposes this as a stable config capability rather than a discovery API.
  if (runtime.kind === "codex") return ["none", "minimal", "low", "medium", "high", "xhigh"];
  return [];
}

function resolveEffort(
  runtime: RuntimeStatus,
  requested: WorkloadEffort,
  modelId?: string,
): { effort?: string | null; code?: string } {
  const supported = supportedEfforts(runtime, modelId);
  if (supported.length === 0) {
    return { effort: runtime.effort ?? undefined, code: "effort-capability-unavailable" };
  }
  if (supported.includes(requested)) return { effort: requested };
  const requestedRank = EFFORTS.indexOf(requested);
  const ranked = supported.slice().sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  const below = ranked.filter((effort) => EFFORTS.indexOf(effort) <= requestedRank).at(-1);
  return below
    ? { effort: below, code: "effort-clamped-to-capability" }
    : { effort: null, code: "effort-below-capability-unavailable" };
}

function resolvePolicyBoundedEffort(
  runtime: RuntimeStatus,
  requested: WorkloadEffort,
  policy: WorkloadHostPolicy,
  modelId?: string,
): { effort?: string | null; codes: string[] } {
  let bounded = requested;
  const codes: string[] = [];
  if (policy.maxEffort && EFFORTS.indexOf(bounded) > EFFORTS.indexOf(policy.maxEffort)) {
    bounded = policy.maxEffort;
    codes.push("effort-clamped-to-host-policy");
  }
  const exactEfforts = modelId ? safeModelProfile(runtime, modelId)?.efforts : null;
  if (exactEfforts && exactEfforts.length === 0) {
    codes.push("effort-capability-unavailable");
    return { effort: null, codes };
  }
  const supported = resolveEffort(runtime, bounded, modelId);
  if (supported.code) codes.push(supported.code);
  const resolved = normalizeEffort(supported.effort);
  if (
    policy.maxEffort &&
    resolved &&
    EFFORTS.indexOf(resolved) > EFFORTS.indexOf(policy.maxEffort)
  ) {
    codes.push("effort-below-capability-unavailable");
    return { effort: null, codes: [...new Set(codes)] };
  }
  return { effort: supported.effort, codes };
}

function resolvedEffortOrCurrent(
  effort: string | null | undefined,
  current: string | null | undefined,
): string | null | undefined {
  return effort === undefined ? current : effort;
}

function exactModelPolicyIssue(input: {
  allocation: WorkloadAllocation;
  requirementsVerified: boolean;
  runtime: RuntimeStatus;
  modelId: string;
  policy: WorkloadHostPolicy;
  policyValid: boolean;
}): string | null {
  if (!input.policyValid) return "host-allocation-policy-invalid-active-preserved";
  if (!input.requirementsVerified) return "parent-requirements-invalid-active-preserved";
  if (input.policy.pinnedModelId && input.policy.pinnedModelId !== input.modelId) {
    return "host-pinned-model-preserved";
  }
  const profile = safeModelProfile(input.runtime, input.modelId);
  if (input.policy.maxTier) {
    const maxRank = ["economy", "balanced", "frontier"].indexOf(input.policy.maxTier);
    if (["economy", "balanced", "frontier"].indexOf(input.allocation.tier) > maxRank) {
      return "parent-tier-exceeds-host-cost-policy-active-preserved";
    }
    if (!profile?.costTier) return "requested-exact-model-cost-tier-unknown-active-preserved";
    if (["economy", "balanced", "frontier"].indexOf(profile.costTier) > maxRank) {
      return "requested-exact-model-exceeds-host-cost-policy-active-preserved";
    }
  }
  if (profile?.costTier && profile.costTier !== input.allocation.tier) {
    return "requested-exact-model-tier-mismatch-active-preserved";
  }
  const totalTokens = input.allocation.requirements.inputTokens + input.allocation.requirements.expectedOutputTokens;
  if (totalTokens > 0 && (!profile?.contextWindow || profile.contextWindow < totalTokens)) {
    return "requested-exact-model-context-incompatible-active-preserved";
  }
  if (input.allocation.requirements.toolRequired && profile?.supportsTools !== true && !profile?.capabilities.includes("tools")) {
    return "requested-exact-model-tools-incompatible-active-preserved";
  }
  if (
    input.allocation.requirements.multimodalRequired &&
    profile?.supportsMultimodal !== true &&
    !profile?.capabilities.includes("multimodal")
  ) {
    return "requested-exact-model-multimodal-incompatible-active-preserved";
  }
  const required = input.policy.requiredCapabilities ?? [];
  if (required.length > 0 && (!profile || required.some((capability) => !profile.capabilities.includes(capability)))) {
    return "requested-exact-model-capability-incompatible-active-preserved";
  }
  return null;
}

/** Host-authored control-plane calls may lower effort without accepting parent model data. */
export function resolveHostControlPlaneRuntime(
  runtime: RuntimeStatus,
  requestedEffort: WorkloadEffort,
): RuntimeStatus {
  const host = effectiveHostPolicy();
  if (!host.valid) return { ...runtime };
  const effort = resolvePolicyBoundedEffort(runtime, requestedEffort, host.policy, runtime.model ?? undefined);
  return { ...runtime, effort: resolvedEffortOrCurrent(effort.effort, runtime.effort) };
}

export function resolveWorkloadAllocation(input: {
  allocation?: WorkloadAllocation | null;
  runtime: RuntimeStatus;
  phase: WorkloadPhase;
  manualOverride?: AgentRuntimeOverride | null;
  explicitPinned?: boolean;
  /** Host-owned only. Parent model JSON is never allowed to populate this. */
  hostPolicy?: WorkloadHostPolicy;
  /** Host-owned result of an exact structured-contract validation. */
  requirementsVerified?: boolean;
}): WorkloadResolution {
  const allocation = input.allocation ?? defaultWorkloadAllocation(input.phase);
  const requirementsVerified = input.requirementsVerified ?? allocation.requirementsVerified === true;
  if (input.manualOverride || input.explicitPinned) {
    return {
      allocation,
      requirementsVerified,
      runtime: { ...input.runtime },
      resolvedRuntimeId: null,
      resolvedTier: resolvedTierForRuntime(input.runtime),
      source: "manual-override",
      resolutionCodes: ["manual-runtime-override-preserved"],
    };
  }

  const model = allocation.modelId && liveModelInventory(input.runtime).includes(allocation.modelId)
    ? allocation.modelId
    : null;
  if (!model) {
    return {
      allocation,
      requirementsVerified,
      runtime: { ...input.runtime },
      resolvedRuntimeId: null,
      resolvedTier: resolvedTierForRuntime(input.runtime),
      source: "safe-fallback",
      resolutionCodes: [
        allocation.modelId
          ? "parent-model-not-in-live-inventory-active-preserved"
          : "parent-exact-model-missing-active-preserved",
      ],
    };
  }
  const host = effectiveHostPolicy(input.hostPolicy);
  const policyIssue = exactModelPolicyIssue({
    allocation,
    runtime: input.runtime,
    modelId: model,
    requirementsVerified,
    policy: host.policy,
    policyValid: host.valid,
  });
  if (policyIssue) {
    return {
      allocation,
      requirementsVerified,
      runtime: { ...input.runtime },
      resolvedRuntimeId: null,
      resolvedTier: resolvedTierForRuntime(input.runtime),
      source: "safe-fallback",
      resolutionCodes: [policyIssue],
    };
  }
  const effort = resolvePolicyBoundedEffort(input.runtime, allocation.effort, host.policy, model);
  const resolutionCodes = [
    model === input.runtime.model ? "active-model-parent-selected" : "parent-live-model-selected",
    ...effort.codes,
  ];
  const fallback = allocation.reasonCodes.includes("missing-ai-allocation") || allocation.reasonCodes.includes("invalid-ai-allocation");
  return {
    allocation,
    requirementsVerified,
    runtime: {
      ...input.runtime,
      model: model ?? input.runtime.model,
      effort: resolvedEffortOrCurrent(effort.effort, input.runtime.effort),
    },
    resolvedRuntimeId: null,
    resolvedTier: safeModelProfile(input.runtime, model)?.costTier ?? null,
    source: fallback ? "safe-fallback" : "ai-assigned",
    resolutionCodes,
  };
}

/**
 * Resolve the parent AI's exact decision across live runtimes. Manual/scoped
 * pins still win. Missing or invalid pairs preserve the active fallback as-is.
 */
export function resolveWorkloadAllocationAcrossRuntimes(input: {
  allocation?: WorkloadAllocation | null;
  runtimes: RuntimeStatus[];
  fallbackRuntime: RuntimeStatus;
  phase: WorkloadPhase;
  manualOverride?: AgentRuntimeOverride | null;
  explicitPinned?: boolean;
  /** Host-owned only. Parent model JSON is never allowed to populate this. */
  hostPolicy?: WorkloadHostPolicy;
  /** Host-owned result of an exact structured-contract validation. */
  requirementsVerified?: boolean;
}): WorkloadResolution {
  const allocation = input.allocation ?? defaultWorkloadAllocation(input.phase);
  const requirementsVerified = input.requirementsVerified ?? allocation.requirementsVerified === true;
  if (input.manualOverride || input.explicitPinned) {
    const resolution = resolveWorkloadAllocation({
      allocation,
      runtime: input.fallbackRuntime,
      phase: input.phase,
      manualOverride: input.manualOverride,
      explicitPinned: input.explicitPinned,
      hostPolicy: input.hostPolicy,
      requirementsVerified,
    });
    return {
      ...resolution,
      resolvedRuntimeId: inventoryIdForRuntime(input.runtimes, input.fallbackRuntime),
      resolvedTier: resolvedTierForRuntime(input.fallbackRuntime),
    };
  }

  // Parent output is data, never a provider alias. The host only validates the
  // opaque runtime ID and exact model ID it advertised for this invocation.
  if (allocation.runtimeId && allocation.modelId) {
    const requestedRuntime = runtimeForInventoryId(input.runtimes, allocation.runtimeId);
    if (requestedRuntime && liveModelInventory(requestedRuntime).includes(allocation.modelId)) {
      const host = effectiveHostPolicy(input.hostPolicy);
      const policyIssue = exactModelPolicyIssue({
        allocation,
        runtime: requestedRuntime,
        modelId: allocation.modelId,
        requirementsVerified,
        policy: host.policy,
        policyValid: host.valid,
      });
      if (policyIssue) {
        return {
          allocation,
          requirementsVerified,
          runtime: { ...input.fallbackRuntime },
          resolvedRuntimeId: inventoryIdForRuntime(input.runtimes, input.fallbackRuntime),
          resolvedTier: resolvedTierForRuntime(input.fallbackRuntime),
          source: "safe-fallback",
          resolutionCodes: [policyIssue],
        };
      }
      const effort = resolvePolicyBoundedEffort(
        requestedRuntime,
        allocation.effort,
        host.policy,
        allocation.modelId,
      );
      const fallback = allocation.reasonCodes.includes("missing-ai-allocation") || allocation.reasonCodes.includes("invalid-ai-allocation");
      return {
        allocation,
        requirementsVerified,
        runtime: {
          ...requestedRuntime,
          model: allocation.modelId,
          effort: resolvedEffortOrCurrent(effort.effort, requestedRuntime.effort),
        },
        resolvedRuntimeId: allocation.runtimeId,
        resolvedTier: safeModelProfile(requestedRuntime, allocation.modelId)?.costTier ?? null,
        source: fallback ? "safe-fallback" : "ai-assigned",
        resolutionCodes: ["parent-selected-live-runtime-model", ...effort.codes],
      };
    }
  }
  return {
    allocation,
    requirementsVerified,
    runtime: { ...input.fallbackRuntime },
    resolvedRuntimeId: inventoryIdForRuntime(input.runtimes, input.fallbackRuntime),
    resolvedTier: resolvedTierForRuntime(input.fallbackRuntime),
    source: "safe-fallback",
    resolutionCodes: [
      !allocation.runtimeId || !allocation.modelId
        ? "parent-runtime-model-pair-missing-active-preserved"
        : "parent-runtime-model-pair-invalid-active-preserved",
    ],
  };
}

/** Replace the planned effort with the exact value the runner put on its CLI/API request. */
export function reconcileWorkloadRunnerResult(
  resolution: WorkloadResolution,
  result: { appliedEffort?: unknown },
): WorkloadResolution {
  if (!Object.prototype.hasOwnProperty.call(result, "appliedEffort")) return resolution;
  const raw = result.appliedEffort;
  const appliedEffort = raw === null ? null : normalizeEffort(raw);
  const invalid = raw !== null && appliedEffort === null;
  const prior = resolution.runtime.effort ?? null;
  const changed = prior !== appliedEffort || invalid;
  return {
    ...resolution,
    runtime: { ...resolution.runtime, effort: appliedEffort },
    resolutionCodes: changed
      ? [...new Set([
          ...resolution.resolutionCodes,
          invalid ? "runner-effort-invalid-omitted" : "runner-effort-revalidated",
        ])]
      : resolution.resolutionCodes,
  };
}

/** Receipt deliberately excludes user prompts, briefs, history, and tool data. */
export function workloadAllocationReceipt(resolution: WorkloadResolution): Record<string, unknown> {
  const requestedReasonCodes = normalizeReasonCodes(resolution.allocation.reasonCodes);
  const resolutionReasonCodes = normalizeReasonCodes(resolution.resolutionCodes);
  const receiptReasonCodes = [...new Set([...requestedReasonCodes, ...resolutionReasonCodes])];
  const featurePayload = JSON.stringify({
    phase: resolution.allocation.phase,
    tier: resolution.allocation.tier,
    runtimeId: resolution.allocation.runtimeId ?? null,
    modelId: resolution.allocation.modelId ?? null,
    effort: resolution.allocation.effort,
    requirements: resolution.allocation.requirements,
    requirementsVerified: resolution.requirementsVerified,
    reasonCodes: requestedReasonCodes,
  });
  const featureHash = createHash("sha256").update(featurePayload).digest("hex");
  const fallback = resolution.source === "safe-fallback";
  const resolvedModelId = resolution.runtime.model ?? null;
  const hasResolvedCurrent = Boolean(resolvedModelId && resolution.resolvedRuntimeId);
  const status = resolution.source === "manual-override" && hasResolvedCurrent
    ? "user-pin"
    : fallback && hasResolvedCurrent
      ? "fallback-current"
      : !fallback && hasResolvedCurrent
        ? "resolved"
        : "unresolved";
  return {
    schemaVersion: "agentlas.model-allocation-receipt.v1",
    decisionId: `desktop:model-allocation:${featureHash.slice(0, 24)}`,
    packetId: null,
    status,
    requested: {
      tier: resolution.allocation.tier,
      modelClass: resolution.allocation.modelClass ?? null,
      modelId: resolution.allocation.modelId ?? null,
      effort: resolution.allocation.effort,
    },
    resolved: {
      tier: resolution.resolvedTier,
      provider: resolution.runtime.backend ?? resolution.runtime.kind,
      modelId: resolvedModelId,
      sessionId: resolution.resolvedRuntimeId,
      effort: resolution.runtime.effort ?? "none",
    },
    reasonCodes: receiptReasonCodes,
    inputFeatureHash: `sha256:${featureHash}`,
    selectorVersion: "agentlas-desktop.parent-ai.v1",
    independentVerificationRequired: requestedReasonCodes.some((code) =>
      code === "high-risk" || code === "critical-risk" || code === "independent-verification",
    ),
    validationIssues: fallback ? requestedReasonCodes : [],
    privacy: { rawPromptIncluded: false, rawTranscriptIncluded: false },
  };
}

export function workloadAllocationPromptExample(phase: WorkloadPhase): string {
  return JSON.stringify({
    schema: "agentlas.workload-allocation.v1",
    runtimeId: "runtime-1 (copy exactly from LIVE_RUNTIME_INVENTORY)",
    modelId: "exact live model ID copied from that runtime",
    tier: "economy|balanced|frontier",
    modelClass: "optional: auto|haiku|luna|flash|mini|sonnet|terra|tera|composer|opus|sol|grok",
    effort: "none|minimal|low|medium|high|xhigh|max",
    phase,
    requirements: {
      inputTokens: 12000,
      expectedOutputTokens: 2000,
      toolRequired: false,
      multimodalRequired: false,
    },
    reasonCodes: ["bounded-scope|parallel-throughput|complex-reasoning|large-context|high-risk|cross-result-synthesis"],
    rationale: "short observable reason; no hidden chain-of-thought",
  });
}

export function workloadAllocationInventoryPrompt(
  runtimes: RuntimeStatus | RuntimeStatus[],
): string {
  const list = Array.isArray(runtimes) ? runtimes : [runtimes];
  return [
    "LIVE_RUNTIME_INVENTORY is authoritative. Copy runtimeId and modelId exactly from the same entry; never infer or invent a provider model ID from tier or modelClass.",
    `LIVE_RUNTIME_INVENTORY=${JSON.stringify(workloadRuntimeInventory(list))}`,
  ].join("\n");
}
