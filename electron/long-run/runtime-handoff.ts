import { ownsHostGoalLoop } from "./host-goal-surface";
import type { GoalRuntimeSelectionReceipt, RuntimeSelection, RuntimeStatus } from "../../shared/types";
import { ollamaModelListIncludes } from "../../shared/runtime-connect";
import type { LongRunTaskCheckpoint } from "../../shared/long-run-checkpoint";
import { getChat, normalizeChatRuntimeSelection, setChatRuntimeSelection } from "../store/chats";
import { getChatGoalRevision } from "../store/chat-goals";
import { appendLongRunEvent, getLongRunByGoalId, getLongRunGoalRevisionBinding } from "../store/long-runs";
import { getDb } from "../store/db";
import { desktopStoreTransaction } from "../store/change-bus";
import { assertChatRuntimeSelectionTicketCurrent, reserveChatRuntimeSelectionTicket,
  type ChatRuntimeSelectionTicket } from "../store/chat-runtime-selection-ticket";
import { captureLongRunRuntimeSelection } from "./exact-runtime-binding";
import { resolveDesktopRuntimeAdapter } from "./runtime-adapters";
import { pickRunner, rolePriorityRuntimes, runtimeModelUnavailable, selectExactRuntime } from "../runtime/selection";
import { runtimeCooldownForSelection } from "../runtime/runtime-cooldown";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";

type HandoffEvent = {
  goalId: string; goalRevision: number; chatId: string; selectionRevision: number;
  state: "pending" | "claimed"; requested: RuntimeSelection;
  checkpointId?: string; successorInvocationId?: string;
  origin?: "quota-auto";
  preferred?: RuntimeSelection;
  cooldownUntil?: number;
};

export function goalAutoRuntimeRestoreDue(checkpoint: LongRunTaskCheckpoint,
  currentSelection: RuntimeSelection, now = Date.now()): boolean {
  const event = latest(checkpoint.capsule.runId);
  if (event?.origin !== "quota-auto" || event.state !== "claimed" || !event.preferred
    || !event.preferred.source
    || event.requested.kind !== currentSelection.kind
    || event.requested.backend !== currentSelection.backend
    || event.requested.model !== currentSelection.model) return false;
  return now >= (event.cooldownUntil ?? 0)
    && !runtimeCooldownForSelection(event.preferred, now);
}

/** Only a known, typed quota cooldown can change an unattended Goal model.
 * The handoff is bound to the next settled checkpoint and leaves the chat's
 * saved preference untouched. A claimed handoff remembers that preference so
 * a later observation can restore it when the cooldown expires. */
