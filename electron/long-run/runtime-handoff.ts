import type { GoalRuntimeSelectionReceipt, RuntimeSelection, RuntimeStatus } from "../../shared/types";
import type { LongRunTaskCheckpoint } from "../../shared/long-run-checkpoint";
import { getChat, setChatRuntimeSelection } from "../store/chats";
import { getChatGoalRevision } from "../store/chat-goals";
import { appendLongRunEvent, getLongRunByGoalId, getLongRunGoalRevisionBinding } from "../store/long-runs";
import { getDb } from "../store/db";
import { captureLongRunRuntimeSelection } from "./exact-runtime-binding";
import { resolveDesktopRuntimeAdapter } from "./runtime-adapters";
import { pickRunner } from "../runtime/selection";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";

type HandoffEvent = {
  goalId: string; goalRevision: number; chatId: string; selectionRevision: number;
  state: "pending" | "claimed"; requested: RuntimeSelection;
  checkpointId?: string; successorInvocationId?: string;
};

function publicSelection(selection: RuntimeSelection): RuntimeSelection {
  // Main keeps the executable source in its durable handoff event. Renderer
  // receipts need the selected model and seat, never a local provider path.
  const { source: _source, ...visible } = selection;
  return visible;
}

function latest(runId: string): HandoffEvent | null {
  const row = getDb().prepare("SELECT payload_json FROM long_run_events WHERE run_id=? AND kind='run.goal_runtime_selection' ORDER BY seq DESC LIMIT 1")
    .get(runId) as { payload_json: string } | undefined;
  if (!row) return null;
  try {
    const value = JSON.parse(row.payload_json) as HandoffEvent;
    return value && (value.state === "pending" || value.state === "claimed") ? value : null;
  } catch { return null; }
}

function claimedForDispatch(runId: string, checkpointId: string, successorInvocationId: string): HandoffEvent | null {
  const row = getDb().prepare(`SELECT payload_json FROM long_run_events WHERE run_id=?
    AND kind='run.goal_runtime_selection' AND json_extract(payload_json,'$.state')='claimed'
    AND json_extract(payload_json,'$.checkpointId')=?
    AND json_extract(payload_json,'$.successorInvocationId')=? ORDER BY seq DESC LIMIT 1`)
    .get(runId, checkpointId, successorInvocationId) as { payload_json: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.payload_json) as HandoffEvent; } catch { return null; }
}

export function resolveRequestedGoalRuntimeSelection(requested: RuntimeSelection, inventory: readonly RuntimeStatus[]): RuntimeSelection {
  const candidates = inventory.filter(runtime => runtime.kind === requested.kind
    && (!requested.backend || runtime.backend === requested.backend)
    && (!requested.source || runtime.source === requested.source)
    && (requested.kind !== "acp" || requested.acpAgentId === runtime.acpAgentId));
  if (candidates.length !== 1) throw new Error(candidates.length ? "goal_runtime_selection_ambiguous" : "goal_runtime_selection_unavailable");
  const runtime = candidates[0];
  if (!pickRunner(runtime) || runtime.credentialAccess?.status === "unavailable" || runtime.signInRequired)
    throw new Error("goal_runtime_selection_unavailable");
  const model = requested.model ?? runtime.model ?? undefined;
  if (!model) throw new Error("goal_runtime_model_required");
  // A failed/stale live discovery cannot authorize an unattended change. Some
  // CLIs have no list protocol: their host catalogue can admit a pending
  // request, but only the actual pinned invocation can prove execution.
  if ((runtime.modelDiscovery?.status === "failed" || runtime.modelDiscovery?.stale)
    || (runtime.availableModels?.length && !runtime.availableModels.includes(model)))
    throw new Error("goal_runtime_model_unverified");
  const selection: RuntimeSelection = { ...requested, model, backend: runtime.backend, source: runtime.source,
    acpAgentId: runtime.acpAgentId, longContext: requested.longContext ?? runtime.longContextEnabled,
    role: "orchestrator", inherit: false };
  resolveDesktopRuntimeAdapter(selection);
  captureLongRunRuntimeSelection(selection, { requireExact: true });
  return selection;
}

/** Explicit Goal-scoped request. Ordinary chat pins remain a new-message
 * preference; they never silently rewrite the active Goal's execution model. */
export function requestGoalRuntimeSelection(input: {
  chatId: string; expectedGoalId: string; expectedGoalRevision: number;
  selection: RuntimeSelection;
}, inventory: readonly RuntimeStatus[]): GoalRuntimeSelectionReceipt {
  const requested = resolveRequestedGoalRuntimeSelection(input.selection, inventory);
  return getDb().transaction(() => {
    const chat = getChat(input.chatId), run = getLongRunByGoalId(input.expectedGoalId);
    const revision = getChatGoalRevision(input.expectedGoalId);
    if (!chat || chat.goalId !== input.expectedGoalId || !run || run.rootChatId !== chat.id
      || run.surface === "science" || revision?.lifecycle !== "ongoing"
      || revision.revision !== input.expectedGoalRevision
      || getLongRunGoalRevisionBinding(run.id)?.revision !== input.expectedGoalRevision
      || ["completed", "failed", "cancelled"].includes(run.status)) throw new Error("goal_runtime_selection_revision_changed");
    const previous = latest(run.id);
    const selectionRevision = (previous?.selectionRevision ?? 0) + 1;
    // The chat's next-message preference is not an executable-path lease.
    // Preserve the semantic preference, never an executable path. Only the
    // Goal handoff event owns the inventory-confirmed source for this episode.
    const { source: _exactSource, ...chatPreference } = input.selection;
    const updated = setChatRuntimeSelection(chat.id, chatPreference);
    appendLongRunEvent({ runId: run.id, kind: "run.goal_runtime_selection", actorKind: "user",
      payload: { goalId: run.goalId, goalRevision: revision.revision, chatId: chat.id,
        selectionRevision, state: "pending", requested } satisfies HandoffEvent });
    return { chat: updated, goalId: run.goalId, goalRevision: revision.revision,
      selectionRevision, state: "pending" as const, requested: publicSelection(requested), effective: null };
  }).immediate();
}

