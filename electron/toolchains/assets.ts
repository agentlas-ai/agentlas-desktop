import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import { sha256Value, graphExecutionDigest } from "../../shared/graph-execution-digest";
import { requiredExecutionPermission } from "../../shared/graph-node-protocol";
import type { ToolchainAsset, ToolchainAssetContract, ToolchainAssetCreateInput, ToolchainAssetVersion, ToolchainJsonSchema, ToolchainOutputBinding } from "../../shared/toolchain-asset";
import type { Automation } from "../../shared/types";
import { getDb } from "../store/db";
import { createAutomation, getAutomation, markToolchainImplementationAutomation } from "../store/automations";
import { emitDesktopStoreChange } from "../store/change-bus";

const PREFIX = "toolchain.asset.v1:";
const KEY_PREFIX = "toolchain.capability-key.v1:";
const DEFINITION_PREFIX = "toolchain.definition.v1:";
const IMPLEMENTATION_PREFIX = "toolchain.implementation-fingerprint.v1:";
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
export function toolchainVersionHash(version: Pick<ToolchainAssetVersion, "contract" | "implementation" | "provenance" | "definitionFingerprint" | "implementationFingerprint">): string {
  return sha256Value({ contract: version.contract, implementation: version.implementation, provenance: version.provenance,
    ...(version.definitionFingerprint ? { definitionFingerprint: version.definitionFingerprint } : {}),
    ...(version.implementationFingerprint ? { implementationFingerprint: version.implementationFingerprint } : {}) });
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
function checkedSource(input: ToolchainAssetCreateInput) {
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
  return { ...source, graph: source.graph };
}
function capabilityKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:/-]{0,159}$/.test(value.trim().toLowerCase())) throw new Error("toolchain_capability_key_invalid");
  return value.trim().toLowerCase();
}
/** Conservative executable equality, not a claim that arbitrary programs are semantically equal.
 * Node order is retained; generated node/edge IDs, labels and canvas placement are not identity. */
