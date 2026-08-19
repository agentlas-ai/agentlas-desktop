import type { AgentRuntimeOverride, RuntimeStatus } from "../../shared/types";
import { createHash } from "node:crypto";

/**
 * A parent LLM assigns provider-neutral capacity. Deterministic host code only
 * validates an exact runtime/model pair against the host's execution inventory.
 * It never infers difficulty from task words or manufactures provider model IDs.
 */
export type WorkloadModelTier = "economy" | "balanced" | "frontier";
/**
 * 열린 어휘 — provider가 새 리즌 레벨을 추가해도 이 타입을 고치지 않는다.
 * 2026-07-28 실측: codex debug models가 gpt-5.6-sol에서 "ultra"(자동 위임)를 광고했다.
 * 알려진 7단계는 KNOWN_EFFORTS로 남겨 랭크 폴백에만 쓴다(아래 effortRank).
 */
export type WorkloadEffort = string;
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
/**
 * 랭크 폴백 전용 — 모델이 스스로 광고한 목록에 없는 값의 상대 순서를 추정할 때만 쓴다.
 * 유효성 검사에는 절대 쓰지 않는다(EFFORT_TOKEN_RE가 그 역할). effortRank() 참고.
 */
const EFFORTS: WorkloadEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_TOKEN_RE = /^[a-z][a-z0-9-]{0,23}$/;
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

export function normalizeEffort(value: unknown): WorkloadEffort | null {
  const raw = cleanText(value, 24).toLowerCase();
  return EFFORT_TOKEN_RE.test(raw) ? raw : null;
}

/**
 * 랭크 산정 — supported(모델이 스스로 광고한 순서)가 뼈대다. value가 거기 있으면
 * own-index를 그대로 쓴다. 없지만 알려진 7단계 표(EFFORTS)의 값이면, supported
 * 안에서 "이 값보다 known-rank가 낮거나 같은" 마지막 항목 바로 뒤(소수 위치)에
 * 끼워 넣는다 — 항상 "목록 끝"으로 미는 옛 방식은 known 값이 실제로는 supported의
 * 상위권 항목보다 낮은 능력인데도 전부 통과시켜 버리는 역전을 낳았다(예: supported가
 * low/xhigh/max만 광고할 때 "medium"이 xhigh·max보다 낮다는 사실이 사라짐).
 * 알려진 표에도 없는 완전 미지의 값은 +Infinity로 둬 상한 비교에서 항상 밀린다.
 */
function effortRank(value: string, supported: readonly string[]): number {
  const own = supported.indexOf(value);
  if (own !== -1) return own;
  const known = EFFORTS.indexOf(value);
  if (known === -1) return Number.POSITIVE_INFINITY;
  let insertAfter = -1;
  supported.forEach((item, index) => {
    const itemKnown = EFFORTS.indexOf(item);
    if (itemKnown !== -1 && itemKnown <= known) insertAfter = index;
  });
  return insertAfter + 0.5;
}

/** 특정 모델 목록과 무관한 순수 전역 랭크 — admin 정책 상한처럼 한 모델의 서브셋에
 * 묶이면 안 되는 비교에 쓴다. 알려진 7단계 밖의 값은 +Infinity(=항상 상한 이상). */
