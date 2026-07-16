import type { ExperienceContextSelection, ExperienceEnvironment } from "../../shared/types";
import {
  experienceEnvironmentKey,
  listPromotedExperienceProjection,
  type PromotedExperienceProjection,
} from "./store";
import {
  canonicalEnvironmentProfile,
  classifyCanonicalTaskIds,
  isRuntimeEligibleExperienceEnvironmentProfile,
} from "./taxonomy";
import { localEmbeddingTokens, rankHybridLocal } from "../memory/local-embedding";

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
 * Pre-route evidence from reviewed, exact-base-bound Experience items. This is
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
  if (!input.basePackageHash || !/^[a-f0-9]{64}$/.test(input.basePackageHash)) return null;
  const environmentProfile = canonicalEnvironmentProfile(input.environment);
  if (!isRuntimeEligibleExperienceEnvironmentProfile(environmentProfile)) return null;
  const taskTerms = classifyCanonicalTaskIds(input.task);
  if (taskTerms.length === 0) return null;
  const candidates = listRuntimeBoundExperienceProjection({
    agentId: input.agentId,
    projectId: input.projectId,
    projectPath: input.projectPath,
    environment: input.environment,
    basePackageHash: input.basePackageHash,
    taskTerms,
  });
  const related = candidates
    .filter((candidate) => candidate.relationScore > 0)
    .sort((left, right) => right.relationScore - left.relationScore || right.updatedAt.localeCompare(left.updatedAt));
  if (related.length === 0) return null;
  const taskSet = new Set(taskTerms);
  const matchedTerms = [...new Set(related.flatMap((candidate) =>
    candidate.taskTerms.filter((term) => taskSet.has(term))))].slice(0, 6);
  if (matchedTerms.length === 0) return null;
  const bestEvidenceFit = rankHybridLocal(input.task, related.map((candidate) => ({
    id: candidate.id,
    text: `${candidate.summary} ${candidate.taskTerms.join(" ")}`,
    embedding: candidate.embedding,
    prior: confidencePrior(candidate),
  })))[0]?.score ?? 0;
  return {
    // Promoted + attested/verified + exact base + exact environment + canonical
    // relation is equivalent to a curated routing hint, not a mere word match.
    // Bounded query fit breaks ties between several equally governed agents;
    // it can refine a valid relation but can never create one.
    score: Math.min(20, 12 + Math.max(0, bestEvidenceFit) * 4 + matchedTerms.length * 0.25),
    reason: `reviewed Experience matches ${matchedTerms.join(", ")}`,
    matchedTerms,
  };
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
  if (!input.basePackageHash || !/^[a-f0-9]{64}$/.test(input.basePackageHash)) {
    return { prompt: "", selectedCandidateIds: [], approximateTokens: 0 };
  }
  const environmentProfile = canonicalEnvironmentProfile(input.environment);
  if (!isRuntimeEligibleExperienceEnvironmentProfile(environmentProfile)) {
    return { prompt: "", selectedCandidateIds: [], approximateTokens: 0 };
  }
  const terms = taskTokens(input.task);
  if (localEmbeddingTokens(input.task).length === 0) {
    return { prompt: "", selectedCandidateIds: [], approximateTokens: 0 };
  }
  const candidates = listRuntimeBoundExperienceProjection({
    agentId: input.agentId,
    projectId: input.projectId,
    projectPath: input.projectPath,
    environment: input.environment,
    basePackageHash: input.basePackageHash,
    taskTerms: [...terms],
  });
  const ranked = rankHybridLocal(input.task, candidates.map((item) => ({
    id: item.id,
    text: `${item.summary} ${item.taskTerms.join(" ")}`,
    embedding: item.embedding,
    prior: confidencePrior(item),
    experience: item,
  }))).filter((entry) =>
    entry.lexicalScore > 0 || entry.semanticEligible || entry.item.experience.relationScore > 0);

  const selectedCandidateIds: string[] = [];
  const lines: string[] = [];
  const dynamicTokenBudget = Math.max(
    0,
    EXPERIENCE_SELECTED_MAX_APPROX_TOKENS - Math.max(0, Math.floor(input.reservedApproxTokens ?? 0)),
  );
  const candidateLines = ranked.map(({ item }) =>
    `- [experience:${item.experience.id}] ${item.experience.summary.replace(/\s+/g, " ").trim()}`);
  const allPrompt = candidateLines.length > 0
    ? `${EXPERIENCE_CORE}\n\n### Task-selected reviewed items\n${candidateLines.join("\n")}`
    : "";
  if (allPrompt && approximateExperienceTokens(allPrompt) <= dynamicTokenBudget) {
    return {
      prompt: allPrompt,
      selectedCandidateIds: ranked.map(({ item }) => item.experience.id),
      approximateTokens: approximateExperienceTokens(allPrompt),
    };
  }
  for (const { item: rankedItem } of ranked) {
    if (selectedCandidateIds.length >= EXPERIENCE_SELECTED_MAX_ITEMS) break;
    const item = rankedItem.experience;
    const line = `- [experience:${item.id}] ${item.summary.replace(/\s+/g, " ").trim()}`;
    const proposed = `${EXPERIENCE_CORE}\n\n### Task-selected reviewed items\n${[...lines, line].join("\n")}`;
    if (approximateExperienceTokens(proposed) > dynamicTokenBudget) continue;
    lines.push(line);
    selectedCandidateIds.push(item.id);
  }

  const prompt = lines.length > 0
    ? `${EXPERIENCE_CORE}\n\n### Task-selected reviewed items\n${lines.join("\n")}`
    : "";
  return {
    prompt,
    selectedCandidateIds,
    approximateTokens: approximateExperienceTokens(prompt),
  };
}
