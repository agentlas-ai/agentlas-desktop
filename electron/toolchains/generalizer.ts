import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import { sha256Value } from "../../shared/graph-execution-digest";
import { buildGraphFromBlueprint } from "../../shared/graph-blueprint";
import { isGraphControlTool } from "../../shared/graph-authoring";
import { requiredExecutionPermission } from "../../shared/graph-node-protocol";
import type { RuntimeSelection, WorkflowGraph } from "../../shared/types";
import type { ToolchainAsset, ToolchainAssetCreateInput, ToolchainGenerationInput, ToolchainGenerationResult } from "../../shared/toolchain-asset";
import { TOOLCHAIN_GENERATION_TIMEOUT_MS } from "../../shared/toolchain-asset";
import { getDb } from "../store/db";
import { createAutomation, removeAutomation } from "../store/automations";
import { getProject } from "../store/projects";
import { listInstalledServers } from "../mcp-tools/registry";
import { GLOBAL_ORCHESTRATOR_SLUG } from "../architecture/manifest";
import { callConnectedModelDetailed, configuredOrchestratorJudgmentPolicy } from "../system-agents/judgment";
import { TOOLCHAIN_GENERALIZER_AGENT, TOOLCHAIN_GENERALIZATION_OUTPUT_SCHEMA, type ToolchainGeneralizationDecision } from "../system-agents/toolchain-generalizer";
import { graphMcpEffectProblems } from "../workflow/mcp-call";
import { currentUiLocale } from "../ui-locale";
import { addToolchainVersion, createToolchainAsset, getToolchainAsset, listToolchainAssets, matchingToolchainVersion, toolchainSchemaProblems } from "./assets";

const PREFIX = "toolchain.generalization.v1:";
const validateDecision = new Ajv({ strict: true, allErrors: true }).compile<ToolchainGeneralizationDecision>(TOOLCHAIN_GENERALIZATION_OUTPUT_SCHEMA);
const pending = new Map<string, { inputHash: string; promise: Promise<ToolchainGenerationResult> }>();
interface GenerationActor { callerChatId?: string | null; signal?: AbortSignal; assertCurrent?: () => void }
interface GenerationRecord {
  inputHash: string;
  result: Omit<ToolchainGenerationResult, "asset"> & { assetId: string };
  agentId: string;
  taskId: string;
  catalogRevision: string;
  runtimeReceipt: Awaited<ReturnType<typeof callConnectedModelDetailed>>["runtimeReceipt"];
  attempts: Awaited<ReturnType<typeof callConnectedModelDetailed>>["attempts"];
  createdAt: string;
}

