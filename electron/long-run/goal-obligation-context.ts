import { compileLongRunCheckpoint, type LongRunTaskCheckpoint } from "../../shared/long-run-checkpoint";
import { createHash } from "node:crypto";
import type { McpInvocationRequest, OrchestrationTarget, RuntimeSelection } from "../../shared/types";
import type { GoalRevision, GoalSourceMessage } from "../../shared/auto-goal";
import { copyGoalExecutionObligations, goalExecutionObligationsSatisfied,
  type GoalExecutionObligations, type GoalObligationExecutionEvidence } from "../../shared/goal-execution-obligations";
import { getDb } from "../store/db";
import { getChat } from "../store/chats";
import { getChatGoalRevision, attachStoredGoalExecutionObligations } from "../store/chat-goals";
import { findCanonicalTaskForChat, canonicalTaskOwnsChat } from "../store/tasks";
import { readGoalPlan } from "../store/goal-plans";
import { appendLongRunEvent, getLongRunByGoalId, getLongRunGoalRevisionBinding, getLongRunAttemptGoalRevision, longRunOwnerHold, goalOwnerAnswerHold } from "../store/long-runs";

/** Host-owned intent only. Each episode still needs a newly prepared Main grant. */
export interface GoalObligationPreflightIntent {
  schemaVersion: "agentlas.goal-obligation-preflight-intent.v1";
  chatId: string; goalId: string; goalRevision: number; obligationVersion: number; requestedRunId: string;
  sourceMessageId: string; userPrompt: string; targets: OrchestrationTarget[];
  permission: "read" | "write"; runtimeSelection?: RuntimeSelection;
}
const preparedIntents = new WeakMap<GoalObligationPreflightIntent, () => void>();
export function assertGoalObligationPreflightIntent(intent: GoalObligationPreflightIntent): void {
  const verify = preparedIntents.get(intent);
  if (!verify) throw new Error("goal_obligation_intent_unconfirmed");
  verify();
}
export const goalObligationDigest = (text: string): string => createHash("sha256").update(text).digest("hex");
interface ClaimedParticipantSource { proposalId: string; taskId: string; taskVersion: number; targets: OrchestrationTarget[] }
interface GoalTeamPreflightApi {
  readClaimedGoalParticipantSource(input: { runId: string; chatId: string; promptDigest: string }): ClaimedParticipantSource | null;
  prepareGoalObligationTeamPreflight(intent: GoalObligationPreflightIntent): Promise<{
    kind: string; ref?: NonNullable<McpInvocationRequest["oneTeamPreflightRef"]>;
  }>;
  failOneTeamPreflightStart(ref: NonNullable<McpInvocationRequest["oneTeamPreflightRef"]>): unknown;
}
const preflightApi = () => require("../one/team-preflight") as GoalTeamPreflightApi;

/** Canonical old receipts restore selectors as intent, never as runtime authority.
 * The owner message, Main start and its prompt binding must form one exact chain.
 * Incomplete/conflicting history remains unknown; it does not bar ordinary work. */
