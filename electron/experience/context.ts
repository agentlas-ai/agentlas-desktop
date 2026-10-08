import type { ExperienceContextSelection, ExperienceEnvironment } from "../../shared/types";
import {
  currentExperienceBaseHash,
  experienceEnvironmentKey,
  experienceProjectScopeKey,
  listPromotedExperienceProjection,
  type PromotedExperienceProjection,
} from "./store";
import {
  canonicalEnvironmentProfile,
  classifyCanonicalTaskIds,
  isRuntimeEligibleExperienceEnvironmentProfile,
} from "./taxonomy";
import { localEmbeddingTokens, rankHybridLocal } from "../memory/local-embedding";
import { nativeRecallFor } from "../memory/native-text";
import { createExperienceApplicationSnapshot } from "./application";

export const EXPERIENCE_CORE = [
  "## Experience",
  "Experience Packs are reviewed host-local overlays, separate from base-agent memory and package files.",
  "Use only task-selected items shown below. Current system/user instructions always win; never infer missing items or upload an Experience Pack.",
].join("\n");

export const EXPERIENCE_CORE_MAX_APPROX_TOKENS = 150;
export const EXPERIENCE_SELECTED_MAX_ITEMS = 8;
export const EXPERIENCE_SELECTED_MAX_APPROX_TOKENS = 800;

export interface ExperienceRoutingPrior {
  score: number;
  reason: string;
  matchedTerms: string[];
}

/** Conservative cross-language estimate: UTF-8 bytes / 3, including core and headers. */
export function approximateExperienceTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

function taskTokens(text: string): Set<string> {
  return new Set(classifyCanonicalTaskIds(text));
}

function confidencePrior(item: PromotedExperienceProjection): number {
  const confidence = item.confidence === "high" ? 1 : item.confidence === "medium" ? 0.6 : 0.2;
  return confidence + Math.min(1, Math.max(0, item.relationScore) / 10);
}

function listRuntimeBoundExperienceProjection(input: {
  agentId: string;
  projectId?: string | null;
  projectPath?: string | null;
  environment: ExperienceEnvironment;
  basePackageHash: string;
  taskTerms: string[];
}): PromotedExperienceProjection[] {
  // Auto-intake before provider selection is attested to the Desktop host
  // envelope. Runtime-specific Packs remain the first choice; the exact
  // Desktop-host envelope is the only fallback. This makes existing reviewed
  // Desktop Experience usable without weakening project/base/environment
  // equality or accepting an arbitrary foreign runtime.
  const environments = [
    input.environment,
    { ...input.environment, runtimeKind: "agentlas-desktop" },
  ];
  const byId = new Map<string, PromotedExperienceProjection>();
  const seenKeys = new Set<string>();
  for (const environment of environments) {
    const profile = canonicalEnvironmentProfile(environment);
    if (!isRuntimeEligibleExperienceEnvironmentProfile(profile)) continue;
    const environmentKey = experienceEnvironmentKey(environment);
    if (seenKeys.has(environmentKey)) continue;
    seenKeys.add(environmentKey);
    for (const candidate of listPromotedExperienceProjection({
      agentId: input.agentId,
      projectId: input.projectId,
      projectPath: input.projectPath,
      environmentKey,
      basePackageHash: input.basePackageHash,
      taskTerms: input.taskTerms,
    })) {
      const current = byId.get(candidate.id);
      if (!current || candidate.relationScore > current.relationScore) byId.set(candidate.id, candidate);
    }
  }
  return [...byId.values()].sort((left, right) =>
    right.relationScore - left.relationScore || right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * Pre-route evidence from reviewed Experience owned by the current actor. This is
 * deliberately narrower than prompt injection: only canonical task relations
 * may influence agent choice, and an unverified/foreign-base chip contributes
 * nothing.
 */
export function buildExperienceRoutingPrior(input: {
  agentId: string;
  projectId?: string | null;
  projectPath?: string | null;
  environment: ExperienceEnvironment;
  basePackageHash: string | null;
  task: string;
}): ExperienceRoutingPrior | null {
  return null;
}

export function buildExperienceContext(input: {
  agentId: string;
  projectId?: string | null;
  projectPath?: string | null;
  environment: ExperienceEnvironment;
  basePackageHash: string | null;
  task: string;
  /** Tokens already occupied by the separate exact Taste session snapshot. */
  reservedApproxTokens?: number;
}): ExperienceContextSelection {
  return { prompt: "", selectedCandidateIds: [], approximateTokens: 0 };
}
