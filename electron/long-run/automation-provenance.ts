import { createHash } from "node:crypto";
import { getDb } from "../store/db";
import { getAutomation } from "../store/automations";
import { getChatGoalContract, getChatGoalRevision } from "../store/chat-goals";
import { appendLongRunEvent, getLongRunByGoalId, getLongRunGoalRevisionBinding } from "../store/long-runs";
import { invocationMatchesGoalRevision } from "./verification-boundary";
import type { GoalAutomationObservation } from "../../shared/runtime-plan";
import { graphExecutionDigest } from "../../shared/graph-execution-digest";

const BINDING_KIND = "goal.automation_provenance_bound";
const MAX_BINDINGS_READ = 24;
const MAX_OBSERVATIONS = 2;

interface AutomationDefinitionRow {
  id: string; created_at: string; created_by: string; goal_id: string | null;
  prompt_template: string; graph_json: string | null; target_type: string; target_id: string;
  project_id: string | null; runtime_selection_json: string | null;
  schedule: string; schedule_json: string | null; timezone: string | null;
  trigger_type: string | null; trigger_json: string | null;
}

interface BindingReceipt {
  schemaVersion: "agentlas.goal-automation-provenance.v1";
  goalId: string; goalRevision: number; chatId: string; invocationRunId: string;
  automationId: string; automationCreatedAt: string; definitionDigest: string; graphDigest: string | null;
  /** A later Goal revision may carry this explicit human authority. */
  amendmentMessageId?: string;
  amendmentProposalId?: string;
  amendmentProposalInputDigest?: string;
}

/** Main-only snapshot of a currently valid Goal-created automation bridge. */
export interface CurrentGoalAutomationBinding {
  goalId: string;
  goalRevision: number;
  chatId: string;
  invocationRunId: string;
  automationId: string;
  automationCreatedAt: string;
  definitionDigest: string;
  graphDigest: string | null;
  longRunId: string;
  amendmentMessageId?: string;
  amendmentProposalId?: string;
  amendmentProposalInputDigest?: string;
}

function definition(automationId: string): AutomationDefinitionRow | null {
  return getDb().prepare(`SELECT id, created_at, created_by, goal_id, prompt_template, graph_json,
    target_type, target_id, project_id, runtime_selection_json, schedule, schedule_json,
    timezone, trigger_type, trigger_json FROM automations WHERE id = ?`)
    .get(automationId) as AutomationDefinitionRow | undefined ?? null;
}

/** Do not use getChat() for a provenance read: its projection may repair the
 * canonical Task and therefore write to the store. These three raw columns
 * are sufficient for the exact owner check. */
