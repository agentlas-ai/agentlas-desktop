import { withCurrentHistoryProducer } from "./history-runtime-fences";
import { createHash } from "node:crypto";
import type { Automation, WorkflowGraph } from "../../shared/types";
import { buildGraphFromBlueprint, type GraphBlueprint } from "../../shared/graph-blueprint";
import { graphAuthoringShapeProblems, GRAPH_BLUEPRINT_INPUT_SCHEMA, isGraphControlTool, ONE_GRAPH_TOOLS } from "../../shared/graph-authoring";
import { readAutomationGraphDefinition, resolveAutomationGraph } from "../../shared/automation-graph-definition";
import { requiredExecutionPermission } from "../../shared/graph-node-protocol";
import { decideGraphRunRequest } from "../../shared/graph-run-request";
import { graphCommandInvocationKind, graphCommandRequestMatches } from "../../shared/graph-command";
import { getDb } from "../store/db";
import { desktopStoreTransaction } from "../store/change-bus";
import { getChat } from "../store/chats";
import { createAutomation, getAutomation, hasDurableActiveAutomationExecution, hasGraphLoginWait,
  listAutomations, updateAutomation, updateAutomationGraph } from "../store/automations";
import { listAutomationGraphReconciliations } from "../store/graph-reconciliation";
import { enqueueTriggerEvent, getTriggerEvent } from "../store/trigger-events";
import { applyAutomationLifecycle, automationDefinitionDigest } from "../automation-lifecycle";
import { reportGraphConnections } from "../workflow/tool-inventory";
import { currentUiLocale } from "../ui-locale";
import { specFromStored, nextRun } from "../store/schedule";
import { AUTOMATION_PROTOCOL } from "../automation-emitter";
import { sha256Value } from "../../shared/graph-execution-digest";
import { graphMcpEffectProblems, inspectGraphMcpTools } from "../workflow/mcp-call";
import { recordOneGraphAuthority } from "./graph-ownership";
import { oneTeamDispatchOwnerChat, type OneTeamCaller } from "./team-dispatch";
import { searchToolchainAssets } from "../toolchains/search";
import { recordToolchainSearchMiss } from "../toolchains/detector-observations";
import { grantToolchainTrial, toolchainTrialGranted } from "../toolchains/trial";
import { getToolchainAsset, listToolchainAssets, publishToolchainVersion } from "../toolchains/assets";
import { callToolchain, getToolchainCall, listToolchainCalls } from "../toolchains/calls";
import type { ToolchainAsset, ToolchainCallReceipt } from "../../shared/toolchain-asset";
import { generateToolchain } from "../toolchains/generalizer";
import { TOOLCHAIN_CONSUMER_TOOLS } from "../toolchains/consumer";
import { reportToolchainAssetProblem, openToolchainAssetReports,
  preflightToolchainAssetRepair, withToolchainAssetRepairCommit, settleToolchainAssetRepair } from "../toolchains/reports";
import { readToolchainState } from "../toolchains/store";
import { recordToolchainAssetDiscovery, toolchainAssetUsage } from "../toolchains/usage";
import { currentOneToolchainNativeInvocation } from "./toolchain-native-runtime";
import { resolveNativeAssetPublicationAuthority } from "../toolchains/asset-cold-start";
import { resolveGraphOriginMessage, type GraphOriginBinding } from "./graph-origin";
import { ephemeralGraphSweptOff, markOneGraphEphemeral } from "./ephemeral-graphs";
import { graphStructure } from "../../shared/graph-structure";
import { occasionMarkers, sameWorkName } from "../../shared/graph-instance-advice";
import { graphPurpose } from "../../shared/graph-purpose";

/** A Work task's capability (team-control-server scope "toolchain-consumer"). */
/**
 * The owner message a graph's reports answer (22 O3). Run delivery only reports into the origin conversation against a
 * user message there when proven (automation-delivery.ts); an unknown command remains null in a standalone report. The anchor is the message the
 * calling run received (graph-origin.ts), not the conversation's latest message (native-harness notyet NH15).
 */
function ownerOriginMessage(chatId: string, caller: OneTeamCaller): string | null {
  return resolveGraphOriginMessage(getDb(), chatId, caller as OneTeamCaller & GraphOriginBinding);
}

/** A Work task's or a teammate's capability (team-control-server scopes "toolchain-consumer" and "room-member"). */
function isToolchainConsumer(caller: OneTeamCaller): boolean {
  const scope = (caller as { scope?: unknown }).scope;
  return scope === "toolchain-consumer" || scope === "room-member";
}
function owner(caller: OneTeamCaller) {
  if (isToolchainConsumer(caller)) {
    // The Work task or teammate itself is the requester; it never stands in for One's conversation.
    const chat = caller.chatId ? getChat(caller.chatId) : null;
    if (!chat || chat.archivedAt || oneTeamDispatchOwnerChat(chat.id) !== null) throw new Error("one_graph_owner_missing");
    return chat;
  }
  const chatId = oneTeamDispatchOwnerChat(caller.chatId);
  const chat = chatId ? getChat(chatId) : null;
  if (!chat) throw new Error("one_graph_owner_missing");
  return chat;
}
function writable(caller: OneTeamCaller): void {
  if (caller.permission !== "write" && caller.permission !== "full") throw new Error("one_graph_write_permission_required");
  if (owner(caller).archivedAt) throw new Error("one_graph_owner_archived");
}
function scoped(caller: OneTeamCaller): Automation[] {
  // A Work task owns no graphs: everything it runs is reached as a callable Toolchain.
  if (isToolchainConsumer(caller)) return [];
  const chat = owner(caller);
  return listAutomations().filter(a => a.monitor?.originChatId === chat.id);
}
function exact(caller: OneTeamCaller, id: unknown): Automation {
  const automation = typeof id === "string" ? scoped(caller).find(a => a.id === id) : undefined;
  if (!automation) throw new Error("one_graph_target_not_in_context");
  return automation;
}
/** The caller's own Toolchain request: its result stays readable even if the
 * contract is withdrawn or goes stale after the request was accepted. */
