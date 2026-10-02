import { readOnlyBrowserToolIsMutating } from "./read-only-browser-tools";

const AGENTLAS_BROWSER_PREFIX = "mcp__agentlas-browser__browser_";
const CODEX_AGENTLAS_BROWSER = /^agentlas-browser\.(browser_[a-z_]+)$/;

/**
 * The bundled browser's tool name in the one spelling this classifier knows.
 *
 * Codex reports MCP tools as `<server>.<tool>` (`agentlas-browser.browser_snapshot`); Claude and
 * the other runtimes report `mcp__<server>__<tool>`. Measured 2026-09-27 on the owner's store:
 * 1,460 codex browser events and not one of them could ever be read as an observation, because
 * the check below only knew the `mcp__` spelling. An update restart that interrupted a Threads
 * automation step which had only taken snapshots therefore left it "may have acted outside" —
 * automation_ambiguous_side_effect, next run null, until a person reconciled it by hand.
 * The argument checks stay exactly as strict; only the name spelling is folded.
 */
export function canonicalAgentlasBrowserToolName(name: string): string {
  const codex = CODEX_AGENTLAS_BROWSER.exec(name);
  return codex ? `mcp__agentlas-browser__${codex[1]}` : name;
}

export function isAgentlasBrowserToolName(name: string): boolean {
  return canonicalAgentlasBrowserToolName(name).startsWith(AGENTLAS_BROWSER_PREFIX);
}

/** Use the same argument-sensitive observation contract enforced by Main's proxy. */
export function isReadOnlyGraphBrowserObservation(rawName: string, rawArgs: unknown): boolean {
  const name = canonicalAgentlasBrowserToolName(rawName);
  if (!name.startsWith(AGENTLAS_BROWSER_PREFIX) || typeof rawArgs !== "string") return false;
  try {
    const args: unknown = JSON.parse(rawArgs);
    if (!args || typeof args !== "object" || Array.isArray(args)) return false;
    return !readOnlyBrowserToolIsMutating({
      toolName: name.slice("mcp__agentlas-browser__".length),
      args,
    });
  } catch { return false; }
}
