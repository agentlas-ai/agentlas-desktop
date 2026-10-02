import { createHash, randomUUID } from "node:crypto";
import type { Automation, AutomationWorkspaceMode } from "../shared/types";
import { getDb } from "./store/db";
import { getAutomation } from "./store/automations";
import { getProject } from "./store/projects";
import { getChatGoalRevision } from "./store/chat-goals";
import { getLongRunGoalRevisionBinding } from "./store/long-runs";
import { recordRunEvent } from "./store/run-events";
import { invocationMatchesGoalRevision } from "./long-run/verification-boundary";
import { getAutomationDefinitionDigest, isCurrentGoalAutomationBinding, readCurrentGoalAutomationBinding } from "./long-run/automation-provenance";
import { captureAutomationInvocationBinding, invocationWorkspaceBindingsEqual, revalidateInvocationWorkspaceBinding, type InvocationWorkspaceBinding } from "./invocation/workspace-binding";

const INTENT_EVENT = "automation_workspace_intent";
const SOURCE_EVENT = "automation_workspace_source";
const OCCURRENCE_EVENT = "automation_workspace_bound";

interface GoalOwner {
  goalId: string;
  chatId: string;
  revision: number | null;
  authority: "ongoing" | "legacy" | "owner";
}
interface WorkspaceIntent {
  schemaVersion: "agentlas.automation-workspace-intent.v1";
  automationCreatedAt: string;
  mode: AutomationWorkspaceMode;
  projectId: string | null;
  goalOwner: GoalOwner | null;
  definitionDigest: string | null;
}
interface IntentReceipt { id: string; value: WorkspaceIntent }

/** Main-only snapshot. Invocation capability and directory identity never enter shared DTOs. */
export interface AutomationWorkspaceSnapshot {
  automationId: string;
  automationCreatedAt: string;
  mode: AutomationWorkspaceMode;
  projectId: string | null;
  goalOwner: GoalOwner | null;
  intentId: string | null;
  binding: InvocationWorkspaceBinding;
}

function isMode(value: unknown): value is AutomationWorkspaceMode {
  return value === "follow_goal" || value === "project" || value === "standalone";
}
export class AutomationWorkspaceError extends Error {
  constructor(readonly code: string) { super(code); this.name = "AutomationWorkspaceError"; }
}

