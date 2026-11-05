/**
 * How optional tools are chosen for a run (output/tool-search-at-scale-20261105/TOOL-ARCHITECTURE.md). No imports: the turn-tools
 * control server reads it when it writes a run's capability file, and must not load the selector to do so.
 * - "judge": one pre-run judgment call names the optional tools (measured cost about 5 s per turn).
 * - "model": no pre-run call; the model finds and calls installed tools in the turn (harness_search -> tool.describe -> tool.call).
 * AGENTLAS_TOOL_SELECTION overrides. The default stays "judge" until the real-model A/B of THOUGHT-EXPERIMENTS.md F7 has run on
 * every runtime (codex measured, claude not: weekly limit).
 */
export type ToolSelectionMode = "judge" | "model";
export const DEFAULT_TOOL_SELECTION_MODE: ToolSelectionMode = "judge";
/**
 * Runtimes whose model runs on this computer and may be small. They keep the judge in "model" mode: measured 
 * (scripts/test-model-picks-local-ab.cjs), qwen3:1.7b found the connector with harness_search and stopped there 3/3 (judge 3/3).
 */
export const LOCAL_MODEL_RUNTIME_KINDS: ReadonlySet<string> = new Set(["ollama", "lmstudio", "mlx", "agentlas-local"]);
export function toolSelectionMode(env: NodeJS.ProcessEnv = process.env, runtimeKind?: string | null): ToolSelectionMode {
  const value = env.AGENTLAS_TOOL_SELECTION;
  const mode = value === "model" || value === "judge" ? value : DEFAULT_TOOL_SELECTION_MODE;
  return mode === "model" && runtimeKind && LOCAL_MODEL_RUNTIME_KINDS.has(runtimeKind) ? "judge" : mode;
}
