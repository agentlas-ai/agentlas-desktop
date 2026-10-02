import { createHash } from "node:crypto";
import type { Automation, WorkflowGraph } from "../../shared/types";
import { buildGraphFromBlueprint, type GraphBlueprint } from "../../shared/graph-blueprint";
import { graphAuthoringShapeProblems, GRAPH_BLUEPRINT_INPUT_SCHEMA, ONE_GRAPH_TOOLS } from "../../shared/graph-authoring";
import { readAutomationGraphDefinition, resolveAutomationGraph } from "../../shared/automation-graph-definition";
import { requiredExecutionPermission } from "../../shared/graph-node-protocol";
import { decideGraphRunRequest } from "../../shared/graph-run-request";
import { getDb } from "../store/db";
import { getChat } from "../store/chats";
import { createAutomation, getAutomation, hasDurableActiveAutomationExecution, hasGraphLoginWait,
  listAutomations, updateAutomation, updateAutomationGraph } from "../store/automations";
import { getAutomationGraphReconciliation } from "../store/graph-reconciliation";
import { enqueueTriggerEvent, getTriggerEvent } from "../store/trigger-events";
import { applyAutomationLifecycle, automationDefinitionDigest } from "../automation-lifecycle";
import { reportGraphConnections } from "../workflow/tool-inventory";
import { currentUiLocale } from "../ui-locale";
import { specFromStored, nextRun } from "../store/schedule";
import { AUTOMATION_PROTOCOL } from "../automation-emitter";
import { sha256Value } from "../../shared/graph-execution-digest";
import { inspectGraphMcpTools } from "../workflow/mcp-call";
import { recordOneGraphAuthority } from "./graph-ownership";
import { oneTeamDispatchOwnerChat, type OneTeamCaller } from "./team-dispatch";