function requestedByCaller(caller: OneTeamCaller, automationId: string, eventId: unknown): boolean {
  const event = typeof eventId === "string" ? getTriggerEvent(eventId) : null;
  if (!event || event.automationId !== automationId) return false;
  const payload = event.payload as Record<string, unknown>;
  return payload.source === "toolchain" && payload.ownerChatId === owner(caller).id;
}
function exactOrRequested(caller: OneTeamCaller, id: unknown, eventId: unknown): Automation {
  if (typeof id === "string" && scoped(caller).some(a => a.id === id)) return exact(caller, id);
  const automation = typeof id === "string" && requestedByCaller(caller, id, eventId) ? getAutomation(id) : null;
  if (!automation) throw new Error("one_graph_target_not_in_context");
  return automation;
}
function fresh(a: Automation, expected: unknown): void {
  if (typeof expected !== "string" || expected !== automationDefinitionDigest(a)) throw new Error("one_graph_definition_changed");
}
function editable(a: Automation, affectedNodeIds = resolveAutomationGraph(a).nodes.map(node => node.id)): void {
  if (hasDurableActiveAutomationExecution(a.id) || hasGraphLoginWait(a.id)
    || getDb().prepare("SELECT 1 FROM automation_trigger_events WHERE automation_id=? AND status IN ('pending','claimed') LIMIT 1").get(a.id)) throw new Error("one_graph_execution_unsettled");
  const held = new Set(listAutomationGraphReconciliations(a.id).flatMap(view => view.nodes.map(node => node.nodeId)));
  const affected = affectedNodeIds.filter(id => held.has(id));
  if (affected.length) throw new Error(`one_graph_leaf_unsettled:${affected.join(",")}`);
}
/** Preserve unresolved coordinates while allowing an unrelated branch to be repaired. */
function changedGraphNodes(before: WorkflowGraph, after: WorkflowGraph): string[] {
  const changed = new Set([...before.nodes, ...after.nodes].filter(node =>
    JSON.stringify(before.nodes.find(candidate => candidate.id === node.id))
      !== JSON.stringify(after.nodes.find(candidate => candidate.id === node.id))).map(node => node.id));
  for (const edge of [...before.edges, ...after.edges]) {
    if (JSON.stringify(before.edges.find(candidate => candidate.id === edge.id))
      !== JSON.stringify(after.edges.find(candidate => candidate.id === edge.id))) {
      changed.add(edge.source); changed.add(edge.target);
    }
  }
  return [...changed];
}
function receipt(a: Automation, extra: Record<string, unknown> = {}) {
  return { schemaVersion: "agentlas.one-graph-receipt.v1", graph_id: a.id, name: a.name,
    definition_revision: automationDefinitionDigest(a), enabled: a.enabled, next_run_at: a.nextRunAt,
    ...extra };
}
/** A reference cannot enlarge the parent's conversation, tool or write scope.
 * Recheck descendants when saving AND admitting a future run, since children
 * can be edited after their parent was authored. */
function checkReferences(caller: OneTeamCaller, graph: WorkflowGraph, selfId?: string,
  parentPermission: "read" | "write" = requiredExecutionPermission(graph),
  parentHubMode = "local-only", visited = new Set<string>()): void {
  const candidates = scoped(caller);
  for (const node of graph.nodes) {
    if (node.type !== "subgraph") continue;
    const ref = node.config?.graphRef;
    const child = candidates.find(a => a.id === ref);
    if (!child || child.id === selfId || visited.has(child.id)) throw new Error("one_graph_subgraph_invalid");
    if (parentPermission === "read" && (child.executionPermission !== "read" || requiredExecutionPermission(resolveAutomationGraph(child)) !== "read")) throw new Error("one_graph_subgraph_permission_mismatch");
    if (parentHubMode === "local-only" && child.hubMode !== "local-only") throw new Error("one_graph_subgraph_hub_scope_mismatch");
    const branch = new Set(visited); branch.add(child.id);
    checkReferences(caller, resolveAutomationGraph(child), selfId, parentPermission, parentHubMode, branch);
  }
}
/** Admission for a durable command after its short-lived MCP capability has
 * gone away. The saved origin and saved grants, never payload fields, own scope. */
export function validateOneGraphCommandScope(a: Automation): void {
  const chatId = a.monitor?.originChatId;
  if (!chatId || !getChat(chatId)) throw new Error("one_graph_owner_missing");
  checkReferences({ chatId, permission: a.executionPermission }, resolveAutomationGraph(a), a.id,
    a.executionPermission, a.hubMode ?? "local-only");
}
async function connected(caller: OneTeamCaller, a: Automation): Promise<void> {
  const graph = resolveAutomationGraph(a);
  checkReferences(caller, graph, a.id, a.executionPermission, a.hubMode ?? "local-only");
  const report = await reportGraphConnections(graph, currentUiLocale());
  if (!report.activation.canActivate) throw new Error(`one_graph_not_connected:${report.activation.reason}`);
}
function graphSame(a: Automation, graph: WorkflowGraph, bp: GraphBlueprint, schedule: string, triggerType: string): boolean {
  return JSON.stringify(a.graph) === JSON.stringify(graph) && a.goal === bp.goal
    && a.name === bp.name && a.scheduleHuman === schedule && a.triggerType === triggerType;
}

