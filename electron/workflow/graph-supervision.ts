/** Main-owned Graph proposals. Structural verification never claims an executed outcome. */
import { randomUUID } from "node:crypto";
import type { WorkflowGraph, GraphVerificationReceipt } from "../../shared/types";
import { sha256Value } from "../../shared/graph-execution-digest";
import { findGraphContradictions, repairGraphContradictions } from "../../shared/graph-contradictions";
import { getDb } from "../store/db";
import { getAutomation, updateAutomationGraph, automationGraphEditEpoch } from "../store/automations";
import { automationDefinitionDigest } from "../automation-lifecycle";
import { desktopStoreTransaction } from "../store/change-bus";
import { getChat } from "../store/chats";
import { getLongRunByGoalId } from "../store/long-runs";
import { peekGoalExecutionControlGeneration, peekAutomationStopGeneration } from "../automation-execution-control";
import { evaluateGraphPatch, graphPatchNeedsApproval, graphPatchCanAutoApplyLocal, type GraphPatch } from "./graph-patch";
import { currentUiLocale } from "../ui-locale";
import type { JudgmentRuntimeReceipt, JudgmentRuntimeAttempt } from "../system-agents/judgment";
const processId = randomUUID();
const controls = new Map<string, number>();
const pending = new Map<string, Set<AbortController>>();
const L = (ko: string, en: string): string => (currentUiLocale() === "ko" ? ko : en);
/** Which step is unfinished and what to write into it: the authoring model reads this and fixes the graph before it is saved. */
export interface GraphSupervisionDetail { nodeId: string; reason: string; nextAction: string }
export class GraphSupervisionError extends Error { constructor(readonly code: string, readonly detail?: GraphSupervisionDetail) { super(code); } }
function fail(code: string, detail?: GraphSupervisionDetail): never { throw new GraphSupervisionError(code, detail); }
/** What a refused save says to the authoring model; the code alone (the old behaviour) when the step is not named. */
export function graphSupervisionProblem(error: unknown): string {
  if (!(error instanceof GraphSupervisionError)) return JSON.stringify({ code: error instanceof Error ? error.message : "GRAPH_SHAPE_INVALID" });
  return JSON.stringify({ code: error.code, ...(error.detail ? { node: error.detail.nodeId, reason: error.detail.reason, fix: error.detail.nextAction } : {}) });
}
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
function schema(): void { getDb().exec(`CREATE TABLE IF NOT EXISTS graph_supervision_proposals (
 id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json)),
 applied_json TEXT CHECK(applied_json IS NULL OR json_valid(applied_json)))`); }
export interface SuperviseGraphOptions {
  /** The graph as it is already saved. A step that is identical there (same settings, same connections) is not asked to be finished
   *  again: it already runs, and a repair of something else must not be refused for it. */
  prior?: unknown;
  /** The automation's own prompt, when known. An output step with nothing written falls back to it, so it is empty only if this is. */
  promptTemplate?: string;
}
/** Reuse the actual kernel loop planner and deterministic contradiction repair; no adapters run. */
export function superviseGraph(raw: unknown, options: SuperviseGraphOptions = {}): { graph: WorkflowGraph; verification: GraphVerificationReceipt; warnings: GraphSaveWarning[] } {
  const graph = structuredClone(raw) as WorkflowGraph;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !graph.nodes.length
    || graph.nodes.length > 1000 || graph.edges.length > 4000) fail("GRAPH_SHAPE_INVALID");
  const ids = new Set<string>(), edges = new Set<string>();
  for (const n of graph.nodes) {
    if (!n || !["trigger","condition","transform","eval","code","output","agent","action","subgraph","toolchain_call","tool"].includes(n.type) || typeof n.id !== "string" || !n.id || ids.has(n.id) || !n.config || typeof n.config !== "object" || Array.isArray(n.config)) fail("GRAPH_NODE_INVALID");
    if (n.type === "toolchain_call") {
      const call = n.config.toolchainCall as Record<string, unknown> | undefined;
      if (!call || typeof call.toolchainId !== "string" || !call.toolchainId.trim()
          || typeof call.version !== "number" || !Number.isSafeInteger(call.version) || call.version < 1
          || !call.args || typeof call.args !== "object" || Array.isArray(call.args)) fail("GRAPH_NODE_INVALID");
    }
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
  unfinishedStepProblem(next, options);
  subgraphNestingProblem(next, options);
  return { graph: next, verification: { schemaVersion: "agentlas.graph-verification.v1", graphDigest: sha256Value(next),
    structural: "verified", runtime: "not_checked", saved: false, repairedNodeIds: repaired.movedNodeIds },
    warnings: saveWarnings(next) };
}
/**
 * Calls of one automation by another may nest MAX_SUBGRAPH_DEPTH levels at run time (run-graph.ts). A graph whose own chain of calls is already
 * deeper than that can never make its deepest call, so the author is told here, with the step to shorten.
 */