export function captureGoalExecutionObligations(runId: string, source: GoalSourceMessage): GoalExecutionObligations | undefined {
  const db = getDb();
  const row = db.prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?").get(source.messageId) as
    { chat_id: string; role: string; text: string } | undefined;
  if (!row || row.chat_id !== source.chatId || row.role !== "user" || row.text !== source.text) throw new Error("goal_obligation_source_changed");
  const promptDigest = goalObligationDigest(row.text);
  const starts = db.prepare("SELECT seq, payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind='invoke_started'")
    .all(runId, source.chatId) as Array<{ seq: number; payload_json: string }>;
  const links = db.prepare("SELECT seq, payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind='invoke_prompt_bound'")
    .all(runId, source.chatId) as Array<{ seq: number; payload_json: string }>;
  if (starts.length !== 1 || links.length !== 1 || starts[0].seq >= links[0].seq) return undefined;
  let started: Record<string, unknown>, bound: Record<string, unknown>;
  try { started = JSON.parse(starts[0].payload_json); bound = JSON.parse(links[0].payload_json); } catch { return undefined; }
  if (bound.promptMessageId !== source.messageId || started.taskIntent !== "task") return undefined;
  const api = preflightApi();
  const selected = typeof api.readClaimedGoalParticipantSource === "function"
    ? api.readClaimedGoalParticipantSource({ runId, chatId: source.chatId, promptDigest }) : null;
  let targets = selected?.targets;
  let provenance: GoalExecutionObligations["source"] | undefined = selected && targets?.length
    && started.oneTeamPreflightProposalId === selected.proposalId ? {
      kind: "claimed_preflight", chatId: source.chatId, messageId: source.messageId, runId, promptDigest,
      proposalId: selected.proposalId, taskId: selected.taskId, taskVersion: selected.taskVersion,
    } : undefined;
  if (!provenance && (selected || started.oneTeamPreflightProposalId !== undefined)) return undefined;
  if (!provenance) {
    const task = findCanonicalTaskForChat(source.chatId);
    if (!task || !canonicalTaskOwnsChat(task, source.chatId)
      || started.oneTeamExecutionPolicy !== "confirmed_existing_roster" || !Array.isArray(started.taskForceTargets)
      || !started.taskForceTargets.length) return undefined;
    targets = started.taskForceTargets as OrchestrationTarget[];
    provenance = { kind: "owner_invocation", chatId: source.chatId, messageId: source.messageId,
      runId, promptDigest, taskId: task.id, taskVersion: task.version };
  }
  try { return copyGoalExecutionObligations({ schemaVersion: "agentlas.goal-execution-obligations.v1", version: 1,
    source: provenance, participants: targets!.map((target, index) => ({ id: `participant:${index + 1}`, target, role: "participant" as const })),
    reviewAssignments: "unresolved" }); } catch { return undefined; }
}

export function currentGoalExecutionObligations(revision: GoalRevision): GoalExecutionObligations | undefined {
  if (revision.executionObligations) return copyGoalExecutionObligations(revision.executionObligations);
  const run = getLongRunByGoalId(revision.goalId);
  if (!run || getChat(revision.chatId)?.goalId !== revision.goalId
    || getLongRunGoalRevisionBinding(run.id)?.revision !== revision.revision) return undefined;
  const links = getDb().prepare(`SELECT DISTINCT run_id FROM run_events WHERE chat_id=? AND kind='invoke_prompt_bound'
    AND json_extract(payload_json,'$.promptMessageId')=?`).all(revision.chatId, revision.originalRequest.messageId) as Array<{ run_id: string }>;
  // Two different original starts are ambiguous, not a license to choose a roster.
  if (links.length !== 1) return undefined;
  let intent: GoalExecutionObligations | undefined;
  try { intent = captureGoalExecutionObligations(links[0].run_id, revision.originalRequest); }
  catch (error) { if (error instanceof Error && error.message === "goal_obligation_source_changed") return undefined; throw error; }
  return intent ? attachStoredGoalExecutionObligations(revision.goalId, revision.revision, intent).executionObligations : undefined;
}

/** Existing prompt module's typed data. Numeric mandate values stay unchanged. */
export function goalObligationPlannerData(goalId: string, expectedRevision: number): object | undefined {
  const goal = getChatGoalRevision(goalId);
  if (!goal || goal.revision !== expectedRevision) throw new Error("goal_obligation_context_changed");
  const obligations = currentGoalExecutionObligations(goal);
  const plan = readGoalPlan(goalId, expectedRevision);
  return { executionObligations: obligations ?? null, cadence: goal.cadence ?? null,
    mission: plan?.mission ?? null, reviewEveryHours: plan?.review_every_hours ?? null };
}

/** Restore typed source data inside the existing checkpoint module. The schema
 * identity, registered module, instructions and composition order stay intact. */
