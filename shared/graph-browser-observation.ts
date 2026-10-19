import { readOnlyBrowserToolIsMutating } from "./read-only-browser-tools";

const AGENTLAS_BROWSER_PREFIX = "mcp__agentlas-browser__browser_";
const CODEX_AGENTLAS_BROWSER = /^agentlas-browser\.(browser_[a-z_]+)$/;

/**









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