function subgraphNestingProblem(graph: WorkflowGraph, options: SuperviseGraphOptions): void {
  // A calling step that is already saved exactly so is not asked about again: a repair of something else must not be refused for it.
  const prior = options.prior as WorkflowGraph | undefined;
  const before = new Map<string, string>(Array.isArray(prior?.nodes) ? prior!.nodes.filter(n => n?.type === "subgraph").map(n => [n.id, sha256Value(n)] as const) : []);
  if (!graph.nodes.some(n => n.type === "subgraph" && before.get(n.id) !== sha256Value(n))) return;
  const { MAX_SUBGRAPH_DEPTH } = require("./run-graph") as typeof import("./run-graph");
  const { getAutomation: load } = require("../store/automations") as typeof import("../store/automations");
  const levels = (g: WorkflowGraph, seen: Set<string>, level: number): { depth: number; nodeId: string | null } => {
    let best: { depth: number; nodeId: string | null } = { depth: level, nodeId: null };
    for (const n of g.nodes) {
      if (n.type !== "subgraph") continue;
      const ref = typeof n.config?.graphRef === "string" ? n.config.graphRef : "";
      if (!ref || seen.has(ref)) continue;
      const inner = load(ref)?.graph;
      const here = inner ? levels(inner, new Set([...seen, ref]), level + 1) : { depth: level + 1, nodeId: null };
      if (here.depth > best.depth) best = { depth: here.depth, nodeId: n.id };
    }
    return best;
  };
  const deepest = levels(graph, new Set<string>(), 0);
  if (deepest.depth > MAX_SUBGRAPH_DEPTH && deepest.nodeId) {
    const step = graph.nodes.find(n => n.id === deepest.nodeId);
    fail("SUBGRAPH_DEPTH_EXCEEDED", { nodeId: deepest.nodeId,
      reason: L(`"${step?.label || deepest.nodeId}"에서 시작하는 자동화 호출이 ${deepest.depth}단으로 겹쳐, 한 번에 부를 수 있는 ${MAX_SUBGRAPH_DEPTH}단을 넘습니다.`,
        `The automation calls starting at "${step?.label || deepest.nodeId}" nest ${deepest.depth} levels deep, past the ${MAX_SUBGRAPH_DEPTH} that can be made at once.`),
      nextAction: L("안쪽 자동화를 하나로 합치거나 부르는 단계를 줄이세요.", "Merge the inner automations into one, or reduce the number of calling steps.") });
  }
}
/** A shape the graph saves and runs, but whose outcome the author should know about. It never refuses the save. */
export interface GraphSaveWarning { code: string; nodeIds: string[]; reason: string; fix: string }
/**
 * Two steps that can run at the same time and both overwrite one result name: the run goes on with the value of the step declared later in the
 * graph, the same on every run (run-graph.ts applyProduces). The author is told which step wins and how to keep both.
 */