export function automationWorkspaceOwnerText(error: AutomationWorkspaceError, locale: string): string {
  if (error.code === "automation_workspace_reconciliation_required" || error.code === "automation_workspace_occurrence_changed") {
    return locale === "ko"
      ? "이전 실행의 작업 범위를 확인할 수 없거나 범위가 바뀌어 이어서 실행을 멈췄습니다. 실행 기록에서 외부 반영 여부를 확인·조정하고, 작업 범위를 선택한 뒤 [처음부터 새 실행]을 누르세요."
      : "Continuation stopped because the previous workspace is unverified or changed. Review and reconcile external effects in the run history, choose the workspace, then select [Start a fresh run].";
  }
  const scope = error.code === "automation_workspace_folder_unavailable" || error.code === "automation_workspace_project_unavailable";
  return locale === "ko"
    ? scope ? "자동화의 작업 폴더 또는 프로젝트를 찾을 수 없어 실행을 멈췄습니다. 자동화 편집에서 작업 범위를 다시 선택한 뒤 실행하세요."
      : "자동화의 작업 범위 권한을 확인할 수 없어 실행을 멈췄습니다. 이전 실행의 반영 여부와 Goal을 확인하고 자동화 편집에서 작업 범위를 다시 선택한 뒤 실행하세요."
    : scope ? "The automation stopped because its working folder or project is unavailable. Reselect its workspace in the automation editor, then run it again."
      : "The automation stopped because its workspace authority could not be verified. Review the previous run and Goal, then reselect its workspace in the automation editor before running again.";
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function nullableString(value: unknown): value is string | null | undefined {
  return value == null || typeof value === "string" && value.length > 0 && value.length <= 512;
}
/** run_events adds an envelope, omits nulls and stringifies objects. Store only
 * closed scalar fields and a digest; decoding projects only our own fields. */
function intentPayload(value: WorkspaceIntent): Record<string, unknown> {
  return { schemaVersion: value.schemaVersion, automationCreatedAt: value.automationCreatedAt,
    mode: value.mode, projectId: value.projectId, ownerGoalId: value.goalOwner?.goalId,
    ownerChatId: value.goalOwner?.chatId, ownerRevision: value.goalOwner?.revision,
    ownerAuthority: value.goalOwner?.authority, definitionDigest: value.definitionDigest,
    intentDigest: digest(value) };
}
function readIntent(a: Automation, kind = INTENT_EVENT): IntentReceipt | null {
  const row = getDb().prepare(`SELECT id, payload_json FROM run_events
    WHERE automation_id = ? AND kind = ? ORDER BY rowid DESC LIMIT 1`)
    .get(a.id, kind) as { id: string; payload_json: string } | undefined;
  if (!row) return null;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(row.payload_json); } catch { throw new AutomationWorkspaceError("automation_workspace_intent_invalid"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AutomationWorkspaceError("automation_workspace_intent_invalid");
  if (raw.automationCreatedAt !== a.createdAt) return null;
  const hasOwner = raw.ownerGoalId != null || raw.ownerChatId != null || raw.ownerRevision != null || raw.ownerAuthority != null;
  if (raw.schemaVersion !== "agentlas.automation-workspace-intent.v1" || !isMode(raw.mode)
    || !nullableString(raw.projectId) || !nullableString(raw.definitionDigest)
    || hasOwner && (typeof raw.ownerGoalId !== "string" || !nullableString(raw.ownerGoalId)
      || typeof raw.ownerChatId !== "string" || !nullableString(raw.ownerChatId)
      || !(raw.ownerRevision == null || Number.isSafeInteger(raw.ownerRevision) && Number(raw.ownerRevision) > 0)
      || !["ongoing", "legacy", "owner"].includes(String(raw.ownerAuthority)))) {
    throw new AutomationWorkspaceError("automation_workspace_intent_invalid");
  }
  const value: WorkspaceIntent = { schemaVersion: "agentlas.automation-workspace-intent.v1",
    automationCreatedAt: a.createdAt, mode: raw.mode, projectId: raw.projectId as string ?? null,
    goalOwner: hasOwner ? { goalId: raw.ownerGoalId as string, chatId: raw.ownerChatId as string,
      revision: raw.ownerRevision as number ?? null, authority: raw.ownerAuthority as GoalOwner["authority"] } : null,
    definitionDigest: raw.definitionDigest as string ?? null };
  if (raw.intentDigest !== digest(value)) throw new AutomationWorkspaceError("automation_workspace_intent_invalid");
  return { id: row.id, value };
}

/** Raw reads avoid getChat's Task-repair writes. Goal/source identity, never monitor or prompt, owns inheritance. */
function currentGoalSource(owner: GoalOwner): { working_folder: string | null; project_id: string | null } | null {
  const row = getDb().prepare(`SELECT ch.working_folder, ch.project_id, ch.goal_id, ch.origin_surface,
      c.status, c.objective, r.id AS run_id, r.surface, r.status AS run_status
    FROM chats ch JOIN chat_goal_contracts c ON c.chat_id = ch.id AND c.goal_id = ch.goal_id
    JOIN long_runs r ON r.goal_id = c.goal_id AND r.root_chat_id = ch.id
    WHERE ch.id = ? AND c.goal_id = ? AND ch.archived_at IS NULL LIMIT 1`)
    .get(owner.chatId, owner.goalId) as {
      working_folder: string | null; project_id: string | null; goal_id: string; origin_surface: string;
      status: string; objective: string | null; run_id: string; surface: string; run_status: string;
    } | undefined;
  if (!row || row.status !== "active" || !row.objective?.trim()
    || (row.surface !== "one" && row.surface !== "work") || row.origin_surface !== row.surface
    || row.run_status === "completed" || row.run_status === "cancelled") return null;
  const revision = getChatGoalRevision(owner.goalId);
  if ((revision?.revision ?? null) !== owner.revision || revision && revision.chatId !== owner.chatId) return null;
  if (revision && getLongRunGoalRevisionBinding(row.run_id)?.revision !== revision.revision) return null;
  return row;
}

function eligibleGoalOwner(a: Automation, intent: IntentReceipt | null): GoalOwner | null {
  // An explicit prior owner selection may retain its verified source for a later
  // selector change. Retaining metadata is not execution authority by itself.
  const retained = intent?.value.goalOwner;
  if (retained && currentGoalSource(retained)) return { ...retained, authority: "owner" };
  const sourceReceipt = readIntent(a, SOURCE_EVENT);
  if (sourceReceipt?.value.goalOwner && sourceReceipt.value.definitionDigest === getAutomationDefinitionDigest(a.id)
    && currentGoalSource(sourceReceipt.value.goalOwner)) return sourceReceipt.value.goalOwner;
  if (a.createdBy !== "agent") return null;
  const ongoing = readCurrentGoalAutomationBinding(a.id);
  if (ongoing) {
    const owner: GoalOwner = { goalId: ongoing.goalId, chatId: ongoing.chatId, revision: ongoing.goalRevision, authority: "ongoing" };
    if (!currentGoalSource(owner)) return null;
    if (retained && (retained.goalId !== owner.goalId || retained.chatId !== owner.chatId)) return null;
    return retained ? { ...owner, authority: "owner" } : owner;
  }
  return null;
}

/** A mutable legacy association is a review candidate, never inherited authority. */
function legacyGoalCandidate(a: Automation): { owner: GoalOwner; label: string } | null {
  if (a.createdBy !== "agent" || !a.goalId) return null;
  const contract = getDb().prepare("SELECT chat_id FROM chat_goal_contracts WHERE goal_id = ? LIMIT 1")
    .get(a.goalId) as { chat_id: string } | undefined;
  const revision = getChatGoalRevision(a.goalId);
  if (!contract || revision?.lifecycle === "ongoing") return null;
  const owner: GoalOwner = { goalId: a.goalId, chatId: contract.chat_id, revision: revision?.revision ?? null, authority: "owner" };
  if (!currentGoalSource(owner)) return null;
  const chat = getDb().prepare("SELECT title FROM chats WHERE id = ?").get(owner.chatId) as { title: string | null } | undefined;
  return { owner, label: chat?.title?.trim() || a.goalId };
}

/** Only trusted Main's fresh finite-Goal continuation creation may call this.
 * Existing mutable goal_id rows cannot be auto-adopted. One receipt at creation. */
export function bindCreatedGoalContinuationWorkspace(input: {
  automationId: string; goalId: string; sourceChatId: string; invocationRunId: string;
}): void {
  getDb().transaction(() => {
    const a = getAutomation(input.automationId);
    const revision = getChatGoalRevision(input.goalId);
    const owner: GoalOwner = { goalId: input.goalId, chatId: input.sourceChatId,
      revision: revision?.revision ?? null, authority: "legacy" };
    const started = getDb().prepare(`SELECT ts FROM run_events WHERE run_id = ? AND chat_id = ?
      AND kind = 'invoke_started' ORDER BY seq ASC LIMIT 1`).get(input.invocationRunId, input.sourceChatId) as { ts: string } | undefined;
    if (!a || a.createdBy !== "agent" || a.goalId !== input.goalId || !currentGoalSource(owner)
      || revision && !invocationMatchesGoalRevision(input.invocationRunId, input.goalId, revision.revision)
      || !started || !Number.isFinite(Date.parse(started.ts)) || !Number.isFinite(Date.parse(a.createdAt))
      || Date.parse(a.createdAt) < Date.parse(started.ts)) {
      throw new AutomationWorkspaceError("automation_workspace_creation_source_unverified");
    }
    const value: WorkspaceIntent = { schemaVersion: "agentlas.automation-workspace-intent.v1", automationCreatedAt: a.createdAt,
      mode: "follow_goal", projectId: a.projectId ?? null, goalOwner: owner,
      definitionDigest: getAutomationDefinitionDigest(a.id) };
    const prior = readIntent(a, SOURCE_EVENT);
    if (prior) {
      if (JSON.stringify(prior.value) !== JSON.stringify(value)) throw new AutomationWorkspaceError("automation_workspace_creation_source_unverified");
      return;
    }
    recordRunEvent({ runId: input.invocationRunId, automationId: a.id, kind: SOURCE_EVENT,
      sourceEventId: `automation-workspace-source:${a.id}`, payload: intentPayload(value) });
  })();
}

function hasPriorGoalBinding(a: Automation): boolean {
  if (a.createdBy !== "agent") return false;
  if (a.goalId) return true;
  return !!getDb().prepare(`SELECT 1 FROM long_run_events WHERE kind = 'goal.automation_provenance_bound'
    AND json_extract(payload_json, '$.automationId') = ?
    AND json_extract(payload_json, '$.automationCreatedAt') = ? LIMIT 1`).get(a.id, a.createdAt);
}

export function automationWorkspaceView(a: Automation): Automation {
  const intent = readIntent(a);
  const goal = eligibleGoalOwner(a, intent);
  const candidate = goal ? { owner: goal, label: (getDb().prepare("SELECT title FROM chats WHERE id = ?").get(goal.chatId) as { title: string | null } | undefined)?.title || goal.goalId } : legacyGoalCandidate(a);
  const needsReview = !a.projectId && !goal && (intent?.value.mode === "follow_goal" || !intent && hasPriorGoalBinding(a));
  return { ...a, workspaceMode: a.projectId ? "project" : intent?.value.mode === "follow_goal"
    ? "follow_goal" : intent ? "standalone" : goal || needsReview ? "follow_goal" : "standalone",
    workspaceNeedsReview: needsReview, workspaceCanFollowGoal: !!candidate,
    ...(candidate ? { workspaceGoalCandidate: { goalId: candidate.owner.goalId, label: candidate.label } } : {}) };
}

export function captureAutomationWorkspace(a: Automation): AutomationWorkspaceSnapshot {
  const intent = readIntent(a);
  let mode: AutomationWorkspaceMode = "standalone";
  let goalOwner: GoalOwner | null = null;
  let folder: string | null = null;
  if (a.projectId) {
    mode = "project";
    const project = getProject(a.projectId);
    if (!project) throw new AutomationWorkspaceError("automation_workspace_project_unavailable");
    folder = project.folderPath ?? null;
  } else if (intent?.value.mode === "follow_goal") {
    goalOwner = eligibleGoalOwner(a, intent);
    const selected = intent.value.goalOwner;
    if (!goalOwner || !selected || goalOwner.goalId !== selected.goalId || goalOwner.chatId !== selected.chatId) {
      throw new AutomationWorkspaceError("automation_workspace_goal_authority_changed");
    }
    mode = "follow_goal";
  } else if (!intent) {
    goalOwner = eligibleGoalOwner(a, null);
    if (goalOwner) mode = "follow_goal";
    else if (hasPriorGoalBinding(a)) throw new AutomationWorkspaceError("automation_workspace_goal_authority_changed");
  }
  if (goalOwner) {
    const source = currentGoalSource(goalOwner);
    if (!source) throw new AutomationWorkspaceError("automation_workspace_goal_authority_changed");
    const project = source.project_id && !source.working_folder ? getProject(source.project_id) : null;
    if (source.project_id && !source.working_folder && !project) throw new AutomationWorkspaceError("automation_workspace_project_unavailable");
    folder = source.working_folder ?? project?.folderPath ?? null;
  }
  let binding: InvocationWorkspaceBinding;
  try { binding = captureAutomationInvocationBinding(folder); }
  catch { throw new AutomationWorkspaceError("automation_workspace_folder_unavailable"); }
  return Object.freeze({ automationId: a.id, automationCreatedAt: a.createdAt, mode,
    projectId: a.projectId ?? null, goalOwner, intentId: intent?.id ?? null,
    binding });
}

/** Read-only per-node check. Never writes intent or receipt rows. */
export function revalidateAutomationWorkspace(snapshot: AutomationWorkspaceSnapshot): void {
  const a = getAutomation(snapshot.automationId);
  if (!a || a.createdAt !== snapshot.automationCreatedAt) throw new AutomationWorkspaceError("automation_workspace_owner_changed");
  if (snapshot.goalOwner?.authority === "ongoing" && !isCurrentGoalAutomationBinding({
    automationId: a.id, goalId: snapshot.goalOwner.goalId, chatId: snapshot.goalOwner.chatId,
    expectedGoalRevision: snapshot.goalOwner.revision!,
  })) throw new AutomationWorkspaceError("automation_workspace_goal_authority_changed");
  const current = captureAutomationWorkspace(a);
  if (snapshot.mode !== current.mode || snapshot.projectId !== current.projectId || snapshot.intentId !== current.intentId
    || JSON.stringify(snapshot.goalOwner) !== JSON.stringify(current.goalOwner)
    || !invocationWorkspaceBindingsEqual(snapshot.binding, current.binding)) {
    throw new AutomationWorkspaceError("automation_workspace_scope_changed");
  }
  try { revalidateInvocationWorkspaceBinding(snapshot.binding); }
  catch { throw new AutomationWorkspaceError("automation_workspace_folder_unavailable"); }
}

/** Owner API mutation and explicit choice share a transaction. Omitted mode preserves intent. */
export function withOwnerAutomationWorkspaceIntent(
  mode: unknown, before: Automation | null, mutate: () => Automation, requestedGoalId?: unknown,
): Automation {
  if (mode !== undefined && !isMode(mode)) throw new AutomationWorkspaceError("automation_workspace_mode_invalid");
  return getDb().transaction(() => {
    const priorIntent = before ? readIntent(before) : null;
    let source = before ? eligibleGoalOwner(before, priorIntent) : null;
    if (requestedGoalId !== undefined && (mode !== "follow_goal" || typeof requestedGoalId !== "string")) {
      throw new AutomationWorkspaceError("automation_workspace_goal_choice_invalid");
    }
    if (mode === "follow_goal" && requestedGoalId !== undefined) {
      const candidate = before && legacyGoalCandidate(before);
      source = source?.goalId === requestedGoalId ? source : candidate?.owner.goalId === requestedGoalId ? candidate.owner : null;
    }
    if (mode === "follow_goal" && !source) throw new AutomationWorkspaceError("automation_workspace_goal_authority_unavailable");
    const a = mutate();
    if (mode === undefined) return a;
    if ((mode === "project") !== !!a.projectId) throw new AutomationWorkspaceError("automation_workspace_project_choice_mismatch");
    const value: WorkspaceIntent = { schemaVersion: "agentlas.automation-workspace-intent.v1",
      automationCreatedAt: a.createdAt, mode, projectId: a.projectId ?? null,
      goalOwner: mode !== "follow_goal" && priorIntent?.value.mode === mode && priorIntent.value.projectId === (a.projectId ?? null)
        ? priorIntent.value.goalOwner : source ? { ...source, authority: "owner" } : null,
      definitionDigest: null };
    if (!priorIntent || JSON.stringify(priorIntent.value) !== JSON.stringify(value)) {
      recordRunEvent({ runId: `automation-workspace-intent-${a.id}-${randomUUID()}`, automationId: a.id,
        kind: INTENT_EVENT, payload: intentPayload(value) });
    }
    return a;
  })();
}

/** One receipt per logical occurrence, including resumed runs. No per-node/poll ledger amplification. */
export function bindAutomationWorkspaceOccurrence(snapshot: AutomationWorkspaceSnapshot, input: {
  runId: string; occurrenceId: string; unboundResume: boolean;
}): void {
  revalidateAutomationWorkspace(snapshot);
  const payload = { schemaVersion: "agentlas.automation-workspace-occurrence.v1", occurrenceId: input.occurrenceId,
    scopeDigest: digest({ automationId: snapshot.automationId, automationCreatedAt: snapshot.automationCreatedAt,
      occurrenceId: input.occurrenceId, mode: snapshot.mode, projectId: snapshot.projectId,
      goalOwner: snapshot.goalOwner, intentId: snapshot.intentId, binding: snapshot.binding }) };
  getDb().transaction(() => {
    const previous = getDb().prepare(`SELECT payload_json FROM run_events WHERE automation_id = ? AND kind = ?
      AND json_extract(payload_json, '$.occurrenceId') = ? ORDER BY rowid DESC LIMIT 1`)
      .get(snapshot.automationId, OCCURRENCE_EVENT, input.occurrenceId) as { payload_json: string } | undefined;
    if (previous) {
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(previous.payload_json); } catch { throw new AutomationWorkspaceError("automation_workspace_occurrence_changed"); }
      if (!raw || raw.schemaVersion !== payload.schemaVersion || raw.occurrenceId !== payload.occurrenceId
        || raw.scopeDigest !== payload.scopeDigest) throw new AutomationWorkspaceError("automation_workspace_occurrence_changed");
      return;
    }
    // An old checkpoint has no sealed workspace authority. Missing tool rows
    // or settled effects cannot prove which cwd it used. Never retrofit scope.
    if (input.unboundResume) throw new AutomationWorkspaceError("automation_workspace_reconciliation_required");
    recordRunEvent({ runId: input.runId, automationId: snapshot.automationId,
      kind: OCCURRENCE_EVENT, sourceEventId: `automation-workspace:${input.occurrenceId}`, payload });
  })();
}