async function waitForResult(caller: OneTeamCaller, a: Automation, input: Record<string, unknown>) {
  const read = () => {
    const event = typeof input.event_id === "string" ? getTriggerEvent(input.event_id) : null;
    if (!event || event.automationId !== a.id) throw new Error("one_graph_event_not_in_context");
    if (!scoped(caller).some(item => item.id === a.id) && !requestedByCaller(caller, a.id, event.id)) {
      throw new Error("one_graph_target_not_in_context");
    }
    return event;
  };
  let event = read();
  const until = Date.now() + Number(input.wait_seconds ?? 0) * 1000;
  while ((event.status === "pending" || event.status === "claimed") && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, Math.min(500, until - Date.now())));
    event = read();
  }
  const row = event.runId ? getDb().prepare("SELECT status, node_states_json, node_failures_json, checkpoint_json FROM automation_runs WHERE id=? AND automation_id=?").get(event.runId, a.id) as
    { status: string; node_states_json: string | null; node_failures_json: string | null; checkpoint_json: string | null } | undefined : undefined;
  const checkpoint = row?.checkpoint_json ? JSON.parse(row.checkpoint_json) as { checkpointDigest?: string; outputs?: Record<string, unknown> } : null;
  if (checkpoint) {
    const { checkpointDigest, ...sealed } = checkpoint;
    if (checkpointDigest !== sha256Value(sealed)) throw new Error("one_graph_result_checkpoint_invalid");
  }
  const outputs = checkpoint?.outputs ?? {};
  let results: unknown;
  if (typeof input.node_id === "string") {
    if (typeof outputs[input.node_id] !== "string") throw new Error("one_graph_output_not_available");
    const output = outputs[input.node_id] as string;
    const offset = Number(input.offset ?? 0), limit = Number(input.limit ?? 16000);
    results = { node_id: input.node_id, output: output.slice(offset, offset + limit), offset, total_characters: output.length, truncated: offset + limit < output.length };
  } else {
    let remaining = 32000;
    results = Object.entries(outputs).slice(-32).map(([nodeId, output]) => {
      const text = typeof output === "string" ? output : JSON.stringify(output);
      const value = text.slice(0, Math.min(4000, remaining)); remaining -= value.length;
      return { node_id: nodeId, output: value, total_characters: text.length, truncated: value.length < text.length };
    });
  }
  return { graph_id: a.id, event_id: event.id, run_id: event.runId, event_status: event.status,
    status: event.status === "delivered" ? (event.runOutcome ?? row?.status ?? "delivered") : event.status,
    ...(row ? { node_states: JSON.parse(row.node_states_json ?? "{}"), failures: JSON.parse(row.node_failures_json ?? "{}"), results } : {}),
    ...(event.lastError ? { error: event.lastError } : {}) };
}

function assetManifest(asset: ToolchainAsset, version = asset.stableVersion ?? asset.versions.at(-1)?.version) {
  const release = asset.versions.find(item => item.version === version);
  if (!release) throw new Error("toolchain_version_not_found");
  return { toolchain_id: asset.id, toolchainId: asset.id, version: release.version, name: release.contract.name,
    status: asset.status, stable_version: asset.stableVersion, content_hash: release.contentHash,
    description: release.contract.description, when_to_use: release.contract.whenToUse, when_not_to_use: release.contract.whenNotToUse,
    input_schema: release.contract.inputSchema, output_schema: release.contract.outputSchema, examples: release.contract.examples,
    variation_statement: release.contract.variationStatement, validation: release.validation,
    fresh_session_test: release.coldStart ? { ...release.coldStart, matching_requests: release.coldStart.positives,
      found: release.coldStart.positiveFound, selected: release.coldStart.positiveSelected,
      bound: release.coldStart.positiveBound, wrongly_selected: release.coldStart.negativeSelected } : null,
    exposed_by: release.exposedBy ?? null,
    effects: { readOnlyHint: requiredExecutionPermission(release.implementation.snapshot.graph) === "read" },
    versions: asset.versions.map(item => ({ version: item.version, content_hash: item.contentHash, validation: item.validation.state })),
    usage: toolchainAssetUsage(asset.id) };
}

function trialManifest(asset: ToolchainAsset, version: number) {
  const manifest = assetManifest(asset, version);
  return { ...manifest, status: "callable", stage: "trial", validation: { ...manifest.validation, state: "trial" },
    versions: manifest.versions.map(item => item.version === version ? { ...item, validation: "trial" } : item) };
}

function toolchainPublicationSummary(asset: ToolchainAsset, version: number, before: ToolchainAsset) {
  const tested = asset.versions.find(v => v.version === version)?.coldStart;
  const prior = before.versions.find(v => v.version === version)?.coldStart;
  const sameTest = tested && prior && tested.at === prior.at && tested.nativeIntentId === prior.nativeIntentId && tested.catalogDigest === prior.catalogDigest;
  const callable = asset.stableVersion === version && asset.status === "callable";
  return { state: callable ? "callable" : "draft",
    ...(sameTest ? (before.status === "callable" && before.stableVersion === version ? { already_callable: true } : { already_tested: true }) : {}),
    ...(callable ? {} : { next: currentUiLocale() === "ko" ? "테스트 결과를 확인하고 툴체인을 수정한 뒤 다시 시도하세요."
      : "Review the test results and improve the Toolchain before retrying." }) };
}

function assetOwnedBy(caller: OneTeamCaller, _asset: ToolchainAsset): void {
  // Assets belong to this local owner's library. A release's creator chat is
  // provenance, not ownership: the owner's UI or another authenticated One
  // conversation may improve it. Work consumers retain read/call-only scope.
  if (isToolchainConsumer(caller)) throw new Error("toolchain_owner_scope_required");
  writable(caller);
}
function callerCall(caller: OneTeamCaller, id: unknown): ToolchainCallReceipt {
  const call = typeof id === "string" ? getToolchainCall(id) : null;
  const original = currentOneToolchainNativeInvocation().assertCurrent();
  if (caller.chatId !== original.chatId || !call || call.callerChatId !== original.chatId)
    throw new Error("toolchain_call_not_in_context");
  return call;
}
async function waitForCall(caller: OneTeamCaller, id: unknown, seconds: number): Promise<ToolchainCallReceipt> {
  let call = callerCall(caller, id);
  const until = Date.now() + seconds * 1000;
  while (call.status === "running" && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, Math.min(250, until - Date.now())));
    call = callerCall(caller, id);
  }
  return call;
}
function callManifest(call: ToolchainCallReceipt) {
  const name = getToolchainAsset(call.toolchainId)?.versions.find(version => version.version === call.version)?.contract.name;
  const { result, ...metadata } = call;
  // Native runtime projections cap long output. Keep the exact immutable identity
  // ahead of its potentially large result so the received event remains attributable.
  return { ...metadata, ...(name ? { name } : {}), call_id: call.id, toolchain_id: call.toolchainId,
    ...("result" in call ? { result } : {}) };
}