export function compileGoalObligationCheckpoint(...args: Parameters<typeof compileLongRunCheckpoint>): string {
  const text = compileLongRunCheckpoint(...args), checkpoint: LongRunTaskCheckpoint = args[0];
  if (checkpoint.goalRevision == null) return text;
  return JSON.stringify({ ...JSON.parse(text), ...goalObligationPlannerData(checkpoint.goalId, checkpoint.goalRevision) });
}
export function withGoalObligationContextText(text: string, goalId: string | null | undefined, revision: number | null | undefined): string {
  if (!text || !goalId || revision == null) return text;
  return JSON.stringify({ ...JSON.parse(text), ...goalObligationPlannerData(goalId, revision) });
}

type Continuation = { requestJson: string; prompt: string; verify(): void };
// The map bridges native JSON serialization only for a request Main prepared in
// this process. Run id alone is insufficient; every byte must still match.
const continuationRequests = new Map<string, Continuation>();
const preparingRunIds = new Set<string>();
function bindContinuation(request: McpInvocationRequest, verify: () => void): McpInvocationRequest {
  if (!request.runId) throw new Error("goal_obligation_run_identity_missing");
  if (continuationRequests.size >= 128) throw new Error("goal_obligation_preparation_capacity");
  continuationRequests.set(request.runId, { requestJson: JSON.stringify(request), prompt: request.userPrompt, verify });
  return request;
}
export function goalObligationContinuationPrompt(request: McpInvocationRequest): string | undefined {
  const source = request.runId ? continuationRequests.get(request.runId) : undefined;
  if (!source) return undefined;
  if (source.requestJson !== JSON.stringify(request)) throw new Error("goal_obligation_request_changed");
  source.verify();
  return source.prompt;
}
export function releaseGoalObligationContinuation(request: McpInvocationRequest): void {
  const source = request.runId ? continuationRequests.get(request.runId) : undefined;
  if (source && source.requestJson === JSON.stringify(request)) continuationRequests.delete(request.runId!);
}
export function abandonGoalObligationContinuation(request: McpInvocationRequest): void {
  const source = request.runId ? continuationRequests.get(request.runId) : undefined;
  if (!source || source.requestJson !== JSON.stringify(request)) return;
  releaseGoalObligationContinuation(request);
  try {
    const started = getDb().prepare("SELECT 1 FROM run_events WHERE run_id=? AND kind='invoke_started' LIMIT 1").get(request.runId);
    if (!started && request.oneTeamPreflightRef) preflightApi().failOneTeamPreflightStart(request.oneTeamPreflightRef);
  } catch { console.warn("[goal-obligations] owned preflight cleanup remains unconfirmed"); }
}

