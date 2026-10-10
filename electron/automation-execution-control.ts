import { claimAgiDecisionStopBinding, type AgiUnblockInput } from "./agi/monitor";
import { createHash } from "node:crypto";
import { goalDeadlineAt } from "./long-run/goal-deadline";
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
const automationStopGenerations = new Map<string, number>();
interface DecisionStopEntry { identity: { goalId: string; rootChatId: string; longRunId: string }; controller: AbortController }
const decisionStops = new Set<DecisionStopEntry>();
/** Decision-only registration: immutable ownership comes from a real consumed
 * monitor claim, never a raw Goal tuple or executable scheduler admission. */
export function bindAgiDecisionStop(input: AgiUnblockInput, generation: number, controller: AbortController): () => void {
  const binding = claimAgiDecisionStopBinding(input.decisionIngress, input);
  if (binding.db !== getDb() || !binding.chatId || !binding.runId) refused();
  const identity = { goalId: binding.goalId, rootChatId: binding.chatId, longRunId: binding.runId };
  assertGoalExecutionControlGeneration(identity, generation);
  const entry = { identity, controller };
  decisionStops.add(entry);
  // Release is unconditional even when Stop or failed storage revoked authority.
  return () => { decisionStops.delete(entry); };
}
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
  // Driven from long_runs so idx_long_run_events_kind applies per run (no whole-log scan).
  const bridge = getDb().prepare(`SELECT e.run_id, e.seq, e.payload_json FROM long_runs r CROSS JOIN long_run_events e
    WHERE e.run_id = r.id AND e.kind = 'goal.automation_provenance_bound' AND e.actor_kind = 'host'
      AND json_extract(e.payload_json, '$.automationId') = ?
      AND json_extract(e.payload_json, '$.automationCreatedAt') = ? ORDER BY e.occurred_at DESC, e.rowid DESC LIMIT 1`)
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

function finiteBinding(automationId: string): { goalId: string; deadlineAt: string } | undefined {
  const row = getDb().prepare(`SELECT e.payload_json FROM long_runs r CROSS JOIN long_run_events e WHERE e.run_id=r.id
    AND e.kind='goal.automation_provenance_bound' AND e.actor_kind='host' AND json_extract(e.payload_json,'$.automationId')=?
    ORDER BY e.occurred_at DESC,e.rowid DESC LIMIT 1`)
    .get(automationId) as { payload_json: string } | undefined;
  if (!row) return undefined;
  const raw = JSON.parse(row.payload_json);
  if (raw.lifecycle !== "finite") return undefined;
  if (typeof raw.goalId !== "string" || typeof raw.deadlineAt !== "string" || !Number.isFinite(Date.parse(raw.deadlineAt)))
    refused("automation_finite_goal_dispatch_refused");
  return { goalId: raw.goalId, deadlineAt: raw.deadlineAt };
}
export function isFiniteGoalDispatchRefusal(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "automation_finite_goal_dispatch_refused");
}
/** Independent and ongoing paths retain their existing policy. A finite bridge can never fall back to independent. */
export function captureFiniteAutomationGoalExecutionOwner(automationId: string): AutomationGoalExecutionOwner | undefined {
  if (!finiteBinding(automationId)) return undefined;
  try {
    const owner = captureAutomationGoalExecutionOwner(automationId);
    if (!owner) refused("automation_finite_goal_dispatch_refused");
    return owner;
  } catch { refused("automation_finite_goal_dispatch_refused"); }
}
/** Reuse a scheduler Stop handle; direct Graph runs own only their own handle. */
export function bindFiniteGraphRunStop(automationId: string, controller: AbortController, owner: AutomationGoalExecutionOwner): () => void {
  const identity = owners.get(owner), prior = controllers.get(automationId);
  assertAutomationGoalExecutionOwner(owner);
  if (!identity) refused("automation_finite_goal_dispatch_refused");
  const deadline = finiteBinding(automationId)!.deadlineAt, current = goalDeadlineAt(identity.goalId);
  if (!current) refused("automation_finite_goal_dispatch_refused");
  const delay = Math.min(Date.parse(deadline),Date.parse(current)) - Date.now();
  let release: () => void;
  if (prior) {
    if (!prior.owner || JSON.stringify(prior.owner) !== JSON.stringify(identity)) refused("automation_finite_goal_dispatch_refused");
    const abort = () => controller.abort(prior.controller.signal.reason);
    if (prior.controller.signal.aborted) abort();
    else prior.controller.signal.addEventListener("abort",abort,{ once: true });
    release = () => prior.controller.signal.removeEventListener("abort",abort);
  } else { bindAutomationRunStop(automationId,controller,owner); release = () => releaseAutomationRunStop(automationId,controller); }
  // One bound deadline cancellation, not an autonomous retry or cadence.
  const timer = delay <= 2_147_483_647 ? setTimeout(() => controller.abort(Object.assign(new Error("automation_finite_goal_dispatch_refused"),
    { code: "automation_finite_goal_dispatch_refused" })),Math.max(0,delay)) : null;
  timer?.unref?.();
  return () => { if (timer) clearTimeout(timer); release(); };
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
  assertGoalExecutionControlGeneration(input, null);
}
/** A native Stop remains effective when its durable write fails. A captured
 * generation also stays stale after an explicit Resume (Stop/Resume ABA).
 * Registered waits recovered in another Main check the current Stop without
 * comparing a generation belonging to the previous process. */