async function dispatchToolchain(caller: OneTeamCaller, name: string, input: Record<string, unknown>): Promise<unknown> {
  const chat = owner(caller);
  if (name === "toolchain_search") {
    const assets = listToolchainAssets();
    const selected = searchToolchainAssets(String(input.task), assets, input.limit as number | undefined);
    recordToolchainAssetDiscovery(selected);
    if (selected.length) return { schemaVersion: "agentlas.toolchain-search.v2", toolchains: selected.map(asset => assetManifest(asset)) };
    // An empty search is One saying "I am about to redo this": the repeated-work detector's evidence (toolchains/detector.ts).
    recordToolchainSearchMiss({ task: input.task, chatId: caller.chatId });
    // A detector draft earns callability in real use (toolchains/trial.ts): at most one, marked as a trial. It is shown
    // as callable for this conversation because the host granted this exact trial version.
    const trial = grantToolchainTrial(String(input.task), caller.chatId, assets);
    return { schemaVersion: "agentlas.toolchain-search.v2", toolchains: trial ? [trialManifest(trial.asset, trial.version)] : [] };
  }
  if (name === "toolchain_inspect") {
    const asset = getToolchainAsset(String(input.toolchain_id));
    if (!asset) throw new Error("toolchain_not_found");
    const manifest = assetManifest(asset, input.version as number | undefined);
    if (input.include_reports !== true) return { schemaVersion: "agentlas.toolchain-inspect.v1", ...manifest };
    if (isToolchainConsumer(caller)) throw new Error("toolchain_owner_scope_required");
    if (chat.archivedAt) throw new Error("toolchain_caller_archived");
    const original = currentOneToolchainNativeInvocation().assertCurrent();
    if (caller.chatId !== original.chatId) throw new Error("toolchain_call_not_in_context");
    const reports = await openToolchainAssetReports({ callerChatId: original.chatId, toolchainId: asset.id,
      version: manifest.version, contentHash: manifest.content_hash });
    return { schemaVersion: "agentlas.toolchain-inspect.v1", ...manifest, reports };
  }
  if (name === "toolchain_result") return callManifest(await waitForCall(caller, input.call_id, Number(input.wait_seconds ?? 0)));
  if (name === "toolchain_report") {
    const call = callerCall(caller, input.call_id);
    const outcome = await reportToolchainAssetProblem({ callerChatId: call.callerChatId!, callId: call.id,
      problem: String(input.problem), expected: typeof input.expected === "string" ? input.expected : null });
    return { schemaVersion: "agentlas.toolchain-report.v2", toolchainId: call.toolchainId, version: call.version, call_id: call.id,
      next: currentUiLocale() === "ko" ? "해당 Toolchain 없이 다른 방법으로 작업을 이어가세요." : "Continue the task without the Toolchain.",
      ...(outcome.state === "queue_full" ? { state: outcome.state, open: outcome.open }
        : { report_id: outcome.reportId, state: outcome.state, delivered_to: outcome.deliveredTo }) };
  }
  if (name === "toolchain_run") {
    // A Toolchain that only reads runs under read permission; one that writes, posts or sends needs write (calls.ts caps the run
    // at the caller's permission either way).
    const target = getToolchainAsset(String(input.toolchain_id))?.versions.find(version => version.version === Number(input.version));
    if (!target || requiredExecutionPermission(target.implementation.snapshot.graph) !== "read") writable(caller);
    if (chat.archivedAt) throw new Error("toolchain_caller_archived");
    const native = currentOneToolchainNativeInvocation(), original = native.assertCurrent(), execution = native.execution();
    if (caller.chatId !== original.chatId) throw new Error("toolchain_call_not_in_context");
    const pending = callToolchain({ toolchainId: String(input.toolchain_id), version: Number(input.version), args: input.args as Record<string, unknown> },
      { callerChatId: original.chatId, parentRunId: original.runId, signal: execution.signal,
        requestId: String(input.request_id), permission: caller.permission === "read" ? "read" : "write", dryRun: input.dry_run === true,
        trial: toolchainTrialGranted(original.chatId, String(input.toolchain_id), Number(input.version)),
        beforeExecution: call => native.registerCall(call).then(() => undefined),
        afterSettlement: call => native.registerCall(call).then(() => undefined),
        withExecution: (call, body) => execution.run(call, body) });
    pending.catch(() => undefined);
    const settled = await Promise.race([pending, new Promise<null>(resolve => {
      const timer = setTimeout(() => resolve(null), Number(input.wait_seconds ?? 20) * 1000); timer.unref?.();
    })]);
    if (settled) return callManifest(settled);
    native.assertCurrent();
    const receipt = listToolchainCalls(String(input.toolchain_id)).find(call => call.callerChatId === original.chatId && call.requestId === input.request_id);
    if (!receipt) throw new Error("toolchain_call_receipt_missing");
    return callManifest(receipt);
  }
  writable(caller);
  if (name === "toolchain_create") {
    const native = currentOneToolchainNativeInvocation(), original = native.assertCurrent(), preparation = native.preparation("generalization");
    if (caller.chatId !== original.chatId) throw new Error("toolchain_call_not_in_context");
    const targetId = typeof input.toolchain_id === "string" ? input.toolchain_id : null;
    const reportId = typeof input.report_id === "string" ? input.report_id : null;
    if (reportId && !targetId) throw new Error("toolchain_repair_original_report_required");
    // This check only denies bypass; report reads and repair writes still require
    // their exact current native source, audience and owner effect admissions.
    if (targetId && !reportId && (readToolchainState(`asset:${targetId}`).reports ?? []).some(report => report.state === "open"))
      throw new Error("toolchain_repair_report_id_required");
    const repair = targetId && reportId ? { callerChatId: original.chatId, toolchainId: targetId, reportId } : null;
    if (repair) await preflightToolchainAssetRepair({ ...repair, requestId: String(input.request_id) });
    else native.assertPreparedCommitBound();
    native.assertCurrent(); preparation.producer.assertCurrent("generalization");
    const generationInput={ request:String(input.request),requestId:String(input.request_id),...(input.toolchain_id?{toolchainId:String(input.toolchain_id)}:{}),...(chat.projectId?{projectId:chat.projectId}:{}) };
    const generationActor: NonNullable<Parameters<typeof generateToolchain>[1]> = {callerChatId:original.chatId,signal:preparation.signal,preparationProducer:preparation.producer,
      assertCurrent:()=>{ native.assertCurrent(); writable(caller); },
      withPreparedCommit: repair ? (proposal, commit) => withToolchainAssetRepairCommit(repair, proposal, commit) : (proposal, commit) => {
        // The actual model may select an existing identity even when the request
        // omitted toolchain_id. That cannot bypass its report/repair admission.
        const checkReports = () => {
          if (proposal.decision === "new_version" && proposal.targetToolchainId
            && (readToolchainState(`asset:${proposal.targetToolchainId}`).reports ?? []).some(report => report.state === "open"))
            throw new Error("toolchain_repair_report_id_required");
        };
        checkReports();
        return native.withPreparedCommit(proposal, () => { checkReports(); return commit(); });
      }};
    const result = await preparation.run(() => withCurrentHistoryProducer("toolchain",ports=>ports.toolchain.generateToolchain(generationInput,generationActor),()=>generateToolchain(generationInput,generationActor)));
    await native.registerProduced(result);
    return { schemaVersion: "agentlas.toolchain-create.v2", ...assetManifest(result.asset, result.version),
      decision: result.decision, rationale: result.rationale, generalization_id: result.generalizationId };
  }
  if (name === "toolchain_publish") {
    const asset = getToolchainAsset(String(input.toolchain_id));
    if (!asset) throw new Error("toolchain_not_found");
    assetOwnedBy(caller, asset);
    const version = Number(input.version);
    const reportId = typeof input.report_id === "string" ? input.report_id : null;
    const repairRequestId = typeof input.repair_request_id === "string" ? input.repair_request_id : null;
    if (Boolean(reportId) !== Boolean(repairRequestId)) throw new Error("toolchain_repair_exact_acceptance_required");
    const native = currentOneToolchainNativeInvocation(), original = native.assertCurrent(), preparation = native.preparation("fresh-session-evaluation");
    if (caller.chatId !== original.chatId) throw new Error("toolchain_call_not_in_context");
    const nativePublication = await resolveNativeAssetPublicationAuthority({ kind: "one", caller, id: asset.id, version });
    native.assertCurrent();
    const pending = preparation.run(() => publishToolchainVersion(asset.id, version,
      { callerChatId: original.chatId, permission: "write", nativePublication, signal: preparation.signal }));
    pending.catch(() => undefined);
    const settled = await Promise.race([pending, new Promise<null>(resolve => { const timer = setTimeout(() => resolve(null), 45_000); timer.unref?.(); })]);
    const repaired = settled && reportId && repairRequestId ? await settleToolchainAssetRepair({ callerChatId: original.chatId,
      toolchainId: asset.id, reportId, repairRequestId }) : null;
    return { schemaVersion: "agentlas.toolchain-publish.v2", ...assetManifest(settled ?? getToolchainAsset(asset.id)!, version),
      ...(repaired ? { repaired_report: repaired } : {}),
      ...(settled ? toolchainPublicationSummary(settled, version, asset) : { testing: true, state: "testing",
        next: currentUiLocale() === "ko" ? "테스트가 진행 중입니다. 같은 툴체인의 결과를 다시 확인하세요." : "Testing is in progress. Check the same Toolchain result again." }) };
  }
  throw new Error("toolchain_unknown_operation");
}

