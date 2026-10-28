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

import { judgeSubset, noToolsJudgmentFallback, type JudgeHint, type SubsetVerdict } from "../system-agents/judgment";
import { isVerifiedJudgmentCapability } from "../system-agents/judgment-capability";
import { isToolJudgmentCompetent, readToolChoiceMeasurements, requiresMeasuredToolJudgment, toolJudgmentCompetence,
  type ToolChoiceMeasurement, type ToolJudgmentCompetence } from "../system-agents/judgment-competence";
import { invocationJudgmentContext, withInvocationJudgmentContext } from "../runtime/judgment-context";
import type { RuntimeSelection } from "../../shared/types";

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
  /**
   * "skill-plugin": an installed plugin whose skills (instructions + references) the
   * host inlines for this turn. No credential, no side effect, no install.
   */
  kind?: "tool" | "skill-plugin";
  /**
   * May the deterministic local-relevance fallback pick this when the judge cannot
   * answer? Only installed, credential-free entries qualify — the fallback must
   * never install a tool, raise a key prompt, or change the browser host binding.
   */
  fallbackEligible?: boolean;
  /**
   * Published by Agentlas (a built-in or Agentlas-published plugin). Wins over an
   * outside entry for the same capability (shared/capability-priority.ts).
   */
  agentlas?: boolean;
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
  /** No qualified judge was available, so none was asked (planMcpJudgeRoute "skip"). Nothing failed: proceed with the configured set. */
  judgeSkipped?: true;
  /** measured-local: a measured local judge (meaning shortlist of the shelf, enforced answer shape). */
  pipeline?: McpJudgeProfile;
  /** measured-local only: candidates offered after the meaning shortlist (absent = the whole shelf was offered). */
  shortlist?: { offered: number; of: number };
}

export interface McpGoalNeedContext {
  objective: string;
  acceptanceCriteria: readonly string[];
}

/**
 * Standing context around the current request. It is rendered apart from the
 * CURRENT TASK so the judge does not read an agent's general instructions,
 * session policy, or capability catalogue as this turn's request. A bare
 * "answer READY" turn used to trigger a credential prompt because the agent's
 * standing instructions mentioned a credentialed service (2026-09-12).
 */
export interface McpTaskContext {
  agentName?: string;
  workingFolder?: string | null;
  /** Effective agent system prompt, session policy and similar standing text. */
  agentInstructions?: string;
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
  "When an entry marked 'Agentlas' and another entry cover the same capability, prefer the Agentlas one; otherwise prefer a 'hub' entry over a 'local' one.",
  "Judge the whole Goal objective and every acceptance criterion when a Goal contract is supplied; the latest task text may only be one implementation step.",
  "Treat a native browser as available only when the runtime capability context explicitly says available. Unknown or unavailable means you must not assume the runtime has its own browser, UI capture, or interaction channel.",
  "Even an available native browser satisfies a criterion only when it can produce the required evidence on the same target surface; availability alone does not prove Desktop can observe that surface.",
  "When a criterion requires rendered UI, interaction, screenshots, or browser-visible evidence and no explicit runtime capability supplies it, select the appropriate offered browser or computer-use tool.",
  "When nativeWebSearch=available, use the runtime's built-in web search and do not select a credentialed Brave Search MCP unless the user explicitly requested that exact service.",
  "Do not select a browser merely because the task mentions an app, Flutter, frontend, or a website. Source-only implementation, build, or test criteria may need no browser.",
  "Return an empty list only when every capability required for the complete Goal is either explicitly available in the runtime context or needs none of the offered tools.",
  "An entry marked 'needs credential' costs the user a blocking API-key prompt before the run starts, so name it only when the task is impossible without it.",
  "AGENT CONTEXT is standing background (who the agent is, its general instructions, session policy, working folder). It describes what the agent may do in general and is never this turn's request: a service, site, or credential mentioned only there must not be selected unless the CURRENT TASK itself requires it.",
  "Err toward returning fewer tools.",
  "Entries marked 'skill plugin' are different: they are installed instruction packs (domain workflows and references) with no credential, install, or side effect. Select a skill plugin whenever the CURRENT TASK or the Goal falls inside its domain, even if the task could be attempted without it — relevance, not strict necessity, is the rule for skill plugins. Do not select one for an unrelated task.",
].join(" ");