export function autoHandoffGoalRuntimeAtWait(input: {
  checkpoint: LongRunTaskCheckpoint; currentSelection: RuntimeSelection;
  inventory: readonly RuntimeStatus[];
  now?: number;
}): { state: "unchanged" | "handoff" | "cooldown-wait"; until?: number } {
  const now = input.now ?? Date.now();
  const run = getLongRunByGoalId(input.checkpoint.goalId);
  const revision = getChatGoalRevision(input.checkpoint.goalId);
  if (!run || !ownsHostGoalLoop(run.surface) || revision?.lifecycle !== "ongoing"
    || revision.revision !== input.checkpoint.goalRevision
    || getLongRunGoalRevisionBinding(run.id)?.revision !== revision.revision
    || input.checkpoint.sideEffects.state !== "settled") return { state: "unchanged" };
  const prior = latest(run.id);
  const cooling = runtimeCooldownForSelection(input.currentSelection, now);
  // prepareCheckpointContinuation already resolves a pending user choice, so
  // cooling here is the requested model itself, not the prior producer.
  if (prior?.state === "pending") return cooling?.kind === "quota"
    ? { state: "cooldown-wait", until: cooling.until } : { state: "unchanged" };
  let preferred = prior?.origin === "quota-auto" && prior.preferred
    ? prior.preferred : input.currentSelection;
  let next: RuntimeSelection | null = null;
  if (cooling?.kind === "quota") {
    const fallback = rolePriorityRuntimes([...input.inventory], "orchestrator")
      .find(candidate => candidate.kind !== input.currentSelection.kind
        || candidate.backend !== input.currentSelection.backend
        // Another open ACP seat is another account; only when the current selection names its own seat.
        || (candidate.kind === "acp" && !!input.currentSelection.acpAgentId && candidate.acpAgentId !== input.currentSelection.acpAgentId));
    if (!fallback) return { state: "cooldown-wait", until: cooling.until };
    try {
      next = resolveRequestedGoalRuntimeSelection({ kind: fallback.kind, backend: fallback.backend,
        source: fallback.source, model: fallback.model ?? undefined,
        effort: fallback.effort ?? undefined, longContext: fallback.longContextEnabled,
        ...(fallback.acpAgentId ? { acpAgentId: fallback.acpAgentId } : {}) }, input.inventory);
    } catch { return { state: "cooldown-wait", until: cooling.until }; }
  } else if (prior?.origin === "quota-auto" && prior.state === "claimed" && prior.preferred
    && prior.requested.kind === input.currentSelection.kind
    && prior.requested.backend === input.currentSelection.backend
    && prior.requested.model === input.currentSelection.model
    && prior.preferred.source && now >= (prior.cooldownUntil ?? 0)
    && !runtimeCooldownForSelection(prior.preferred, now)) {
    try { next = resolveRequestedGoalRuntimeSelection(prior.preferred, input.inventory); }
    catch { /* Keep using the working fallback until the preferred model is available. */ }
  }
  if (!next || (next.kind === input.currentSelection.kind && next.backend === input.currentSelection.backend
    && next.source === input.currentSelection.source && next.model === input.currentSelection.model
    && (next.acpAgentId ?? null) === (input.currentSelection.acpAgentId ?? null))) return { state: "unchanged" };
  appendLongRunEvent({ runId: run.id, kind: "run.goal_runtime_selection", actorKind: "host",
    payload: { goalId: run.goalId, goalRevision: revision.revision, chatId: run.rootChatId!,
      selectionRevision: (prior?.selectionRevision ?? 0) + 1, state: "pending",
      requested: next, origin: "quota-auto", preferred,
      cooldownUntil: cooling?.kind === "quota" ? cooling.until : prior?.cooldownUntil } satisfies HandoffEvent });
  return { state: "handoff" };
}

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

/** Fixed Goal handoff failures retain a machine code through the common IPC boundary.
 * An owner's choice is refused only for a cause outside the app: the runtime is not installed or cannot run
 * (unavailable), it is signed out (sign_in_required), its credential store cannot be read (credential_unavailable),
 * or the runtime's own authoritative model list proves the model absent (model_unverified). The other codes belong
 * to the unattended path, whose guesses nobody confirmed. */
function goalRuntimeSelectionError(code:
  | "goal_runtime_selection_ambiguous"
  | "goal_runtime_selection_unavailable"
  | "goal_runtime_sign_in_required"
  | "goal_runtime_credential_unavailable"
  | "goal_runtime_model_required"
  | "goal_runtime_model_unverified"
): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** `owner`: the person picked this runtime and model from the app's own list (the chip). The unattended callers (a quota
 * fallback) keep every guard: nobody confirmed what they pick, so a failed or stale model discovery cannot authorize it. */