function saveWarnings(graph: WorkflowGraph): GraphSaveWarning[] {
  const { concurrentOverwriteWriters } = require("./run-graph") as typeof import("./run-graph");
  const label = (id: string): string => { const n = graph.nodes.find(c => c.id === id); return n?.label || id; };
  return concurrentOverwriteWriters(graph).map(c => ({
    code: "REDUCER_WRITE_CONFLICT", nodeIds: c.nodeIds,
    reason: L(`${c.nodeIds.map(label).map(x => `"${x}"`).join(", ")}이(가) 동시에 실행될 수 있고 모두 "${c.name}"에 덮어씁니다. 실행은 계속되고, 더 뒤에 놓인 "${label(c.keptNodeId)}"의 값이 남습니다.`,
      `${c.nodeIds.map(label).map(x => `"${x}"`).join(", ")} can run at the same time and all overwrite "${c.name}". The run goes on and the value of "${label(c.keptNodeId)}", the step placed later in the graph, is kept.`),
    fix: L("둘 다 남기려면 결과 이름을 다르게 하거나 저장 규칙(reducer)을 'append'로 바꾸세요.", "To keep both, give them different result names or set the save rule (reducer) to 'append'."),
  }));
}
/**
 * A step that does nothing is found here, where the author can still finish it, instead of at every scheduled run. The same facts the
 * kernel treats as "nothing to do" at run time (run-graph.ts: transform, tool, output): a graph saved before this check existed
 * still runs, those steps are skipped with a note.
 */