/** Render the standing agent context as background, clearly separated from the current task. */
export function renderMcpTaskContext(context?: McpTaskContext): string {
  const instructions = context?.agentInstructions?.trim();
  const lines = [
    "AGENT CONTEXT (standing background; NOT this turn's request):",
    `Agent: ${context?.agentName?.trim() || "unspecified"}`,
    `Working folder: ${context?.workingFolder?.trim() || "none"}`,
    "Standing instructions and session policy:",
    instructions || "none",
  ];
  return lines.join("\n");
}

/** Preserve the complete Goal contract; a later criterion may be the one that requires a tool. */
export function renderMcpGoalNeedContext(goal?: McpGoalNeedContext): string {
  if (!goal) return "GOAL CONTRACT:\nnone";
  const renderedCriteria = goal.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion.trim()}`);
  return [
    "GOAL CONTRACT (host-owned, judge the complete contract):",
    `Objective: ${goal.objective.trim() || "unspecified"}`,
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
const MCP_NEED_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * full: the whole shelf in one selection (hosted judges: subscription CLIs, BYOK, Agentlas serving — unchanged).
 * measured-local: a judge whose competence comes from a measurement of that exact local model (judgment-competence.ts
 * status measured_pass). Same judgment text and order; a meaning shortlist of the shelf and a decoder-enforced answer shape.
 */
export type McpJudgeProfile = "full" | "measured-local";

export type McpJudgeRoute =
  | { kind: "pin"; profile?: McpJudgeProfile }
  | { kind: "fallback"; selection: RuntimeSelection; profile?: McpJudgeProfile }
  | { kind: "skip"; reason: string };

/**
 * Pin when it can judge without tools AND its model is a measured tool judge (or there is no pin: the pool route
 * applies). Otherwise borrow a pool runtime that is both, or skip — the run then proceeds with its configured tools.
 * `competence` defaults to "no measurements": a runtime that needs one (judgment-competence.ts) does not judge.
 */
export function planMcpJudgeRoute(timeoutMs: number,
  deps: {
    pin?: () => RuntimeSelection | undefined;
    fallback?: (timeoutMs: number) => RuntimeSelection | null;
    competence?: (selection: RuntimeSelection) => ToolJudgmentCompetence;
  } = {}): McpJudgeRoute {
  const pin = (deps.pin ?? (() => invocationJudgmentContext()?.selection))();
  if (!pin) return { kind: "pin" };
  const competenceOf = deps.competence ?? ((selection: RuntimeSelection) => toolJudgmentCompetence(selection, []));
  const isolated = isVerifiedJudgmentCapability(pin, "no_tools");
  const pinCompetence = competenceOf(pin);
  const measuredLocal = (competence: ToolJudgmentCompetence) => competence.status === "measured_pass"
    ? { profile: "measured-local" as const } : {};
  if (isolated && isToolJudgmentCompetent(pinCompetence)) return { kind: "pin", ...measuredLocal(pinCompetence) };
  const fallback = (deps.fallback ?? ((ms: number) => noToolsJudgmentFallback(ms, undefined,
    (selection) => isToolJudgmentCompetent(competenceOf(selection)))))(timeoutMs);
  const cause = isolated ? pinCompetence.reason : `${pin.kind}_cannot_judge_without_tools`;
  return fallback
    ? { kind: "fallback", selection: fallback, ...measuredLocal(competenceOf(fallback)) }
    : { kind: "skip", reason: `judgment_skipped:${cause}_and_no_measured_pool_runtime_under_${timeoutMs}ms` };
}

/** Measurements are read only when a runtime that needs one can be asked (the pin, or the pool behind it). */
async function measuredJudgeRoute(timeoutMs: number,
  readMeasurements: () => Promise<ToolChoiceMeasurement[]> = readToolChoiceMeasurements): Promise<McpJudgeRoute> {
  const pin = invocationJudgmentContext()?.selection;
  const consultsPool = Boolean(pin) && (!isVerifiedJudgmentCapability(pin!, "no_tools") || requiresMeasuredToolJudgment(pin!));
  const measurements = consultsPool ? await readMeasurements() : [];
  // An owner-served model (Ollama / LM Studio / MLX) without a receipt is measured in the background; this judgment is
  // skipped as before and a later one uses the receipt (external-tool-judgment.ts).
  if (pin && toolJudgmentCompetence(pin, measurements).status === "unmeasured") {
    void import("../system-agents/external-tool-judgment").then((external) => external.ensureExternalToolJudgmentMeasured(pin)).catch(() => {});
  }
  return planMcpJudgeRoute(timeoutMs, { competence: (selection) => toolJudgmentCompetence(selection, measurements) });
}

function renderMcpInventory(candidates: readonly McpNeedCandidate[]): string {
  return candidates
    .map(
      (candidate) =>
        `- ${candidate.id} (${candidate.origin}${candidate.agentlas ? ", Agentlas" : ""}${candidate.kind === "skill-plugin" ? ", skill plugin" : ""}${candidate.needsCredential ? ", needs credential" : ""}): ${candidate.name} — ${candidate.description}`,
    )
    .join("\n");
}

// ── Measured-local profile: the same judgment with less to choose from and an enforced answer shape ─────────────
// Code only — no judgment text or order changes (owner rule 2026-10-28: a defect is not fixed by editing prompts).
// QA 2026-10-28 (docs 2026-10-28-local-model-browser-judge): with the whole shelf (72 entries) a small local judge drifted
// to salient entries and answered in prose the parser rejects. For a judge whose competence was MEASURED on this machine
// (judgment-competence.ts measured_pass), the shelf is shortlisted by meaning with the app's local Model2Vec (recall
// only; the model still decides and may choose none) and the answer shape is enforced by the decoder (json_schema).
// Hosted judges keep the whole shelf without a schema.

/** Shortlist size for a measured local judge. */
export const MCP_NEED_SHORTLIST_SIZE = 8;

/**
 * The enforced answer shape: ids are a closed enum of exactly the offered entries. No length or count caps in the grammar
 * (scripts/test-provider-schema-no-grammar-caps: a grammar cap makes a strict decoder cut or loop instead of answering);
 * parseSubset already keeps only offered ids.
 */
export function mcpNeedSubsetOutputSchema(labels: readonly string[]): NonNullable<Parameters<typeof judgeSubset>[0]["outputSchema"]> {
  return { name: "agentlas_tool_need_subset", schema: { type: "object", additionalProperties: false, required: ["selected", "confidence", "reason"],
    properties: { selected: { type: "array", items: { type: "string", enum: [...labels] } },
      confidence: { type: "number" }, reason: { type: "string" } } } };
}

const shelfVectors = new Map<string, number[]>();

/**
 * Recall only: the candidates whose description is nearest in meaning to the task (the app's local Model2Vec, the same
 * embedding memory recall uses). Null = offer the whole shelf: no verified Model2Vec asset (the hashing fallback is not
 * meaning), or nothing to cut. Never decides: the judge still chooses among the shortlist, and may choose none.
 */
export async function shortlistMcpCandidatesByMeaning(task: string, candidates: readonly McpNeedCandidate[],
  size = MCP_NEED_SHORTLIST_SIZE): Promise<McpNeedCandidate[] | null> {
  if (candidates.length <= size) return null;
  let embedding: typeof import("../memory/local-embedding");
  try { embedding = await import("../memory/local-embedding"); } catch { return null; }
  const taskVector = embedding.autoLocalEmbedding(task);
  if (taskVector.degraded) return null;
  const scored = candidates.map((candidate, index) => {
    const text = `${candidate.name}: ${candidate.description}`;
    const key = `${taskVector.modelSha256 ?? ""}\u0000${text}`;
    let vector = shelfVectors.get(key);
    if (!vector) {
      vector = embedding.autoLocalEmbedding(text).vector;
      shelfVectors.set(key, vector);
      if (shelfVectors.size > 2_000) shelfVectors.delete(shelfVectors.keys().next().value!);
    }
    return { candidate, index, score: embedding.cosineSimilarity(taskVector.vector, vector) };
  });
  // The offered order stays the shelf's own order (Hub first); only membership changes.
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, size)
    .sort((a, b) => a.index - b.index).map((row) => row.candidate);
}

export async function resolveMcpNeeds(input: {
  /** The request for this turn only (user text plus attachment summary). */
  task: string;
  /** Standing agent/session context, rendered apart from the task. Omitted means legacy single-blob callers. */
  taskContext?: McpTaskContext;
  candidates: McpNeedCandidate[];
  goal?: McpGoalNeedContext;
  runtimeCapabilities?: McpRuntimeCapabilities;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injectable judge (tests). Defaults to the resident judgment service. */
  judgeSubsetFn?: typeof judgeSubset;
  /** Measured-local shortlist size (A/B). Defaults to MCP_NEED_SHORTLIST_SIZE. */
  shortlistSize?: number;
  /** Injectable route planner (tests). Defaults to the invocation pin + measured pool fallback. */
  planJudgeRoute?: (timeoutMs: number) => McpJudgeRoute | Promise<McpJudgeRoute>;
}): Promise<ResolvedMcpNeeds> {
  const ordered = preferHub(input.candidates);
  const candidates = ordered.slice(0, MAX_CANDIDATES);
  const omitted = ordered.slice(MAX_CANDIDATES).map((candidate) => candidate.id);
  if (!input.task.trim() || candidates.length === 0) {
    return { needed: [], decided: false, reason: "no task or no candidates", omitted };
  }

  // The judge must never block the run. When the invocation's pinned runtime cannot
  // judge without tools (codex: not release-verified), or its model is not a measured
  // tool judge (an owner-loaded local model without a passing receipt), borrow a pool
  // member only if it is verified, measured to answer inside the deadline and itself
  // a measured judge; otherwise skip.
  const route = await (input.planJudgeRoute ?? measuredJudgeRoute)(input.timeoutMs ?? MCP_NEED_DEFAULT_TIMEOUT_MS);
  if (route.kind === "skip") {
    return { needed: [], decided: false, reason: route.reason, omitted, decisionFailure: "unavailable", judgeSkipped: true };
  }
  const judge = input.judgeSubsetFn ?? judgeSubset;
  const onRoute = <T>(run: () => Promise<T>): Promise<T> => route.kind === "fallback"
    ? withInvocationJudgmentContext(route.selection, input.signal ?? invocationJudgmentContext()?.signal, run)
    : run();
  const measuredLocal = route.profile === "measured-local";
  const shortlist = measuredLocal
    // A Goal's criteria can need a tool the latest turn text does not name: they join the recall query.
    ? await shortlistMcpCandidatesByMeaning([input.goal?.objective ?? "", ...(input.goal?.acceptanceCriteria ?? []), input.task]
      .map((part) => part.trim()).filter(Boolean).join("\n"), candidates, input.shortlistSize ?? MCP_NEED_SHORTLIST_SIZE) : null;
  const offered = shortlist ?? candidates;
  const verdict = await onRoute(() => judge({
    kind: MCP_NEED_JUDGMENT_KIND,
    // Optional selection is metadata preparation, not authority to run tools.
    // Unsupported isolation returns undecided; configured pins and exact active
    // Goal selections remain governed by auto-select's existing host checks.
    requireNoTools: true,
    question: MCP_NEED_JUDGMENT_QUESTION,
    labels: offered.map((candidate) => candidate.id),
    // Composition order: fixed → variable (docs/PROMPT-COMPOSITION-POLICY.md, ledger desktop.judgment.kind.mcp-need.user).
    input: [
      `AVAILABLE TOOLS:\n${renderMcpInventory(offered)}`,
      renderMcpRuntimeCapabilities(input.runtimeCapabilities),
      renderMcpGoalNeedContext(input.goal),
      ...(input.taskContext ? [renderMcpTaskContext(input.taskContext)] : []),
      `CURRENT TASK${input.taskContext ? " (the user's request for this turn; judge this)" : ""}:\n${input.task.trim()}`,
    ].join("\n\n"),
    guidance: MCP_NEED_JUDGMENT_GUIDANCE,
    ...(measuredLocal ? { outputSchema: mcpNeedSubsetOutputSchema(offered.map((candidate) => candidate.id)) } : {}),
    maxInputChars: null,
    signal: input.signal,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  }));
  const profile = measuredLocal ? { pipeline: "measured-local" as const,
    ...(shortlist ? { shortlist: { offered: shortlist.length, of: candidates.length } } : {}) } : {};

  if (verdict.source !== "llm") {
    return { needed: [], decided: false, reason: verdict.reason, omitted, ...profile,
      ...(verdict.failureKind ? { failureKind: verdict.failureKind } : {}),
      ...(verdict.decisionFailure ? { decisionFailure: verdict.decisionFailure } : {}),
      ...(verdict.attempts ? { attempts: verdict.attempts } : {}) };
  }
  return {
    needed: verdict.selected,
    decided: true,
    reason: verdict.reason,
    omitted,
    ...profile,
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
    // Agentlas-published wins the same capability; between equals the Hub entry wins.
    const better = !existing
      || (candidate.agentlas === true && existing.agentlas !== true)
      || (Boolean(candidate.agentlas) === Boolean(existing.agentlas) && existing.origin === "local" && candidate.origin === "hub");
    if (better) byName.set(key, candidate);
  }
  return [...byName.values()].sort((a, b) => (a.origin === b.origin ? 0 : a.origin === "hub" ? -1 : 1));
}
