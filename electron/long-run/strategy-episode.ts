/** Bounded finite adaptation: one existing tactic reorder + one existing automation + one real wait.
 * No scheduler, provider dispatch or authority is supplied by model arguments. */
import { withInvocationAccounting } from "./accounting-context";
import { timerWaitAuthority } from "./goal-deadline";
import { getDb } from "../store/db";
import { desktopStoreTransaction } from "../store/change-bus";
import { captureGoalEpisode, assertGoalEpisodeCapture, withGoalEpisodeSelfChange, applyGoalEpisodeRest,
  type GoalEpisodeDisposition } from "./episode-disposition";
import { readGoalPlan, updateGoalPlanNode, withCurrentGoalPlan } from "../store/goal-plans";
import { getChatGoalRevision } from "../store/chat-goals";
import { listLongRunTasks, unsettledLongRunAttemptCount } from "../store/long-runs";
import { getAutomation, listAutomations } from "../store/automations";
import { readCurrentGoalAutomationBinding, getAutomationDefinitionDigest } from "./automation-provenance";
import { getLatestAutomationStrategyRevision } from "../store/automation-strategy-revisions";
import { applyEpisodeReservedStrategyProposal, type AutomationStrategyProposalReceipt } from "../store/automation-strategy-proposals";
import { runAutomationStrategyCycle } from "../automation-strategy-cycle";
import { latestGoalWaitSubscription, registerGoalWaitSubscription } from "./wait-subscriptions";
import { projectGoalPlanReadiness, selectActiveTactics, type LiveGoalPlan } from "../../shared/goal-shape";
import { graphExecutionDigest, sha256Value } from "../../shared/graph-execution-digest";
import type { WorkflowGraph } from "../../shared/types";
import type { AgiGoalFactsDeps } from "../agi/goal-facts";
import type { GoalWaitIntent } from "./wait-emitter";
import { assertAgiDecisionControl, agiDecisionAbortSignal, AGI_DECISION_CONTROL_CHANGED } from "../agi/decision-control";
import { assertAgiDecisionIngress, type AgiUnblockInput } from "../agi/monitor";
import { withInvocationJudgmentContext } from "../runtime/judgment-context";

export interface StrategyReorder { op: "reorder"; nodeId: string; ord: number }
interface SourceRun { id: string; status: "ok" | "error"; graph_digest: string; occurrence_id: string; checkpoint_json: string; dry_run: number; resume_of_run_id: string | null; evidenceDigest?: string }
interface StrategySource {
  automationId: string; source: SourceRun; definition: string; graph: string; revision: number; authorityDigest: string;
  binding: NonNullable<ReturnType<typeof readCurrentGoalAutomationBinding>>;
}
interface StrategyCapture { captureId: string; goalId: string; reason: string | null; source: StrategySource | null;
  plan: LiveGoalPlan | null; taskDigest: string | null; deadline: string | null }
