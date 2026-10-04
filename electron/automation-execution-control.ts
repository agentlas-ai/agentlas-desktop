import { createHash } from "node:crypto";
import { getDb } from "./store/db";
import { getAutomation } from "./store/automations";
import { getChatGoalContract, getChatGoalRevision } from "./store/chat-goals";
import { getLongRunByGoalId, getLongRunGoalRevisionBinding, longRunOwnerHold } from "./store/long-runs";
import { getAutomationDefinitionDigest, readCurrentGoalAutomationBinding } from "./long-run/automation-provenance";
import { invocationMatchesGoalRevision } from "./long-run/verification-boundary";
import { readReviewedAutomationGoalExecutionOwner } from "./automation-goal-owner-review";

/** Execution ownership is separate from a selectable workspace. Only a Main
 * creation receipt can bind a Goal to this actual scheduler controller. */
interface GoalOwner {
  automationId: string; automationCreatedAt: string; definitionDigest: string;
  goalId: string; rootChatId: string; longRunId: string; revision: number;
  sourceInvocationId: string | null; receiptId: string; generation: number;
}
declare const goalExecutionOwnerBrand: unique symbol;
export type AutomationGoalExecutionOwner = { readonly [goalExecutionOwnerBrand]: true };
declare const nativeGoalStopOwnerBrand: unique symbol;
export type NativeGoalStopOwner = Readonly<{ goalId: string; rootChatId: string; longRunId: string;
  [nativeGoalStopOwnerBrand]: true }>;
const nativeGoalOwners = new WeakMap<NativeGoalStopOwner, { goalId: string; rootChatId: string; longRunId: string }>();
const owners = new WeakMap<AutomationGoalExecutionOwner, GoalOwner>();
interface StopEntry { controller: AbortController; owner?: GoalOwner; definitionSnapshot?: string }
const controllers = new Map<string, StopEntry>();
const goalStops = new Map<string, { generation: number; receiptCursor: number; resumeAcknowledged?: boolean }>();
const admittedGoals = new Map<string, { goalId: string; rootChatId: string; longRunId: string; receiptCursor: number }>();
const goalKey = (owner: Pick<GoalOwner, "goalId" | "rootChatId" | "longRunId">) =>
  JSON.stringify([owner.goalId, owner.rootChatId, owner.longRunId]);
function refused(code = "automation_goal_execution_owner_changed"): never {
  throw Object.assign(new Error(code), { code });
}

/**
 * A refusal raised by these barriers (typed `code`, never matched on message text): the Goal must
 * not receive another dispatch right now — stopped, superseded, or not in queued/running (e.g. the
 * host is still verifying effects). Callers that only wanted to dispatch more work withhold it; a
 * barrier refusal is not a failure of work that already finished.
 */
export function isGoalDispatchRefusal(error: unknown): error is Error & { code: string } {
  return error instanceof Error && (error as { code?: unknown }).code === "automation_goal_execution_owner_changed";
}