function chatBinding(chatId: string): { id: string; goal_id: string | null; origin_surface: string } | null {
  return getDb().prepare("SELECT id, goal_id, origin_surface FROM chats WHERE id = ?")
    .get(chatId) as { id: string; goal_id: string | null; origin_surface: string } | undefined ?? null;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function definitionDigest(row: AutomationDefinitionRow): string {
  // Scheduler-owned last_run/next_run/enabled are intentionally excluded. A
  // changed task, target, runtime, trigger, or schedule invalidates the link.
  return digest({ createdAt: row.created_at, goalId: row.goal_id,
    prompt: row.prompt_template, graph: row.graph_json, targetType: row.target_type,
    targetId: row.target_id, projectId: row.project_id, runtime: row.runtime_selection_json,
    schedule: row.schedule, scheduleSpec: row.schedule_json, timezone: row.timezone,
    triggerType: row.trigger_type, trigger: row.trigger_json });
}

/**
 * Read-only definition token for a caller that wants to perform an exact
 * optimistic-concurrency check before changing an automation.  Keep this
 * beside the Goal provenance digest so the two paths cannot silently drift.
 */
export function getAutomationDefinitionDigest(automationId: string): string | null {
  const row = definition(automationId);
  return row ? definitionDigest(row) : null;
}

function runGraphDigest(automationId: string): string | null {
  // getAutomation is a SELECT + pure projection; unlike getChat it does not
  // materialize Tasks. Use the same execution digest as the graph runner.
  const automation = getAutomation(automationId);
  return automation?.graph ? graphExecutionDigest(automation, automation.graph) : null;
}

function currentGoal(goalId: string, expectedGoalRevision: number, chatId: string, invocationRunId: string): {
  runId: string;
} | null {
  const goal = getChatGoalRevision(goalId);
  const contract = getChatGoalContract(goalId);
  const run = getLongRunByGoalId(goalId);
  const chat = chatBinding(chatId);
  if (!goal || goal.revision !== expectedGoalRevision || goal.lifecycle !== "ongoing"
    || goal.chatId !== chatId || contract?.status !== "active" || !run || run.surface === "science"
    || run.rootChatId !== chatId || getLongRunGoalRevisionBinding(run.id)?.revision !== expectedGoalRevision
    || !chat || chat.goal_id !== goalId || chat.origin_surface !== run.surface
    || !invocationMatchesGoalRevision(invocationRunId, goalId, expectedGoalRevision)) return null;
  return { runId: run.id };
}

/**
 * An explicit user amendment can authorize the same Goal-owned automation to
 * continue under a new revision.  It does not relabel an old attempt: the
 * long-run binding and the source message must already point at the new
 * revision, and the amendment metadata must match the Goal revision exactly.
 */
function currentGoalForAmendment(input: {
  goalId: string; expectedGoalRevision: number; chatId: string;
  amendmentMessageId: string; amendmentProposalId: string; amendmentProposalInputDigest: string;
}): { runId: string } | null {
  const goal = getChatGoalRevision(input.goalId);
  const contract = getChatGoalContract(input.goalId);
  const run = getLongRunByGoalId(input.goalId);
  const chat = chatBinding(input.chatId);
  const source = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?")
    .get(input.amendmentMessageId) as { chat_id: string; role: string; text: string } | undefined;
  const amendment = goal?.amendment;
  if (!goal || goal.revision !== input.expectedGoalRevision || goal.lifecycle !== "ongoing"
    || goal.chatId !== input.chatId || contract?.status !== "active" || !run || run.surface === "science"
    || run.rootChatId !== input.chatId || getLongRunGoalRevisionBinding(run.id)?.revision !== input.expectedGoalRevision
    || !chat || chat.goal_id !== input.goalId || chat.origin_surface !== run.surface
    || goal.sourceMessage.messageId !== input.amendmentMessageId
    || amendment?.kind !== "automation_strategy"
    || amendment.proposalId !== input.amendmentProposalId
    || amendment.proposalInputDigest !== input.amendmentProposalInputDigest
    || !source || source.chat_id !== input.chatId || source.role !== "user"
    || source.text !== goal.sourceMessage.text) return null;
  return { runId: run.id };
}

/** Only a newly created automation from this exact Goal invocation can acquire
 * this bridge. Legacy goal_id and a matching prompt/name never grant ownership. */
export function bindCreatedAutomationToOngoingGoal(input: {
  goalId: string; expectedGoalRevision: number; chatId: string;
  invocationRunId: string; automationId: string;
}): BindingReceipt {
  if (!input.goalId || !input.chatId || !input.invocationRunId || !input.automationId
    || !Number.isSafeInteger(input.expectedGoalRevision) || input.expectedGoalRevision < 1
    || [input.goalId, input.chatId, input.invocationRunId, input.automationId].some(value => value.length > 512)) {
    throw new Error("goal_automation_binding_identity_invalid");
  }
  return getDb().transaction(() => {
    const owner = currentGoal(input.goalId, input.expectedGoalRevision, input.chatId, input.invocationRunId);
    const row = definition(input.automationId);
    const started = getDb().prepare(`SELECT ts FROM run_events WHERE run_id = ? AND chat_id = ?
      AND kind = 'invoke_started' ORDER BY seq ASC LIMIT 1`).get(input.invocationRunId, input.chatId) as
      { ts: string } | undefined;
    if (!owner || !row || row.created_by !== "agent" || row.goal_id != null
      || !started || !Number.isFinite(Date.parse(started.ts))
      || !Number.isFinite(Date.parse(row.created_at))
      || Date.parse(row.created_at) < Date.parse(started.ts)) {
      throw new Error("goal_automation_binding_source_unverified");
    }
    const receipt: BindingReceipt = {
      schemaVersion: "agentlas.goal-automation-provenance.v1",
      goalId: input.goalId, goalRevision: input.expectedGoalRevision,
      chatId: input.chatId, invocationRunId: input.invocationRunId,
      automationId: row.id, automationCreatedAt: row.created_at,
      definitionDigest: definitionDigest(row),
      graphDigest: runGraphDigest(row.id),
    };
    appendLongRunEvent({ runId: owner.runId, kind: BINDING_KIND, actorKind: "host", payload: receipt });
    return receipt;
  })();
}

function parseBinding(raw: string): BindingReceipt | null {
  try {
    const value = JSON.parse(raw) as Partial<BindingReceipt>;
    if (value.schemaVersion !== "agentlas.goal-automation-provenance.v1"
      || typeof value.goalId !== "string" || typeof value.chatId !== "string"
      || typeof value.invocationRunId !== "string" || typeof value.automationId !== "string"
      || typeof value.automationCreatedAt !== "string"
      || !Number.isSafeInteger(value.goalRevision) || typeof value.definitionDigest !== "string"
      || !/^[a-f0-9]{64}$/.test(value.definitionDigest)
      || !(value.graphDigest === null || typeof value.graphDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.graphDigest))
      || ((value.amendmentMessageId !== undefined || value.amendmentProposalId !== undefined || value.amendmentProposalInputDigest !== undefined)
        && (typeof value.amendmentMessageId !== "string" || !value.amendmentMessageId.trim()
          || typeof value.amendmentProposalId !== "string" || !value.amendmentProposalId.trim()
          || typeof value.amendmentProposalInputDigest !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(value.amendmentProposalInputDigest)))) return null;
    return value as BindingReceipt;
  } catch { return null; }
}

