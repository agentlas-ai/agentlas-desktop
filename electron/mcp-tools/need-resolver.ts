// Which MCP tools does this task actually need?
//
// Replaces keyword auto-selection outright. The old path scored catalog entries against
// KEYWORD_HINTS ("search"/"검색"/"조사" → brave-search, "issue"/"commit" → github), so a
// Reddit posting automation that merely said "조사" was handed a Brave Search requirement
// and the user got a blocking "API key required" prompt for a tool the task never needed —
// which stopped automations that had been running fine for months.
//
// Two hard rules here:
//   1. NO WORD MATCHING decides anything. The connected model reads the task and names the
//      capabilities it genuinely needs. Catalog text is passed as inventory, never as a rule.
//   2. A tool this resolver did not confirm is NEVER attached, NEVER required, and NEVER
//      raises a key prompt. When no model answers, `decided` is false and the caller attaches
//      nothing optional — the run proceeds with whatever is already configured instead of
//      interrogating the user.
//
// Hub first: the Hub routing plugin already resolves capabilities and tool-calls correctly,
// so its entries are offered first and win ties against a local catalog entry.

import { judgeSubset, type JudgeHint, type SubsetVerdict } from "../system-agents/judgment";

export interface McpNeedCandidate {
  /** Catalog id or hub slug. */
  id: string;
  /** Human name shown to the model as inventory. */
  name: string;
  /** One-line description of what the tool does. */
  description: string;
  /** "hub" entries win over "local" ones for the same capability. */
  origin: "hub" | "local";
  /** True when using this tool would force a credential/API-key prompt on the user. */
  needsCredential?: boolean;
}

export interface ResolvedMcpNeeds {
  /** Ids the model confirmed the task genuinely needs. */
  needed: string[];
  /** True when a model actually answered. False = attach nothing, ask nothing. */
  decided: boolean;
  reason: string;
  /** Candidates dropped by the cap, so a truncated inventory is never read as "all of it". */
  omitted: string[];
  failureKind?: SubsetVerdict<string>["failureKind"];
  decisionFailure?: SubsetVerdict<string>["decisionFailure"];
  attempts?: SubsetVerdict<string>["attempts"];
}

export interface McpGoalNeedContext {
  objective: string;
  acceptanceCriteria: readonly string[];
}

export interface McpRuntimeCapabilities {
  /** Host-proven native browser access for this exact invocation. */
  nativeBrowser: "available" | "unavailable" | "unknown";
  /** Runtime-provided web search (for example Codex web_search or Claude WebSearch). */
  nativeWebSearch?: "available" | "unavailable" | "unknown";
}

/** Inventory ceiling for one judgment call. Hub entries are offered first, so a cut
 *  never silently drops a Hub capability in favour of a local one. */
// The judge must see the whole shelf. When Hub plugins joined the Build inventory
// this cap silently dropped 75 of 155 candidates — and because Hub entries are
// appended last, the cut fell entirely on them, so "the model chose" was really
// "the model never saw it". The real budget guard is MAX_INPUT_CHARS below
// (measured 2026-08-16: 155 candidates render to ~12k of the 24k allowance);
// this count cap only exists as a runaway backstop.
const MAX_CANDIDATES = 400;
const MAX_INPUT_CHARS = 24_000;

export const MCP_NEED_JUDGMENT_KIND = "mcp-tool-need";

export const MCP_NEED_JUDGMENT_QUESTION =
  "Which of the available tools does this task genuinely require in order to complete? Judge what the task actually does, not which words it contains.";

export const MCP_NEED_JUDGMENT_GUIDANCE = [
  "Name a tool ONLY when the task cannot be completed without it.",
  "Mentioning a topic is not a need: a task that says 'research'/'조사'/'검색' while posting to a site does not need a web-search tool, and a task that mentions an issue or a commit does not need the GitHub tool.",
  "Prefer a 'hub' entry over a 'local' one when both cover the same capability.",
  "Judge the whole Goal objective and every acceptance criterion when a Goal contract is supplied; the latest task text may only be one implementation step.",
  "Treat a native browser as available only when the runtime capability context explicitly says available. Unknown or unavailable means you must not assume the runtime has its own browser, UI capture, or interaction channel.",
  "Even an available native browser satisfies a criterion only when it can produce the required evidence on the same target surface; availability alone does not prove Desktop can observe that surface.",
  "When a criterion requires rendered UI, interaction, screenshots, or browser-visible evidence and no explicit runtime capability supplies it, select the appropriate offered browser or computer-use tool.",
  "When nativeWebSearch=available, use the runtime's built-in web search and do not select a credentialed Brave Search MCP unless the user explicitly requested that exact service.",
  "Do not select a browser merely because the task mentions an app, Flutter, frontend, or a website. Source-only implementation, build, or test criteria may need no browser.",
  "Return an empty list only when every capability required for the complete Goal is either explicitly available in the runtime context or needs none of the offered tools.",
  "An entry marked 'needs credential' costs the user a blocking API-key prompt before the run starts, so name it only when the task is impossible without it.",
  "Err toward returning fewer tools.",
].join(" ");