function catalogRevision(assets = listToolchainAssets()): string {
  return sha256Value(assets.map(asset => [asset.id, asset.revision, asset.status, asset.stableVersion]));
}
function readResult(key: string, inputHash: string): ToolchainGenerationResult | null {
  const row = getDb().prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
  if (!row) return null;
  const record = JSON.parse(row.value) as GenerationRecord;
  if (record.inputHash !== inputHash) throw new Error("toolchain_generation_request_conflict");
  const asset = getToolchainAsset(record.result.assetId);
  if (!asset?.versions.some(version => version.version === record.result.version)) throw new Error("toolchain_generation_receipt_invalid");
  const { assetId: _assetId, ...result } = record.result;
  return { ...result, asset };
}
function parseDecision(text: string): ToolchainGeneralizationDecision {
  const value: unknown = JSON.parse(text.trim());
  if (!validateDecision(value)) throw new Error(`toolchain_generalization_shape_invalid:${JSON.stringify(validateDecision.errors)}`);
  return value;
}
function catalogContext(assets: ToolchainAsset[]) {
  // Inspect every asset, including drafts and withdrawn capabilities. Search only
  // returns callable releases and cannot decide whether a new identity is needed.
  return assets.map(asset => ({ id: asset.id, capabilityKey: asset.capabilityKey ?? null, name: asset.name,
    status: asset.status, stableVersion: asset.stableVersion, versions: asset.versions.map(version => ({
      version: version.version, validation: version.validation.state, contract: version.contract,
    })) }));
}
function typedSchema(schema: unknown, root: unknown, depth = 0): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 32) return false;
  const shape = schema as Record<string, unknown>;
  if (Object.hasOwn(shape, "const") || Array.isArray(shape.enum) && shape.enum.length > 0) return true;
  if (typeof shape.$ref === "string") {
    if (!shape.$ref.startsWith("#/")) return false;
    let target: unknown = root;
    for (const segment of shape.$ref.slice(2).split("/")) {
      const field = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!target || typeof target !== "object" || !Object.hasOwn(target, field)) return false;
      target = (target as Record<string, unknown>)[field];
    }
    return typedSchema(target, root, depth + 1);
  }
  for (const union of [shape.anyOf, shape.oneOf]) if (Array.isArray(union))
    return union.length > 0 && union.every(member => typedSchema(member, root, depth + 1));
  const types = Array.isArray(shape.type) ? shape.type : [shape.type];
  if (!types.length || types.some(type => !["string", "number", "integer", "boolean", "null", "object", "array"].includes(String(type)))) return false;
  if (types.includes("array") && !(Array.isArray(shape.items)
    ? shape.items.length > 0 && shape.items.every(item => typedSchema(item, root, depth + 1)) : typedSchema(shape.items, root, depth + 1))) return false;
  if (types.includes("object")) {
    if (shape.properties && Object.values(shape.properties as Record<string, unknown>).some(property => !typedSchema(property, root, depth + 1))) return false;
    if (shape.additionalProperties && typeof shape.additionalProperties === "object" && !typedSchema(shape.additionalProperties, root, depth + 1)) return false;
  }
  return true;
}
function compileDecision(decision: Exclude<ToolchainGeneralizationDecision, { decision: "reuse" }>): WorkflowGraph {
  const contract = decision.contract;
  if (contract.inputSchema.type !== "object" || !contract.variationStatement.trim()) throw new Error("toolchain_generalized_inputs_required");
  if (!typedSchema(contract.inputSchema, contract.inputSchema) || !typedSchema(contract.outputSchema, contract.outputSchema)) throw new Error("toolchain_typed_contract_required");
  if (new Set(contract.examples.map(example => sha256Value(example.input))).size < 2) throw new Error("toolchain_generalization_examples_required");
  for (const example of contract.examples) {
    if (toolchainSchemaProblems(contract.inputSchema, example.input).length || toolchainSchemaProblems(contract.outputSchema, example.expectedOutput).length)
      throw new Error("toolchain_example_invalid");
  }
  const fields = Object.keys((contract.inputSchema.properties ?? {}) as Record<string, unknown>);
  if (!fields.length || fields.some(field => !/^[A-Za-z_][\w-]*$/.test(field) || ["__proto__", "prototype", "constructor", "input"].includes(field)))
    throw new Error("toolchain_input_fields_invalid");
  const blueprint = decision.blueprint;
  if (blueprint.trigger.kind !== "input" || blueprint.trigger.varName !== "input") throw new Error("toolchain_command_implementation_required");
  if (blueprint.steps.some(step => step.kind === "runGraph" || step.mcpCall && isGraphControlTool(step.mcpCall.catalogId, step.mcpCall.toolName)))
    throw new Error("toolchain_unpinned_or_recursive_dependency");
  if (!blueprint.steps[decision.outputStep]) throw new Error("toolchain_output_binding_invalid");
  const consumed = new Set(blueprint.steps.flatMap(step => step.consumes ?? []));
  if (fields.some(field => !consumed.has(field))) throw new Error("toolchain_input_binding_missing");
  const built = buildGraphFromBlueprint(blueprint, currentUiLocale(), { knownGraphs: [], inputVariables: fields });
  if (!built.ok) throw new Error(`toolchain_blueprint_invalid:${JSON.stringify(built.problems)}`);
  if (graphMcpEffectProblems(built.graph, currentUiLocale()).length) throw new Error("toolchain_implementation_effect_mismatch");
  return built.graph;
}