function bindingCurrent(binding: BindingReceipt, goalId: string, goalRevision: number, chatId: string): boolean {
  const automation = definition(binding.automationId);
  const authority = binding.amendmentMessageId && binding.amendmentProposalId && binding.amendmentProposalInputDigest
    ? currentGoalForAmendment({ goalId, expectedGoalRevision: goalRevision, chatId,
      amendmentMessageId: binding.amendmentMessageId,
      amendmentProposalId: binding.amendmentProposalId,
      amendmentProposalInputDigest: binding.amendmentProposalInputDigest })
    : currentGoal(goalId, goalRevision, chatId, binding.invocationRunId);
  return binding.goalId === goalId && binding.goalRevision === goalRevision && binding.chatId === chatId
    && Boolean(authority)
    && automation?.created_at === binding.automationCreatedAt
    && automation.created_by === "agent" && automation.goal_id === null
    && definitionDigest(automation) === binding.definitionDigest
    && runGraphDigest(binding.automationId) === binding.graphDigest;
}

/**
 * Resolve the durable Goal bridge without inferring ownership from
 * automations.goal_id, name, prompt, or a matching graph.  This is used by
 * strategy review/apply to keep a Goal-created automation bound after a
 * prompt-only revision changes its definition digest.
 */
export function readCurrentGoalAutomationBinding(
  automationId: string,
): CurrentGoalAutomationBinding | null {
  const normalized = automationId.trim();
  if (!normalized) return null;
  const runRows = getDb().prepare(`SELECT run_id, payload_json FROM long_run_events
    WHERE kind = ? ORDER BY occurred_at DESC, rowid DESC LIMIT ?`)
    .all(BINDING_KIND, MAX_BINDINGS_READ * 4) as Array<{ run_id: string; payload_json: string }>;
  for (const row of runRows) {
    const binding = parseBinding(row.payload_json);
    if (!binding || binding.automationId !== normalized) continue;
    if (!isCurrentGoalAutomationBinding({
      goalId: binding.goalId,
      expectedGoalRevision: binding.goalRevision,
      chatId: binding.chatId,
      automationId: normalized,
    })) continue;
    return { ...binding, longRunId: row.run_id };
  }
  return null;
}

/**
 * Append the new digest to the same durable Goal bridge after a validated
 * graph revision.  The caller invokes this inside its SQLite transaction, so
 * a provenance failure rolls the graph and revision event back as one unit.
 */