export interface PreparedGoalStrategyEpisode { captureId: string; requestDigest: string; proposalId: string }
const preparationHandles = new WeakSet<PreparedGoalStrategyEpisode>();
const hash = sha256Value;
function schema(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS goal_strategy_episode_captures (
    id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json)));
    CREATE TABLE IF NOT EXISTS goal_strategy_episode_results (
    id TEXT PRIMARY KEY, input_digest TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json)))`);
}
export function strategyEpisodeReason(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return /^(goal_(?:strategy|episode|plan|wait)|checkpoint|proposal|automation_strategy)_[a-z_]+$/.test(code) ? code : "goal_strategy_unavailable";
}
function captured(id: string): StrategyCapture {
  schema();
  const row = getDb().prepare("SELECT value_json FROM goal_strategy_episode_captures WHERE id=?").get(id) as { value_json: string } | undefined;
  if (!row) throw new Error("goal_strategy_capture_missing");
  return JSON.parse(row.value_json) as StrategyCapture;
}
/** Require an actual sealed v4 no-effect Graph checkpoint, not provenance's intentionally unknown KPI.
 * Only deterministic Main branches may have executed; opaque runtime output remains unknown. */
function noEffectSource(source: SourceRun, graph: WorkflowGraph, definition: string): void {
  if (source.resume_of_run_id !== null || source.dry_run !== 0 || source.status !== "ok" || source.checkpoint_json.length > 2_000_000)
    throw new Error("goal_strategy_source_unavailable");
  const checkpoint = JSON.parse(source.checkpoint_json) as Record<string, unknown>;
  const { checkpointDigest, ...payload } = checkpoint;
  if (checkpoint.schemaVersion !== "agentlas.automation-graph-checkpoint.v4" || checkpointDigest !== hash(payload)
    || checkpoint.graphDigest !== source.graph_digest || checkpoint.occurrenceId !== source.occurrence_id
    || !["inFlightNodeIds", "ambiguousNodeIds"].every(k => Array.isArray(checkpoint[k]) && (checkpoint[k] as unknown[]).length === 0)
    || !checkpoint.toolReceipts || typeof checkpoint.toolReceipts !== "object" || Array.isArray(checkpoint.toolReceipts)
    || !Object.values(checkpoint.toolReceipts).every(value => Array.isArray(value) && value.length === 0)
    || !checkpoint.loginWaits || typeof checkpoint.loginWaits !== "object" || Object.keys(checkpoint.loginWaits).length)
    throw new Error("goal_strategy_effects_unknown");
  // Unlike opaque model/tool execution, these exact Main branches cannot call an external adapter.
  // Every other node must have been skipped. No absence-of-error or zero-tool-count inference.
  const completed = checkpoint.completedNodeIds, skipped = checkpoint.skippedNodeIds;
  if (!Array.isArray(completed) || !Array.isArray(skipped) || !completed.length
    || completed.length + skipped.length !== graph.nodes.length
    || new Set([...completed,...skipped]).size !== graph.nodes.length
    || [...completed,...skipped].some(id => typeof id !== "string" || !graph.nodes.some(node => node.id === id))
    || completed.some(id => {
      const node = graph.nodes.find(n => n.id === id)!;
      return !["trigger", "condition", "transform"].includes(node.type)
        && !(node.type === "output" && ["read", "pure"].includes(String(node.config.effect))
          && typeof node.config.text === "string" && node.config.text.trim().length > 0);
    })) throw new Error("goal_strategy_effects_unknown");
  const entered = checkpoint.nodeInputDigests;
  if (!entered || typeof entered !== "object" || Array.isArray(entered)
    || Object.keys(entered).sort().join("\0") !== [...completed].sort().join("\0")
    || graph.edges.some(edge => edge.maxIterations !== undefined)) throw new Error("goal_strategy_source_coverage");
  // Reject cycles even if no loop annotation or iteration was retained.
  const visiting = new Set<string>(), visited = new Set<string>();
  const cyclic = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if (graph.edges.filter(e => e.source === id).some(e => cyclic(e.target))) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  if (graph.nodes.some(node => cyclic(node.id))) throw new Error("goal_strategy_source_coverage");
  const db = getDb();
  const events = db.prepare("SELECT id,seq,kind,node_id,payload_json FROM run_events WHERE run_id=? ORDER BY seq LIMIT 501")
    .all(source.id) as Array<{ id: string; seq: number; kind: string; node_id: string | null; payload_json: string }>;
  const journal = db.prepare("SELECT seq,kind,node_id,payload_json FROM graph_run_journal WHERE run_id=? ORDER BY seq LIMIT 501")
    .all(source.id) as Array<{ seq: number; kind: string; node_id: string | null; payload_json: string | null }>;
  if (!events.length || events.length >= 501 || !journal.length || journal.length >= 501) throw new Error("goal_strategy_source_coverage");
  const decoded = events.map(event => {
    const payload = JSON.parse(event.payload_json);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("goal_strategy_source_coverage");
    return { ...event, payload };
  });
  const starts = decoded.filter(e => e.kind === "workflow_graph_started"), ends = decoded.filter(e => e.kind === "workflow_graph_finished");
  if (starts.length !== 1 || ends.length !== 1 || starts[0].seq >= ends[0].seq
    // The actual run-event writer omits null payload keys. The source row above still proves no resume.
    || starts[0].payload.resumeOfRunId != null || starts[0].payload.simulation !== false
    || starts[0].payload.graphDigest !== source.graph_digest || starts[0].payload.definitionDigest !== definition
    || starts[0].payload.occurrenceId !== source.occurrence_id || starts[0].payload.nodeCount !== graph.nodes.length
    || ends[0].payload.status !== "ok" || ends[0].payload.ok !== true) throw new Error("goal_strategy_source_coverage");
  const states = decoded.filter(e => e.kind === "workflow_node_state");
  if (states.some(e => e.seq <= starts[0].seq || e.seq >= ends[0].seq || !graph.nodes.some(n => n.id === e.node_id)))
    throw new Error("goal_strategy_source_coverage");
  for (const node of graph.nodes) {
    const sequence = states.filter(e => e.node_id === node.id).map(e => e.payload.state);
    if (JSON.stringify(sequence) !== JSON.stringify(completed.includes(node.id) ? ["running","done"] : ["skipped"]))
      throw new Error("goal_strategy_source_coverage");
  }
  for (let i=0; i<journal.length; i++) {
    const row=journal[i], payload=row.payload_json === null ? null : JSON.parse(row.payload_json);
    if (row.seq !== i+1 || (payload !== null && (typeof payload !== "object" || Array.isArray(payload)))
      || !["node_reserved","node_intent","node_settled","run_completed"].includes(row.kind)
      || (row.kind !== "run_completed" && !completed.includes(row.node_id))) throw new Error("goal_strategy_source_coverage");
  }
  if (journal.filter(e => e.kind === "run_completed").length !== 1 || journal.at(-1)?.kind !== "run_completed"
    || completed.some(id => JSON.stringify(journal.filter(e => e.node_id === id).map(e => e.kind)) !== JSON.stringify(["node_reserved","node_intent","node_settled"])))
    throw new Error("goal_strategy_source_coverage");
  if (decoded.some(e => ["mcp_tool-use","graph_host_effect","graph_uncertain_effect_noted"].includes(e.kind)))
    throw new Error("goal_strategy_effects_unknown");
  source.evidenceDigest = hash({ starts, ends, states, journal });

}
function sourceFor(automationId: string): StrategySource {
  const automation = getAutomation(automationId), binding = readCurrentGoalAutomationBinding(automationId);
  if (!automation?.enabled || !automation.graph || !binding) throw new Error("goal_strategy_binding_unavailable");
  if (getDb().prepare("SELECT 1 FROM automation_runs WHERE automation_id=? AND status='running' LIMIT 1").get(automationId))
    throw new Error("goal_strategy_automation_active");
  // Never skip a newer incomplete source to resurrect an old convenient result.
  const source = getDb().prepare(`SELECT id,status,graph_digest,occurrence_id,checkpoint_json,dry_run,resume_of_run_id FROM automation_runs
    WHERE automation_id=? ORDER BY rowid DESC LIMIT 1`).get(automationId) as SourceRun | undefined;
  if (!source?.checkpoint_json) throw new Error("goal_strategy_source_unavailable");
  const graph = graphExecutionDigest(automation, automation.graph), definition = getAutomationDefinitionDigest(automationId);
  if (!definition || source.graph_digest !== graph) throw new Error("goal_strategy_source_stale");
  noEffectSource(source, automation.graph, definition);
  const authority = getDb().prepare("SELECT enabled,execution_permission,tool_mode,hub_mode,target_version,end_at,max_runs FROM automations WHERE id=?").get(automationId);
  return { automationId, source, graph, definition, binding, authorityDigest: hash(authority), revision: getLatestAutomationStrategyRevision(automationId)?.revision ?? 0 };
}
export function captureGoalStrategyEpisode(captureId: string, goalId: string, now = Date.now()): void {
  schema();
  if (getDb().prepare("SELECT 1 FROM goal_strategy_episode_captures WHERE id=?").get(captureId)) {
    if (captured(captureId).goalId !== goalId) throw new Error("goal_strategy_capture_conflict");
    return;
  }
  captureGoalEpisode({ captureId, goalId });
  const value: StrategyCapture = { captureId, goalId, reason: null, source: null, plan: null, taskDigest: null, deadline: null };
  try {
    const custody = assertGoalEpisodeCapture(captureId, now).custody!;
    if (!custody.effectsSettled) throw new Error("goal_strategy_effects_unknown");
    const plan = readGoalPlan(goalId), revision = getChatGoalRevision(goalId), timer = timerWaitAuthority(goalId,now);
    if (!timer.ok || timer.lifecycle !== "finite" || revision?.lifecycle !== "finite" || !plan || plan.fallback || !plan.deadline_at || !Number.isFinite(Date.parse(plan.deadline_at))
      || Date.parse(plan.deadline_at) <= now) throw new Error("goal_strategy_deadline_unavailable");
    const matches = listAutomations().filter(a => readCurrentGoalAutomationBinding(a.id)?.goalId === goalId);
    if (matches.length !== 1) throw new Error("goal_strategy_binding_unavailable");
    const source = sourceFor(matches[0].id);
    if (source.binding.goalRevision !== revision.revision || source.binding.longRunId !== custody.runId) throw new Error("goal_strategy_binding_unavailable");
    Object.assign(value, { source, plan, deadline: plan.deadline_at, taskDigest: hash(listLongRunTasks(custody.runId)) });
  } catch (error) { value.reason = strategyEpisodeReason(error); }
  getDb().prepare("INSERT INTO goal_strategy_episode_captures(id,goal_id,value_json) VALUES (?,?,?)").run(captureId,goalId,JSON.stringify(value));
}
function current(captureId: string, now: number): StrategyCapture {
  const value = captured(captureId);
  if (value.reason || !value.source || !value.plan || !value.deadline) throw new Error(value.reason ?? "goal_strategy_capture_missing");
  const c = assertGoalEpisodeCapture(captureId, now).custody!;
  const wait = latestGoalWaitSubscription(value.goalId);
  if (wait && ["pending", "claimed"].includes(wait.state)) throw new Error("goal_strategy_wait_exists");
  if (!c.effectsSettled || unsettledLongRunAttemptCount(c.runId)) throw new Error("goal_strategy_effects_unknown");
  if (hash(listLongRunTasks(c.runId)) !== value.taskDigest || hash(sourceFor(value.source.automationId)) !== hash(value.source))
    throw new Error("goal_strategy_source_stale");
  if (getChatGoalRevision(value.goalId)?.lifecycle !== "finite" || Date.parse(value.deadline) <= now) throw new Error("goal_strategy_deadline_reached");
  return value;
}
export function validateStrategyReorder(plan: LiveGoalPlan, raw: unknown, now: number): StrategyReorder {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("goal_strategy_ops_invalid");
  const op = raw as Record<string, unknown>;
  if (Object.keys(op).sort().join(",") !== "nodeId,op,ord" || op.op !== "reorder" || typeof op.nodeId !== "string"
    || !Number.isSafeInteger(op.ord) || Math.abs(op.ord as number) > 1_000_000) throw new Error("goal_strategy_ops_invalid");
  const node = plan.tactics.find(t => t.id === op.nodeId), readiness = projectGoalPlanReadiness(plan, { nowMs: now });
  const branch = readiness.branches.find(b => b.nodeId === op.nodeId);
  if (!node || node.status !== "active" || !branch?.inspectable || !branch.workClasses.includes("local_write"))
    throw new Error("goal_strategy_tactic_held");
  if (selectActiveTactics(plan, { nowMs: now }).some(t => t.id === node.id)) throw new Error("goal_strategy_reorder_noop");
  const peers = plan.tactics.filter(t => t.status === "active" && t.strategy_id === node.strategy_id && t.id !== node.id);
  if (!peers.length || peers.some(t => t.ord <= (op.ord as number)) || node.ord === op.ord)
    throw new Error("goal_strategy_reorder_noop");
  const projected = { ...plan, tactics: plan.tactics.map(t => t.id === node.id ? { ...t, ord: op.ord as number } : t) };
  if (!selectActiveTactics(projected, { nowMs: now }).some(t => t.id === node.id)) throw new Error("goal_strategy_tactic_not_selected");
  return { op: "reorder", nodeId: node.id, ord: op.ord as number };
}
function assertIntent(intent: GoalWaitIntent, deadline: string, now: number): void {
  if (Object.keys(intent).sort().join(",") !== "condition,deadline,nextAction,schemaVersion,subject"
    || intent.schemaVersion !== "agentlas.goal-wait-intent.v1" || intent.subject.kind !== "timer"
    || Object.keys(intent.subject).sort().join(",") !== "kind,notBefore" || intent.condition !== "due"
    || intent.deadline !== null || typeof intent.nextAction !== "string" || !intent.nextAction.trim() || intent.nextAction.length > 1000
    || !Number.isFinite(Date.parse(intent.subject.notBefore)) || Date.parse(intent.subject.notBefore) <= now
    || Date.parse(intent.subject.notBefore) > Date.parse(deadline)) throw new Error("goal_strategy_rest_invalid");
}
function requestDigest(captureId: string, op: StrategyReorder, intent: GoalWaitIntent): string { return hash({ captureId, op, intent }); }
function currentDecision(captureId: string, decision: AgiUnblockInput, now: number): StrategyCapture {
  assertAgiDecisionControl(decision?.decisionControl, decision);
  const value = current(captureId,now), custody = assertGoalEpisodeCapture(captureId,now).custody!;
  if (decision.goalId !== value.goalId || decision.runId !== custody.runId) throw new Error(AGI_DECISION_CONTROL_CHANGED);
  return value;
}
export async function prepareGoalStrategyEpisode(input: { captureId: string; op: StrategyReorder; intent: GoalWaitIntent },
  decision: AgiUnblockInput,
  cycle: typeof runAutomationStrategyCycle = runAutomationStrategyCycle): Promise<PreparedGoalStrategyEpisode> {
  const value = currentDecision(input.captureId, decision, Date.now()), source = value.source!, signal = agiDecisionAbortSignal(decision);
  const op = validateStrategyReorder(value.plan!, input.op, Date.now());
  assertIntent(input.intent, value.deadline!, Date.now());
  const target = value.plan!.tactics.find(t => t.id === op.nodeId)!;
  let prepared: AutomationStrategyProposalReceipt | null = null;
  const custody = assertGoalEpisodeCapture(input.captureId, Date.now()).custody!;
  // Attribute both review calls to the immutable Main producer, including bridged
  // automations whose legacy goal_id column is intentionally null.
  await withInvocationJudgmentContext(undefined,signal,() => withInvocationAccounting({ runId: custody.producerInvocationId, chatId: custody.chatId,
    readOwner: () => { currentDecision(input.captureId, decision, Date.now());
      return { goalId: custody.goalId, attemptId: custody.workerAttemptId }; } }, () => cycle({ automationId: source.automationId, sourceRunId: source.source.id, status: source.source.status, outcome: null,
    goalRecommendation: { proposalId: input.captureId, goalId: value.goalId, goalRevision: value.plan!.revision,
      intent: "change-strategy", rationale: JSON.stringify(op), strategy: { schemaVersion: "agentlas.goal-strategy.v1",
        summary: target.description, change: JSON.stringify({ ...op, description: target.description, done_when: target.done_when }) }, cadence: null },
    signal,
    isCurrent: () => { try { currentDecision(input.captureId, decision, Date.now()); return true; } catch { return false; } },
    episodePreparation: { captureId: input.captureId, prepared: receipt => { prepared = receipt; } } })));
  currentDecision(input.captureId, decision, Date.now());
  const proposal = prepared as AutomationStrategyProposalReceipt | null;
  if (!proposal || proposal.reviewStatus !== "approved" || proposal.adjudication.decision !== "within_scope"
    || proposal.status !== "pending" || proposal.automationId !== source.automationId || proposal.sourceRunId !== source.source.id
    || proposal.expectedDefinitionDigest !== source.definition || proposal.expectedGraphDigest !== source.graph
    || proposal.expectedRevision !== source.revision || proposal.goalId !== value.goalId || proposal.goalRevision !== value.plan!.revision) throw new Error("goal_strategy_review_unavailable");
  const handle = Object.freeze({ captureId: input.captureId, requestDigest: requestDigest(input.captureId,op,input.intent), proposalId: proposal.id });
  preparationHandles.add(handle);
  return handle;
}
export function readGoalStrategyEpisodeResult(requestId: string, captureId: string, op: StrategyReorder, intent: GoalWaitIntent): GoalEpisodeDisposition | null {
  schema();
  const row = getDb().prepare("SELECT input_digest,value_json FROM goal_strategy_episode_results WHERE id=?").get(requestId) as { input_digest: string; value_json: string } | undefined;
  if (!row) return null;
  if (row.input_digest !== requestDigest(captureId,op,intent)) throw new Error("goal_strategy_request_conflict");
  return { ...JSON.parse(row.value_json), replayed: true } as GoalEpisodeDisposition;
}
export function commitGoalStrategyEpisode(input: { requestId: string; captureId: string; op: StrategyReorder; intent: GoalWaitIntent;
  prepared: PreparedGoalStrategyEpisode; latestReceipt?: AgiGoalFactsDeps["latestReceipt"]; now?: number }, decision: AgiUnblockInput): GoalEpisodeDisposition {
  schema();
  return desktopStoreTransaction(getDb(), () => {
    const replay = readGoalStrategyEpisodeResult(input.requestId,input.captureId,input.op,input.intent);
    if (replay) return replay;
    const now = input.now ?? Date.now(), value = currentDecision(input.captureId,decision,now), signal = agiDecisionAbortSignal(decision);
    // Own synchronous plan/version changes use the existing derived capsule.
    // Within that transaction only the original private claim/lifetime is checked.
    const assertLifetime = (): void => {
      try { if (signal.aborted) throw new Error(AGI_DECISION_CONTROL_CHANGED);
        assertAgiDecisionIngress(decision.decisionIngress,decision);
      } catch { throw Object.assign(new Error(AGI_DECISION_CONTROL_CHANGED), { code: AGI_DECISION_CONTROL_CHANGED }); }
    };
    const op = validateStrategyReorder(value.plan!,input.op,now), digest = requestDigest(input.captureId,op,input.intent);
    assertIntent(input.intent, value.deadline!, now);
    if (!preparationHandles.has(input.prepared) || input.prepared.captureId !== input.captureId || input.prepared.requestDigest !== digest)
      throw new Error("goal_strategy_preparation_missing");
    const derivedId = `${input.captureId}:strategy`;
    let automationRevision: number | null = null;
    withGoalEpisodeSelfChange(input.captureId,derivedId,now,() => {
      assertLifetime();
      withCurrentGoalPlan(value.goalId,value.plan!.mutationIdentity!,plan => updateGoalPlanNode(plan,op.nodeId,{ ord: op.ord }));
      assertLifetime();
      automationRevision = applyEpisodeReservedStrategyProposal(input.prepared.proposalId,input.captureId).revisionReceipt?.revision ?? null;
      if (automationRevision === null) throw new Error("goal_strategy_revision_missing");
    });
    assertLifetime();
    const result = applyGoalEpisodeRest({ requestId: input.requestId, captureId: derivedId, goalId: value.goalId,
      intent: input.intent, now, signal, latestReceipt: input.latestReceipt },registerGoalWaitSubscription);
    // A reentrant readback may end the decision while the wait is still tentative.
    // Refusal here rolls back the owned transaction; committed replay is read first.
    assertLifetime();
    if (result.status !== "wait_registered" || !result.waitId || !result.checkpointId) throw new Error(result.code);
    Object.assign(result, { strategyEpisode: { sourceCaptureId: input.captureId, derivedCaptureId: derivedId,
      proposalId: input.prepared.proposalId, automationId: value.source!.automationId, automationRevision, op } });
    getDb().prepare("INSERT INTO goal_strategy_episode_results(id,input_digest,value_json) VALUES (?,?,?)")
      .run(input.requestId,digest,JSON.stringify(result));
    return result;
  }).immediate();
}