/** Future authoring only: no task graph scan, no migration and no example effects. */
export function generateToolchain(input: ToolchainGenerationInput, actor: GenerationActor = {}): Promise<ToolchainGenerationResult> {
  if (!input || typeof input.request !== "string" || !input.request.trim() || input.request.length > 8000
    || typeof input.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.requestId))
    return Promise.reject(new Error("toolchain_generation_input_invalid"));
  const normalized = { request: input.request.trim(), toolchainId: input.toolchainId ?? null, projectId: input.projectId ?? null };
  const inputHash = sha256Value(normalized);
  const key = `${PREFIX}${sha256Value({ callerChatId: actor.callerChatId ?? null, requestId: input.requestId })}`;
  actor.assertCurrent?.(); actor.signal?.throwIfAborted();
  const previous = readResult(key, inputHash);
  if (previous) return Promise.resolve(previous);
  const running = pending.get(key);
  if (running) return running.inputHash === inputHash ? running.promise : Promise.reject(new Error("toolchain_generation_request_conflict"));
  const promise = prepare(input, actor, key, inputHash).finally(() => pending.delete(key));
  pending.set(key, { inputHash, promise });
  return promise;
}

async function prepare(input: ToolchainGenerationInput, actor: GenerationActor, key: string, inputHash: string): Promise<ToolchainGenerationResult> {
  const controller = new AbortController();
  const signal = actor.signal ? AbortSignal.any([actor.signal, controller.signal]) : controller.signal;
  const deadline = Date.now() + TOOLCHAIN_GENERATION_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new Error("toolchain_generalization_timeout")), TOOLCHAIN_GENERATION_TIMEOUT_MS);
  timer.unref?.();
  try {
    let feedback = "";
    for (let round = 0; round < 3; round++) {
      signal.throwIfAborted(); actor.assertCurrent?.();
      if (input.projectId && !getProject(input.projectId)) throw new Error("toolchain_project_not_found");
      const assets = listToolchainAssets();
      const requested = input.toolchainId ? assets.find(asset => asset.id === input.toolchainId) : null;
      if (input.toolchainId && !requested) throw new Error("toolchain_not_found");
      if (requested?.status === "withdrawn") throw new Error("toolchain_capability_withdrawn");
      const revision = catalogRevision(assets);
      const context = JSON.stringify({ request: input.request, requestedAssetId: input.toolchainId ?? null,
        productLanguage: currentUiLocale(), catalog: catalogContext(assets),
        requestedImplementation: requested?.versions.at(-1)?.implementation.snapshot.graph ?? null,
        installedProviders: listInstalledServers().filter(server => server.enabled).map(server => ({ catalogId: server.catalogId, name: server.name })),
        feedback, outputSchema: TOOLCHAIN_GENERALIZATION_OUTPUT_SCHEMA });
      if (Buffer.byteLength(context) > 1024 * 1024) throw new Error("toolchain_catalog_context_too_large");
      const policy = configuredOrchestratorJudgmentPolicy();
      if (!policy) throw new Error("toolchain_orchestrator_unconfigured");
      const detailed = await callConnectedModelDetailed({ systemPrompt: TOOLCHAIN_GENERALIZER_AGENT.core, input: context,
        selectionPolicy: policy, requireNoTools: true, signal, timeoutMs: Math.max(1, deadline - Date.now()) });
      signal.throwIfAborted(); actor.assertCurrent?.();
      if (!detailed.text && detailed.failure?.kind === "refused" && detailed.failure.source === "marker"
        && detailed.failure.message === "judgment_orchestrator_pool_changed") {
        feedback = "The configured orchestrator pool refreshed during runtime discovery. Re-read its current policy and the current catalog.";
        continue;
      }
      if (!detailed.text) throw new Error("toolchain_generalization_unavailable");
      if (catalogRevision() !== revision) { feedback = "Catalog changed while you reviewed it. Compare the fresh complete catalog again before choosing an identity."; continue; }
      try {
        const decision = parseDecision(detailed.text);
        const target = decision.toolchainId ? assets.find(asset => asset.id === decision.toolchainId) : null;
        if (input.toolchainId && decision.toolchainId !== input.toolchainId) throw new Error("toolchain_requested_identity_mismatch");
        if (decision.decision !== "new_asset" && !target) throw new Error("toolchain_not_found");
        if (target?.status === "withdrawn") throw new Error("toolchain_capability_withdrawn");
        if (target?.capabilityKey && target.capabilityKey !== decision.capabilityKey) throw new Error("toolchain_capability_identity_mismatch");
        if (decision.decision === "new_asset" && assets.some(asset => asset.capabilityKey === decision.capabilityKey))
          throw new Error("toolchain_existing_capability_requires_reuse_or_version");
        const graph = decision.decision === "reuse" ? null : compileDecision(decision);
        const result = getDb().transaction(() => {
          signal.throwIfAborted(); actor.assertCurrent?.();
          if (catalogRevision() !== revision) throw new Error("toolchain_catalog_changed");
          const replay = readResult(key, inputHash);
          if (replay) return replay;
          let asset: ToolchainAsset;
          let version: number;
          let outcome: ToolchainGenerationResult["decision"] = decision.decision;
          if (decision.decision === "reuse") {
            const release = target!.versions.find(release => release.version === decision.version);
            if (target!.status !== "callable" || release?.validation.state !== "passed") throw new Error("toolchain_version_not_callable");
            asset = target!; version = release.version;
          } else {
            const runtime = detailed.runtimeReceipt?.selection;
            if (!runtime?.model) throw new Error("toolchain_runtime_pin_required");
            const runtimeSelection: RuntimeSelection = { ...runtime, role: "worker", inherit: false,
              ...(detailed.runtimeReceipt?.effort ? { effort: detailed.runtimeReceipt.effort } : {}),
              ...(detailed.runtimeReceipt?.longContext !== undefined ? { longContext: detailed.runtimeReceipt.longContext } : {}) };
            // Only a new, disabled staging graph is constructed here. Its frozen
            // carrier is retained; the staging row is removed in this same transaction.
            const source = createAutomation({ name: decision.contract.name, goal: decision.contract.description,
              targetType: "agent", targetId: `builtin-${GLOBAL_ORCHESTRATOR_SLUG}`, promptTemplate: "",
              projectId: input.projectId ?? null, graphJson: graph!, runtimeSelection,
              executionPermission: requiredExecutionPermission(graph!), toolMode: "auto", hubMode: "local-only",
              scheduleHuman: "", triggerType: "command", trigger: { kind: "command" }, enabled: false, createdBy: "agent" });
            const creation: ToolchainAssetCreateInput = { sourceAutomationId: source.id, capabilityKey: decision.capabilityKey,
              contract: decision.contract, outputBinding: { nodeId: `step${decision.outputStep + 1}`, format: decision.outputFormat } };
            asset = decision.decision === "new_version" ? addToolchainVersion(target!.id, creation, actor) : createToolchainAsset(creation, actor);
            const exact = matchingToolchainVersion(asset, creation);
            if (!exact) throw new Error("toolchain_generation_version_missing");
            version = exact.version;
            if (assets.some(prior => prior.id === asset.id && prior.versions.some(release => release.version === version))) outcome = "reuse";
            removeAutomation(source.id);
          }
          const result: ToolchainGenerationResult = { asset, version, decision: outcome, rationale: decision.rationale, generalizationId: `tcg_${randomUUID()}` };
          const { asset: _asset, ...withoutAsset } = result;
          const record: GenerationRecord = { inputHash, result: { ...withoutAsset, assetId: asset.id },
            agentId: `builtin-${GLOBAL_ORCHESTRATOR_SLUG}`, taskId: TOOLCHAIN_GENERALIZER_AGENT.id, catalogRevision: revision,
            runtimeReceipt: detailed.runtimeReceipt, attempts: detailed.attempts, createdAt: new Date().toISOString() };
          getDb().prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(key, JSON.stringify(record));
          return result;
        }).immediate();
        return result;
      } catch (error) {
        feedback = `Host rejected the proposal: ${error instanceof Error ? error.message : "toolchain_generalization_invalid"}. Correct it using the current catalog and the same requested capability. Do not create a duplicate or ask the user to author schemas.`;
        if (round === 2) throw error;
      }
    }
    throw new Error("toolchain_catalog_changed");
  } finally { clearTimeout(timer); }
}