function readOwner(automationId: string): Omit<GoalOwner, "generation"> | undefined {
  const a = getAutomation(automationId);
  if (!a) refused();
  // An explicit owner lifecycle review may authorize an existing row. It is a
  // separate receipt, never a fabricated fresh invocation or workspace choice.
  const reviewed = readReviewedAutomationGoalExecutionOwner(a.id);
  if (reviewed) {
    if (reviewed.automationId !== a.id || reviewed.automationCreatedAt !== a.createdAt
      || reviewed.sourceInvocationId !== null || !Number.isSafeInteger(reviewed.revision) || reviewed.revision < 1) refused();
    return reviewed;
  }
  // This immutable creation event is not automation_workspace_intent. An
  // independent automation following another Goal's folder gains no ownership.
  const source = getDb().prepare(`SELECT id, run_id, payload_json FROM run_events
    WHERE automation_id = ? AND kind = 'automation_workspace_source' ORDER BY rowid DESC LIMIT 1`)
    .get(a.id) as { id: string; run_id: string; payload_json: string } | undefined;
  const bridge = getDb().prepare(`SELECT run_id, seq, payload_json FROM long_run_events
    WHERE kind = 'goal.automation_provenance_bound' AND actor_kind = 'host'
      AND json_extract(payload_json, '$.automationId') = ?
      AND json_extract(payload_json, '$.automationCreatedAt') = ? ORDER BY occurred_at DESC, rowid DESC LIMIT 1`)
    .get(a.id, a.createdAt) as { run_id: string; seq: number; payload_json: string } | undefined;
  if (!source && !bridge) {
    if (a.goalId) refused("automation_goal_execution_owner_unverified"); // Mutable legacy associations never mint a controller owner.
    return undefined;
  }
  if (a.createdBy !== "agent") refused();
  if (source) {
    const raw = JSON.parse(source.payload_json) as Record<string, unknown>;
    if (raw.schemaVersion !== "agentlas.automation-workspace-intent.v1" || raw.mode !== "follow_goal"
      || raw.automationCreatedAt !== a.createdAt || raw.ownerAuthority !== "legacy"
      || typeof raw.ownerGoalId !== "string" || raw.ownerGoalId !== a.goalId
      || typeof raw.ownerChatId !== "string" || !Number.isSafeInteger(raw.ownerRevision)
      || Number(raw.ownerRevision) < 1 || typeof raw.definitionDigest !== "string") refused();
    const value = { schemaVersion: raw.schemaVersion, automationCreatedAt: a.createdAt,
      mode: raw.mode, projectId: raw.projectId ?? null,
      goalOwner: { goalId: raw.ownerGoalId, chatId: raw.ownerChatId, revision: raw.ownerRevision, authority: raw.ownerAuthority },
      definitionDigest: raw.definitionDigest };
    if (createHash("sha256").update(JSON.stringify(value)).digest("hex") !== raw.intentDigest
      || getAutomationDefinitionDigest(a.id) !== raw.definitionDigest) refused();
    const run = getLongRunByGoalId(raw.ownerGoalId);
    const started = getDb().prepare(`SELECT ts FROM run_events WHERE run_id = ? AND chat_id = ?
      AND kind = 'invoke_started' ORDER BY seq ASC LIMIT 1`).get(source.run_id, raw.ownerChatId) as { ts: string } | undefined;
    if (!run || !started || !Number.isFinite(Date.parse(started.ts)) || !Number.isFinite(Date.parse(a.createdAt))
      || Date.parse(a.createdAt) < Date.parse(started.ts)
      || !invocationMatchesGoalRevision(source.run_id, raw.ownerGoalId, Number(raw.ownerRevision))) refused();
    return { automationId: a.id, automationCreatedAt: a.createdAt, definitionDigest: raw.definitionDigest,
      goalId: raw.ownerGoalId, rootChatId: raw.ownerChatId, longRunId: run.id, revision: Number(raw.ownerRevision),
      sourceInvocationId: source.run_id, receiptId: source.id };
  }
  const current = readCurrentGoalAutomationBinding(a.id);
  const raw = JSON.parse(bridge!.payload_json) as Record<string, unknown>;
  if (!current || bridge!.run_id !== current.longRunId || raw.goalId !== current.goalId
    || raw.goalRevision !== current.goalRevision || raw.chatId !== current.chatId
    || raw.invocationRunId !== current.invocationRunId || raw.definitionDigest !== current.definitionDigest) refused();
  return { automationId: a.id, automationCreatedAt: current.automationCreatedAt, definitionDigest: current.definitionDigest,
    goalId: current.goalId, rootChatId: current.chatId, longRunId: current.longRunId, revision: current.goalRevision,
    sourceInvocationId: current.invocationRunId, receiptId: `${bridge!.run_id}:${bridge!.seq}` };
}

function assertCanonicalGoal(input: { goalId: string; rootChatId: string; longRunId?: string; revision: number }) {
  const run = getLongRunByGoalId(input.goalId), revision = getChatGoalRevision(input.goalId);
  const chat = getDb().prepare("SELECT goal_id, origin_surface, archived_at FROM chats WHERE id = ?")
    .get(input.rootChatId) as { goal_id: string | null; origin_surface: string; archived_at: string | null } | undefined;
  if (!run || (input.longRunId && run.id !== input.longRunId) || run.rootChatId !== input.rootChatId || run.surface === "science"
    || !["active", "blocked"].includes(getChatGoalContract(input.goalId)?.status ?? "")
    || !revision || revision.revision !== input.revision || revision.chatId !== input.rootChatId
    || getLongRunGoalRevisionBinding(run.id)?.revision !== input.revision
    || !chat || chat.goal_id !== input.goalId || chat.origin_surface !== run.surface || chat.archived_at != null) refused();
  return { run, revision };
}
function assertGoalDispatch(input: { goalId: string; rootChatId: string; longRunId: string }): void {
  const run = getLongRunByGoalId(input.goalId);
  if (!run || run.id !== input.longRunId || !["queued", "running"].includes(run.status)
    || getChatGoalContract(input.goalId)?.status !== "active" || longRunOwnerHold(run.id)) refused();
  const stop = goalStops.get(goalKey(input));
  if (stop && !stop.resumeAcknowledged) {
    // A failed durable pause still fences new dispatch in this Main process.
    // Only a later explicit owner resume can release it, never a host status write.
    const release = getDb().prepare(`SELECT MAX(seq) AS seq FROM long_run_events WHERE run_id = ? AND actor_kind = 'user'
      AND ((kind = 'run.user_control' AND (json_extract(payload_json, '$.action') = 'resume_with_message'
        OR json_extract(payload_json, '$.command') = 'resume'))
        OR (kind = 'run.status_changed' AND json_extract(payload_json, '$.to') IN ('queued', 'running')))`)
      .get(run.id) as { seq: number | null } | undefined;
    if (typeof release?.seq !== "number" || release.seq <= stop.receiptCursor) refused();
  }
}
/** Synchronous lifecycle barrier for Main's finite-Goal create/re-enable path.
 * A workspace choice is never consulted and cannot release an owner stop. */