const MAX_GOAL_OBJECTIVE_CHARS = 2_000;
const MAX_GOAL_CRITERIA_CHARS = 6_000;
const MAX_TASK_CHARS = 3_000;

function boundedText(value: string, limit: number): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 12)).trimEnd()} [truncated]`;
}

/** Keep every criterion represented when a large contract must be bounded. */
export function renderMcpGoalNeedContext(goal?: McpGoalNeedContext): string {
  if (!goal) return "GOAL CONTRACT:\nnone";
  const criteria = goal.acceptanceCriteria.slice(0, 32);
  const perCriterionBudget = criteria.length > 0
    ? Math.max(80, Math.floor(MAX_GOAL_CRITERIA_CHARS / criteria.length) - 8)
    : MAX_GOAL_CRITERIA_CHARS;
  const renderedCriteria = criteria.map((criterion, index) =>
    `${index + 1}. ${boundedText(criterion, perCriterionBudget)}`);
  if (goal.acceptanceCriteria.length > criteria.length) {
    renderedCriteria.push(`[${goal.acceptanceCriteria.length - criteria.length} further criteria omitted]`);
  }
  return [
    "GOAL CONTRACT (host-owned, judge the complete contract):",
    `Objective: ${boundedText(goal.objective, MAX_GOAL_OBJECTIVE_CHARS) || "unspecified"}`,
    "Acceptance criteria:",
    renderedCriteria.join("\n") || "none supplied",
  ].join("\n");
}

function renderMcpRuntimeCapabilities(capabilities?: McpRuntimeCapabilities): string {
  return [
    "RUNTIME CAPABILITIES (host-proven for this invocation):",
    `nativeBrowser=${capabilities?.nativeBrowser ?? "unknown"}`,
    `nativeWebSearch=${capabilities?.nativeWebSearch ?? "unknown"}`,
  ].join("\n");
}

/**
 * Ask the connected model which of the available tools the task really needs.
 * Never falls back to keyword scoring: an undecided run attaches no optional tool.
 */
export async function resolveMcpNeeds(input: {
  task: string;
  candidates: McpNeedCandidate[];
  goal?: McpGoalNeedContext;
  runtimeCapabilities?: McpRuntimeCapabilities;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injectable judge (tests). Defaults to the resident judgment service. */
  judgeSubsetFn?: typeof judgeSubset;
}): Promise<ResolvedMcpNeeds> {
  const ordered = preferHub(input.candidates);
  const candidates = ordered.slice(0, MAX_CANDIDATES);
  const omitted = ordered.slice(MAX_CANDIDATES).map((candidate) => candidate.id);
  if (!input.task.trim() || candidates.length === 0) {
    return { needed: [], decided: false, reason: "no task or no candidates", omitted };
  }

  const inventory = candidates
    .map(
      (candidate) =>
        `- ${candidate.id} (${candidate.origin}${candidate.needsCredential ? ", needs credential" : ""}): ${candidate.name} — ${candidate.description}`,
    )
    .join("\n");

  const verdict = await (input.judgeSubsetFn ?? judgeSubset)({
    kind: MCP_NEED_JUDGMENT_KIND,
    question: MCP_NEED_JUDGMENT_QUESTION,
    labels: candidates.map((candidate) => candidate.id),
    input: [
      renderMcpGoalNeedContext(input.goal),
      renderMcpRuntimeCapabilities(input.runtimeCapabilities),
      `CURRENT TASK:\n${boundedText(input.task, MAX_TASK_CHARS)}`,
      `AVAILABLE TOOLS:\n${inventory}`,
    ].join("\n\n"),
    guidance: MCP_NEED_JUDGMENT_GUIDANCE,
    maxInputChars: MAX_INPUT_CHARS,
    signal: input.signal,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });

  if (verdict.source !== "llm") {
    return { needed: [], decided: false, reason: "no connected model answered", omitted,
      ...(verdict.failureKind ? { failureKind: verdict.failureKind } : {}),
      ...(verdict.decisionFailure ? { decisionFailure: verdict.decisionFailure } : {}),
      ...(verdict.attempts ? { attempts: verdict.attempts } : {}) };
  }
  return {
    needed: verdict.selected,
    decided: true,
    reason: verdict.reason,
    omitted,
  };
}

export interface McpBuildRecommendCandidate {
  /** Catalog id, or `custom:<serverId>` for a user-installed server. */
  id: string;
  name: string;
  description: string;
  origin: "catalog" | "custom" | "hub";
  needsCredential?: boolean;
}

export interface ResolvedMcpBuildRecommendations {
  /** Ids the model chose to offer, in the model's preference order. */
  recommended: string[];
  /** True when a model actually answered. False = recommend nothing, never keyword-score. */
  decided: boolean;
  reason: string;
  omitted: string[];
}

export const MCP_BUILD_RECOMMEND_JUDGMENT_KIND = "mcp-build-recommend";

export const MCP_BUILD_RECOMMEND_QUESTION =
  "Which of the available tools should be offered for the agent this request asks to build? Judge what the built agent will actually do — in any language — not which words the request contains.";

export const MCP_BUILD_RECOMMEND_GUIDANCE = [
  "Recommend a tool only when the built agent's job genuinely involves that capability.",
  "Mentioning a topic is not a need: a request that says 'research'/'조사' in passing does not make a web-search tool necessary.",
  "A 'custom' entry is a server the user installed themselves — include it only when the request clearly refers to it or to its purpose.",
  "An empty list is a valid answer. Err toward fewer tools; every entry costs the user a review decision, and one marked 'needs credential' costs an API-key setup.",
].join(" ");

/**
 * Ask the connected model which tools to OFFER in the Build review sheet.
 * The sibling of `resolveMcpNeeds` for build time: same rule — an undecided
 * run recommends nothing instead of reverting to keyword scores.
 */
export async function resolveMcpBuildRecommendations(input: {
  request: string;
  candidates: McpBuildRecommendCandidate[];
  /** Old catalog wordlists, demoted to model reference only. */
  hints?: JudgeHint<string>[];
  signal?: AbortSignal;
  /** Injectable judge (tests). Defaults to the resident judgment service. */
  judgeSubsetFn?: typeof judgeSubset;
}): Promise<ResolvedMcpBuildRecommendations> {
  const candidates = input.candidates.slice(0, MAX_CANDIDATES);
  const omitted = input.candidates.slice(MAX_CANDIDATES).map((candidate) => candidate.id);
  if (!input.request.trim() || candidates.length === 0) {
    return { recommended: [], decided: false, reason: "no request or no candidates", omitted };
  }

  const inventory = candidates
    .map(
      (candidate) =>
        `- ${candidate.id} (${candidate.origin}${candidate.needsCredential ? ", needs credential" : ""}): ${candidate.name} — ${candidate.description}`,
    )
    .join("\n");

  const verdict = await (input.judgeSubsetFn ?? judgeSubset)({
    kind: MCP_BUILD_RECOMMEND_JUDGMENT_KIND,
    question: MCP_BUILD_RECOMMEND_QUESTION,
    labels: candidates.map((candidate) => candidate.id),
    input: `BUILD REQUEST:\n${input.request.slice(0, 4000)}\n\nAVAILABLE TOOLS:\n${inventory}`,
    guidance: MCP_BUILD_RECOMMEND_GUIDANCE,
    hints: input.hints,
    maxInputChars: MAX_INPUT_CHARS,
    signal: input.signal,
  });

  if (verdict.source !== "llm") {
    return { recommended: [], decided: false, reason: "no connected model answered", omitted };
  }
  return { recommended: verdict.selected, decided: true, reason: verdict.reason, omitted };
}

/** Hub entries win over local ones covering the same capability, and are offered first. */
export function preferHub(candidates: McpNeedCandidate[]): McpNeedCandidate[] {
  const byName = new Map<string, McpNeedCandidate>();
  for (const candidate of candidates) {
    const key = candidate.name.trim().toLowerCase();
    const existing = byName.get(key);
    if (!existing || (existing.origin === "local" && candidate.origin === "hub")) {
      byName.set(key, candidate);
    }
  }
  return [...byName.values()].sort((a, b) => (a.origin === b.origin ? 0 : a.origin === "hub" ? -1 : 1));
}
