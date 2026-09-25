import { preparedMcpBindings, preparedMcpTransport, type PreparedMcpBinding } from "../mcp-tools/prepared-transport";

/** Main-only capability. Neither serialized request fields nor model output can mint it. */
const grants = new WeakMap<object, { path: string; binding: PreparedMcpBinding; current: () => void }>();
export const SCIENCE_COLLECTION_TOOLS: readonly string[] = Object.freeze([
  "list_project_evidence", "record_source_evidence", "read_existing_source_text",
]);
const backends = new Set(["anthropic", "openai", "google", "upstage", "custom", "glm", "kimi", "deepseek", "minimax", "xai", "openrouter"]);
const localRuntimes = new Set(["ollama", "lmstudio", "mlx", "agentlas-local"]);
export function supportsScienceCollectionRuntime(selection: { kind?: string; backend?: string | null; model?: string | null } | null): boolean {
  return !!selection && (selection.kind === "byok" && backends.has(selection.backend ?? "")
    || localRuntimes.has(selection.kind ?? ""))
    && typeof selection.model === "string" && selection.model.trim().length > 0;
}
export function assertScienceCollectionRuntimeSelection(actual: { kind: string; backend?: string | null; model?: string | null; source?: string | null; effort?: string | null }, expected: { kind: string; backend?: string | null; model?: string | null; source?: string | null; effort?: string | null } | undefined): void {
  if (!expected || !supportsScienceCollectionRuntime(actual)
    || actual.kind !== expected.kind || actual.backend !== expected.backend || actual.model !== expected.model
    || (expected.source != null && actual.source !== expected.source)
    || (expected.effort != null && actual.effort !== expected.effort)) {
    throw new Error("science_collection_runtime_selection_changed");
  }
}
export const scienceEvidenceCollectionHost = Object.freeze({
  schema: "agentlas.science-evidence-collection-host.v1" as const,
  supportsRuntime: supportsScienceCollectionRuntime,
});

/** Called only after Main has materialized Science's exact turn-scoped server. */
export function issueScienceCollectionCapability(path: string, current: () => void): object {
  current();
  const bindings = preparedMcpBindings(path);
  if (bindings.length !== 1 || bindings[0].configKey !== "agentlas-science") throw new Error("science_collection_server_identity_invalid");
  const capability = Object.freeze({});
  grants.set(capability, { path, binding: bindings[0], current });
  return capability;
}
export function assertScienceCollectionCapability(capability: object, path?: string): PreparedMcpBinding {
  const grant = grants.get(capability);
  if (!grant || (path !== undefined && path !== grant.path)) throw new Error("science_collection_main_capability_required");
  grant.current();
  const bindings = preparedMcpBindings(grant.path);
  if (bindings.length !== 1 || bindings[0] !== grant.binding) throw new Error("science_collection_server_identity_changed");
  preparedMcpTransport(grant.binding, grant.binding.server);
  return grant.binding;
}
export function assertScienceCollectionTool(capability: object, tool: { kind: string; prepared?: PreparedMcpBinding; serverToolName?: string } | undefined): void {
  const binding = assertScienceCollectionCapability(capability);
  if (!tool || tool.kind !== "mcp" || tool.prepared !== binding || !SCIENCE_COLLECTION_TOOLS.includes(tool.serverToolName ?? "")) {
    throw new Error("science_collection_tool_denied");
  }
}
