// Which runtimes get the host built-in web tools `web_search` and `web_read` (electron/web-search). One declaration.
//
// API and local-model runtimes have no web search of their own, so the host drives the bundled Agentlas browser for them.
// The subscription CLIs (claude-code, codex, antigravity, grok, kimi, cursor, github-copilot-cli) bring their own search
// and fetch tools and never receive these. The text each side reads is in shared/builtin-tools.ts.
export const WEB_TOOL_RUNTIME_KINDS: ReadonlySet<string> = new Set([
  "byok", "agentlas", "agentlas-local", "ollama", "lmstudio", "mlx",
]);

export const WEB_TOOL_NAMES: ReadonlySet<string> = new Set(["web_search", "web_read"]);

export function runtimeGetsWebTools(runtimeKind: string): boolean {
  return WEB_TOOL_RUNTIME_KINDS.has(runtimeKind);
}