function knownEffortRank(value: string): number {
  const known = EFFORTS.indexOf(value);
  return known !== -1 ? known : Number.POSITIVE_INFINITY;
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

/** raw.efforts의 발견 순서를 그대로 보존한다 — 고정 EFFORTS로 재정렬/재클램프하지 않는다. */
function dedupedEfforts(values: unknown[]): WorkloadEffort[] {
  const seen = new Set<string>();
  const found: WorkloadEffort[] = [];
  for (const entry of values) {
    const effort = normalizeEffort(entry);
    if (!effort || seen.has(effort)) continue;
    seen.add(effort);
    found.push(effort);
  }
  return found;
}

function safeModelProfile(runtime: RuntimeStatus, modelId: string) {
  const raw = runtime.allocationModelProfiles?.[modelId];
  if (!raw) return null;
  const costTier = normalizeWorkloadTier(raw.costTier);
  const capabilities = normalizeCapabilityList(raw.capabilities) ?? [];
  const efforts = raw.efforts === undefined
    ? null
    : Array.isArray(raw.efforts) && raw.efforts.length <= 32
      ? dedupedEfforts(raw.efforts)
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
    // union은 Set 삽입 순서를 보존한다 — 첫 모델의 발견 순서가 앞서고, 이후 모델이
    // 추가로 광고하는 값만 뒤에 덧붙는다. 고정 EFFORTS로 재정렬/재클램프하지 않는다.
    const union = new Set<WorkloadEffort>();
    let foundHostProfile = false;
    for (const candidate of liveModelInventory(runtime)) {
      const modelEfforts = safeModelProfile(runtime, candidate)?.efforts;
      if (modelEfforts === null || modelEfforts === undefined) continue;
      foundHostProfile = true;
      for (const effort of modelEfforts) union.add(effort);
    }
    if (foundHostProfile) return [...union];
  }
  // 모델별 실측 프로필이 전혀 없을 때만 쓰는 최후 폴백 — 발견 데이터가 아니므로
  // "ultra" 같은 새 값은 여기서 절대 나타날 수 없다. 최소한 알려진 7단계는 갖춘다.
  if (runtime.kind === "codex") return [...EFFORTS];
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
  const requestedRank = effortRank(requested, supported);
  const ranked = supported.slice().sort((a, b) => effortRank(a, supported) - effortRank(b, supported));
  const below = ranked.filter((effort) => effortRank(effort, supported) <= requestedRank).at(-1);
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
  const codes: string[] = [];
  // policy.maxEffort는 admin이 Agentlas 자체 어휘(EFFORTS)로 지정한 상한이지 특정
  // 모델의 광고 목록이 아니다 — knownEffortRank로만 비교한다. 모델별 서브셋 인덱스를
  // 쓰면(effortRank) supported=["max"] 같은 좁은 목록에서 "high"가 "max"보다 높게
  // 랭크되는 역전이 생긴다. 알려진 표에 없는 값(예: 신규 "ultra")은 +Infinity로 둬
  // 상한 비교에서 항상 안전하게(더 낮은 쪽으로) 밀리게 한다.
  let bounded = requested;
  if (policy.maxEffort && knownEffortRank(bounded) > knownEffortRank(policy.maxEffort)) {
    bounded = policy.maxEffort;
    codes.push("effort-clamped-to-host-policy");
  }
  const exactEfforts = modelId ? safeModelProfile(runtime, modelId)?.efforts : null;
  if (exactEfforts && exactEfforts.length === 0) {
    codes.push("effort-capability-unavailable");
    return { effort: null, codes };
  }
  const resolvedResult = resolveEffort(runtime, bounded, modelId);
  if (resolvedResult.code) codes.push(resolvedResult.code);
  const resolved = normalizeEffort(resolvedResult.effort);
  if (
    policy.maxEffort &&
    resolved &&
    knownEffortRank(resolved) > knownEffortRank(policy.maxEffort)
  ) {
    codes.push("effort-below-capability-unavailable");
    return { effort: null, codes: [...new Set(codes)] };
  }
  return { effort: resolvedResult.effort, codes };
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

export function modelRoleForWorkloadPhase(phase: WorkloadPhase): "orchestrator" | "worker" {
  return phase === "delegate" ? "worker" : "orchestrator";
}

/** Receipt deliberately excludes user prompts, briefs, history, and tool data. */
export function workloadAllocationReceipt(
  resolution: WorkloadResolution,
  observedUsage?: { inputTokens: number; outputTokens: number } | null,
): Record<string, unknown> {
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
    // v2: `role` joined the receipt around 2026-07-28 and `resolved.effort` can
    // now be null, both without a version bump — so the 46 receipts on this
    // machine are three different shapes all stamped v1, and a reader has no way
    // to tell which it holds. Measured: the 26 receipts written before
    // 2026-07-27 have no `role` key at all, which reads as "role unknown" and is
    // easy to mistake for "role was never assigned" (I made exactly that
    // mistake). A shape change needs a version, or the version is decoration.
    schemaVersion: "agentlas.model-allocation-receipt.v2",
    decisionId: `desktop:model-allocation:${featureHash.slice(0, 24)}`,
    packetId: null,
    role: modelRoleForWorkloadPhase(resolution.allocation.phase),
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
      // `?? "none"` turned an unknown into a value. Measured across the 46 live
      // receipts on this machine: 17 asked for medium/high and recorded
      // `resolved.effort: "none"`, and every one of those 17 carries NO
      // effort-* reason code — they are `missing-ai-allocation` +
      // `parent-runtime-model-pair-missing-active-preserved`, i.e. no
      // allocation happened at all and the active runtime was preserved with
      // whatever effort it never reported. The receipt read as "we deliberately
      // ran at no effort"; the truth was "nobody decided, and we do not know".
      //
      // The resolver already distinguishes the real cases with codes
      // (effort-clamped-to-capability, effort-below-capability-unavailable,
      // effort-capability-unavailable), so the only thing missing was for the
      // field to stop answering a question it had not been asked.
      effort: resolution.runtime.effort ?? null,
    },
    reasonCodes: receiptReasonCodes,
    inputFeatureHash: `sha256:${featureHash}`,
    selectorVersion: "agentlas-desktop.parent-ai.v1",
    independentVerificationRequired: requestedReasonCodes.some((code) =>
      code === "high-risk" || code === "critical-risk" || code === "independent-verification",
    ),
    usage: observedUsage
      && Number.isInteger(observedUsage.inputTokens)
      && observedUsage.inputTokens >= 0
      && Number.isInteger(observedUsage.outputTokens)
      && observedUsage.outputTokens >= 0
      ? {
          inputTokens: observedUsage.inputTokens,
          outputTokens: observedUsage.outputTokens,
        }
      : null,
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