export function appendGoalAutomationRevisionBinding(input: {
  binding: CurrentGoalAutomationBinding;
  definitionDigest: string;
  graphDigest: string | null;
  sourceEventId: string;
}): void {
  if (!/^[a-f0-9]{64}$/.test(input.definitionDigest)
    || (input.graphDigest !== null && !/^sha256:[a-f0-9]{64}$/.test(input.graphDigest))) {
    throw new Error("goal_automation_binding_digest_invalid");
  }
  appendLongRunEvent({
    runId: input.binding.longRunId,
    kind: BINDING_KIND,
    actorKind: "host",
    sourceEventId: input.sourceEventId,
    payload: {
      schemaVersion: "agentlas.goal-automation-provenance.v1",
      goalId: input.binding.goalId,
      goalRevision: input.binding.goalRevision,
      chatId: input.binding.chatId,
      invocationRunId: input.binding.invocationRunId,
      automationId: input.binding.automationId,
      automationCreatedAt: input.binding.automationCreatedAt,
      definitionDigest: input.definitionDigest,
      graphDigest: input.graphDigest,
      ...(input.binding.amendmentMessageId ? { amendmentMessageId: input.binding.amendmentMessageId } : {}),
      ...(input.binding.amendmentProposalId ? { amendmentProposalId: input.binding.amendmentProposalId } : {}),
      ...(input.binding.amendmentProposalInputDigest ? { amendmentProposalInputDigest: input.binding.amendmentProposalInputDigest } : {}),
    },
  });
}

/**
 * Rebind a Goal-owned automation after an explicit user amendment.  This is
 * an authority receipt only; no provider invocation or external effect is
 * started.  The caller must already have advanced the Goal and long-run
 * revision inside the same SQLite transaction.
 */
export function appendGoalAutomationAmendmentBinding(input: {
  binding: CurrentGoalAutomationBinding;
  goalRevision: number;
  amendmentMessageId: string;
  proposalId: string;
  proposalInputDigest: string;
  sourceEventId: string;
}): CurrentGoalAutomationBinding {
  if (!Number.isSafeInteger(input.goalRevision) || input.goalRevision < 1
    || !input.amendmentMessageId.trim() || !input.proposalId.trim()
    || !/^sha256:[a-f0-9]{64}$/i.test(input.proposalInputDigest)) {
    throw new Error("goal_automation_amendment_binding_invalid");
  }
  const authority = currentGoalForAmendment({
    goalId: input.binding.goalId,
    expectedGoalRevision: input.goalRevision,
    chatId: input.binding.chatId,
    amendmentMessageId: input.amendmentMessageId,
    amendmentProposalId: input.proposalId,
    amendmentProposalInputDigest: input.proposalInputDigest,
  });
  const row = definition(input.binding.automationId);
  if (!authority || !row || row.created_by !== "agent" || row.goal_id !== null
    || definitionDigest(row) !== input.binding.definitionDigest
    || runGraphDigest(input.binding.automationId) !== input.binding.graphDigest) {
    throw new Error("goal_automation_amendment_binding_stale");
  }
  const next: CurrentGoalAutomationBinding = {
    ...input.binding,
    goalRevision: input.goalRevision,
    amendmentMessageId: input.amendmentMessageId,
    amendmentProposalId: input.proposalId,
    amendmentProposalInputDigest: input.proposalInputDigest,
  };
  appendLongRunEvent({
    runId: authority.runId,
    kind: BINDING_KIND,
    actorKind: "host",
    sourceEventId: input.sourceEventId,
    payload: {
      schemaVersion: "agentlas.goal-automation-provenance.v1",
      goalId: next.goalId,
      goalRevision: next.goalRevision,
      chatId: next.chatId,
      invocationRunId: next.invocationRunId,
      automationId: next.automationId,
      automationCreatedAt: next.automationCreatedAt,
      definitionDigest: next.definitionDigest,
      graphDigest: next.graphDigest,
      amendmentMessageId: next.amendmentMessageId,
      amendmentProposalId: next.amendmentProposalId,
      amendmentProposalInputDigest: next.amendmentProposalInputDigest,
    },
  });
  return next;
}