export function assertFiniteGoalLifecycleCurrent(input: { goalId: string; rootChatId: string; expectedRevision: number }): void {
  const { run, revision } = assertCanonicalGoal({ ...input, revision: input.expectedRevision });
  if (revision.lifecycle !== "finite") refused();
  assertGoalDispatch({ ...input, longRunId: run.id });
}
/** Call only from Main's explicit owner Resume ingress after its durable
 * transaction succeeds. Historical resumes cannot release an unreadable stop. */
export function acknowledgeGoalExecutionResume(input: { goalId: string; rootChatId: string; expectedRevision: number }): void {
  const { run } = assertCanonicalGoal({ ...input, revision: input.expectedRevision });
  if (!["queued", "running"].includes(run.status) || getChatGoalContract(input.goalId)?.status !== "active"
    || longRunOwnerHold(run.id)) refused();
  const stop = goalStops.get(goalKey({ ...input, longRunId: run.id }));
  if (stop) stop.resumeAcknowledged = true;
}
/** Seal the canonical native invocation admission, never a caller's raw stop
 * tuple. Stop can later use this proof even when initial storage reads fail. */
export function captureNativeGoalStopOwner(input: { goalId: string; rootChatId: string; longRunId: string }): NativeGoalStopOwner {
  const revision = getChatGoalRevision(input.goalId);
  if (!revision) refused();
  assertCanonicalGoal({ ...input, revision: revision.revision });
  const token = Object.freeze({ ...input }) as NativeGoalStopOwner;
  nativeGoalOwners.set(token, { ...input });
  return token;
}
export function nativeGoalStopOwnerMatches(token: NativeGoalStopOwner | undefined, goalId: string, rootChatId: string): boolean {
  const owner = token && nativeGoalOwners.get(token);
  return Boolean(owner && owner.goalId === goalId && owner.rootChatId === rootChatId);
}
function assertOwnerCurrent(owner: GoalOwner): void {
  const current = readOwner(owner.automationId);
  const { generation: _generation, ...identity } = owner;
  if (!current || JSON.stringify(current) !== JSON.stringify(identity)) refused();
  assertCanonicalGoal(owner);
  assertGoalDispatch(owner);
  if ((goalStops.get(goalKey(owner))?.generation ?? 0) !== owner.generation) refused();
}

/** Capture before the first awaited admission check. Copied/JSON tokens cannot
 * bind or assert a run, and a pause during that await invalidates this token. */
export function captureAutomationGoalExecutionOwner(automationId: string): AutomationGoalExecutionOwner | undefined {
  const identity = readOwner(automationId);
  if (!identity) return undefined;
  const owner: GoalOwner = { ...identity, generation: goalStops.get(goalKey(identity))?.generation ?? 0 };
  assertOwnerCurrent(owner);
  admittedGoals.set(goalKey(owner), { goalId: owner.goalId, rootChatId: owner.rootChatId,
    longRunId: owner.longRunId, receiptCursor: getLongRunByGoalId(owner.goalId)!.lastEventSeq });
  const token = Object.freeze({}) as AutomationGoalExecutionOwner;
  owners.set(token, Object.freeze(owner));
  return token;
}
export function assertAutomationGoalExecutionOwner(owner: AutomationGoalExecutionOwner | undefined): void {
  if (!owner) return;
  const identity = owners.get(owner);
  if (!identity) refused();
  assertOwnerCurrent(identity);
}
/** Read-only lifecycle association check; unlike dispatch it remains available
 * while paused, so disabling the exact owned row does not require a live grant. */