function fingerprintImplementation(source: Automation, contract: ToolchainAssetContract, outputBinding: ToolchainOutputBinding): string {
  const graph = source.graph!;
  const nodeIds = new Map(graph.nodes.map((node, index) => [node.id, `node:${index}`]));
  const executable = {
    version: graph.version, budget: graph.budget ?? null,
    nodes: graph.nodes.map(node => {
      const config = { ...node.config };
      if (node.type === "trigger") delete config.promptLabel;
      return { type: node.type, config };
    }),
    edges: graph.edges.map(edge => ({ source: nodeIds.get(edge.source) ?? edge.source, target: nodeIds.get(edge.target) ?? edge.target,
      sourceHandle: edge.sourceHandle ?? null, maxIterations: edge.maxIterations ?? null }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
  return sha256Value({ graph: executable, inputSchema: contract.inputSchema, outputSchema: contract.outputSchema,
    outputBinding: { ...outputBinding, nodeId: nodeIds.get(outputBinding.nodeId) },
    targetType: source.targetType, targetId: source.targetId, targetVersion: source.targetVersion ?? null,
    promptTemplate: source.promptTemplate, executionPermission: source.executionPermission ?? "write",
    runtimeSelection: source.runtimeSelection ?? null, projectId: source.projectId ?? null,
    toolMode: source.toolMode ?? "auto", hubMode: source.hubMode ?? "hub-allowed" });
}
export function toolchainImplementationFingerprint(input: ToolchainAssetCreateInput): string {
  return fingerprintImplementation(checkedSource(input), input.contract, input.outputBinding);
}
export function toolchainDefinitionFingerprint(input: ToolchainAssetCreateInput): string {
  return sha256Value({ implementationFingerprint: toolchainImplementationFingerprint(input), examples: input.contract.examples });
}
/** Older releases are compared from their frozen snapshot without rewriting them. */
export function matchingToolchainVersion(asset: ToolchainAsset, input: ToolchainAssetCreateInput): ToolchainAssetVersion | undefined {
  const implementationFingerprint = toolchainImplementationFingerprint(input);
  const definitionFingerprint = sha256Value({ implementationFingerprint, examples: input.contract.examples });
  const candidates = asset.versions.filter(version => version.implementation.snapshot.graph).map(version => {
    const implementation = version.implementationFingerprint ?? fingerprintImplementation(version.implementation.snapshot,
      version.contract, version.implementation.outputBinding);
    return { version, implementation, definition: version.definitionFingerprint
      ?? sha256Value({ implementationFingerprint: implementation, examples: version.contract.examples }) };
  });
  return candidates.find(item => item.version.validation.state === "passed" && item.implementation === implementationFingerprint)?.version
    ?? candidates.find(item => item.definition === definitionFingerprint)?.version;
}
function indexedAsset(key: string): ToolchainAsset | null {
  const row = getDb().prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
  if (!row) return null;
  const asset = getToolchainAsset(row.value);
  if (!asset) throw new Error("toolchain_identity_index_corrupt");
  return asset;
}
function reserveIdentity(key: string, id: string): void {
  const existing = indexedAsset(key);
  if (existing && existing.id !== id) throw new Error(`toolchain_existing_capability:${existing.id}`);
  getDb().prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING").run(key, id);
}
function makeVersion(id: string, version: number, input: ToolchainAssetCreateInput, creatorChatId: string | null,
  definitionFingerprint: string, implementationFingerprint: string): ToolchainAssetVersion {
  const source = checkedSource(input);
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
    version, contentHash: "", definitionFingerprint, implementationFingerprint, createdAt: new Date().toISOString(), contract: clone(input.contract),
    implementation: { kind: "graph", automationId: implementation.id, snapshot: frozen, outputBinding: clone(input.outputBinding) },
    provenance: { sourceAutomationId: source.id, sourceDefinitionDigest: graphExecutionDigest(source, source.graph), creatorChatId },
    validation: { state: "untested", at: null, receipts: [], problems: [] },
  };
  release.contentHash = toolchainVersionHash(release);
  return release;
}
export function createToolchainAsset(input: ToolchainAssetCreateInput, actor: { callerChatId?: string | null } = {}): ToolchainAsset {
  return getDb().transaction(() => {
    const key = capabilityKey(input.capabilityKey);
    const implementationFingerprint = toolchainImplementationFingerprint(input);
    const fingerprint = sha256Value({ implementationFingerprint, examples: input.contract.examples });
    const byKey = key ? indexedAsset(`${KEY_PREFIX}${key}`) : null;
    const byDefinition = indexedAsset(`${DEFINITION_PREFIX}${fingerprint}`);
    const byImplementation = indexedAsset(`${IMPLEMENTATION_PREFIX}${implementationFingerprint}`);
    const existing = byKey ?? byDefinition ?? byImplementation;
    if (existing) {
      if (existing.status === "withdrawn") throw new Error(`toolchain_withdrawn:${existing.id}`);
      if (byDefinition && byDefinition.id !== existing.id) throw new Error(`toolchain_existing_capability:${byDefinition.id}`);
      if (byImplementation && byImplementation.id !== existing.id) throw new Error(`toolchain_existing_capability:${byImplementation.id}`);
      if (!matchingToolchainVersion(existing, input)) throw new Error(`toolchain_existing_capability:${existing.id}`);
      // Reserve equivalent names under the original identity so subsequent revisions
      // cannot use the same alias to open a second asset.
      if (key) reserveIdentity(`${KEY_PREFIX}${key}`, existing.id);
      return clone(existing);
    }
    const id = `tc_${randomUUID()}`;
    const now = new Date().toISOString();
    const version = makeVersion(id, 1, input, actor.callerChatId ?? null, fingerprint, implementationFingerprint);
    const asset = save({ schemaVersion: "agentlas.toolchain-asset.v1", id, name: input.contract.name,
      ...(key ? { capabilityKey: key } : {}), status: "draft", stableVersion: null,
      revision: 0, createdAt: now, updatedAt: now, versions: [version] });
    if (key) reserveIdentity(`${KEY_PREFIX}${key}`, id);
    reserveIdentity(`${DEFINITION_PREFIX}${fingerprint}`, id);
    reserveIdentity(`${IMPLEMENTATION_PREFIX}${implementationFingerprint}`, id);
    return asset;
  }).immediate();
}
export function addToolchainVersion(id: string, input: ToolchainAssetCreateInput, actor: { callerChatId?: string | null } = {}): ToolchainAsset {
  return getDb().transaction(() => {
    const asset = getToolchainAsset(id);
    if (!asset) throw new Error("toolchain_not_found");
    if (asset.status === "withdrawn") throw new Error(`toolchain_withdrawn:${asset.id}`);
    const key = capabilityKey(input.capabilityKey);
    const implementationFingerprint = toolchainImplementationFingerprint(input);
    const fingerprint = sha256Value({ implementationFingerprint, examples: input.contract.examples });
    const byKey = key ? indexedAsset(`${KEY_PREFIX}${key}`) : null;
    if (byKey && byKey.id !== id) throw new Error(`toolchain_existing_capability:${byKey.id}`);
    if (key && asset.capabilityKey && key !== asset.capabilityKey && !byKey) throw new Error("toolchain_capability_key_immutable");
    const byDefinition = indexedAsset(`${DEFINITION_PREFIX}${fingerprint}`);
    if (byDefinition && byDefinition.id !== id) throw new Error(`toolchain_existing_capability:${byDefinition.id}`);
    const byImplementation = indexedAsset(`${IMPLEMENTATION_PREFIX}${implementationFingerprint}`);
    if (byImplementation && byImplementation.id !== id) throw new Error(`toolchain_existing_capability:${byImplementation.id}`);
    if (matchingToolchainVersion(asset, input)) return clone(asset);
    const version = makeVersion(id, Math.max(...asset.versions.map(item => item.version)) + 1, input, actor.callerChatId ?? null, fingerprint, implementationFingerprint);
    const next = save({ ...asset, ...(!asset.capabilityKey && key ? { capabilityKey: key } : {}), versions: [...asset.versions, version] });
    if (key) reserveIdentity(`${KEY_PREFIX}${key}`, id);
    reserveIdentity(`${DEFINITION_PREFIX}${fingerprint}`, id);
    reserveIdentity(`${IMPLEMENTATION_PREFIX}${implementationFingerprint}`, id);
    return next;
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