/** Await outside store transactions; repeat the original Goal/source CAS before entry. */
export async function prepareGoalObligationContinuation(request: McpInvocationRequest,
  expected?: { goalId: string; goalRevision: number | null }): Promise<McpInvocationRequest> {
  const chat = getChat(request.chatId), run = chat?.goalId ? getLongRunByGoalId(chat.goalId) : null;
  const revision = run ? getChatGoalRevision(run.goalId) : null;
  if (expected && (chat?.goalId !== expected.goalId || revision?.revision !== expected.goalRevision)) throw new Error("goal_obligation_preparation_changed");
  if (!chat || !run || !revision || revision.chatId !== chat.id || run.rootChatId !== chat.id) return request;
  const obligations = currentGoalExecutionObligations(revision);
  if (!obligations) return request;
  if (!expected) throw new Error("goal_obligation_source_context_required");
  if (typeof preflightApi().prepareGoalObligationTeamPreflight !== "function") throw new Error("goal_obligation_team_unavailable");
  if (!request.runId || request.oneTeamPreflightRef) throw new Error("goal_obligation_fresh_preparation_required");
  if (preparingRunIds.has(request.runId) || continuationRequests.has(request.runId)
    || getDb().prepare("SELECT 1 FROM run_events WHERE run_id=? AND kind='invoke_started' LIMIT 1").get(request.runId)) {
    throw new Error("goal_obligation_run_already_prepared");
  }
  const requestJson = JSON.stringify(request), authorityJson = JSON.stringify(revision.authorityRefs);
  const authority = revision.authorityRefs.map(ref => /^invocation:([^:]+):permission:(read|write|full)$/.exec(ref)).find(Boolean);
  if (!authority || (authority[2] === "read" && request.permissions !== "read")) throw new Error("goal_obligation_permission_changed");
  const ownerCursor = () => (getDb().prepare("SELECT COALESCE(MAX(rowid),0) AS cursor FROM chat_messages WHERE chat_id=? AND role='user'").get(chat.id) as { cursor: number }).cursor;
  const expectedOwnerCursor = ownerCursor();
  const verify = () => {
    const now = getLongRunByGoalId(run.goalId), goal = getChatGoalRevision(run.goalId), current = getChat(chat.id);
    if (!now || current?.goalId !== run.goalId || now.rootChatId !== chat.id || goal?.revision !== revision.revision
      || getLongRunGoalRevisionBinding(now.id)?.revision !== revision.revision
      || JSON.stringify(request) !== requestJson || JSON.stringify(goal.authorityRefs) !== authorityJson
      || ownerCursor() !== expectedOwnerCursor || JSON.stringify(goal.executionObligations) !== JSON.stringify(obligations)
      || longRunOwnerHold(now.id) || goalOwnerAnswerHold(now.id) || (now.status === "paused" && !["app_closed", "crash_recovery", "runtime_unavailable"].includes(now.pauseReason ?? ""))
      || ["completed", "failed", "cancelled", "cancelling", "pausing"].includes(now.status)) {
      throw new Error("goal_obligation_preparation_changed");
    }
    const source = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id=?").get(obligations.source.messageId) as
      { chat_id: string; role: string; text: string } | undefined;
    if (source?.chat_id !== chat.id || source.role !== "user" || goalObligationDigest(source.text) !== obligations.source.promptDigest) throw new Error("goal_obligation_source_changed");
  };
  verify();
  const source = getDb().prepare("SELECT text FROM chat_messages WHERE id=?").get(obligations.source.messageId) as { text: string };
  const intent: GoalObligationPreflightIntent = { schemaVersion: "agentlas.goal-obligation-preflight-intent.v1",
    chatId: chat.id, goalId: revision.goalId, goalRevision: revision.revision, obligationVersion: obligations.version, requestedRunId: request.runId,
    sourceMessageId: obligations.source.messageId, userPrompt: source.text, targets: obligations.participants.map(p => p.target),
    permission: request.permissions === "read" ? "read" : "write", ...(request.runtimeSelection ? { runtimeSelection: request.runtimeSelection } : {}) };
  const sealed = JSON.stringify(intent);
  preparedIntents.set(intent, () => { if (JSON.stringify(intent) !== sealed) throw new Error("goal_obligation_intent_changed"); verify(); });
  let prepared: Awaited<ReturnType<GoalTeamPreflightApi["prepareGoalObligationTeamPreflight"]>> | undefined;
  preparingRunIds.add(request.runId);
  try {
    prepared = await preflightApi().prepareGoalObligationTeamPreflight(intent);
    verify();
    if (prepared.kind !== "reserved" || !prepared.ref || prepared.ref.mode !== "team"
      || prepared.ref.reservedRunId !== request.runId) throw new Error("goal_obligation_team_unavailable");
    return bindContinuation({ ...request, oneTeamPreflightRef: prepared.ref }, verify);
  } catch (error) {
    if (prepared?.ref) preflightApi().failOneTeamPreflightStart(prepared.ref);
    throw error;
  } finally { preparingRunIds.delete(request.runId); }
  // The intent WeakMap lifetime follows its canonical preflight owner through claim/fail/expiry.
}

