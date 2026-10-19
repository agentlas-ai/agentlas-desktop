/**
 * Capability priority — Agentlas providers first, outside equivalents as fallback.
 *
 * Owner decision (2026-09-24): "우선순위를 agentlas 플러그인을 우선으로 하자는거지".
 * Runtimes (Claude Code, Codex) load the owner's own tools next to the ones
 * Agentlas binds: a user Playwright MCP server, Claude in Chrome, Codex's bundled
 * browser plugins. The rule is PRIORITY, not a ban:
 *
 *   1. When an Agentlas provider for a capability is reachable in this run,
 *      outside equivalents are hidden (two browsers with overlapping tool names
 *      split the model's choice; the Agentlas one owns the login state, the
 *      approval gate and the live view).
 *   2. When no Agentlas provider is reachable, outside equivalents stay as the
 *      fallback so the run never dead-ends, and the model is told the order.
 *   3. An explicit user choice (a Computer Use grant) opens everything.
 *
 * Prior art this follows (researched 2026-09-24):
 *   - APT pin priorities (apt_preferences(5)): priorities order candidates;
 *     only a negative pin forbids a package. A lower-priority source is still
 *     installed when nothing better exists — demotion, not removal.
 *   - Android intent resolution: a preferred activity short-circuits resolution
 *     only while that component resolves; otherwise normal resolution (and the
 *     user's own choice in the chooser) takes over — no dead end.
 *   - Anthropic tool search / defer_loading: selection accuracy drops when many
 *     tools with similar names and overlapping functions are loaded at once, so
 *     a duplicate provider is better hidden than listed beside the preferred one.
 *
 * Capability classes come from plugin manifests (`provides.tools[].capability`),
 * so a new Agentlas plugin (design, investment analysis, memory, long-run …)
 * joins the priority guidance by being installed. Only classes whose outside
 * equivalents are known and addressable per runtime are listed below; adding
 * one is data, not a new branch.
 */

/** Publisher name Agentlas-published plugin manifests carry (`publisher.name`). */
export const AGENTLAS_PUBLISHER_NAME = "Agentlas";

export function isAgentlasPublisher(publisher: unknown): boolean {
  if (!publisher || typeof publisher !== "object") return false;
  const name = (publisher as { name?: unknown }).name;
  return typeof name === "string" && name.trim().toLowerCase() === AGENTLAS_PUBLISHER_NAME.toLowerCase();
}

/**
 * Where the Agentlas provider of a capability stands for one run.
 *   bound       — Main bound it for this run.
 *   available   — reachable in this run through another Agentlas channel
 *                 (for example the engine plugin's copy inside the runtime).
 *   unavailable — measured absent for this run.
 *   unknown     — not measurable without breaking a boundary (hermetic turns).
 */
export type AgentlasProviderState = "bound" | "available" | "unavailable" | "unknown";

/**
 * What happens to outside equivalents.
 *   open          — explicit user grant; nothing is hidden.
 *   agentlas-only — an Agentlas provider is reachable; outside equivalents hidden.
 *   fallback      — no Agentlas provider is reachable; outside equivalents stay.
 */
export type OutsideProviderPolicy = "open" | "agentlas-only" | "fallback";

export function outsideProviderPolicy(input: {
  explicitGrant?: boolean;
  agentlas: AgentlasProviderState;
}): OutsideProviderPolicy {
  if (input.explicitGrant) return "open";
  return input.agentlas === "bound" || input.agentlas === "available" ? "agentlas-only" : "fallback";
}

export interface CapabilityEquivalents {
  capability: string;
  /** MCP server names the Agentlas provider uses inside a runtime (Main binding and engine plugin copy). */
  agentlasServerNames: readonly string[];
  /** Evidence (launch command/args) that a declared server is the Agentlas provider under another name. */
  agentlasServerEvidence?: RegExp;
  /** Human names of outside equivalents, for the model's guidance. */
  outsideLabel: string;
  /** Claude Code tool-name patterns of outside equivalents (`--disallowedTools` syntax). */
  claudeToolPatterns: readonly string[];
  /** Codex plugin ids of outside equivalents (`-c plugins.<id>.enabled=false`). */
  codexPlugins: readonly string[];
  /** Codex user-config server names of outside equivalents. */
  codexServerNames: readonly string[];
  /** Launch evidence of an outside equivalent declared under another server name. */
  codexServerEvidence: RegExp;
}

/**








 */
export const CAPABILITY_EQUIVALENTS: readonly CapabilityEquivalents[] = [
  {
    capability: "browser",
    agentlasServerNames: ["agentlas-browser"],
    agentlasServerEvidence: /agentlas-browser|browser-cdp-launcher/,
    outsideLabel: "Playwright, Chrome DevTools, Puppeteer or other browser MCP servers",
    claudeToolPatterns: [
      "mcp__*playwright*",
      "mcp__*chrome-devtools*",
      "mcp__*puppeteer*",
      "mcp__*browsermcp*",
      "mcp__*browser-use*",
    ],
    codexPlugins: ["playwright@claude-plugins-official"],
    codexServerNames: ["playwright", "chrome-devtools", "puppeteer", "browsermcp", "browser-use"],
    codexServerEvidence: /@playwright\/mcp|playwright-mcp|chrome-devtools-mcp|@modelcontextprotocol\/server-puppeteer|puppeteer-mcp|@browsermcp\/mcp|browser-use/,
  },
];

export function capabilityEquivalents(capability: string): CapabilityEquivalents | null {
  return CAPABILITY_EQUIVALENTS.find((entry) => entry.capability === capability) ?? null;
}

export interface AgentlasCapabilityProvider {
  capability: string;
  /** Tool id / MCP server key the model sees (e.g. agentlas-browser, cua-driver). */
  toolId: string;
}

const MAX_GUIDANCE_PROVIDERS = 16;


/** `capability=tool` pairs for the one-line `prefer` prompt module (same selection as the guidance above). */
export function preferredProviderPairs(providers: readonly AgentlasCapabilityProvider[]): string[] {
  const byCapability = new Map<string, string[]>();
  let count = 0;
  for (const provider of providers) {
    const capability = provider.capability.trim();
    const toolId = provider.toolId.trim();
    if (!capability || !toolId || count >= MAX_GUIDANCE_PROVIDERS) continue;
    // Priority only matters where an outside equivalent exists (browser, computer use, …); a capability with no
    // known competitor needs no ordering line.
    const equivalents = capabilityEquivalents(capability);
    if (!equivalents || equivalents.codexServerNames.includes(toolId)) continue;
    const tools = byCapability.get(capability) ?? [];
    if (tools.includes(toolId)) continue;
    tools.push(toolId);
    byCapability.set(capability, tools);
    count += 1;
  }
  return [...byCapability].map(([capability, tools]) => `${capability}=${tools.join("|")}`);
}

/** Sort comparator: Agentlas-published first, original order otherwise (stable sort). */
export function agentlasFirst<T extends { agentlas?: boolean }>(left: T, right: T): number {
  return (left.agentlas ? 0 : 1) - (right.agentlas ? 0 : 1);
}