/** The conversation that owns graphs for this caller — the same rule every one_graph_* tool applies (graph drafts). */
export function oneGraphOwnerChatId(caller: OneTeamCaller): string {
  if (isToolchainConsumer(caller)) throw new Error("one_graph_consumer_scope");
  return owner(caller).id;
}

/** one_graph_save's checks — shape, compiler, MCP effect, references, schedule — without saving (graph drafts). */
export async function validateOneGraphBlueprint(caller: OneTeamCaller, bp: GraphBlueprint, graphId: string | null):
  Promise<{ ok: true } | { ok: false; code: string; problems: unknown }> {
  const shape = graphAuthoringShapeProblems(bp, GRAPH_BLUEPRINT_INPUT_SCHEMA, "blueprint");
  if (shape.length) return { ok: false, code: "one_graph_input_invalid", problems: shape };
  const existing = graphId ? exact(caller, graphId) : null;
  const built = buildGraphFromBlueprint(bp, currentUiLocale(), { knownGraphs: scoped(caller).map(a => ({ id: a.id, name: a.name })), ...(existing ? { selfId: existing.id } : {}) });
  if (!built.ok) return { ok: false, code: "one_graph_blueprint_invalid", problems: built.problems };
  const effectProblems = graphMcpEffectProblems(built.graph, currentUiLocale());
  if (effectProblems.length) return { ok: false, code: "one_graph_blueprint_invalid", problems: effectProblems.map(p => ({ reason: p.reason, ask: null })) };
  try { checkReferences(caller, built.graph, existing?.id, requiredExecutionPermission(built.graph), existing?.hubMode ?? "local-only"); }
  catch (error) { return { ok: false, code: "one_graph_reference_invalid", problems: [{ reason: error instanceof Error ? error.message : String(error), ask: null }] }; }
  if (bp.trigger.kind === "cron") {
    const spec = specFromStored(bp.trigger.schedule, existing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (!spec || !nextRun(spec)) return { ok: false, code: "one_graph_schedule_invalid", problems: [{ reason: "schedule has no next run", ask: null }] };
  }
  return { ok: true };
}

export async function oneGraphDispatch(caller: OneTeamCaller, name: string, input: Record<string, unknown>): Promise<unknown> {
  if (isToolchainConsumer(caller) && !TOOLCHAIN_CONSUMER_TOOLS.includes(name)) throw new Error("one_graph_consumer_scope");
  const tool = ONE_GRAPH_TOOLS.find(t => t.name === name);
  if (!tool) throw new Error("one_graph_unknown_operation");
  const problems = graphAuthoringShapeProblems(input, tool.inputSchema);
  if (problems.length) return { ok: false, code: "one_graph_input_invalid", problems };
  const chat = owner(caller);
  if (name === "one_graph_schema") return { schemaVersion: "agentlas.one-graph-authoring.v1", blueprint: GRAPH_BLUEPRINT_INPUT_SCHEMA,
    definitionProtocol: "agentlas.automation-graph-definition.v1", execution: "host_compiled_dependency_graph", strategyOwner: "One",
    ...(input.catalog_id ? { inventory: await inspectGraphMcpTools({ chat, catalogId: input.catalog_id as string, permission: caller.permission }) } : {}),
    ...(input.include_registration_protocol === true ? { registrationProtocol: AUTOMATION_PROTOCOL } : {}) };
  if (name.startsWith("toolchain_")) return dispatchToolchain(caller, name, input);
  if (name === "one_graph_inspect") {
    if (!input.graph_id) return { graphs: scoped(caller).map(a => receipt(a, { source: a.graph?.nodes.length ? "stored-graph" : "legacy-prompt", goal: a.goal ?? null })) };
    const a = exact(caller, input.graph_id);
    const definition = readAutomationGraphDefinition(a, automationDefinitionDigest(a), input.if_cache_key as string | undefined);
    if (definition.graph && input.node_ids) {
      const ids = input.node_ids as string[];
      if (ids.some(id => !definition.graph!.nodes.some(node => node.id === id))) throw new Error("one_graph_node_missing");
      const requested = definition.graph.nodes.filter(node => ids.includes(node.id));
      if (requested.length === 1 && (input.offset !== undefined || Buffer.byteLength(JSON.stringify(requested[0]), "utf8") > 96 * 1024)) {
        const serialized = JSON.stringify(requested[0]);
        const offset = Number(input.offset ?? 0), limit = Number(input.limit ?? 16000);
        return { ...receipt(a), ...definition, graph: undefined, selection: { node_id: requested[0].id,
          node_json: serialized.slice(offset, offset + limit), offset, total_characters: serialized.length,
          truncated: offset + limit < serialized.length } };
      }
      const nodes: WorkflowGraph["nodes"] = [];
      let bytes = 0;
      for (const node of requested) {
        const size = Buffer.byteLength(JSON.stringify(node), "utf8");
        if (bytes + size > 96 * 1024) break;
        nodes.push(node); bytes += size;
      }
      const included = new Set(nodes.map(node => node.id));
      const edges = definition.graph.edges.filter(edge => included.has(edge.source) || included.has(edge.target));
      // A selection is a definition slice, not a standalone executable graph.
      return { ...receipt(a), ...definition, graph: undefined, selection: { nodes,
        remaining_node_ids: requested.filter(node => !included.has(node.id)).map(node => node.id),
        edges: edges.slice(0, 256).map(edge => ({ id: edge.id, source: edge.source, target: edge.target })),
        edges_truncated: edges.length > 256 } };
    }
    if (definition.graph && Buffer.byteLength(JSON.stringify(definition.graph), "utf8") > 128 * 1024) {
      const offset = Number(input.node_offset ?? 0);
      return { ...receipt(a), ...definition, graph: undefined, definition_omitted: "fetch_node_slices",
        node_offset: offset, next_node_offset: offset + 128 < definition.graph.nodes.length ? offset + 128 : null,
        nodes: definition.graph.nodes.slice(offset, offset + 128).map(node => ({ id: node.id, type: node.type, label: node.label?.slice(0, 160),
          execution: node.config?.mcpCall ? "mcp_call" : node.type,
          produces: node.config?.produces, instruction_characters: String(node.config?.prompt ?? node.config?.code ?? node.config?.note ?? "").length })),
        edges: definition.graph.edges.slice(0, 512).map(edge => ({ id: edge.id, source: edge.source, target: edge.target })),
        edges_truncated: definition.graph.edges.length > 512 };
    }
    return { ...receipt(a), ...definition };
  }
  if (name === "one_graph_result") return waitForResult(caller, exactOrRequested(caller, input.graph_id, input.event_id), input);
  if (name === "one_graph_set_enabled" && input.enabled === false) {
    const a = exact(caller, input.graph_id);
    const result = applyAutomationLifecycle({ parsed: { action: "pause", automationId: a.id, name: a.name, prompt: "", schedule: "", scheduleEmitted: false },
      chatId: chat.id, canWrite: false });
    return receipt(result.automation, { ok: true, action: result.action, active_run_stop_requested: result.activeRunStopRequested });
  }
  writable(caller);
  if (name === "one_graph_save") {
    const bp = input.blueprint as GraphBlueprint;
    const existing = input.graph_id ? exact(caller, input.graph_id) : null;
    if (existing) fresh(existing, input.expected_revision);
    const built = buildGraphFromBlueprint(bp, currentUiLocale(), { knownGraphs: scoped(caller).map(a => ({ id: a.id, name: a.name })), ...(existing ? { selfId: existing.id } : {}) });
    if (!built.ok) return { ok: false, code: "one_graph_blueprint_invalid", problems: built.problems };
    const graph: WorkflowGraph = { ...built.graph, nodes: built.graph.nodes.map(node =>
      ["agent", "action", "eval"].includes(node.type) && !node.config?.mcpCall
        ? { ...node, config: { ...node.config, ref: chat.agentId, targetType: "agent" } } : node) };
    // A declared effect no argument can satisfy is refused on every run; say so now, while the author can fix it.
    const effectProblems = graphMcpEffectProblems(graph, currentUiLocale());
    if (effectProblems.length) return { ok: false, code: "one_graph_blueprint_invalid", problems: effectProblems.map(p => ({ reason: p.reason, ask: null })) };
    const hubMode = existing?.hubMode ?? "local-only";
    const permission = requiredExecutionPermission(graph);
    checkReferences(caller, graph, existing?.id, permission, hubMode);
    const schedule = bp.trigger.kind === "cron" ? bp.trigger.schedule : "";
    const triggerType = built.triggerType === "manual" ? "command" : "schedule";
    if (bp.trigger.kind === "cron") {
      const spec = specFromStored(schedule, existing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
      if (!spec || !nextRun(spec)) return { ok: false, code: "one_graph_schedule_invalid" };
    }
    const connections = input.enabled === false ? null : await reportGraphConnections(graph, currentUiLocale());
    const enable = input.enabled !== false && connections?.activation.canActivate === true;
    // A one-off graph switched off when its Goal ended or it sat idle (one/ephemeral-graphs.ts) is wanted again when
    // One saves it unchanged: switch it back on for a fresh lifetime. A graph the owner switched off stays off.
    const revive = (a: Automation): Automation => {
      if (!enable || !ephemeralGraphSweptOff(a)) return a;
      const resumed = applyAutomationLifecycle({ parsed: { action: "resume", automationId: a.id, expectedDefinitionDigest: automationDefinitionDigest(a),
        name: a.name, prompt: "", schedule: "", scheduleEmitted: false }, chatId: chat.id, canWrite: true }).automation;
      markOneGraphEphemeral(resumed, chat.id);
      return resumed;
    };
    return desktopStoreTransaction(getDb(), () => {
      const matches = scoped(caller).filter(a => a.name.normalize("NFKC").toLowerCase() === bp.name.normalize("NFKC").toLowerCase());
      if (!existing && matches.length) {
        if (matches.length === 1 && graphSame(matches[0], graph, bp, schedule, triggerType)) {
          const same = revive(matches[0]);
          recordOneGraphAuthority(same, chat.id);
          return receipt(same, { ok: true, action: "already_saved" });
        }
        throw new Error("one_graph_name_conflict_use_exact_id");
      }
      // Graphs of the same structure already saved here: the same work for another item is one graph run with a new input, not another
      // copy. A copy is refused only when its name differs by nothing but a date or number; any other look-alike is told to the author.
      const fingerprint = graphStructure(graph).fingerprint;
      const lookAlikes = existing ? [] : scoped(caller).filter(a => a.graph?.nodes?.length && graphStructure(resolveAutomationGraph(a)).fingerprint === fingerprint);
      // A new input graph of fixed code or tool steps only is a tool, not a graph: done directly once, a Toolchain when it comes back.
      if (!existing && graphPurpose(graph, bp.trigger.kind) === "tool") return { ok: false, code: "one_graph_is_a_tool",
        next: "This graph only runs fixed code or tool steps on an input, so it is a tool, not a graph (a graph is recurring work where AIs act on results, or something on a schedule). Do these steps directly now. If the same operation keeps coming back, make it a Toolchain with toolchain_create: say what the steps do and include the code or commands." };
      const sameWork = lookAlikes.find(a => sameWorkName(a.name, bp.name));
      if (sameWork) return { ok: false, code: "one_graph_same_work_exists", graph_id: sameWork.id, name: sameWork.name, definition_revision: automationDefinitionDigest(sameWork),
        enabled: sameWork.enabled,
        next: "This work is already saved as a graph; a graph is for work that comes back with different inputs. Run it with the new input (one_graph_run), or change that graph (one_graph_save with its graph_id and current revision) so the date or item is an input. Do not save another copy." };
      let saved: Automation;
      if (existing) {
        const current = exact(caller, existing.id); fresh(current, input.expected_revision);
        if (graphSame(current, graph, bp, schedule, triggerType)) {
          const same = revive(current);
          recordOneGraphAuthority(same, chat.id);
          return receipt(same, { ok: true, action: "unchanged" });
        }
        editable(current, changedGraphNodes(resolveAutomationGraph(current), graph));
        updateAutomationGraph(current.id, graph, { note: "One structured blueprint" });
        // The monitor lives inside the trigger document: replacing the trigger without it dropped the origin binding,
        // so every revision of a saved graph failed its own scope check (measured 2026-10-04, QA app, real model).
        saved = updateAutomation(current.id, { name: bp.name, goal: bp.goal, promptTemplate: bp.goal,
          scheduleHuman: schedule, scheduleJson: null, triggerType, trigger: { kind: triggerType },
          // A later editor cannot establish the original command of an unbound graph.
          monitor: current.monitor,
          executionPermission: permission });
        saved = applyAutomationLifecycle({ parsed: { action: enable ? "resume" : "pause", automationId: saved.id, expectedDefinitionDigest: automationDefinitionDigest(saved), name: saved.name, prompt: "", schedule: "", scheduleEmitted: false }, chatId: chat.id, canWrite: true }).automation;
      } else saved = createAutomation({ name: bp.name, goal: bp.goal, promptTemplate: bp.goal,
        targetType: "agent", targetId: chat.agentId, projectId: chat.projectId,
        runtimeSelection: chat.runtimeSelection ?? undefined, hubMode: "local-only", executionPermission: permission,
        graphJson: graph, enabled: enable, createdBy: "agent", scheduleHuman: schedule, scheduleJson: null,
        triggerType, monitor: { schemaVersion: "agentlas.automation-monitor.v1", originChatId: chat.id,
          originMessageId: ownerOriginMessage(chat.id, caller), notificationPolicy: "meaningful_changes", deadline: null } });
      // An input-triggered graph is work One does now until it proves it comes back: it ends with the Goal it was made for or
      // after idle days, unless it has served three different inputs (one/ephemeral-graphs.ts).
      markOneGraphEphemeral(saved, chat.id);
      recordOneGraphAuthority(saved, chat.id);
      const markers = existing ? [] : occasionMarkers(bp.name);
      return receipt(saved, { ok: true, action: existing ? "updated" : "created", ...(connections && !enable ? { activation: connections.activation } : {}),
        ...(markers.length ? { advice: [{ code: "graph_name_names_one_occasion", markers,
          next: "A graph is for work that comes back with different inputs. This name carries a date or number; if the graph is only for this occasion, switch it off when done and do such work directly next time. If it will recur, rename it for the recurring work (one_graph_save with graph_id) and pass the date or item as its input." }] } : {}),
        ...(lookAlikes.length ? { similar_graphs: lookAlikes.slice(0, 3).map(a => ({ graph_id: a.id, name: a.name, enabled: a.enabled })),
          similar_graphs_next: "These graphs have the same structure. If this is the same kind of work for another item, run one of them with the new input (one_graph_run) instead of saving more copies." } : {}) });
    }).immediate();
  }
  // A lost tool response can be retried after the host pinned a runtime or the
  // definition was revised/withdrawn. Look up that exact request BEFORE new-run
  // admission; it only reads the caller's previous event and cannot queue work.
  const requestHash = name === "one_graph_run" ? createHash("sha256").update(`${chat.id}\0${input.request_id}`).digest("hex") : null;
  const prior = requestHash ? getDb().prepare("SELECT id, payload_json FROM automation_trigger_events WHERE automation_id=? AND trigger_kind='command' AND dedupe_key=?")
    .get(input.graph_id, `one-graph:${requestHash}`) as { id: string; payload_json: string } | undefined : undefined;
  const a = name === "one_graph_run"
    ? prior ? exactOrRequested(caller, input.graph_id, prior.id) : exact(caller, input.graph_id)
    : exact(caller, input.graph_id);
  if (prior) {
    const payload = JSON.parse(prior.payload_json) as Record<string, unknown>;
    if (!graphCommandRequestMatches(payload, { definitionRevision: input.expected_revision, ownerChatId: chat.id,
      input: input.input, dryRun: input.dry_run === true })) throw new Error("one_graph_request_identity_conflict");
    return { ...receipt(a), definition_revision: payload.definitionRevision, ok: true, already_requested: true,
      invoked_as: graphCommandInvocationKind(payload),
      ...await waitForResult(caller, a, { ...input, event_id: prior.id, wait_seconds: input.wait_seconds ?? 20 }) };
  }
  fresh(a, input.expected_revision);
  if (name === "one_graph_patch") return desktopStoreTransaction(getDb(), () => {
    const current = exact(caller, a.id); fresh(current, input.expected_revision);
    const graph = structuredClone(resolveAutomationGraph(current));
    const edits = (input.instructions ?? []) as Array<{ node_id: string; instruction: string }>;
    const calls = (input.mcp_calls ?? []) as Array<{ node_id: string; call: GraphBlueprint["steps"][number]["mcpCall"] }>;
    editable(current, [...edits, ...calls].map(edit => edit.node_id));
    if (!edits.length && !calls.length) throw new Error("one_graph_patch_empty");
    if (new Set(edits.map(edit => edit.node_id)).size !== edits.length) throw new Error("one_graph_duplicate_node_patch");
    for (const edit of edits) {
      const node = graph.nodes.find(n => n.id === edit.node_id);
      // A code step is changed by saving the revised blueprint (one_graph_save with graph_id), not by an instruction.
      if (node?.type === "code") throw new Error("one_graph_code_step_requires_save");
      if (!node || !["agent", "action"].includes(node.type)) throw new Error("one_graph_instruction_node_invalid");
      node.config = { ...node.config, ...(node.config.mcpCall ? { note: edit.instruction } : { prompt: edit.instruction }) };
    }
    if (new Set(calls.map(edit => edit.node_id)).size !== calls.length) throw new Error("one_graph_duplicate_node_patch");
    for (const edit of calls) {
      const node = graph.nodes.find(n => n.id === edit.node_id);
      if (!node || !node.config?.mcpCall || !["agent", "action"].includes(node.type)) throw new Error("one_graph_mcp_node_invalid");
      if (isGraphControlTool(edit.call?.catalogId, edit.call?.toolName)) throw new Error("one_graph_recursive_tool_call");
      node.config = { ...node.config, mcpCall: edit.call };
    }
    const effectProblems = graphMcpEffectProblems({ nodes: graph.nodes.filter(node => calls.some(edit => edit.node_id === node.id)) }, currentUiLocale());
    if (effectProblems.length) return { ok: false, code: "one_graph_blueprint_invalid", graph_id: current.id, problems: effectProblems.map(p => ({ reason: p.reason, ask: null })) };
    checkReferences(caller, graph, current.id, current.executionPermission, current.hubMode ?? "local-only");
    if (JSON.stringify(graph) === JSON.stringify(resolveAutomationGraph(current)) && (input.goal === undefined || input.goal === current.goal)) {
      recordOneGraphAuthority(current, chat.id);
      return receipt(current, { ok: true, action: "unchanged" });
    }
    updateAutomationGraph(current.id, graph, { note: "One instruction patch" });
    const promptPatch = !current.graph?.nodes.length && edits.length === 1 && edits[0].node_id === "n1" ? { promptTemplate: edits[0].instruction } : {};
    const saved = input.goal === undefined && !Object.keys(promptPatch).length ? getAutomation(current.id)! : updateAutomation(current.id, { ...promptPatch, ...(input.goal === undefined ? {} : { goal: input.goal as string }) });
    recordOneGraphAuthority(saved, chat.id);
    return receipt(saved, { ok: true, action: "updated", changed_node_ids: [...new Set([...edits, ...calls].map(edit => edit.node_id))] });
  }).immediate();
  if (name === "one_graph_set_enabled") {
    editable(a, []); await connected(caller, a);
    const result = applyAutomationLifecycle({ parsed: { action: "resume", automationId: a.id, expectedDefinitionDigest: input.expected_revision as string,
      name: a.name, prompt: "", schedule: "", scheduleEmitted: false }, chatId: chat.id, canWrite: true });
    markOneGraphEphemeral(result.automation, chat.id);
    return receipt(result.automation, { ok: true, action: result.action });
  }
  if (name === "one_graph_run") {
    await connected(caller, a);
    const queuedReceipt = getDb().transaction(() => {
      const current = exact(caller, a.id); fresh(current, input.expected_revision);
      // The kernel reads the exact unsettled leaf coordinates at dispatch. A
      // new request does not authorize replay, and healthy branches remain usable.
      const heldNodeIds = [...new Set(listAutomationGraphReconciliations(a.id).flatMap(view => view.nodes.map(node => node.nodeId)))];
      const decision = decideGraphRunRequest({ ref: current.id, automations: [current], input: input.input as Record<string, unknown> | undefined, dryRun: input.dry_run === true });
      if (!decision.ok) return decision;
      const requestHash = createHash("sha256").update(`${chat.id}\0${input.request_id}`).digest("hex");
      const dedupeKey = `one-graph:${requestHash}`;
      const payload = { source: "one-mcp", definitionRevision: input.expected_revision, ownerChatId: chat.id,
        input: decision.input, dryRun: input.dry_run === true, invokedAs: "graph" };
      const prior = getDb().prepare("SELECT payload_json FROM automation_trigger_events WHERE automation_id=? AND trigger_kind='command' AND dedupe_key=?").get(a.id, dedupeKey) as { payload_json: string } | undefined;
      if (prior && prior.payload_json !== JSON.stringify(payload)) throw new Error("one_graph_request_identity_conflict");
      const queued = enqueueTriggerEvent({ automationId: a.id, triggerKind: "command", dedupeKey, payload });
      return { ...receipt(current, { ok: true, status: "requested", event_id: queued.event.id, already_requested: !queued.inserted, event_status: queued.event.status,
        invoked_as: graphCommandInvocationKind(payload), held_node_ids: heldNodeIds }), event_id: queued.event.id };
    }).immediate();
    if (!("event_id" in queuedReceipt)) return queuedReceipt;
    return { ...queuedReceipt, ...await waitForResult(caller, a, { ...input, event_id: queuedReceipt.event_id, wait_seconds: input.wait_seconds ?? 20 }) };
  }
  throw new Error("one_graph_unknown_operation");
}
