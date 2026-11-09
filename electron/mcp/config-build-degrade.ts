/**
 * What a run does when the app's own tool host is still not ready after the bounded waits of config-build-retry.ts (owner rule
 * no internal harness code reaches the owner; the request completes, or the cause is external).
 *
 * A plain conversation turn (no Goal tools, no team, no automation, no required tool, not One, not an app/Science/Work-session run)
 * depends on no tool: it runs as an ordinary turn without the tool table and the owner is told once. Every run whose protocol needs
 * its tools keeps the typed not-dispatched refusal, which the send queue and the blocked-Goal sweep start again. The decision only
 * ever removes tools, so it cannot widen authority. Pure: the same rule for every runtime, OS and host (Main or daemon).
 */

export interface ToollessTurnFacts {
  aborted: boolean;
  /** The run's tool scope is still current (client.ts isMcpConfigCurrent). */
  current: boolean;
  /** The thrown machine code (client.ts mcpConfigFailureCode). */
  code: string | null;
  requiredToolCatalogIds: number;
  scienceToolServer: boolean;
  workSessionMain: boolean;
  /** A Goal chat's controller pass, a team, an automation node, a Science or unattended run: its protocol depends on its tools. */
  executionContext: boolean;
  goalToolsOffered: boolean;
  agentAppMode: boolean;
  oneMode: boolean;
  toolModeBrowser: boolean;
}

/** Codes that end a run on purpose and are never replaced by an ordinary turn. */
const NEVER_TOOLLESS_CODES: ReadonlySet<string> = new Set([
  "mcp-goal-tool-scope-changed", "mcp_invocation_scope_ended", "agentlas-browser-host-unavailable",
]);

export function mayRunWithoutToolTable(facts: ToollessTurnFacts): boolean {
  if (facts.aborted || !facts.current) return false;
  if (facts.code !== null && NEVER_TOOLLESS_CODES.has(facts.code)) return false;
  return facts.requiredToolCatalogIds === 0 && !facts.scienceToolServer && !facts.workSessionMain && !facts.executionContext
    && !facts.goalToolsOffered && !facts.agentAppMode && !facts.oneMode && !facts.toolModeBrowser;
}