export function currentAutomationGoalExecutionOwnerMatches(automationId: string,
  goalId: string, rootChatId: string, longRunId: string): boolean {
  const identity = readOwner(automationId);
  if (!identity || identity.goalId !== goalId || identity.rootChatId !== rootChatId || identity.longRunId !== longRunId) return false;
  assertCanonicalGoal(identity);
  return true;
}

/** A verified lifecycle hold may park its own row, including ongoing rows
 * whose legacy goalId column is null. Invalid ownership never grants mutation. */
export function automationGoalExecutionHeld(automationId: string): boolean {
  const identity = readOwner(automationId);
  if (!identity) return false;
  assertCanonicalGoal(identity);
  try { assertGoalDispatch(identity); return false; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error
      && error.code === "automation_goal_execution_owner_changed") return true;
    throw error;
  }
}

function currentDefinitionSnapshot(automationId: string): string | undefined {
  const a = getAutomation(automationId), base = getAutomationDefinitionDigest(automationId);
  if (!a || !base) return undefined;
  return createHash("sha256").update(JSON.stringify({ base, executionPermission: a.executionPermission,
    toolMode: a.toolMode ?? null, hubMode: a.hubMode ?? null, targetVersion: a.targetVersion ?? null,
    goal: a.goal ?? null, monitor: a.monitor ?? null })).digest("hex");
}
export function bindAutomationRunStop(automationId: string, controller: AbortController,
  owner?: AutomationGoalExecutionOwner): void {
  const prior = controllers.get(automationId);
  const identity = owner && owners.get(owner);
  if (prior && (prior.controller !== controller || prior.owner !== identity)) throw new Error("automation_stop_handle_already_bound");
  if (owner && (!identity || identity.automationId !== automationId)) refused();
  try { assertAutomationGoalExecutionOwner(owner); }
  catch (error) { controller.abort(error); throw error; }
  controllers.set(automationId, { controller, ...(identity ? { owner: identity,
    definitionSnapshot: currentDefinitionSnapshot(automationId) } : {}) });
}
export function releaseAutomationRunStop(automationId: string, controller: AbortController): void {
  if (controllers.get(automationId)?.controller === controller) controllers.delete(automationId);
}
export function stopAutomationRun(automationId: string): boolean {
  const entry = controllers.get(automationId);
  if (!entry) return false;
  entry.controller.abort(new Error("automation_stopped_by_user"));
  return true;
}

/** Called after Main's canonical Goal control guards, before its storage
 * transaction. Stop uses captured controller ownership even after revocation;
 * later row changes, disabled state or a failed transaction cannot suppress it. */
export function snapshotAutomationGoalRunStops(input: {
  goalId: string; rootChatId: string; longRunId: string; receiptCursor: number;
}): { automations: ReadonlyArray<{ automationId: string; createdAt: string }>;
  ownsAutomation(automationId: string, createdAt: string): boolean; stop(): void } {
  const key = goalKey(input), prior = goalStops.get(key);
  goalStops.set(key, { generation: (prior?.generation ?? 0) + 1, receiptCursor: input.receiptCursor });
  const selected = [...controllers].filter(([, entry]) => entry.owner?.goalId === input.goalId
    && entry.owner.rootChatId === input.rootChatId && entry.owner.longRunId === input.longRunId);
  return { automations: selected.map(([id, entry]) => ({ automationId: id, createdAt: entry.owner!.automationCreatedAt })),
    ownsAutomation(automationId, createdAt) {
    return selected.some(([id, entry]) => id === automationId && entry.owner?.automationCreatedAt === createdAt
      && entry.definitionSnapshot !== undefined && currentDefinitionSnapshot(id) === entry.definitionSnapshot);
  }, stop() {
    for (const [id, entry] of selected) {
      if (controllers.get(id) === entry) entry.controller.abort(new Error("automation_stopped_by_user"));
    }
  } };
}

/** Storage failure cannot remove an already sealed Main stop relationship.
 * Only tuples admitted earlier in this process can be selected without DB. */
export function stopKnownAutomationGoalRuns(goalId: string, rootChatId: string,
  nativeOwners: ReadonlyArray<NativeGoalStopOwner> = []): void {
  for (const token of nativeOwners) {
    const owner = nativeGoalOwners.get(token);
    if (owner?.goalId === goalId && owner.rootChatId === rootChatId) {
      snapshotAutomationGoalRunStops({ ...owner, receiptCursor: Number.MAX_SAFE_INTEGER }).stop();
    }
  }
  for (const admission of admittedGoals.values()) {
    if (admission.goalId === goalId && admission.rootChatId === rootChatId) {
      snapshotAutomationGoalRunStops({ ...admission, receiptCursor: Number.MAX_SAFE_INTEGER }).stop();
    }
  }
}