export function resolveRequestedGoalRuntimeSelection(requested: RuntimeSelection, inventory: readonly RuntimeStatus[],
  options: { owner?: boolean } = {}): RuntimeSelection {
  const owner = options.owner === true;
  let candidates = inventory.filter(runtime => runtime.kind === requested.kind
    && (!requested.backend || runtime.backend === requested.backend)
    && (!requested.source || runtime.source === requested.source)
    && (requested.kind !== "acp" || requested.acpAgentId === runtime.acpAgentId));
  // A source-less pin names an engine, not a binary (the chip omits the path). When several detected entries share
  // that engine, the invocation takes the first match (selectExactRuntime); prefer one that can run so the exact binding
  // names a real executable. The kind, backend and (for ACP) seat are already fixed by the filter above.
  if (owner && candidates.length > 1) {
    const runnable = candidates.filter(runtime => pickRunner(runtime));
    candidates = [(runnable.length ? runnable : candidates)[0]];
  }
  if (candidates.length !== 1) throw goalRuntimeSelectionError(candidates.length ? "goal_runtime_selection_ambiguous" : "goal_runtime_selection_unavailable");
  const runtime = candidates[0];
  if (!pickRunner(runtime)) throw goalRuntimeSelectionError("goal_runtime_selection_unavailable");
  if (runtime.credentialAccess?.status === "unavailable") throw goalRuntimeSelectionError("goal_runtime_credential_unavailable");
  if (runtime.signInRequired) throw goalRuntimeSelectionError("goal_runtime_sign_in_required");
  // The effective model, effort and long-context are what the episode's own runtime resolution will compute for this
  // pin (selectExactRuntime). Recording them here keeps the handoff equal to what really runs: an effort the model
  // does not offer, or a model-less "Default" pick, is settled now instead of failing the episode later.
  const effective = owner ? selectExactRuntime([runtime], { ...requested, source: runtime.source, role: "orchestrator" })?.active : undefined;
  const model = effective ? effective.model ?? undefined : requested.model ?? runtime.model ?? undefined;
  if (!model && !owner) throw goalRuntimeSelectionError("goal_runtime_model_required");
  // Unattended: a failed/stale live discovery cannot authorize an unattended change. Owner: the person picked the model
  // from the app's own list, so only a runtime whose own list is authoritative (local models) can prove it absent.
  // Some CLIs have no list protocol; their host catalogue can admit a pending request, and only the actual pinned
  // invocation can prove execution (runtimeModelUnavailable is the very test the episode applies).
  if (owner ? runtimeModelUnavailable(runtime, model)
    : ((runtime.modelDiscovery?.status === "failed" || runtime.modelDiscovery?.stale)
      || (model && runtime.availableModels?.length && !(runtime.kind === "ollama"
        ? ollamaModelListIncludes(runtime.availableModels, model)
        : runtime.availableModels.includes(model)))))
    throw goalRuntimeSelectionError("goal_runtime_model_unverified");
  const selection: RuntimeSelection = { ...requested, ...(model ? { model } : {}), backend: runtime.backend, source: runtime.source,
    acpAgentId: runtime.acpAgentId, longContext: requested.longContext ?? effective?.longContextEnabled ?? runtime.longContextEnabled,
    ...(effective ? { effort: effective.effort ?? undefined } : {}), role: "orchestrator", inherit: false };
  if (!model) delete selection.model;
  if (selection.effort === undefined) delete selection.effort;
  try {
    resolveDesktopRuntimeAdapter(selection);
    captureLongRunRuntimeSelection(selection, { requireExact: true });
  } catch { throw goalRuntimeSelectionError("goal_runtime_selection_unavailable"); }
  return selection;
}

export type GoalRuntimeSelectionRequest = {
  chatId: string; expectedGoalId: string; expectedGoalRevision: number;
  selection: RuntimeSelection;
};

/** The ongoing Goal this chat itself owns right now, or null. `expectedGoalId`/`expectedGoalRevision` are what the
 * caller last read; they are never a reason to refuse. The person's intent is "use this model from now on", so a Goal
 * that moved on (a newer revision, a replacement Goal in this chat) is bound at its CURRENT revision, and a Goal that
 * ended, is no longer ongoing, or belongs to another chat is simply not a handoff target: the choice is the chat's
 * pin (the next message) and nothing of another chat is touched. */
function goalHandoffTarget(chatId: string) {
  const chat = getChat(chatId);
  if (!chat?.goalId) return null;
  const run = getLongRunByGoalId(chat.goalId);
  const revision = getChatGoalRevision(chat.goalId);
  if (!run || run.rootChatId !== chat.id || run.surface === "science" || revision?.lifecycle !== "ongoing"
    || ["completed", "failed", "cancelled"].includes(run.status)) return null;
  return { chat, run, revision };
}

/** Reserve the ticket that fences an older in-flight choice behind a newer one, synchronously before runtime
 * detection. Whether a Goal handoff applies is decided later, in the writing transaction, at the then-current binding. */
export function reserveGoalRuntimeSelection(input: GoalRuntimeSelectionRequest): ChatRuntimeSelectionTicket {
  if (!normalizeChatRuntimeSelection(input.selection)) throw new TypeError("Invalid Goal runtime selection");
  const db = getDb();
  return db.transaction(() => reserveChatRuntimeSelectionTicket(db, input.chatId)).immediate();
}

