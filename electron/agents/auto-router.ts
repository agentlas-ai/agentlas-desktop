import type { AutomationHubMode, InstalledAgent } from "../../shared/types";
import { APP_BUILDER_SLUG, GLOBAL_ORCHESTRATOR_SLUG } from "../architecture/manifest";
import type { RuntimeLocale } from "../runtime/status-i18n";
import { judgeRequired, peekJudgment } from "../system-agents/judgment";

export interface AutoRouteChoice {
  agent: InstalledAgent;
  reason: string;
  matchedTerms: string[];
}

export interface AutoRouteExperiencePrior {
  score: number;
  reason: string;
  matchedTerms: string[];
}

export interface AutoRouteOptions {
  allowFallback?: boolean;
  judgedOnly?: boolean;
  judgedPeek?: boolean;
  experiencePriors?: ReadonlyMap<string, AutoRouteExperiencePrior>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const AUTO_ROUTE_JUDGMENT_KIND = "installed-agent-route";

export function isGlobalOrchestrator(agent: InstalledAgent | null | undefined): boolean {
  return agent?.slug === GLOBAL_ORCHESTRATOR_SLUG;
}

export function autoRouteJudgmentInput(userPrompt: string, pool: readonly InstalledAgent[]): string {
  return [
    `REQUEST:\n${userPrompt.slice(0, 3_000)}`,
    "AVAILABLE PROJECT/TURN AGENTS:",
    ...pool.map((agent) =>
      `- ${agent.slug}: ${agent.nameEn || agent.name} — ${(agent.taglineEn || agent.tagline || "").slice(0, 240)}`,
    ),
  ].join("\n");
}

export interface JudgedAutoRouteResult {
  choice: AutoRouteChoice | null;
  source: "llm" | "unavailable";
}

/**
 * Meaning belongs entirely to the connected controller. Code supplies the
 * finite roster and validates the returned exact slug; it never recruits,
 * ranks or substitutes with words, regexes, embeddings or a default agent.
 */
export async function selectAutoRoutedAgentJudged(
  userPrompt: string,
  agents: InstalledAgent[],
  locale: RuntimeLocale,
  opts?: AutoRouteOptions,
): Promise<JudgedAutoRouteResult> {
  const pool = agents.filter((agent, index) => agents.findIndex((item) => item.slug === agent.slug) === index);
  if (!userPrompt.trim() || pool.length === 0) return { choice: null, source: "unavailable" };
  const bySlug = new Map(pool.map((agent) => [agent.slug, agent]));
  const verdict = await judgeRequired<string>({
    kind: AUTO_ROUTE_JUDGMENT_KIND,
    question: "Which exact available agent should be a task-scoped sub-agent for this turn, or none when no listed agent is justified?",
    labels: [...bySlug.keys(), "none"],
    input: autoRouteJudgmentInput(userPrompt, pool),
    guidance: [
      "Judge the full meaning in any language; do not decide from keyword overlap.",
      "A selected agent remains subordinate to the current One/project controller and cannot own the session.",
      "Never select an agent merely to avoid none, and never invent or substitute a slug.",
    ].join(" "),
    scanSecrets: true,
    ...(opts?.signal ? { signal: opts.signal } : {}),
    ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    locale,
  });
  if (!verdict.verdict || verdict.verdict === "none") {
    return { choice: null, source: verdict.source === "llm" ? "llm" : "unavailable" };
  }
  const selected = bySlug.get(verdict.verdict);
  if (!selected) return { choice: null, source: "unavailable" };
  return {
    choice: { agent: selected, reason: verdict.reason, matchedTerms: [] },
    source: "llm",
  };
}

/** Synchronous consumers may use only an already model-authored cached verdict. */
export function selectAutoRoutedAgent(
  userPrompt: string,
  agents: InstalledAgent[],
  _locale: RuntimeLocale,
  _opts?: AutoRouteOptions,
): AutoRouteChoice | null {
  const pool = agents.filter((agent, index) => agents.findIndex((item) => item.slug === agent.slug) === index);
  const verdict = peekJudgment<string>(AUTO_ROUTE_JUDGMENT_KIND, autoRouteJudgmentInput(userPrompt, pool));
  if (!verdict || verdict.source !== "llm" || verdict.verdict === "none") return null;
  const agent = pool.find((candidate) => candidate.slug === verdict.verdict);
  return agent ? { agent, reason: verdict.reason, matchedTerms: [] } : null;
}

export interface HubFirstWorkforceEligibility {
  agentAppMode: boolean;
  hubMode?: AutomationHubMode;
  borrowedAgentCount: number;
  plainConversation: boolean;
  targetAppEdit: boolean;
}

/** Exact explicit mode/authority facts only; no prompt meaning is interpreted. */
export function shouldForceHubFirstWorkforce(input: HubFirstWorkforceEligibility): boolean {
  return !input.agentAppMode
    && input.hubMode === "hub-first"
    && input.borrowedAgentCount === 0
    && !input.targetAppEdit;
}

export function autoRouteStatus(choice: AutoRouteChoice, locale: RuntimeLocale): string {
  const name = locale === "ko" ? choice.agent.name : choice.agent.nameEn || choice.agent.name;
  return locale === "ko"
    ? `사용 에이전트: ${name}. 이유: ${choice.reason}.`
    : `Selected agent: ${name}. Reason: ${choice.reason}.`;
}

export function autoRouteSystemPreamble(
  choice: AutoRouteChoice,
  locale: RuntimeLocale,
  mode: "default" | "apps-generate" | "app-edit" = "default",
): string {
  const bounded = mode === "app-edit"
    ? "Edit only the existing Agentlas App supplied by the host. Preserve user state and verify the change."
    : mode === "apps-generate" && choice.agent.slug === APP_BUILDER_SLUG
      ? "The user explicitly enabled Apps Generate for this turn. Build and verify the requested App."
      : "Act only as a task-scoped sub-agent. Return the result to the current controller; never claim session ownership.";
  return ["## Task-scoped agent call", "", autoRouteStatus(choice, locale), bounded].join("\n");
}