export function getGoalRuntimeSelection(chatId: string): GoalRuntimeSelectionReceipt | null {
  const chat = getChat(chatId), run = chat?.goalId ? getLongRunByGoalId(chat.goalId) : null;
  if (!chat || !run || run.rootChatId !== chat.id || run.surface === "science") return null;
  const evidence = getGoalRuntimeSelectionEvidence(chat.id, run.goalId);
  return evidence ? { chat, goalId: run.goalId, ...evidence } : null;
}

/** Pure durable projection for Main observation paths. Unlike getChat(), this
 * must not reconcile/create canonical Tasks while reading a status snapshot. */
export function getGoalRuntimeSelectionEvidence(chatId: string, goalId: string): Omit<GoalRuntimeSelectionReceipt, "chat" | "goalId"> | null {
  const run = getLongRunByGoalId(goalId);
  if (!run || run.rootChatId !== chatId || run.surface === "science") return null;
  const event = latest(run.id);
  if (!event || event.chatId !== chatId || event.goalId !== run.goalId
    || getChatGoalRevision(run.goalId)?.revision !== event.goalRevision) return null;
  let state: GoalRuntimeSelectionReceipt["state"] = event.state;
  let effective: RuntimeSelection | null = null;
  if (event.state === "claimed" && event.successorInvocationId) {
    const attempt = getDb().prepare(`SELECT a.runtime_selection_json, a.state, a.side_effect_state FROM long_run_worker_attempts a
      JOIN long_run_workers w ON w.id=a.worker_id AND w.run_id=a.run_id
      WHERE a.run_id=? AND a.invocation_run_id=? AND w.role='controller' ORDER BY a.rowid DESC LIMIT 1`)
      .get(run.id, event.successorInvocationId) as { runtime_selection_json: string; state: string; side_effect_state: string } | undefined;
    // Binding an attempt occurs on the pre-run runtime-selected notice. That
    // alone is not evidence the provider executed. Do not call it applied until
    // the host has a successful terminal and settled effect receipt.
    const terminal = getDb().prepare("SELECT 1 FROM run_events WHERE run_id=? AND chat_id=? AND kind='invoke_completed' LIMIT 1")
      .get(event.successorInvocationId, chatId);
    let effectsSettled = false;
    try { effectsSettled = readInvocationEffectBoundary({ invocationRunId: event.successorInvocationId,
      expectedChatId: chatId }).effects === "settled"; } catch { /* No receipt is not settled. */ }
    if (attempt?.state === "completed" && attempt.side_effect_state === "committed" && terminal && effectsSettled) {
      try {
        if (JSON.stringify(JSON.parse(attempt.runtime_selection_json))
          === JSON.stringify(captureLongRunRuntimeSelection(event.requested, { requireExact: true }))) {
          state = "applied"; effective = event.requested;
        }
      } catch { /* Invalid receipt never becomes applied. */ }
    }
  }
  return { goalRevision: event.goalRevision,
    selectionRevision: event.selectionRevision, state, requested: publicSelection(event.requested),
    effective: effective ? publicSelection(effective) : null };
}

/** The pending choice has authority only at this exact settled checkpoint.
 * A claimed choice is replayable solely for its already claimed successor. */
export function goalRuntimeSelectionForCheckpoint(checkpoint: LongRunTaskCheckpoint, dispatchInvocationId?: string): {
  selection: RuntimeSelection; selectionRevision: number;
} | null {
  const event = dispatchInvocationId
    ? claimedForDispatch(checkpoint.capsule.runId, checkpoint.checkpointId, dispatchInvocationId)
    : latest(checkpoint.capsule.runId);
  if (!event || event.goalId !== checkpoint.goalId || event.goalRevision !== checkpoint.goalRevision
    || event.chatId !== checkpoint.capsule.historyRangeRef?.chatId) return null;
  if (event.state === "claimed" && (event.checkpointId !== checkpoint.checkpointId
    || event.successorInvocationId !== dispatchInvocationId)) return null;
  if (event.state === "pending" && dispatchInvocationId) return null;
  return { selection: event.requested, selectionRevision: event.selectionRevision };
}

/** Called inside the same transaction as the successor claim. No asynchronous
 * gap can assign a newer user selection to an older claim. */
export function claimGoalRuntimeSelection(checkpoint: LongRunTaskCheckpoint, successorInvocationId: string): void {
  const selected = goalRuntimeSelectionForCheckpoint(checkpoint);
  if (!selected) return;
  const run = getLongRunByGoalId(checkpoint.goalId), revision = getChatGoalRevision(checkpoint.goalId);
  const event = run ? latest(run.id) : null;
  if (!run || !revision || revision.revision !== checkpoint.goalRevision || revision.lifecycle !== "ongoing"
    || !event || event.state !== "pending" || event.selectionRevision !== selected.selectionRevision)
    throw new Error("goal_runtime_selection_revision_changed");
  appendLongRunEvent({ runId: run.id, kind: "run.goal_runtime_selection", actorKind: "host",
    payload: { ...event, state: "claimed", checkpointId: checkpoint.checkpointId,
      successorInvocationId } satisfies HandoffEvent });
}
