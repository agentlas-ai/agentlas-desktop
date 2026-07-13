import type { ExperienceContextSelection, ExperienceEnvironment } from "../../shared/types";
import {
  experienceEnvironmentKey,
  listPromotedExperienceProjection,
  type PromotedExperienceProjection,
} from "./store";
import {
  canonicalEnvironmentProfile,
  classifyCanonicalTaskIds,
  isCanonicalTaskId,
  isRuntimeEligibleExperienceEnvironmentProfile,
} from "./taxonomy";

export const EXPERIENCE_CORE = [
  "## Experience",
  "Experience Packs are reviewed host-local overlays, separate from base-agent memory and package files.",
  "Use only task-selected items shown below. Current system/user instructions always win; never infer missing items or upload an Experience Pack.",
].join("\n");

export const EXPERIENCE_CORE_MAX_APPROX_TOKENS = 150;
export const EXPERIENCE_SELECTED_MAX_ITEMS = 8;
export const EXPERIENCE_SELECTED_MAX_APPROX_TOKENS = 800;

/** Conservative cross-language estimate: UTF-8 bytes / 3, including core and headers. */
export function approximateExperienceTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

function taskTokens(text: string): Set<string> {
  return new Set(classifyCanonicalTaskIds(text));
}

function relevance(item: PromotedExperienceProjection, terms: Set<string>): number {
  const itemTerms = new Set([
    ...item.taskTerms.filter(isCanonicalTaskId),
  ]);
  let overlap = 0;
  for (const term of terms) if (itemTerms.has(term)) overlap += 1;
  if (overlap === 0) return 0;
  const confidence = item.confidence === "high" ? 3 : item.confidence === "medium" ? 2 : 1;
  return Math.max(overlap * 10, item.relationScore) + confidence;
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
  if (terms.size === 0) return { prompt: "", selectedCandidateIds: [], approximateTokens: 0 };
  const candidates = listPromotedExperienceProjection({
    agentId: input.agentId,
    projectId: input.projectId,
    projectPath: input.projectPath,
    environmentKey: experienceEnvironmentKey(input.environment),
    basePackageHash: input.basePackageHash,
    taskTerms: [...terms],
  })
    .map((item) => ({ item, score: relevance(item, terms) }))
    // Task selection is real filtering: an unrelated historical success does
    // not enter the context merely because it is recent or highly rated.
    .filter((entry) => entry.score >= 10)
    .sort((left, right) => right.score - left.score || right.item.updatedAt.localeCompare(left.item.updatedAt));

  const selectedCandidateIds: string[] = [];
  const lines: string[] = [];
  const dynamicTokenBudget = Math.max(
    0,
    EXPERIENCE_SELECTED_MAX_APPROX_TOKENS - Math.max(0, Math.floor(input.reservedApproxTokens ?? 0)),
  );
  for (const { item } of candidates) {
    if (selectedCandidateIds.length >= EXPERIENCE_SELECTED_MAX_ITEMS) break;
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