function fileGoalHandoff(target: NonNullable<ReturnType<typeof goalHandoffTarget>>, requested: RuntimeSelection,
  actorKind: "user" | "host"): { selectionRevision: number } {
  const previous = latest(target.run.id);
  const selectionRevision = (previous?.selectionRevision ?? 0) + 1;
  appendLongRunEvent({ runId: target.run.id, kind: "run.goal_runtime_selection", actorKind,
    payload: { goalId: target.run.goalId, goalRevision: target.revision.revision, chatId: target.chat.id,
      selectionRevision, state: "pending", requested } satisfies HandoffEvent });
  return { selectionRevision };
}

/** The person's model choice for a chat. A chat with an ongoing Goal gets a handoff for the Goal's next safe episode
 * (state "pending"); otherwise the choice is the chat's pin for the next message and nothing is queued — the receipt
 * then says state "applied" with selectionRevision 0. The chat's pin is written in both cases, never an executable path.
 * Only a cause outside the app refuses a request that needs a handoff (see goalRuntimeSelectionError); the refusal
 * leaves pin and Goal unchanged. */
export function requestGoalRuntimeSelection(input: GoalRuntimeSelectionRequest,
  inventory: readonly RuntimeStatus[], ticket?: ChatRuntimeSelectionTicket): GoalRuntimeSelectionReceipt {
  let requested: RuntimeSelection | null = null, refusal: unknown = null;
  try { requested = resolveRequestedGoalRuntimeSelection(input.selection, inventory, { owner: true }); }
  catch (error) { refusal = error; }
  const db = getDb();
  return desktopStoreTransaction(db, () => {
    if (ticket) {
      if (ticket.chatId !== input.chatId) throw Object.assign(new Error("chat_runtime_selection_superseded"), { code: "chat_runtime_selection_superseded" });
      assertChatRuntimeSelectionTicketCurrent(db, ticket);
    }
    // The chat's next-message preference is not an executable-path lease.
    // Preserve the semantic preference, never an executable path. Only the
    // Goal handoff event owns the inventory-confirmed source for this episode.
    const { source: _exactSource, ...chatPreference } = input.selection;
    const target = goalHandoffTarget(input.chatId);
    if (!target) {
      const pinned = setChatRuntimeSelection(input.chatId, chatPreference, "desktop-ui");
      const shown = pinned.runtimeSelection ? publicSelection(pinned.runtimeSelection) : publicSelection(input.selection);
      return { chat: pinned, goalId: input.expectedGoalId, goalRevision: input.expectedGoalRevision,
        selectionRevision: 0, state: "applied" as const, requested: shown, effective: shown };
    }
    if (!requested) throw refusal;
    const { chat, run, revision } = target;
    const updated = setChatRuntimeSelection(chat.id, chatPreference, "runtime-handoff");
    const { selectionRevision } = fileGoalHandoff(target, requested, "user");
    return { chat: updated, goalId: run.goalId, goalRevision: revision.revision,
      selectionRevision, state: "pending" as const, requested: publicSelection(requested), effective: null };
  }).immediate();
}

/** For a surface that wrote the chat's pin itself inside its own fenced transaction (the phone): the same rule as the
 * chip. When the chat has an ongoing Goal the choice is also filed for the Goal's next safe episode. Call it in that
 * transaction; it never throws — a choice the handoff cannot take (a runtime signed out) stays the chat's pin only. */
