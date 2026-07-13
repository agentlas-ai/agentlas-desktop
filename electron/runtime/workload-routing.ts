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
  reasonCodes: string[];
  /** Short observable justification, never hidden reasoning or the task prompt. */
  rationale: string;
}

export interface WorkloadResolution {
  allocation: WorkloadAllocation;
  runtime: RuntimeStatus;
  source: "ai-assigned" | "manual-override" | "safe-fallback";
  resolutionCodes: string[];
}

export interface WorkloadRuntimeInventoryEntry {
  runtimeId: string;
  kind: RuntimeStatus["kind"];
  backend: RuntimeStatus["backend"];
  models: string[];
  efforts: WorkloadEffort[];
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

function receiptSafeRationale(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/(?:\/[A-Za-z0-9._~ -]+){2,}/g, "[redacted-path]")
    .replace(/\b(?:sk|rk|pk|xox[baprs]|gh[pousr])-[A-Za-z0-9_=-]{12,}\b/g, "[redacted-secret]")
    .slice(0, 240);
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
    const code = cleanText(item, 48).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (code && !out.includes(code)) out.push(code);
    if (out.length >= MAX_REASON_CODES) break;
  }
  return out;
}

export function defaultWorkloadAllocation(
  phase: WorkloadPhase,
  reasonCode = "missing-ai-allocation",
): WorkloadAllocation {
  return {
    schema: "agentlas.workload-allocation.v1",
    tier: "balanced",
    effort: phase === "synthesize" ? "high" : "medium",
    phase,
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
  const reasonCodes = normalizeReasonCodes(obj.reasonCodes ?? obj.reason_codes);
  return {
    schema: "agentlas.workload-allocation.v1",
    ...(runtimeId ? { runtimeId } : {}),
    ...(modelId ? { modelId } : {}),
    tier,
    ...(modelClass && (modelClass === "auto" || TIER_ALIASES[tier].includes(modelClass)) ? { modelClass } : {}),
    effort,
    phase: expectedPhase,
    reasonCodes: reasonCodes.length > 0 ? reasonCodes : ["ai-assigned"],
    rationale: cleanText(obj.rationale, 240) || "Parent AI assigned capacity for this phase.",
  };
}

function liveModelInventory(runtime: RuntimeStatus): string[] {
  const safe = (runtime.allocationModels ?? [])
    .map((model) => cleanText(model, 180))
    .filter((model) => /^[A-Za-z0-9][A-Za-z0-9._:+/() -]{0,179}$/.test(model));
  return [...new Set(safe)];
}

/** Value-safe inventory shown to the parent LLM. It intentionally has no paths, account IDs, prompts or secrets. */
export function workloadRuntimeInventory(runtimes: RuntimeStatus[]): WorkloadRuntimeInventoryEntry[] {
  return runtimes.map((runtime, index) => ({
    runtimeId: `runtime-${index + 1}`,
    kind: runtime.kind,
    backend: runtime.backend,
    models: liveModelInventory(runtime),
    efforts: supportedEfforts(runtime),
  }));
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

function supportedEfforts(runtime: RuntimeStatus): WorkloadEffort[] {
  if (runtime.efforts) {
    return runtime.efforts
      .map((entry) => normalizeEffort(entry.id))
      .filter((effort): effort is WorkloadEffort => Boolean(effort));
  }
  // Codex exposes this as a stable config capability rather than a discovery API.
  if (runtime.kind === "codex") return ["none", "minimal", "low", "medium", "high", "xhigh"];
  return [];
}

function resolveEffort(runtime: RuntimeStatus, requested: WorkloadEffort): { effort?: string; code?: string } {
  const supported = supportedEfforts(runtime);
  if (supported.length === 0) {
    return { effort: runtime.effort ?? undefined, code: "effort-capability-unavailable" };
  }
  if (supported.includes(requested)) return { effort: requested };
  const requestedRank = EFFORTS.indexOf(requested);
  const ranked = supported.slice().sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  const below = ranked.filter((effort) => EFFORTS.indexOf(effort) <= requestedRank).at(-1);
  return { effort: below ?? ranked[0], code: "effort-clamped-to-capability" };
}

export function resolveWorkloadAllocation(input: {
  allocation?: WorkloadAllocation | null;
  runtime: RuntimeStatus;
  phase: WorkloadPhase;
  manualOverride?: AgentRuntimeOverride | null;
  explicitPinned?: boolean;
}): WorkloadResolution {
  const allocation = input.allocation ?? defaultWorkloadAllocation(input.phase);
  if (input.manualOverride || input.explicitPinned) {
    return {
      allocation,
      runtime: { ...input.runtime },
      source: "manual-override",
      resolutionCodes: ["manual-runtime-override-preserved"],
    };
  }

  const model = allocation.modelId && liveModelInventory(input.runtime).includes(allocation.modelId)
    ? allocation.modelId
    : null;
  if (!model) {
    const effort = resolveEffort(input.runtime, allocation.effort);
    return {
      allocation,
      runtime: {
        ...input.runtime,
        effort: effort.effort ?? input.runtime.effort,
      },
      source: "safe-fallback",
      resolutionCodes: [
        allocation.modelId
          ? "parent-model-not-in-live-inventory-active-preserved"
          : "parent-exact-model-missing-active-preserved",
        ...(effort.code ? [effort.code] : []),
      ],
    };
  }
  const effort = resolveEffort(input.runtime, allocation.effort);
  const resolutionCodes = [
    model === input.runtime.model ? "active-model-parent-selected" : "parent-live-model-selected",
    ...(effort.code ? [effort.code] : []),
  ];
  const fallback = allocation.reasonCodes.includes("missing-ai-allocation") || allocation.reasonCodes.includes("invalid-ai-allocation");
  return {
    allocation,
    runtime: {
      ...input.runtime,
      model: model ?? input.runtime.model,
      effort: effort.effort ?? input.runtime.effort,
    },
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
}): WorkloadResolution {
  const allocation = input.allocation ?? defaultWorkloadAllocation(input.phase);
  if (input.manualOverride || input.explicitPinned) {
    return resolveWorkloadAllocation({
      allocation,
      runtime: input.fallbackRuntime,
      phase: input.phase,
      manualOverride: input.manualOverride,
      explicitPinned: input.explicitPinned,
    });
  }

  // Parent output is data, never a provider alias. The host only validates the
  // opaque runtime ID and exact model ID it advertised for this invocation.
  if (allocation.runtimeId && allocation.modelId) {
    const requestedRuntime = runtimeForInventoryId(input.runtimes, allocation.runtimeId);
    if (requestedRuntime && liveModelInventory(requestedRuntime).includes(allocation.modelId)) {
      const effort = resolveEffort(requestedRuntime, allocation.effort);
      const fallback = allocation.reasonCodes.includes("missing-ai-allocation") || allocation.reasonCodes.includes("invalid-ai-allocation");
      return {
        allocation,
        runtime: {
          ...requestedRuntime,
          model: allocation.modelId,
          effort: effort.effort ?? requestedRuntime.effort,
        },
        source: fallback ? "safe-fallback" : "ai-assigned",
        resolutionCodes: ["parent-selected-live-runtime-model", ...(effort.code ? [effort.code] : [])],
      };
    }
  }
  const fallbackEffort = resolveEffort(input.fallbackRuntime, allocation.effort);
  return {
    allocation,
    runtime: {
      ...input.fallbackRuntime,
      effort: fallbackEffort.effort ?? input.fallbackRuntime.effort,
    },
    source: "safe-fallback",
    resolutionCodes: [
      !allocation.runtimeId || !allocation.modelId
        ? "parent-runtime-model-pair-missing-active-preserved"
        : "parent-runtime-model-pair-invalid-active-preserved",
      ...(fallbackEffort.code ? [fallbackEffort.code] : []),
    ],
  };
}

/** Receipt deliberately excludes user prompts, briefs, history, and tool data. */
export function workloadAllocationReceipt(resolution: WorkloadResolution): Record<string, unknown> {
  const featurePayload = JSON.stringify({
    phase: resolution.allocation.phase,
    tier: resolution.allocation.tier,
    runtimeId: resolution.allocation.runtimeId ?? null,
    modelId: resolution.allocation.modelId ?? null,
    effort: resolution.allocation.effort,
    reasonCodes: resolution.allocation.reasonCodes,
  });
  const featureHash = createHash("sha256").update(featurePayload).digest("hex");
  const fallback = resolution.source === "safe-fallback";
  return {
    schemaVersion: "agentlas.model-allocation-receipt.v1",
    decisionId: `desktop:model-allocation:${featureHash.slice(0, 24)}`,
    packetId: null,
    status: resolution.source === "manual-override" ? "user-pin" : fallback ? "fallback-current" : "resolved",
    requested: {
      tier: resolution.allocation.tier,
      modelClass: resolution.allocation.modelClass ?? null,
      sessionId: resolution.allocation.runtimeId ?? null,
      modelId: resolution.allocation.modelId ?? null,
      effort: resolution.allocation.effort,
    },
    resolved: {
      tier: resolution.allocation.tier,
      provider: resolution.runtime.backend ?? resolution.runtime.kind,
      modelId: resolution.runtime.model ?? resolution.runtime.kind,
      sessionId: resolution.allocation.runtimeId ?? null,
      effort: resolution.runtime.effort ?? "none",
    },
    reasonCodes: [
      ...resolution.allocation.reasonCodes,
      ...resolution.resolutionCodes,
      receiptSafeRationale(resolution.allocation.rationale).slice(0, 120),
    ],
    inputFeatureHash: `sha256:${featureHash}`,
    selectorVersion: "agentlas-desktop.parent-ai.v1",
    independentVerificationRequired: resolution.allocation.reasonCodes.some((code) =>
      code === "high-risk" || code === "critical-risk" || code === "independent-verification",
    ),
    validationIssues: fallback ? resolution.allocation.reasonCodes : [],
    privacy: { rawPromptIncluded: false, rawTranscriptIncluded: false },
  };
}

export function workloadAllocationPromptExample(phase: WorkloadPhase): string {
  return JSON.stringify({
    runtimeId: "runtime-1 (copy exactly from LIVE_RUNTIME_INVENTORY)",
    modelId: "exact live model ID copied from that runtime",
    tier: "economy|balanced|frontier",
    modelClass: "optional: auto|haiku|luna|flash|mini|sonnet|terra|composer|opus|sol|grok",
    effort: "none|minimal|low|medium|high|xhigh|max",
    phase,
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