function owner(caller: OneTeamCaller) {
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
  const chat = owner(caller);
  return listAutomations().filter(a => a.monitor?.originChatId === chat.id);
}
function exact(caller: OneTeamCaller, id: unknown): Automation {
  const automation = typeof id === "string" ? scoped(caller).find(a => a.id === id) : undefined;
  if (!automation) throw new Error("one_graph_target_not_in_context");
  return automation;
}
function fresh(a: Automation, expected: unknown): void {
  if (typeof expected !== "string" || expected !== automationDefinitionDigest(a)) throw new Error("one_graph_definition_changed");
}
function editable(a: Automation): void {
  if (hasDurableActiveAutomationExecution(a.id) || hasGraphLoginWait(a.id)
    || getDb().prepare("SELECT 1 FROM automation_trigger_events WHERE automation_id=? AND status IN ('pending','claimed') LIMIT 1").get(a.id)
    || getAutomationGraphReconciliation(a.id)) throw new Error("one_graph_execution_unsettled");
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
    exact(caller, a.id);
    const event = typeof input.event_id === "string" ? getTriggerEvent(input.event_id) : null;
    if (!event || event.automationId !== a.id) throw new Error("one_graph_event_not_in_context");
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

export async function oneGraphDispatch(caller: OneTeamCaller, name: string, input: Record<string, unknown>): Promise<unknown> {
  const tool = ONE_GRAPH_TOOLS.find(t => t.name === name);
  if (!tool) throw new Error("one_graph_unknown_operation");
  const problems = graphAuthoringShapeProblems(input, tool.inputSchema);
  if (problems.length) return { ok: false, code: "one_graph_input_invalid", problems };
  const chat = owner(caller);
  if (name === "one_graph_schema") return { schemaVersion: "agentlas.one-graph-authoring.v1", blueprint: GRAPH_BLUEPRINT_INPUT_SCHEMA,
    definitionProtocol: "agentlas.automation-graph-definition.v1", execution: "host_compiled_dependency_graph", strategyOwner: "One",
    ...(input.catalog_id ? { inventory: await inspectGraphMcpTools({ chat, catalogId: input.catalog_id as string, permission: caller.permission }) } : {}),
    ...(input.include_registration_protocol === true ? { registrationProtocol: AUTOMATION_PROTOCOL } : {}) };
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
  if (name === "one_graph_result") return waitForResult(caller, exact(caller, input.graph_id), input);
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
    return getDb().transaction(() => {
      const matches = scoped(caller).filter(a => a.name.normalize("NFKC").toLowerCase() === bp.name.normalize("NFKC").toLowerCase());
      if (!existing && matches.length) {
        if (matches.length === 1 && graphSame(matches[0], graph, bp, schedule, triggerType)) {
          recordOneGraphAuthority(matches[0], chat.id);
          return receipt(matches[0], { ok: true, action: "already_saved" });
        }
        throw new Error("one_graph_name_conflict_use_exact_id");
      }
      let saved: Automation;
      if (existing) {
        const current = exact(caller, existing.id); fresh(current, input.expected_revision);
        if (graphSame(current, graph, bp, schedule, triggerType)) {
          recordOneGraphAuthority(current, chat.id);
          return receipt(current, { ok: true, action: "unchanged" });
        }
        editable(current);
        updateAutomationGraph(current.id, graph, { note: "One structured blueprint" });
        saved = updateAutomation(current.id, { name: bp.name, goal: bp.goal, promptTemplate: bp.goal,
          scheduleHuman: schedule, scheduleJson: null, triggerType, trigger: { kind: triggerType }, executionPermission: permission });
        saved = applyAutomationLifecycle({ parsed: { action: enable ? "resume" : "pause", automationId: saved.id, expectedDefinitionDigest: automationDefinitionDigest(saved), name: saved.name, prompt: "", schedule: "", scheduleEmitted: false }, chatId: chat.id, canWrite: true }).automation;
      } else saved = createAutomation({ name: bp.name, goal: bp.goal, promptTemplate: bp.goal,
        targetType: "agent", targetId: chat.agentId, projectId: chat.projectId,
        runtimeSelection: chat.runtimeSelection ?? undefined, hubMode: "local-only", executionPermission: permission,
        graphJson: graph, enabled: enable, createdBy: "agent", scheduleHuman: schedule, scheduleJson: null,
        triggerType, monitor: { schemaVersion: "agentlas.automation-monitor.v1", originChatId: chat.id,
          originMessageId: null, notificationPolicy: "meaningful_changes", deadline: null } });
      recordOneGraphAuthority(saved, chat.id);
      return receipt(saved, { ok: true, action: existing ? "updated" : "created", ...(connections && !enable ? { activation: connections.activation } : {}) });
    }).immediate();
  }
  const a = exact(caller, input.graph_id);
  // A lost tool response can be retried after the host pinned a runtime or the
  // definition was later revised. The old exact event remains the authority;
  // it must not become a second execution or require the new definition.
  if (name === "one_graph_run") {
    const requestHash = createHash("sha256").update(`${chat.id}\0${input.request_id}`).digest("hex");
    const prior = getDb().prepare("SELECT id, payload_json FROM automation_trigger_events WHERE automation_id=? AND trigger_kind='command' AND dedupe_key=?").get(a.id, `one-graph:${requestHash}`) as { id: string; payload_json: string } | undefined;
    if (prior) {
      const payload = JSON.parse(prior.payload_json) as { definitionRevision: string; ownerChatId: string; input: Record<string, string>; dryRun: boolean };
      const raw = input.input as Record<string, unknown> | undefined;
      if (payload.definitionRevision !== input.expected_revision || payload.ownerChatId !== chat.id || payload.dryRun !== (input.dry_run === true)
        || Object.entries(payload.input).some(([key, value]) => typeof raw?.[key] !== "string" || (raw[key] as string).trim() !== value)) throw new Error("one_graph_request_identity_conflict");
      return { ...receipt(a), ok: true, already_requested: true,
        ...await waitForResult(caller, a, { ...input, event_id: prior.id, wait_seconds: input.wait_seconds ?? 20 }) };
    }
  }
  fresh(a, input.expected_revision);
  if (name === "one_graph_patch") return getDb().transaction(() => {
    const current = exact(caller, a.id); fresh(current, input.expected_revision); editable(current);
    const graph = structuredClone(resolveAutomationGraph(current));
    const edits = (input.instructions ?? []) as Array<{ node_id: string; instruction: string }>;
    const calls = (input.mcp_calls ?? []) as Array<{ node_id: string; call: GraphBlueprint["steps"][number]["mcpCall"] }>;
    if (!edits.length && !calls.length) throw new Error("one_graph_patch_empty");
    if (new Set(edits.map(edit => edit.node_id)).size !== edits.length) throw new Error("one_graph_duplicate_node_patch");
    for (const edit of edits) {
      const node = graph.nodes.find(n => n.id === edit.node_id);
      if (!node || !["agent", "action"].includes(node.type)) throw new Error("one_graph_instruction_node_invalid");
      node.config = { ...node.config, ...(node.config.mcpCall ? { note: edit.instruction } : { prompt: edit.instruction }) };
    }
    if (new Set(calls.map(edit => edit.node_id)).size !== calls.length) throw new Error("one_graph_duplicate_node_patch");
    for (const edit of calls) {
      const node = graph.nodes.find(n => n.id === edit.node_id);
      if (!node || !node.config?.mcpCall || !["agent", "action"].includes(node.type)) throw new Error("one_graph_mcp_node_invalid");
      if (edit.call?.catalogId === "one-team" && edit.call.toolName.startsWith("one_graph_")) throw new Error("one_graph_recursive_tool_call");
      node.config = { ...node.config, mcpCall: edit.call };
    }
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
    editable(a); await connected(caller, a);
    const result = applyAutomationLifecycle({ parsed: { action: "resume", automationId: a.id, expectedDefinitionDigest: input.expected_revision as string,
      name: a.name, prompt: "", schedule: "", scheduleEmitted: false }, chatId: chat.id, canWrite: true });
    return receipt(result.automation, { ok: true, action: result.action });
  }
  if (name === "one_graph_run") {
    await connected(caller, a);
    const queuedReceipt = getDb().transaction(() => {
      const current = exact(caller, a.id); fresh(current, input.expected_revision);
      if (hasGraphLoginWait(a.id) || getAutomationGraphReconciliation(a.id)) throw new Error("one_graph_execution_unsettled");
      const decision = decideGraphRunRequest({ ref: current.id, automations: [current], input: input.input as Record<string, unknown> | undefined, dryRun: input.dry_run === true });
      if (!decision.ok) return decision;
      const requestHash = createHash("sha256").update(`${chat.id}\0${input.request_id}`).digest("hex");
      const dedupeKey = `one-graph:${requestHash}`;
      const payload = { source: "one-mcp", definitionRevision: input.expected_revision, ownerChatId: chat.id, input: decision.input, dryRun: input.dry_run === true };
      const prior = getDb().prepare("SELECT payload_json FROM automation_trigger_events WHERE automation_id=? AND trigger_kind='command' AND dedupe_key=?").get(a.id, dedupeKey) as { payload_json: string } | undefined;
      if (prior && prior.payload_json !== JSON.stringify(payload)) throw new Error("one_graph_request_identity_conflict");
      const queued = enqueueTriggerEvent({ automationId: a.id, triggerKind: "command", dedupeKey, payload });
      return { ...receipt(current, { ok: true, status: "requested", event_id: queued.event.id, already_requested: !queued.inserted, event_status: queued.event.status }), event_id: queued.event.id };
    }).immediate();
    if (!("event_id" in queuedReceipt)) return queuedReceipt;
    return { ...queuedReceipt, ...await waitForResult(caller, a, { ...input, event_id: queuedReceipt.event_id, wait_seconds: input.wait_seconds ?? 20 }) };
  }
  throw new Error("one_graph_unknown_operation");
}
