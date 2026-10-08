import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import { sha256Value, graphExecutionDigest } from "../../shared/graph-execution-digest";
import { requiredExecutionPermission } from "../../shared/graph-node-protocol";
import type { ToolchainAsset, ToolchainAssetContract, ToolchainAssetCreateInput, ToolchainAssetVersion, ToolchainJsonSchema } from "../../shared/toolchain-asset";
import { getDb } from "../store/db";
import { createAutomation, getAutomation, markToolchainImplementationAutomation } from "../store/automations";
import { emitDesktopStoreChange } from "../store/change-bus";
import { listToolchainStates } from "./store";

const PREFIX = "toolchain.asset.v1:";
// Version-local schemas may retain the same $id across releases without polluting
// a global schema registry. Unknown formats fail compilation instead of being ignored.
const ajv = new Ajv({ allErrors: true, strict: true, addUsedSchema: false });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function toolchainSchemaProblems(schema: ToolchainJsonSchema, value: unknown): string[] {
  const validate = ajv.compile(schema);
  return validate(value) ? [] : (validate.errors ?? []).map(error => `${error.instancePath || "/"}:${error.keyword}`);
}
function checkContract(contract: ToolchainAssetContract): void {
  if (!contract || typeof contract.name !== "string" || !contract.name.trim() || typeof contract.description !== "string" || !contract.description.trim()
    || typeof contract.variationStatement !== "string" || !Array.isArray(contract.whenToUse) || !Array.isArray(contract.whenNotToUse)
    || !Array.isArray(contract.examples) || contract.examples.length > 20
    || [...contract.whenToUse, ...contract.whenNotToUse].some(text => typeof text !== "string")) throw new Error("toolchain_contract_invalid");
  if (contract.inputSchema?.type !== "object" || !contract.outputSchema || typeof contract.outputSchema !== "object") throw new Error("toolchain_schema_invalid");
  ajv.compile(contract.inputSchema); ajv.compile(contract.outputSchema);
  for (const example of contract.examples) {
    if (!example || !Object.prototype.hasOwnProperty.call(example, "expectedOutput")
      || toolchainSchemaProblems(contract.inputSchema, example.input).length
      || toolchainSchemaProblems(contract.outputSchema, example.expectedOutput).length) throw new Error("toolchain_example_invalid");
  }
  if (Buffer.byteLength(JSON.stringify(contract)) > 256 * 1024) throw new Error("toolchain_contract_too_large");
}
export function toolchainVersionHash(version: Pick<ToolchainAssetVersion, "contract" | "implementation" | "provenance">): string {
  return sha256Value({ contract: version.contract, implementation: version.implementation, provenance: version.provenance });
}
export function getToolchainAsset(id: string): ToolchainAsset | null {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return null;
  const row = getDb().prepare("SELECT value FROM meta WHERE key=?").get(`${PREFIX}${id}`) as { value: string } | undefined;
  if (!row) return null;
  const asset = JSON.parse(row.value) as ToolchainAsset;
  if (asset.schemaVersion !== "agentlas.toolchain-asset.v1" || asset.id !== id) throw new Error("toolchain_asset_corrupt");
  for (const version of asset.versions) if (version.contentHash !== toolchainVersionHash(version)) throw new Error("toolchain_release_corrupt");
  return asset;
}
export function listToolchainAssets(): ToolchainAsset[] {
  const rows = getDb().prepare("SELECT key FROM meta WHERE key >= ? AND key < ? ORDER BY key").all(PREFIX, `${PREFIX}\uffff`) as Array<{ key: string }>;
  return rows.map(row => getToolchainAsset(row.key.slice(PREFIX.length))!).filter(Boolean);
}
function save(asset: ToolchainAsset): ToolchainAsset {
  const next = { ...asset, revision: asset.revision + 1, updatedAt: new Date().toISOString() };
  getDb().prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`${PREFIX}${asset.id}`, JSON.stringify(next));
  emitDesktopStoreChange({ entity: "automation", id: asset.id });
  return clone(next);
}
function makeVersion(id: string, version: number, input: ToolchainAssetCreateInput, creatorChatId: string | null): ToolchainAssetVersion {
  checkContract(input.contract);
  const source = getAutomation(input.sourceAutomationId);
  if (!source?.graph?.nodes.length) throw new Error("toolchain_source_graph_missing");
  if (source.workspaceMode === "follow_goal") throw new Error("toolchain_source_workspace_requires_project");
  if (!input.outputBinding || !["json", "text"].includes(input.outputBinding.format)
    || !source.graph.nodes.some(node => node.id === input.outputBinding.nodeId)) throw new Error("toolchain_output_binding_invalid");
  // A live subgraph reference would silently alter an immutable release. Explicit pinned
  // toolchain calls are the composition boundary; freeze/convert a child first.
  if (source.graph.nodes.some(node => node.type === "subgraph")) throw new Error("toolchain_unpinned_subgraph_dependency");
  const modelNodes = source.graph.nodes.filter(node => {
    // Match runGraph's output fast path: only declared read/pure text bypasses
    // the model; outward output and prompt-only output still invoke a runtime.
    const deterministicOutput = node.type === "output" && ["read", "pure"].includes(String(node.config?.effect))
      && typeof node.config?.text === "string" && Boolean(node.config.text);
    return (["agent", "action", "eval"].includes(node.type) || node.type === "output" && !deterministicOutput)
      && !node.config?.mcpCall && !node.config?.toolchainCall;
  });
  if (modelNodes.length && (!source.runtimeSelection?.model
    || modelNodes.some(node => node.config?.runtime && node.config.runtime !== source.runtimeSelection?.kind))) throw new Error("toolchain_runtime_pin_required");
  if ((source.targetType === "hub" && !source.targetVersion)
    || source.graph.nodes.some(node => node.config?.targetType === "hub" && node.config?.ref
      && !node.config?.targetVersion && !(source.targetType === "hub" && source.targetId === node.config.ref && source.targetVersion)))
    throw new Error("toolchain_unpinned_hub_dependency");
  for (const node of source.graph.nodes) {
    const call = node.config?.toolchainCall as { toolchainId?: string; version?: number } | undefined;
    if (!call) continue;
    const dependency = typeof call.toolchainId === "string" ? getToolchainAsset(call.toolchainId) : null;
    if (!Number.isSafeInteger(call.version) || dependency?.status !== "callable"
      || !dependency.versions.some(item => item.version === call.version && item.validation.state === "passed"))
      throw new Error("toolchain_unpinned_toolchain_dependency");
  }
  const implementation = createAutomation({
    name: `Toolchain ${id}@${version}`, goal: input.contract.description,
    scheduleHuman: "", triggerType: "command", trigger: { kind: "command" }, enabled: false,
    targetType: source.targetType, targetId: source.targetId, targetVersion: source.targetVersion,
    runtimeSelection: source.runtimeSelection, projectId: source.projectId,
    promptTemplate: source.promptTemplate, graphJson: clone(source.graph),
    executionPermission: source.executionPermission, toolMode: source.toolMode, hubMode: source.hubMode, createdBy: "agent",
  });
  const frozen = clone(implementation);
  markToolchainImplementationAutomation(implementation.id, id, version);
  const release: ToolchainAssetVersion = {
    version, contentHash: "", createdAt: new Date().toISOString(), contract: clone(input.contract),
    implementation: { kind: "graph", automationId: implementation.id, snapshot: frozen, outputBinding: clone(input.outputBinding) },
    provenance: { sourceAutomationId: source.id, sourceDefinitionDigest: graphExecutionDigest(source, source.graph), creatorChatId },
    validation: { state: "untested", at: null, receipts: [], problems: [] },
  };
  release.contentHash = toolchainVersionHash(release);
  return release;
}
export function createToolchainAsset(input: ToolchainAssetCreateInput, actor: { callerChatId?: string | null } = {}): ToolchainAsset {
  return getDb().transaction(() => {
    const id = `tc_${randomUUID()}`;
    const now = new Date().toISOString();
    const version = makeVersion(id, 1, input, actor.callerChatId ?? null);
    return save({ schemaVersion: "agentlas.toolchain-asset.v1", id, name: input.contract.name, status: "draft", stableVersion: null,
      revision: 0, createdAt: now, updatedAt: now, versions: [version] });
  }).immediate();
}
export function addToolchainVersion(id: string, input: ToolchainAssetCreateInput, actor: { callerChatId?: string | null } = {}): ToolchainAsset {
  return getDb().transaction(() => {
    const asset = getToolchainAsset(id);
    if (!asset) throw new Error("toolchain_not_found");
    const version = makeVersion(id, Math.max(...asset.versions.map(item => item.version)) + 1, input, actor.callerChatId ?? null);
    return save({ ...asset, versions: [...asset.versions, version] });
  }).immediate();
}
export function withdrawToolchainAsset(id: string): ToolchainAsset {
  return getDb().transaction(() => {
    const asset = getToolchainAsset(id);
    if (!asset) throw new Error("toolchain_not_found");
    return save({ ...asset, status: "withdrawn" });
  }).immediate();
}
const publishing = new Map<string, Promise<ToolchainAsset>>();
interface PublicationContext { permission: "read" | "write"; callerChatId?: string | null; signal?: AbortSignal; allowEffectfulValidation?: boolean }
export function publishToolchainVersion(id: string, version: number, context: PublicationContext): Promise<ToolchainAsset> {
  const key = `${id}@${version}`;
  const prior = publishing.get(key); if (prior) return prior;
  const task = validateAndPublish(id, version, context).finally(() => publishing.delete(key));
  publishing.set(key, task); return task;
}
async function validateAndPublish(id: string, version: number, context: PublicationContext): Promise<ToolchainAsset> {
  const before = getToolchainAsset(id);
  const release = before?.versions.find(item => item.version === version);
  if (!before || !release) throw new Error("toolchain_version_not_found");
  if (before.status === "withdrawn") throw new Error("toolchain_withdrawn");
  const examples = release.contract.examples;
  if (!release.contract.variationStatement.trim() || examples.length < 2 || new Set(examples.map(item => sha256Value(item.input))).size < 2)
    throw new Error("toolchain_distinct_validation_examples_required");
  // Only the owner surface can authorize the exact visible example effects. The model
  // publication API does not forward this opt-in. Repeated validation still deduplicates.
  const effectful = requiredExecutionPermission(release.implementation.snapshot.graph) === "write";
  if (effectful && (context.permission !== "write" || context.allowEffectfulValidation !== true)) throw new Error("toolchain_owner_validation_required");
  const { runToolchainValidation } = await import("./calls");
  const receipts: string[] = []; const problems: string[] = [];
  for (let index = 0; index < examples.length; index += 1) {
    const receipt = await runToolchainValidation({ toolchainId: id, version, args: examples[index].input }, {
      ...context, permission: effectful ? "write" : "read", requestId: `validation:${release.contentHash}:${index}`,
    });
    receipts.push(receipt.id);
    if (!receipt.ok || sha256Value(receipt.result) !== sha256Value(examples[index].expectedOutput)) problems.push(`example:${index}:${receipt.error ?? "output_mismatch"}`);
    if (receipt.status === "uncertain" || receipt.status === "running" || effectful && problems.length) break;
  }
  return getDb().transaction(() => {
    const current = getToolchainAsset(id);
    if (!current || current.status === "withdrawn" || current.revision !== before.revision) throw new Error("toolchain_changed_during_validation");
    const passed = problems.length === 0;
    return save({ ...current, ...(passed ? { stableVersion: version, status: "callable" as const, name: release.contract.name } : {}),
      versions: current.versions.map(item => item.version === version ? { ...item,
        validation: { state: passed ? "passed" as const : "failed" as const, at: new Date().toISOString(), receipts, problems } } : item) });
  }).immediate();
}
/** Import only actual legacy contracts. A legacy routing test never becomes execution proof. */
export function migrateLegacyToolchainAssets(): { migrated: string[]; skipped: string[] } {
  const migrated: string[] = []; const skipped: string[] = [];
  for (const state of listToolchainStates()) {
    if (!state.interface) continue;
    if (listToolchainAssets().some(asset => asset.legacyAutomationId === state.automationId)) continue;
    const source = getAutomation(state.automationId);
    const outputs = source?.graph?.nodes.filter(node => !["trigger", "tool"].includes(node.type)
      && !source.graph!.edges.some(edge => edge.source === node.id
        && source.graph!.nodes.find(candidate => candidate.id === edge.target)?.type !== "tool")) ?? [];
    if (!source?.graph || outputs.length !== 1) { skipped.push(state.automationId); continue; }
    try {
      getDb().transaction(() => {
        const old = state.interface!;
        const asset = createToolchainAsset({ sourceAutomationId: state.automationId,
          contract: { name: old.name, description: old.description, whenToUse: old.whenToUse, whenNotToUse: old.whenNotToUse,
            inputSchema: old.inputSchema, outputSchema: {}, examples: [], variationStatement: "" },
          outputBinding: { nodeId: outputs[0].id, format: "text" } }, { callerChatId: old.exposedBy?.chatId });
        save({ ...asset, legacyAutomationId: state.automationId, status: old.state === "deprecated" ? "withdrawn" : "draft" });
        migrated.push(asset.id);
      }).immediate();
    } catch { skipped.push(state.automationId); }
  }
  return { migrated, skipped };
}