/** Exact, bounded lookup for Main's Goal-vs-independent automation label. */
export function isCurrentGoalAutomationBinding(input: {
  goalId: string; expectedGoalRevision: number; chatId: string; automationId: string;
}): boolean {
  if (!input.goalId || !input.chatId || !input.automationId) return false;
  const run = getLongRunByGoalId(input.goalId);
  if (!run || run.rootChatId !== input.chatId) return false;
  const rows = getDb().prepare(`SELECT payload_json FROM long_run_events
    WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT ?`)
    .all(run.id, BINDING_KIND, MAX_BINDINGS_READ) as Array<{ payload_json: string }>;
  for (const row of rows) {
    const binding = parseBinding(row.payload_json);
    if (binding?.automationId === input.automationId) {
      return bindingCurrent(binding, input.goalId, input.expectedGoalRevision, input.chatId);
    }
  }
  return false;
}

/** Bounded, read-only projection. An automation's terminal row is execution
 * evidence only: no effect or domain KPI can be inferred from status, outcome,
 * model prose, or a tool preview. */
export function observeGoalAutomations(input: {
  goalId: string; expectedGoalRevision: number; chatId: string;
}): GoalAutomationObservation[] {
  const goal = getChatGoalRevision(input.goalId);
  const run = getLongRunByGoalId(input.goalId);
  const chat = chatBinding(input.chatId);
  if (!goal || !run || goal.revision !== input.expectedGoalRevision
    || goal.lifecycle !== "ongoing" || goal.chatId !== input.chatId
    || getChatGoalContract(input.goalId)?.status !== "active"
    || chat?.goal_id !== input.goalId || chat.origin_surface !== run.surface
    || run.rootChatId !== input.chatId
    || getLongRunGoalRevisionBinding(run.id)?.revision !== goal.revision) return [];
  const rows = getDb().prepare(`SELECT payload_json, occurred_at FROM long_run_events
    WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT ?`)
    .all(run.id, BINDING_KIND, MAX_BINDINGS_READ) as Array<{ payload_json: string; occurred_at: string }>;
  const seen = new Set<string>();
  const observations: GoalAutomationObservation[] = [];
  for (const event of rows) {
    if (observations.length >= MAX_OBSERVATIONS) break;
    const binding = parseBinding(event.payload_json);
    if (!binding || binding.goalId !== input.goalId || binding.goalRevision !== input.expectedGoalRevision
      || binding.chatId !== input.chatId || seen.has(binding.automationId)) continue;
    seen.add(binding.automationId);
    const valid = bindingCurrent(binding, input.goalId, input.expectedGoalRevision, input.chatId);
    const base: GoalAutomationObservation = {
      automationId: binding.automationId, graphDigest: binding.graphDigest,
      definitionDigest: binding.definitionDigest,
      bindingState: valid ? "current" : "stale",
      executionState: "unknown", terminalRunId: null, terminalStatus: null,
      effectState: "unknown", domainKpiState: "unknown",
    };
    if (!valid) { observations.push(base); continue; }
    const receipt = getDb().prepare(`SELECT h.id, h.status, h.ran_at, r.status AS graph_status, r.dry_run,
      r.graph_digest
      FROM run_history h JOIN automation_runs r ON r.id = h.id AND r.automation_id = h.automation_id
      WHERE h.automation_id = ? AND h.ran_at >= ? ORDER BY h.ran_at DESC, h.rowid DESC LIMIT 1`)
      .get(binding.automationId, event.occurred_at) as
      { id: string; status: string; ran_at: string; graph_status: string; dry_run: number;
        graph_digest: string | null } | undefined;
    if (receipt && receipt.dry_run === 0 && ["ok", "partial", "error", "skipped"].includes(receipt.status)
      && ["ok", "error"].includes(receipt.graph_status)
      // Legacy single-prompt runs have no versioned graph execution receipt.
      // Their terminal row remains visible elsewhere, but is unknown here.
      && binding.graphDigest !== null && receipt.graph_digest === binding.graphDigest) {
      base.executionState = "terminal-receipt";
      base.terminalRunId = receipt.id;
      base.terminalStatus = receipt.status as GoalAutomationObservation["terminalStatus"];
    }
    observations.push(base);
  }
  return observations;
}