function goalCallWitnessResolves(rootChatId: string, invocationRunId: string, result: GoalObligationExecutionEvidence["results"][number]): boolean {
  if (result.targetRef.startsWith("local:team:")) return !!getDb().prepare(`SELECT 1 FROM run_events e JOIN chats c ON c.id=e.chat_id
    WHERE e.run_id=? AND e.chat_id=? AND e.node_id=? AND c.parent_chat_id=? AND c.firm_id=?
    AND e.kind IN ('invoke_result','runtime_usage_unmeasured') AND json_extract(e.payload_json,'$.status')='completed'
    AND json_extract(e.payload_json,'$.phase')='synthesize' LIMIT 1`)
    .get(invocationRunId,result.callChatId,result.callNodeId,rootChatId,result.targetRef.slice("local:team:".length));
  if (result.callChatId !== rootChatId) return false;
  const localAgent = result.targetRef.startsWith("local:agent:");
  const slug = result.targetRef.split(":").slice(2).join(":"), node = `borrow:${slug}`;
  if (!localAgent && result.callNodeId !== node && !result.callNodeId.startsWith(`${node}:`)) return false;
  return !!getDb().prepare(`SELECT 1 FROM run_events WHERE run_id=? AND chat_id=? AND node_id=?
    AND kind='task_force_model_call_completed' AND json_extract(payload_json,'$.status')='completed'
    AND (? IS NULL OR agent_id=?) LIMIT 1`).get(invocationRunId,result.callChatId,result.callNodeId,
      localAgent ? slug : null, localAgent ? slug : null);
}

/** Read-only canonical proof guard for every Goal completion path. The latest
 * controller episode must include the selected participants, never built-in One. */
export function currentGoalObligationsSatisfied(goalId: string): boolean {
  const goal = getChatGoalRevision(goalId), run = getLongRunByGoalId(goalId);
  if (!goal || !run) return true;
  const obligations = currentGoalExecutionObligations(goal);
  if (!obligations) return true; // Explicit absence/legacy uncertainty is not a new blanket veto.
  if (getChat(goal.chatId)?.goalId !== goalId || getLongRunGoalRevisionBinding(run.id)?.revision !== goal.revision) return false;
  const latest = getDb().prepare(`SELECT a.id,a.invocation_run_id,a.state FROM long_run_worker_attempts a
    JOIN long_run_workers w ON w.id=a.worker_id WHERE a.run_id=? AND w.role='controller' ORDER BY a.rowid DESC LIMIT 1`)
    .get(run.id) as { id: string; invocation_run_id: string; state: string } | undefined;
  if (!latest || latest.state !== "completed" || getLongRunAttemptGoalRevision(run.id, latest.id) !== goal.revision) return false;
  const row = getDb().prepare(`SELECT payload_json FROM long_run_events WHERE run_id=? AND kind='run.execution_obligations_observed'
    AND actor_kind='host' AND json_extract(payload_json,'$.invocationRunId')=? ORDER BY seq DESC LIMIT 1`)
    .get(run.id, latest.invocation_run_id) as { payload_json: string } | undefined;
  let evidence: GoalObligationExecutionEvidence;
  try { evidence = JSON.parse(row?.payload_json ?? "null"); } catch { return false; }
  return !!evidence && evidence.goalId === goalId && evidence.goalRevision === goal.revision
    && evidence.invocationRunId === latest.invocation_run_id && goalExecutionObligationsSatisfied(obligations, evidence)
    && evidence.results.every(result => goalCallWitnessResolves(goal.chatId, evidence.invocationRunId, result));
}

export function recordGoalObligationExecution(evidence: GoalObligationExecutionEvidence): boolean {
  const goal = getChatGoalRevision(evidence.goalId), run = getLongRunByGoalId(evidence.goalId);
  if (!goal || !run || goal.revision !== evidence.goalRevision || getChat(goal.chatId)?.goalId !== goal.goalId
    || getLongRunGoalRevisionBinding(run.id)?.revision !== goal.revision || longRunOwnerHold(run.id)
    || ["completed", "failed", "cancelled", "cancelling", "pausing"].includes(run.status)) return false;
  if (!goalExecutionObligationsSatisfied(goal.executionObligations, evidence)) return false;
  if (!evidence.results.every(result => goalCallWitnessResolves(goal.chatId, evidence.invocationRunId, result))) return false;
  appendLongRunEvent({ runId: run.id, kind: "run.execution_obligations_observed", actorKind: "host", payload: evidence });
  return true;
}
