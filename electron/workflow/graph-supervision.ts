/** Main-owned Graph proposals. Structural verification never claims an executed outcome. */
import { randomUUID } from "node:crypto";
import type { WorkflowGraph, GraphVerificationReceipt } from "../../shared/types";
import { sha256Value } from "../../shared/graph-execution-digest";
import { findGraphContradictions, repairGraphContradictions } from "../../shared/graph-contradictions";
import { getDb } from "../store/db";
import { getAutomation, updateAutomationGraph, automationGraphEditEpoch,
  hasDurableActiveAutomationExecution, hasGraphLoginWait } from "../store/automations";
import { getAutomationGraphReconciliation } from "../store/graph-reconciliation";
import { automationDefinitionDigest } from "../automation-lifecycle";
import { desktopStoreTransaction } from "../store/change-bus";
import { getChat } from "../store/chats";
import { getLongRunByGoalId } from "../store/long-runs";
import { peekGoalExecutionControlGeneration, peekAutomationStopGeneration } from "../automation-execution-control";
import { evaluateGraphPatch, graphPatchNeedsApproval, graphPatchCanAutoApplyLocal, type GraphPatch } from "./graph-patch";
import type { JudgmentRuntimeReceipt, JudgmentRuntimeAttempt } from "../system-agents/judgment";
const processId = randomUUID();
const controls = new Map<string, number>();
const pending = new Map<string, Set<AbortController>>();
export class GraphSupervisionError extends Error { constructor(readonly code: string) { super(code); } }
function fail(code: string): never { throw new GraphSupervisionError(code); }
function schema(): void { getDb().exec(`CREATE TABLE IF NOT EXISTS graph_supervision_proposals (
 id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json)),
 applied_json TEXT CHECK(applied_json IS NULL OR json_valid(applied_json)))`); }
