/**
 * Which `hephaestus-network` tools an ordinary Work turn carries (owner decision 2026-10-17, "B: work-core").
 *
 * The engine lists 36 tools (~42.7KB for Codex, ~47.4KB for Claude Code, measured) and every request re-sends them.
 * An ordinary turn's calls (7,879 product Codex rollouts) were workforce continuity, the Context Map gate and the
 * plugin resolver; staffing (preflight/search/prepare ...), the legacy Hub router, memory/auth/admin tools are called
 * by the host orchestrator or by an explicit owner request. The surface is one declaration here; each runtime binds it
 * with its own knob (Codex `enabled_tools`, Claude Code `--disallowedTools`, the proxied runtimes a Main proxy allow list,
 * the in-process tool loop its inventory filter).
 *
 * No Electron import: the daemon and the terminal engine load this too.
 */

/** `full` is every tool the engine lists (isolated builders, Workforce grants, an explicit owner/graph requirement). */
export type HephaestusToolSurface = "full" | "work-core";

/** Raw MCP tool names, as `tools/list` returns them (Codex `enabled_tools` takes exactly these). */
export const HEPHAESTUS_NETWORK_WORK_CORE_TOOLS: readonly string[] = Object.freeze([
  // plugin resolver: the one tool the product prompt names ("missing tool → agentlas_resolve_plugins")
  "agentlas_resolve_plugins",
  "agentlas_tool_search",
  // Workforce continuity: the server instructions tell the model to read the roster at the start of a project turn
  "workforce.goal_context",
  "workforce.record_goal_turn",
  "workforce.goal_runtime",
  // Context Map gate for turns that change source code
  "context.refresh",
  "context.locate",
  "context.refs",
  "context.slice",
  "context.impact",
  "context.verify",
]);

/**
 * Every tool the engine 1.2.66 lists. Claude Code has no allow filter, so the deny list is this set minus the core;
 * a tool a newer engine adds simply stays visible there (extra schema, never a missing one). Codex's allow list is
 * fail-closed instead. `scripts/test-hephaestus-tool-surface.cjs` compares both against the live `tools/list`.
 */
export const HEPHAESTUS_NETWORK_KNOWN_TOOLS: readonly string[] = Object.freeze([
  "agentlas.read_agent_file", "agentlas_resolve_plugins", "agentlas_tool_search", "hephaestus_route",
  "model.resolve_allocation", "hephaestus_cloud_search", "hephaestus_search", "hephaestus_call",
  "hephaestus_network_status", "agentlas_authenticate", "agentlas_auth_status", "hephaestus_hub_invoke",
  "workforce.preflight_work_order", "workforce.search_candidates", "workforce.expand_candidates",
  "workforce.validate_selection", "workforce.prepare_execution", "workforce.validate_execution_receipt",
  "workforce.bind_goal", "workforce.goal_context", "workforce.goal_runtime", "workforce.record_goal_turn",
  "workforce.complete_goal", "goal.strategy", "context.refresh", "context.locate", "context.refs", "context.slice",
  "context.impact", "context.verify", "hephaestus.unpublish_agent", "agentlas.record_agent_memory",
  "agentlas.decide_agent_learning", "agentlas.memory_curation_request", "agentlas.memory_session_open",
  "agentlas.memory_session_recap",
]);

/** Claude Code exposes a tool as `mcp__<server key>__<name>` with every character outside [A-Za-z0-9_-] turned into `_`. */
export function claudeMcpToolName(serverKey: string, rawName: string): string {
  return `mcp__${serverKey}__${rawName.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/*
 * The surface travels from the config builder to its consumers by the config file's path, like the prepared
 * transport registry (prepared-transport.ts): the path is the one thing they already hold and it is unique per
 * invocation. An entry lives exactly as long as the config file does (the config's cleanup removes it).
 * Consumers: Claude Code (`--disallowedTools`), the in-process tool loop of the API and local-model runtimes
 * (loadMainToolInventory). Codex binds `enabled_tools` and the proxied runtimes (antigravity, grok, kimi, cursor,
 * copilot) a proxy-gate allow list at build time, so they never read this registry.
 */
export interface McpToolSurface {
  /** The MCP config key the surface narrows (`hephaestus-network`). */
  readonly serverKey: string;
  /** Raw tool names that stay visible and callable. */
  readonly allow: readonly string[];
}
const surfaceByConfigPath = new Map<string, McpToolSurface>();

export function registerMcpToolSurface(configPath: string, surface: McpToolSurface | null): () => void {
  if (!surface) return () => {};
  const frozen = Object.freeze({ serverKey: surface.serverKey, allow: Object.freeze([...surface.allow]) });
  surfaceByConfigPath.set(configPath, frozen);
  return () => { if (surfaceByConfigPath.get(configPath) === frozen) surfaceByConfigPath.delete(configPath); };
}

/** Claude Code's `--disallowedTools` entries for the config at `configPath`; empty for any config that declared no surface. */
export function mcpToolSurfaceDenial(configPath: string | undefined): readonly string[] {
  const surface = configPath ? surfaceByConfigPath.get(configPath) : undefined;
  if (!surface) return [];
  const allow = new Set(surface.allow);
  return HEPHAESTUS_NETWORK_KNOWN_TOOLS.filter((name) => !allow.has(name)).map((name) => claudeMcpToolName(surface.serverKey, name));
}

/**
 * Whether the config at `configPath` keeps `rawToolName` of server `serverKey` out of the model's view. Fail-closed:
 * once a surface is declared for the server, a tool outside its allow list is hidden, a newer engine's included.
 */
export function mcpToolSurfaceHides(configPath: string | undefined, serverKey: string, rawToolName: string): boolean {
  const surface = configPath ? surfaceByConfigPath.get(configPath) : undefined;
  return !!surface && surface.serverKey === serverKey && !surface.allow.includes(rawToolName);
}