function unfinishedStepProblem(graph: WorkflowGraph, options: SuperviseGraphOptions): void {
  const prior = options.prior as WorkflowGraph | undefined;
  const priorNodes = new Map<string, WorkflowGraph["nodes"][number]>();
  if (prior && Array.isArray(prior.nodes) && Array.isArray(prior.edges)) {
    for (const n of prior.nodes) if (n && typeof n.id === "string") priorNodes.set(n.id, n);
  }
  const incident = (g: WorkflowGraph, id: string): string[] => g.edges.filter(e => e.source === id || e.target === id).map(e => `${e.id}\0${e.source}\0${e.target}`).sort();
  const alreadySaved = (n: WorkflowGraph["nodes"][number]): boolean => {
    const before = priorNodes.get(n.id);
    return !!before && sha256Value(before) === sha256Value(n)
      && JSON.stringify(incident(prior as WorkflowGraph, n.id)) === JSON.stringify(incident(graph, n.id));
  };
  const label = (n: WorkflowGraph["nodes"][number]) => n.label || n.id;
  for (const n of graph.nodes) {
    if (n.type !== "transform" && n.type !== "tool" && n.type !== "output" && n.type !== "eval") continue;
    if (alreadySaved(n)) continue;
    const cfg = n.config as Record<string, unknown>;
    if (n.type === "eval") {
      const hasItems = Array.isArray(cfg.items) && (cfg.items as unknown[]).some(entry => typeof (entry as { text?: unknown })?.text === "string" && (entry as { text: string }).text.trim() !== "");
      if (!text(cfg.subject)) fail("EVAL_INCOMPLETE", { nodeId: n.id,
        reason: L(`검증 단계 "${label(n)}"에 무엇을 볼지(subject)가 없습니다.`, `Verification step "${label(n)}" has no value to check (subject).`),
        nextAction: L("앞 단계가 만든 값 이름을 subject에 적으세요.", "Write the name of a value an earlier step produces into subject.") });
      if (!text(cfg.criteria) && !hasItems) fail("EVAL_INCOMPLETE", { nodeId: n.id,
        reason: L(`검증 단계 "${label(n)}"에 통과 기준(criteria 또는 채점표 items)이 없습니다.`, `Verification step "${label(n)}" has no pass criteria (criteria or checklist items).`),
        nextAction: L("통과 기준을 criteria에 한 문장으로 적거나 items에 채점표를 적으세요.", "Write the pass criteria as one sentence in criteria, or a checklist in items.") });
      continue;
    }
    if (n.type === "transform") {
      const from = text(cfg.from);
      if (!from) fail("TRANSFORM_NODE_UNCONFIGURED", { nodeId: n.id,
        reason: L(`"${label(n)}"에 가공할 값(from)이 없습니다.`, `"${label(n)}" has no value to transform (from).`),
        nextAction: L("앞 단계가 만든 값 이름을 from에 적으세요.", "Write the name of a value an earlier step produces into from.") });
      const mode = text(cfg.mode).toLowerCase();
      const { TRANSFORM_MODES } = require("./run-graph") as typeof import("./run-graph");
      if (mode && !(TRANSFORM_MODES as readonly string[]).includes(mode)) fail("TRANSFORM_MODE_UNKNOWN", { nodeId: n.id,
        reason: L(`"${label(n)}"의 가공 방식 "${text(cfg.mode)}"을(를) 이 제품이 모릅니다.`, `This product does not know the transform mode "${text(cfg.mode)}" used by "${label(n)}".`),
        nextAction: L(`mode를 ${TRANSFORM_MODES.join(" · ")} 중 하나로 바꾸세요.`, `Change mode to one of: ${TRANSFORM_MODES.join(" · ")}.`) });
    } else if (n.type === "tool") {
      if (!text(cfg.catalog)) fail("TOOL_NODE_UNCONFIGURED", { nodeId: n.id,
        reason: L(`도구 단계 "${label(n)}"에 어떤 도구를 쓸지(catalog)가 없습니다.`, `Tool step "${label(n)}" has no tool selected (catalog).`),
        nextAction: L("쓸 도구를 catalog에 적으세요.", "Write the tool to use into catalog.") });
      const attached = graph.nodes.some(c => c.type === "agent" && graph.edges.some(e => (e.source === n.id && e.target === c.id) || (e.target === n.id && e.source === c.id)));
      if (!attached) fail("TOOL_NODE_UNATTACHED", { nodeId: n.id,
        reason: L(`도구 "${text(cfg.catalog)}"가 어느 에이전트 단계에도 이어져 있지 않아 쓰이지 않습니다.`, `The tool "${text(cfg.catalog)}" is not connected to any agent step, so it would not be used.`),
        nextAction: L("이 도구를 쓸 에이전트 단계와 연결(edge)로 이으세요.", "Connect this tool to the agent step that will use it with an edge.") });
    } else if (options.promptTemplate !== undefined) {
      if (!text(cfg.text) && !text(cfg.prompt) && !options.promptTemplate.trim()) fail("OUTPUT_NODE_EMPTY", { nodeId: n.id,
        reason: L(`내보낼 것이 적혀 있지 않은 출력 단계입니다 ("${label(n)}").`, `This output step has nothing to send out ("${label(n)}").`),
        nextAction: L("이 단계가 결과로 남길 내용을 text에 적으세요.", "Write what this step should leave as its result into text.") });
    }
  }
}
function goalControl(id: string): unknown {
  const a = getAutomation(id), chat = a?.monitor?.originChatId ? getChat(a.monitor.originChatId) : null;
  const goalId = a?.goalId ?? chat?.goalId, run = goalId ? getLongRunByGoalId(goalId) : null;
  return run?.rootChatId ? { goalId: run.goalId, rootChatId: run.rootChatId, longRunId: run.id,
    generation: peekGoalExecutionControlGeneration({ goalId: run.goalId, rootChatId: run.rootChatId, longRunId: run.id }) } : null;
}
export function captureGraphProposalBase(id: string) {
  schema(); const a = getAutomation(id); if (!a?.graph) fail("PATCH_NO_GRAPH");
  return { automationId: id, definitionRevision: automationDefinitionDigest(a), editEpoch: automationGraphEditEpoch(id),
    runtimeSelection: a.runtimeSelection ? structuredClone(a.runtimeSelection) : undefined,
    processId, stopGeneration: peekAutomationStopGeneration(id), control: controls.get(id) ?? 0, goalControl: goalControl(id), graph: structuredClone(a.graph), goal: a.goal };
}
export function assertGraphProposalBase(base: ReturnType<typeof captureGraphProposalBase>): void {
  const a=getAutomation(base.automationId);
  if (!a || base.processId !== processId || peekAutomationStopGeneration(base.automationId) !== base.stopGeneration || automationDefinitionDigest(a) !== base.definitionRevision
    || automationGraphEditEpoch(base.automationId) !== base.editEpoch || (controls.get(base.automationId) ?? 0) !== base.control
    || sha256Value(goalControl(base.automationId)) !== sha256Value(base.goalControl)) fail("GRAPH_PROPOSAL_STALE");
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
  const verified=superviseGraph(decision.next,{ prior: base.graph, promptTemplate: getAutomation(base.automationId)?.promptTemplate }), id=randomUUID();
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
    const checked=superviseGraph(value.next,{ prior: value.base.graph, promptTemplate: getAutomation(id)?.promptTemplate }); if (sha256Value(checked.graph)!==sha256Value(value.next)) fail("GRAPH_PROPOSAL_INVALID");
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
