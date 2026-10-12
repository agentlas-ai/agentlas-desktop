/**
 * Runtime tiers (owner 2026-10-12). One place decides how a runtime is driven:
 *  - native-session: the CLI keeps its own session and prompt cache (claude-code, codex, antigravity, grok, kimi, cursor, acp).
 *  - hosted-api: Agentlas runs the tool loop against an API (byok, agentlas serving).
 *  - local: Agentlas runs the tool loop against a managed llama.cpp server (agentlas-local; lmstudio/mlx/ollama are legacy).
 */
import type { RuntimeKind } from "./types";

export type RuntimeTier = "native-session" | "hosted-api" | "local";

export function runtimeTier(kind: RuntimeKind): RuntimeTier {
  switch (kind) {
    case "byok":
    case "agentlas":
      return "hosted-api";
    case "agentlas-local":
    case "ollama":
    case "lmstudio":
    case "mlx":
      return "local";
    default:
      return "native-session";
  }
}
