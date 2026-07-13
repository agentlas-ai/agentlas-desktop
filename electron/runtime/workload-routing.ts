import type { AgentRuntimeOverride, RuntimeStatus } from "../../shared/types";
import { createHash } from "node:crypto";

/**
 * A parent LLM assigns provider-neutral capacity. Host policy code only
 * validates the exact selected id against the live runtime inventory. It never
 * infers difficulty from task words or translates a tier into a provider model.
 */
export type WorkloadModelTier = "economy" | "balanced" | "frontier";
export type WorkloadEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type WorkloadPhase = "plan" | "delegate" | "synthesize";

export interface WorkloadAllocation {
  schema: "agentlas.workload-allocation.v1";
  tier: WorkloadModelTier;
  effort: WorkloadEffort;
  phase: WorkloadPhase;
  /** Exact id selected by the parent AI from the host-advertised live inventory. */
  exactModelId?: string;
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
  return null;
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
    exactModelId: undefined,
    reasonCodes: [reasonCode],
    rationale: "Safe non-frontier fallback because no valid parent allocation was available.",
  };
}

/** Accepts provider-neutral tiers; model names never imply cost or capability. */
export function normalizeWorkloadAllocation(
  value: unknown,
  expectedPhase: WorkloadPhase,
): WorkloadAllocation {
  const obj = asObject(value);
  const tier = normalizeWorkloadTier(obj.tier ?? obj.modelTier ?? obj.model_tier);
  const effort = normalizeEffort(obj.effort);
  const phase = normalizePhase(obj.phase);
  if (!tier || !effort || !phase || phase !== expectedPhase) {
    return defaultWorkloadAllocation(expectedPhase, "invalid-ai-allocation");
  }
  const reasonCodes = normalizeReasonCodes(obj.reasonCodes ?? obj.reason_codes);
  return {
    schema: "agentlas.workload-allocation.v1",
    tier,
    effort,
    phase: expectedPhase,
    exactModelId: cleanText(obj.exactModelId ?? obj.exact_model_id ?? obj.modelId, 160) || undefined,
    reasonCodes: reasonCodes.length > 0 ? reasonCodes : ["ai-assigned"],
    rationale: cleanText(obj.rationale, 240) || "Parent AI assigned capacity for this phase.",
  };
}

function liveModelInventory(runtime: RuntimeStatus): string[] {
  const detected = (runtime.allocationModels ?? runtime.availableModels ?? []).map((model) => model.trim()).filter(Boolean);
  if (runtime.model) detected.unshift(runtime.model);
  return [...new Set(detected)];
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

  const resolutionCodes: string[] = [];
  const inventory = liveModelInventory(input.runtime);
  const model = allocation.exactModelId && inventory.includes(allocation.exactModelId)
    ? allocation.exactModelId
    : null;
  if (!allocation.exactModelId) resolutionCodes.push("parent-exact-model-missing-active-preserved");
  else if (!model) resolutionCodes.push("parent-model-not-in-live-inventory-active-preserved");
  else if (model !== input.runtime.model) resolutionCodes.push("parent-live-model-selected");
  else resolutionCodes.push("active-model-parent-selected");

  const effort = resolveEffort(input.runtime, allocation.effort);
  if (effort.code) resolutionCodes.push(effort.code);
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

/** Receipt deliberately excludes user prompts, briefs, history, and tool data. */
export function workloadAllocationReceipt(resolution: WorkloadResolution): Record<string, unknown> {
  const featurePayload = JSON.stringify({
    phase: resolution.allocation.phase,
    tier: resolution.allocation.tier,
    exactModelId: resolution.allocation.exactModelId ?? null,
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
      modelClass: null,
      modelId: resolution.allocation.exactModelId ?? null,
      effort: resolution.allocation.effort,
    },
    resolved: {
      tier: resolution.allocation.tier,
      provider: resolution.runtime.backend ?? resolution.runtime.kind,
      modelId: resolution.runtime.model ?? resolution.runtime.kind,
      sessionId: null,
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
    exactModelId: "model-id-from-live-inventory",
    tier: "economy|balanced|frontier",
    effort: "none|minimal|low|medium|high|xhigh|max",
    phase,
    reasonCodes: ["bounded-scope|parallel-throughput|complex-reasoning|large-context|high-risk|cross-result-synthesis"],
    rationale: "short observable reason; no hidden chain-of-thought",
  });
}

export function workloadAllocationInventoryPrompt(runtime: RuntimeStatus): string {
  return [
    "LIVE_MODEL_INVENTORY is authoritative. Choose exactModelId only from it; never infer or invent a model id from a tier.",
    `LIVE_MODEL_INVENTORY=${JSON.stringify(liveModelInventory(runtime))}`,
  ].join("\n");
}
