import { createHash, randomUUID } from "node:crypto";
import type { Automation, AutomationWorkspaceMode } from "../shared/types";
import { getDb } from "./store/db";
import { getAutomation } from "./store/automations";
import { getProject } from "./store/projects";
import { getChatGoalRevision } from "./store/chat-goals";
import { recordRunEvent } from "./store/run-events";
import { invocationMatchesGoalRevision } from "./long-run/verification-boundary";
import { getAutomationDefinitionDigest, readCurrentGoalAutomationBinding } from "./long-run/automation-provenance";
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
  /** `detail` is the plain reason a model or owner reads after the code; the code stays the machine-readable cause. */
  constructor(readonly code: string, detail?: string) { super(detail ? `${code}: ${detail}` : code); this.name = "AutomationWorkspaceError"; }
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
  // The Goal's revision is not part of who owns the folder: an amendment moves it while the Goal, its room and its folder stay.
  // Only a Goal that now belongs to another room is not this owner's Goal.
  const revision = getChatGoalRevision(owner.goalId);
  if (revision && revision.chatId !== owner.chatId) return null;
  return row;
}

/**
 * The folder a Goal's room points at, read without asking whether the Goal is still running. A follow-the-Goal automation whose Goal
 * ended, was archived or lost its authority keeps running in the folder it was already following (the room's own folder, or its
 * project's), as a plain automation. That is the same folder it was bound to, so no scope is added; a room or folder that is gone
 * gives no folder at all, which is narrower.
 */
function lastKnownGoalFolder(chatId: string | null): string | null {
  if (!chatId) return null;
  const row = getDb().prepare("SELECT working_folder, project_id FROM chats WHERE id = ?")
    .get(chatId) as { working_folder: string | null; project_id: string | null } | undefined;
  if (!row) return null;
  if (row.working_folder) return row.working_folder;
  return row.project_id ? getProject(row.project_id)?.folderPath ?? null : null;
}

/** The room of the Goal an agent-made automation was bound to by Main's binding receipt. The mutable goal_id column is never read
 * for a folder: a legacy association is a review candidate, not authority over a directory. */
function priorGoalChatId(a: Automation): string | null {
  const bound = getDb().prepare(`SELECT json_extract(e.payload_json, '$.chatId') AS chat_id FROM long_runs r CROSS JOIN long_run_events e
    WHERE e.run_id = r.id AND e.kind = 'goal.automation_provenance_bound'
    AND json_extract(e.payload_json, '$.automationId') = ?
    AND json_extract(e.payload_json, '$.automationCreatedAt') = ? ORDER BY e.occurred_at DESC, e.rowid DESC LIMIT 1`)
    .get(a.id, a.createdAt) as { chat_id: string | null } | undefined;
  return bound?.chat_id ?? null;
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
  }).immediate();
}