export function assertGoalExecutionControlGeneration(input: { goalId: string; rootChatId: string; longRunId: string },
  expectedGeneration: number | null): void {
  const stop = goalStops.get(goalKey(input));
  if (expectedGeneration !== null && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0
    || (stop?.generation ?? 0) !== expectedGeneration)) refused();
  if (stop && !stop.resumeAcknowledged) {
    // A failed durable pause still fences new dispatch in this Main process.
    // Only a later explicit owner resume can release it, never a host status write.
    const release = getDb().prepare(`SELECT MAX(seq) AS seq FROM long_run_events WHERE run_id = ? AND actor_kind = 'user'
      AND ((kind = 'run.user_control' AND (json_extract(payload_json, '$.action') = 'resume_with_message'
        OR json_extract(payload_json, '$.command') = 'resume'))
        OR (kind = 'run.status_changed' AND json_extract(payload_json, '$.to') IN ('queued', 'running')))`)
      .get(input.longRunId) as { seq: number | null } | undefined;
    if (typeof release?.seq !== "number" || release.seq <= stop.receiptCursor) refused();
  }
}
/** Read-only snapshot for an already canonical Main decision; this number
 * does not bind a controller or authorize dispatch by itself. */
export function captureGoalExecutionControlGeneration(input: { goalId: string; rootChatId: string;
  longRunId: string; expectedRevision: number }): number {
  assertCanonicalGoal({ ...input, revision: input.expectedRevision });
  assertGoalDispatch(input);
  return peekGoalExecutionControlGeneration(input);
}

/** Authoring may prepare a local candidate while work is paused or waiting.
 * Reading this epoch grants no dispatch authority; the original epoch can only
 * detect a Stop/Resume change during an awaited preparation. */
export function peekGoalExecutionControlGeneration(input: { goalId: string; rootChatId: string;
  longRunId: string }): number {
  return goalStops.get(goalKey(input))?.generation ?? 0;
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
  const finite = finiteBinding(owner.automationId);
  if (finite) {
    const currentDeadline = goalDeadlineAt(owner.goalId);
    if (finite.goalId !== owner.goalId || !currentDeadline || Date.now() >= Math.min(Date.parse(finite.deadlineAt),Date.parse(currentDeadline)))
      refused("automation_finite_goal_dispatch_refused");
  }
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
  try {
    const identity = readOwner(automationId);
    if (!identity) return undefined;
    const owner: GoalOwner = { ...identity, generation: goalStops.get(goalKey(identity))?.generation ?? 0 };
    assertOwnerCurrent(owner);
    admittedGoals.set(goalKey(owner), { goalId: owner.goalId, rootChatId: owner.rootChatId,
      longRunId: owner.longRunId, receiptCursor: getLongRunByGoalId(owner.goalId)!.lastEventSeq });
    const token = Object.freeze({}) as AutomationGoalExecutionOwner;
    owners.set(token, Object.freeze(owner));
    return token;
  } catch (error) {
    if (finiteBinding(automationId)) refused("automation_finite_goal_dispatch_refused");
    throw error;
  }
}

export function assertAutomationGoalExecutionOwner(owner: AutomationGoalExecutionOwner | undefined): void {
  if (!owner) return;
  const identity = owners.get(owner);
  if (!identity) refused();
  try { assertOwnerCurrent(identity); } catch (error) {
    if (finiteBinding(identity.automationId)) refused("automation_finite_goal_dispatch_refused");
    throw error;
  }
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
/** Local preparation may observe Stop without gaining execution authority.
 * The epoch advances even when no run currently owns a Stop handle. */
export function peekAutomationStopGeneration(automationId: string): number {
  return automationStopGenerations.get(automationId) ?? 0;
}
export function stopAutomationRun(automationId: string): boolean {
  automationStopGenerations.set(automationId, peekAutomationStopGeneration(automationId) + 1);
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
  const decisions = [...decisionStops].filter(entry => goalKey(entry.identity) === key);
  return { automations: selected.map(([id, entry]) => ({ automationId: id, createdAt: entry.owner!.automationCreatedAt })),
    ownsAutomation(automationId, createdAt) {
    return selected.some(([id, entry]) => id === automationId && entry.owner?.automationCreatedAt === createdAt
      && entry.definitionSnapshot !== undefined && currentDefinitionSnapshot(id) === entry.definitionSnapshot);
  }, stop() {
    for (const [id, entry] of selected) {
      if (controllers.get(id) === entry) entry.controller.abort(new Error("automation_stopped_by_user"));
    }
    for (const entry of decisions) {
      if (decisionStops.has(entry)) entry.controller.abort(new Error("automation_stopped_by_user"));
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
  const knownDecisions = new Map([...decisionStops]
    .filter(entry => entry.identity.goalId === goalId && entry.identity.rootChatId === rootChatId)
    .map(entry => [goalKey(entry.identity), entry.identity]));
  for (const identity of knownDecisions.values()) {
    snapshotAutomationGoalRunStops({ ...identity, receiptCursor: Number.MAX_SAFE_INTEGER }).stop();
  }
  for (const admission of admittedGoals.values()) {
    if (admission.goalId === goalId && admission.rootChatId === rootChatId) {
      snapshotAutomationGoalRunStops({ ...admission, receiptCursor: Number.MAX_SAFE_INTEGER }).stop();
    }
  }
}
