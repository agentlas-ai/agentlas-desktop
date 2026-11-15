import type { RuntimeKind } from "../../shared/types";

/**
 * The name a runtime goes by on screen. One table for every place that names a runtime (the Goal refusal sentence, the Work
 * rows of the Workspace menu); typed over RuntimeKind, so a runtime added to the union cannot be left without a name.
 */
export const RUNTIME_PROVIDER_LABEL: Record<RuntimeKind, string> = {
  "claude-code": "Claude Code", codex: "Codex", antigravity: "Antigravity", kimi: "Kimi Code", grok: "Grok",
  cursor: "Cursor Agent", byok: "API", ollama: "Ollama", lmstudio: "LM Studio", mlx: "MLX",
  "agentlas-local": "Agentlas Local", acp: "ACP", agentlas: "Agentlas",
};

/** A seat's own label wins for ACP (several seats share that kind); null for a kind this build has no name for. */
export function runtimeProviderLabel(kind: string, label?: string | null): string | null {
  if (kind === "acp" && label?.trim()) return label.trim();
  return (RUNTIME_PROVIDER_LABEL as Record<string, string | undefined>)[kind] ?? null;
}