export function handOffPinnedSelectionToOngoingGoal(chatId: string, selection: RuntimeSelection,
  inventory: readonly RuntimeStatus[]): "pending" | null {
  try {
    const target = goalHandoffTarget(chatId);
    if (!target) return null;
    fileGoalHandoff(target, resolveRequestedGoalRuntimeSelection(selection, inventory, { owner: true }), "user");
    return "pending";
  } catch { return null; }
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
  const current = getChatGoalRevision(run.goalId)?.revision;
  // A pending choice made under an earlier revision still waits for the Goal's next episode (it is re-bound to the
  // revision that episode runs under when it is claimed). A claimed one belongs to the revision it was claimed under.
  if (!event || !current || event.chatId !== chatId || event.goalId !== run.goalId
    || (event.state === "claimed" ? current !== event.goalRevision : current < event.goalRevision)) return null;
  let state: GoalRuntimeSelectionReceipt["state"] = event.state;
  let effective: RuntimeSelection | null = null;
  if (event.state === "claimed" && event.successorInvocationId) {
    const attempt = getDb().prepare(`SELECT a.runtime_selection_json, a.state FROM long_run_worker_attempts a
      JOIN long_run_workers w ON w.id=a.worker_id AND w.run_id=a.run_id
      WHERE a.run_id=? AND a.invocation_run_id=? AND w.role='controller' ORDER BY a.rowid DESC LIMIT 1`)
      .get(run.id, event.successorInvocationId) as { runtime_selection_json: string; state: string } | undefined;
    // Binding an attempt occurs on the pre-run runtime-selected notice. That
    // alone is not evidence the provider executed. Do not call it applied until
    // the host has a successful terminal and settled effect receipt.
    const terminal = getDb().prepare("SELECT 1 FROM run_events WHERE run_id=? AND chat_id=? AND kind='invoke_completed' LIMIT 1")
      .get(event.successorInvocationId, chatId);
    let effectsSettled = false;
    try { effectsSettled = readInvocationEffectBoundary({ invocationRunId: event.successorInvocationId,
      expectedChatId: chatId }).effects === "settled"; } catch { /* No receipt is not settled. */ }
    if (attempt?.state === "completed" && terminal && effectsSettled) {
      try {
        if (JSON.stringify(JSON.parse(attempt.runtime_selection_json))
          === JSON.stringify(captureLongRunRuntimeSelection(event.requested, { requireExact: true }))) {
          state = "applied"; effective = event.requested;
        }
      } catch { /* Invalid receipt never becomes applied. */ }
    }
  }
  return { goalRevision: event.state === "pending" ? current : event.goalRevision,
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
  // A checkpoint that names no Goal revision (v1) cannot take a handoff. A pending choice filed under an EARLIER revision
  // still waits for this Goal's next episode and is re-bound to this checkpoint's revision when claimed.
  if (!event || event.goalId !== checkpoint.goalId || checkpoint.goalRevision == null
    || (event.state === "claimed" ? event.goalRevision !== checkpoint.goalRevision : event.goalRevision > checkpoint.goalRevision)
    || event.chatId !== checkpoint.capsule.historyRangeRef?.chatId) return null;
  if (event.state === "claimed" && (event.checkpointId !== checkpoint.checkpointId
    || event.successorInvocationId !== dispatchInvocationId)) return null;
  if (event.state === "pending" && dispatchInvocationId) return null;
  return { selection: event.requested, selectionRevision: event.selectionRevision };
}

function sameExactSelection(left: RuntimeSelection, right: RuntimeSelection): boolean {
  try {
    return JSON.stringify(captureLongRunRuntimeSelection(left, { requireExact: true }))
      === JSON.stringify(captureLongRunRuntimeSelection(right, { requireExact: true }));
  } catch { return JSON.stringify(left) === JSON.stringify(right); }
}

/** Called inside the same transaction as the successor claim. No asynchronous
 * gap can assign a newer user selection to an older claim.
 * The claim never fails the episode. The choice it records is the one the episode was prepared with (the choice
 * is the person's, so a Goal that has since changed shape does not unmake it); a choice filed after the episode was
 * prepared (`prepared` differs) stays pending for the next episode; a pending choice from an earlier revision is
 * re-bound to the revision of this checkpoint. */
export function claimGoalRuntimeSelection(checkpoint: LongRunTaskCheckpoint, successorInvocationId: string,
  prepared?: RuntimeSelection): void {
  const selected = goalRuntimeSelectionForCheckpoint(checkpoint);
  if (!selected) return;
  const run = getLongRunByGoalId(checkpoint.goalId);
  const event = run ? latest(run.id) : null;
  if (!run || !event || event.state !== "pending" || event.selectionRevision !== selected.selectionRevision) {
    // Unreachable inside one transaction; if it ever happens the episode runs on its prepared binding and says why.
    if (run) appendLongRunEvent({ runId: run.id, kind: "run.goal_runtime_selection_skipped", actorKind: "host",
      payload: { goalId: checkpoint.goalId, checkpointId: checkpoint.checkpointId, successorInvocationId,
        reason: "handoff_event_changed" } });
    return;
  }
  if (prepared && !sameExactSelection(prepared, selected.selection)) return;
  appendLongRunEvent({ runId: run.id, kind: "run.goal_runtime_selection", actorKind: "host",
    payload: { ...event, goalRevision: checkpoint.goalRevision as number, state: "claimed", checkpointId: checkpoint.checkpointId,
      successorInvocationId } satisfies HandoffEvent });
}