function hasPriorGoalBinding(a: Automation): boolean {
  if (a.createdBy !== "agent") return false;
  if (a.goalId) return true;
  // Indexed per run (see readCurrentGoalAutomationBinding); a bare kind filter scanned the log.
  return !!getDb().prepare(`SELECT 1 FROM long_runs r CROSS JOIN long_run_events e
    WHERE e.run_id = r.id AND e.kind = 'goal.automation_provenance_bound'
    AND json_extract(e.payload_json, '$.automationId') = ?
    AND json_extract(e.payload_json, '$.automationCreatedAt') = ? LIMIT 1`).get(a.id, a.createdAt);
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
      // The Goal the owner picked ended, was archived or lost its authority. The automation goes on in the folder it was
      // following (the picked Goal's room, never another Goal's) as a plain automation; it does not stop to ask for a folder.
      goalOwner = null;
      folder = lastKnownGoalFolder(selected?.chatId ?? null);
    } else mode = "follow_goal";
  } else if (!intent) {
    goalOwner = eligibleGoalOwner(a, null);
    if (goalOwner) mode = "follow_goal";
    else if (hasPriorGoalBinding(a)) folder = lastKnownGoalFolder(priorGoalChatId(a));
  }
  if (goalOwner) {
    const source = currentGoalSource(goalOwner);
    if (!source) {
      // The Goal ended between choosing the owner and reading it: same carry, same folder.
      folder = lastKnownGoalFolder(goalOwner.chatId);
      goalOwner = null;
      mode = "standalone";
    } else {
      const project = source.project_id && !source.working_folder ? getProject(source.project_id) : null;
      if (source.project_id && !source.working_folder && !project) throw new AutomationWorkspaceError("automation_workspace_project_unavailable");
      folder = source.working_folder ?? project?.folderPath ?? null;
    }
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
  // The scope is the folder. A Goal that moved on (a new revision, an end) or an edited choice that lands in the same folder is not a
  // change of scope; the capture below already carries the folder when the Goal is gone. Only another folder is.
  const current = captureAutomationWorkspace(a);
  if (!invocationWorkspaceBindingsEqual(snapshot.binding, current.binding)) {
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

/**
 * The latest receipt of one occurrence. SQLite's json_extract throws "malformed JSON" for the whole query when a single stored row
 * of that kind is unreadable, which would stop every occurrence of the automation for one bad record: that row is skipped and the
 * rest are read one by one.
 */
function previousOccurrenceReceipt(automationId: string, occurrenceId: string): { payload_json: string } | undefined {
  try {
    return getDb().prepare(`SELECT payload_json FROM run_events WHERE automation_id = ? AND kind = ?
      AND json_extract(payload_json, '$.occurrenceId') = ? ORDER BY rowid DESC LIMIT 1`)
      .get(automationId, OCCURRENCE_EVENT, occurrenceId) as { payload_json: string } | undefined;
  } catch {
    const rows = getDb().prepare("SELECT payload_json FROM run_events WHERE automation_id = ? AND kind = ? ORDER BY rowid DESC LIMIT 500")
      .all(automationId, OCCURRENCE_EVENT) as Array<{ payload_json: string }>;
    for (const row of rows) {
      try { if ((JSON.parse(row.payload_json) as { occurrenceId?: unknown })?.occurrenceId === occurrenceId) return row; } catch { /* set aside */ }
    }
    return undefined;
  }
}

/** One receipt per logical occurrence, including resumed runs. No per-node/poll ledger amplification. */
export function bindAutomationWorkspaceOccurrence(snapshot: AutomationWorkspaceSnapshot, input: {
  runId: string; occurrenceId: string; unboundResume: boolean;
}): void {
  revalidateAutomationWorkspace(snapshot);
  // A receipt seals the folder an occurrence runs in. `scopeDigest` is the older whole-snapshot digest (mode, Goal revision, intent
  // id); it stays in the receipt so an older build reads it, but it is only compared for a receipt that has no `bindingDigest`.
  const bindingDigest = digest(snapshot.binding);
  const payload = { schemaVersion: "agentlas.automation-workspace-occurrence.v1", occurrenceId: input.occurrenceId,
    scopeDigest: digest({ automationId: snapshot.automationId, automationCreatedAt: snapshot.automationCreatedAt,
      occurrenceId: input.occurrenceId, mode: snapshot.mode, projectId: snapshot.projectId,
      goalOwner: snapshot.goalOwner, intentId: snapshot.intentId, binding: snapshot.binding }), bindingDigest };
  getDb().transaction(() => {
    const previous = previousOccurrenceReceipt(snapshot.automationId, input.occurrenceId);
    let resealed: "legacy-receipt" | "unreadable-receipt" | "unsealed-checkpoint" | undefined;
    if (previous) {
      let raw: Record<string, unknown> | null = null;
      try { raw = JSON.parse(previous.payload_json); } catch { raw = null; }
      const sound = !!raw && typeof raw === "object" && raw.schemaVersion === payload.schemaVersion && raw.occurrenceId === payload.occurrenceId;
      if (sound && typeof raw!.bindingDigest === "string") {
        // The folder this occurrence was sealed with is the folder it continues in. Another folder is the owner's own change.
        if (raw!.bindingDigest !== bindingDigest) throw new AutomationWorkspaceError("automation_workspace_occurrence_changed");
        return;
      }
      if (sound && raw!.scopeDigest === payload.scopeDigest) return;
      // A receipt from before folder sealing whose Goal part moved since, or one that cannot be read: it cannot prove the folder, so
      // this run seals the current one (the one record is set aside, everything else keeps working) and the occurrence continues.
      resealed = sound ? "legacy-receipt" : "unreadable-receipt";
    } else if (input.unboundResume) {
      // An old checkpoint has no sealed workspace authority; the host starts the occurrence on the current folder itself, as the
      // owner's [Start a fresh run] would, instead of stopping to ask. The earlier attempt's effects stay in the run record.
      resealed = "unsealed-checkpoint";
    }
    recordRunEvent({ runId: input.runId, automationId: snapshot.automationId,
      kind: OCCURRENCE_EVENT, sourceEventId: `automation-workspace:${input.occurrenceId}`,
      payload: resealed ? { ...payload, resealed } : payload });
    // IMMEDIATE: this transaction reads first and then writes. A deferred one that reads, loses a race with the daemon's
    // commit and then upgrades to a write fails at once with SQLITE_BUSY_SNAPSHOT ("database is locked"), which busy_timeout
    // cannot wait out. That killed a scheduled occurrence on 2026-10-11 13:20 KST. Taking the write lock first makes the
    // daemon's write wait instead (same fix as recordRunEvent, 0c76d986).
  }).immediate();
}