/** Reuse the actual kernel loop planner and deterministic contradiction repair; no adapters run. */
export function superviseGraph(raw: unknown): { graph: WorkflowGraph; verification: GraphVerificationReceipt } {
  const graph = structuredClone(raw) as WorkflowGraph;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !graph.nodes.length
    || graph.nodes.length > 1000 || graph.edges.length > 4000) fail("GRAPH_SHAPE_INVALID");
  const ids = new Set<string>(), edges = new Set<string>();
  for (const n of graph.nodes) {
    if (!n || !["trigger","condition","transform","eval","code","output","agent","action","subgraph","tool"].includes(n.type) || typeof n.id !== "string" || !n.id || ids.has(n.id) || !n.config || typeof n.config !== "object" || Array.isArray(n.config)) fail("GRAPH_NODE_INVALID");
    ids.add(n.id);
  }
  for (const e of graph.edges) {
    if (!e || typeof e.id !== "string" || !e.id || edges.has(e.id) || !ids.has(e.source) || !ids.has(e.target)) fail("GRAPH_EDGE_INVALID");
    edges.add(e.id);
  }
  const repaired = repairGraphContradictions(graph), next = repaired.graph!;
  const { planGraphLoops } = require("./run-graph") as typeof import("./run-graph");
  const loops = planGraphLoops(next); if (!loops.ok) fail(loops.failure.code);
  const contradictions = findGraphContradictions(next, planGraphLoops);
  if (contradictions.length) fail(contradictions[0].code);
  if (!next.nodes.some(n => n.type === "trigger")) fail("GRAPH_TRIGGER_MISSING");
  const reachable = new Set(next.nodes.filter(n => n.type === "trigger").map(n => n.id));
  const todo = [...reachable]; for (let i=0;i<todo.length;i++) for (const e of next.edges.filter(e => e.source === todo[i]))
    if (!reachable.has(e.target)) { reachable.add(e.target); todo.push(e.target); }
  if (next.nodes.some(n => !reachable.has(n.id))) fail("GRAPH_NODE_UNREACHABLE");
  for (const n of next.nodes) {
    if (n.type === "condition") {
      const outgoing = next.edges.filter(e => e.source === n.id);
      if (outgoing.some(e => e.sourceHandle !== "true" && e.sourceHandle !== "false")) fail("EDGE_CONDITION_UNRESOLVED");
      if (outgoing.length && (!outgoing.some(e => e.sourceHandle === "true") || !outgoing.some(e => e.sourceHandle === "false"))) fail("GRAPH_BRANCH_INCOMPLETE");
    }
    if (n.type === "code" && (typeof n.config.code !== "string" || !n.config.code.trim())) fail("CODE_NODE_EMPTY");
  }
  return { graph: next, verification: { schemaVersion: "agentlas.graph-verification.v1", graphDigest: sha256Value(next),
    structural: "verified", runtime: "not_checked", saved: false, repairedNodeIds: repaired.movedNodeIds } };
}
function editable(id: string): void {
  if (hasDurableActiveAutomationExecution(id) || hasGraphLoginWait(id) || getAutomationGraphReconciliation(id)
    || getDb().prepare("SELECT 1 FROM automation_trigger_events WHERE automation_id=? AND status IN ('pending','claimed') LIMIT 1").get(id)) fail("GRAPH_EXECUTION_UNSETTLED");
}
function goalControl(id: string): unknown {
  const a = getAutomation(id), chat = a?.monitor?.originChatId ? getChat(a.monitor.originChatId) : null;
  const goalId = a?.goalId ?? chat?.goalId, run = goalId ? getLongRunByGoalId(goalId) : null;
  return run?.rootChatId ? { goalId: run.goalId, rootChatId: run.rootChatId, longRunId: run.id,
    generation: peekGoalExecutionControlGeneration({ goalId: run.goalId, rootChatId: run.rootChatId, longRunId: run.id }) } : null;
}
export function captureGraphProposalBase(id: string) {
  schema(); const a = getAutomation(id); if (!a?.graph) fail("PATCH_NO_GRAPH"); editable(id);
  return { automationId: id, definitionRevision: automationDefinitionDigest(a), editEpoch: automationGraphEditEpoch(id),
    runtimeSelection: a.runtimeSelection ? structuredClone(a.runtimeSelection) : undefined,
    processId, stopGeneration: peekAutomationStopGeneration(id), control: controls.get(id) ?? 0, goalControl: goalControl(id), graph: structuredClone(a.graph), goal: a.goal };
}
export function assertGraphProposalBase(base: ReturnType<typeof captureGraphProposalBase>): void {
  const a=getAutomation(base.automationId);
  if (!a || base.processId !== processId || peekAutomationStopGeneration(base.automationId) !== base.stopGeneration || automationDefinitionDigest(a) !== base.definitionRevision
    || automationGraphEditEpoch(base.automationId) !== base.editEpoch || (controls.get(base.automationId) ?? 0) !== base.control
    || sha256Value(goalControl(base.automationId)) !== sha256Value(base.goalControl)) fail("GRAPH_PROPOSAL_STALE");
  editable(base.automationId);
}
/** Stop never waits for a proposal/model/storage write. */
export function invalidateGraphSupervision(id: string): void {
  controls.set(id,(controls.get(id) ?? 0)+1);
  for (const c of pending.get(id) ?? []) c.abort(new GraphSupervisionError("GRAPH_PROPOSAL_CANCELLED"));
}
export function bindGraphProposalAbort(id: string, controller: AbortController): () => void {
  const set=pending.get(id) ?? new Set<AbortController>(); set.add(controller); pending.set(id,set);
  return () => { set.delete(controller); if (!set.size) pending.delete(id); };
}
export interface GraphGenerationEvidence {
  successfulRound: number;
  rounds: Array<{ round: number; runtimeReceipt?: JudgmentRuntimeReceipt; attempts: JudgmentRuntimeAttempt[] }>;
}
/** Generation evidence describes the model used; it never changes apply authority. */
function generationReceipt(evidence: GraphGenerationEvidence) {
  const runtimeReceipt = (value: JudgmentRuntimeReceipt) => {
    const { kind, backend, source, model, role, inherit, acpAgentId } = value.selection;
    return { route: value.route, fingerprint: value.fingerprint, execution: value.execution,
      selection: { kind, ...(backend !== undefined ? { backend } : {}), ...(source !== undefined ? { source } : {}),
        ...(model !== undefined ? { model } : {}), ...(role !== undefined ? { role } : {}),
        ...(inherit !== undefined ? { inherit } : {}), ...(acpAgentId !== undefined ? { acpAgentId } : {}) },
      ...(value.longContext !== undefined ? { longContext: value.longContext } : {}),
      ...(value.effort !== undefined ? { effort: value.effort } : {}) };
  };
  return { schemaVersion: "agentlas.graph-generation.v1" as const, successfulRound: evidence.successfulRound,
    rounds: evidence.rounds.map(round => ({ round: round.round,
      ...(round.runtimeReceipt ? { runtimeReceipt: runtimeReceipt(round.runtimeReceipt) } : {}),
      attempts: round.attempts.map(attempt => ({ runtimeReceipt: runtimeReceipt(attempt.runtimeReceipt),
        outcome: attempt.outcome, elapsedMs: attempt.elapsedMs,
        ...(attempt.failureKind ? { failureKind: attempt.failureKind } : {}) })) })) };
}
export function prepareGraphProposal(base: ReturnType<typeof captureGraphProposalBase>, patch: GraphPatch, generation?: GraphGenerationEvidence) {
  assertGraphProposalBase(base);
  const decision=evaluateGraphPatch(base.graph,patch); if (!decision.ok) fail(decision.code);
  const verified=superviseGraph(decision.next), id=randomUUID();
  const value={ base, patch, next: verified.graph, verification: verified.verification, risks: decision.risks,
    summary: decision.summary, needsApproval: graphPatchNeedsApproval(decision) || !graphPatchCanAutoApplyLocal(base.graph, patch),
    ...(generation ? { generationReceipt: generationReceipt(generation) } : {}) };
  getDb().prepare("INSERT INTO graph_supervision_proposals(id,automation_id,value_json) VALUES (?,?,?)")
    .run(id,base.automationId,JSON.stringify(value));
  return { ok:true as const, proposalId:id, baseRevision:base.definitionRevision, patch,
    verification:verified.verification, risks:value.risks, summary:value.summary, needsApproval:value.needsApproval,
    ...(patch.rationale ? { rationale:patch.rationale } : {}) };
}
export function applyGraphProposal(id: string, proposalId: string, approved: boolean) {
  schema();
  return desktopStoreTransaction(getDb(),() => {
    const row=getDb().prepare("SELECT automation_id,value_json,applied_json FROM graph_supervision_proposals WHERE id=?").get(proposalId) as
      { automation_id:string; value_json:string; applied_json:string|null }|undefined;
    if (!row || row.automation_id!==id) fail("GRAPH_PROPOSAL_MISSING");
    if (row.applied_json) {
      const applied=JSON.parse(row.applied_json), current=getAutomation(id);
      if (!current || automationDefinitionDigest(current)!==applied.definitionRevision) fail("GRAPH_APPLIED_SUPERSEDED");
      return { ...applied, automation:current, replayed:true };
    }
    const value=JSON.parse(row.value_json) as { base:ReturnType<typeof captureGraphProposalBase>;next:WorkflowGraph;needsApproval:boolean;verification:GraphVerificationReceipt;generationReceipt?:ReturnType<typeof generationReceipt> };
    assertGraphProposalBase(value.base); if (value.needsApproval && !approved) fail("GRAPH_APPROVAL_REQUIRED");
    const checked=superviseGraph(value.next); if (sha256Value(checked.graph)!==sha256Value(value.next)) fail("GRAPH_PROPOSAL_INVALID");
    const a=updateAutomationGraph(id,value.next,{ note:"Verified Graph repair",strictSnapshot:true });
    if (sha256Value(a.graph)!==sha256Value(value.next)) fail("GRAPH_READBACK_MISMATCH");
    const result={ok:true as const,automationId:id,proposalId,automation:a,definitionRevision:automationDefinitionDigest(a),
      verification:{...value.verification,saved:true}, ...(value.generationReceipt ? { generationReceipt:value.generationReceipt } : {})};
    getDb().prepare("UPDATE graph_supervision_proposals SET applied_json=? WHERE id=? AND applied_json IS NULL").run(JSON.stringify(result),proposalId);
    return result;
  }).immediate();
}

/** Read-only lost-reply reconciliation; never applies a pending proposal. */
export function readGraphProposalReceipt(id: string, proposalId: string) {
  schema();
  const row=getDb().prepare("SELECT applied_json FROM graph_supervision_proposals WHERE id=? AND automation_id=?").get(proposalId,id) as {applied_json:string|null}|undefined;
  if (!row?.applied_json) return null;
  const receipt=JSON.parse(row.applied_json),current=getAutomation(id);
  return {...receipt,automation:current,superseded:!current || automationDefinitionDigest(current)!==receipt.definitionRevision};
}
