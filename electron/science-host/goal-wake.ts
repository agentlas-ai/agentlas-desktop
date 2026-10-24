import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { getRunEventBySource, recordRunEvent } from "../store/run-events";
import type { AliveResumeBarrier } from "../../shared/alive";
import { scienceStore } from "agentlas-science";
import { AliveLifetimeStore } from "../alive-core/lifetime-store";
import { scienceLongRunId } from "agentlas-science/dist/contracts/science-long-run";
import { invocationService } from "../invocation/service";
import { tryHostGoalWake, readHostGoalWakeDeferral, cancelHostGoalWakeDeferral,
  recordHostGoalOwnerControl, type HostGoalWakeDeferral } from "../long-run/wake-arbiter";

interface ScienceGoalWakeInput {
  projectId: string; conversationId: string; turnId: string;
  loopSessionId: string | null; invocationRunId: string;
}
const fail = (): never => { throw new Error("science_goal_wake_scope_changed"); };
const workloadId = (projectId: string) => scienceLongRunId(projectId);
function turnScope(input: ScienceGoalWakeInput, queuedOnly = false, terminalAllowed = false) {
  const store = scienceStore(), turn = store.getTurnForProject(input.projectId, input.turnId);
  const binding = store.getConversationRuntimeBinding(input.projectId, input.conversationId);
  const loop = input.loopSessionId ? store.getLoopSessionForProject(input.projectId, input.loopSessionId) : null;
  if (!turn || !binding || turn.conversationId !== input.conversationId || turn.invocationRunId !== input.invocationRunId
    || turn.runtimeChatId !== binding.runtimeChatId || turn.origin !== "loop-continuation"
    || (!terminalAllowed && !(queuedOnly ? turn.status === "queued" : ["queued", "running"].includes(turn.status)))
    || (input.loopSessionId && (!loop || loop.runtimeChatId !== binding.runtimeChatId
      || (!terminalAllowed && !(loop.status === "queued" && loop.activeRunId === null
        || loop.status === "running" && loop.activeRunId === input.invocationRunId))))
    || (!input.loopSessionId && store.getActiveLoopSession(input.projectId))) return fail();
  if (!terminalAllowed) store.assertScienceTurnExecutionAuthority(turn);
  return { store, turn, binding, loop };
}

/** Scope adaptation only. The project working range owns a single host wake
 * budget before and after Science creates its formal research loop. */
export function scienceHostGoalWake<T extends { runId: string }>(input: ScienceGoalWakeInput, start: () => T):
  { start: true; result: T } | { start: false; reason: "chat_busy" | "owner_request_queued" | "wake_budget_reached"; retryAt?: string } {
  const { binding } = turnScope(input);
  return tryHostGoalWake({ runId: workloadId(input.projectId), chatId: binding.runtimeChatId,
    source: "continuation", cause: "research-continuation", invocationRunId: input.invocationRunId,
    gate: invocationService }, start, result => result.runId === input.invocationRunId);
}

export function readScienceHostGoalWake(input: ScienceGoalWakeInput): HostGoalWakeDeferral | null {
  try {
    const { binding } = turnScope(input, true);
    return readHostGoalWakeDeferral({ runId: workloadId(input.projectId), chatId: binding.runtimeChatId, invocationRunId: input.invocationRunId });
  } catch { return null; }
}

export function cancelScienceHostGoalWake(input: ScienceGoalWakeInput): void {
  const { binding } = turnScope(input, false, true);
  cancelHostGoalWakeDeferral({ runId: workloadId(input.projectId), chatId: binding.runtimeChatId, invocationRunId: input.invocationRunId });
}

/** Invoked exclusively by authenticated native owner controls, never by a
 * model tool, Alive callback, or inference from the continuation document. */
export function recordScienceHostGoalOwnerControl(input: {
  projectId: string; conversationId: string; loopSessionId: string | null; requestId: string; control: "resume" | "message";
}): void {
  const store = scienceStore(), binding = store.getConversationRuntimeBinding(input.projectId, input.conversationId);
  const loop = input.loopSessionId ? store.getLoopSessionForProject(input.projectId, input.loopSessionId) : null;
  if (!binding || !["resume", "message"].includes(input.control) || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(input.requestId)
    || (input.loopSessionId && (!loop || loop.runtimeChatId !== binding.runtimeChatId))
    || (!input.loopSessionId && store.getActiveLoopSession(input.projectId))) return fail();
  getDb().transaction(() => {
    const previous = getRunEventBySource(`goal-owner-control:${workloadId(input.projectId)}`, `owner-control:${input.requestId}`);
    recordHostGoalOwnerControl({ runId: workloadId(input.projectId), chatId: binding.runtimeChatId, cause: input.control, requestId: input.requestId });
    // Re-delivery of an old owner action must not cancel a newer wait.
    if (!previous) {
      try {
        const waits = require("../long-run/canonical-owner-waits") as typeof import("../long-run/canonical-owner-waits");
        waits.cancelCanonicalGoalWaitScope({ domain: "science", projectId: input.projectId,
          conversationId: input.conversationId, chatId: binding.runtimeChatId }, "owner_control");
      } catch { /* Owner input remains unconditional; Stop/currentness checks still fence starts. */ }
    }
  }).immediate();
}

/** Process-local observation captured before native owner work can await or change domain state. */
export type ScienceAliveOwnerObservation = Readonly<Record<never, never>>;
const ownerObservations = new WeakMap<ScienceAliveOwnerObservation, {
  projectId: string; conversationId: string; requestId: string; control: "resume" | "message"; agentId: string; lifePresent: boolean; grantable: boolean;
  barrier: AliveResumeBarrier | null; bindingRuntimeChatId: string | null;
}>();
export function captureScienceAliveOwnerControl(input: { projectId: string; conversationId: string; requestId: string; control: "resume" | "message" }): ScienceAliveOwnerObservation {
  const store = scienceStore();
  if (!store.listConversations(input.projectId, { includeReferee: true }).some(conversation => conversation.id === input.conversationId)) return fail();
  const binding = store.getConversationRuntimeBinding(input.projectId, input.conversationId);
  const agentId = store.scienceAliveAgentId(input.projectId);
  let candidate: unknown;
  try { candidate = store.aliveLifetime(); }
  catch (error) { if ((error as { code?: string })?.code !== "science_alive_core_unavailable") throw error; }
  const alive = candidate instanceof AliveLifetimeStore ? candidate : null;
  const lifePresent = !!alive?.get(agentId), barrier = alive?.resumeBarrier(agentId) ?? null;
  // Observe once before domain acceptance or any await. A crash/retry never
  // turns an old native request into approval of a later, different barrier.
  const observationNonce = randomUUID();
  let grantable = false;
  try {
    const observed = recordRunEvent({ runId: `goal-owner-control:${workloadId(input.projectId)}`,
      kind: "science_alive_owner_intent_observed", sourceEventId: `owner-observed:${input.requestId}`,
      payload: { projectId: input.projectId, conversationId: input.conversationId, requestId: input.requestId,
        control: input.control, observationNonce } });
    grantable = observed.payload.projectId === input.projectId && observed.payload.conversationId === input.conversationId
      && observed.payload.control === input.control && observed.payload.observationNonce === observationNonce;
    // If an older host (or a failed common INSERT) already accepted this UUID,
    // its domain receipt cannot become fresh owner authority after a restart.
    const priorRequest = input.control === "message"
      ? !!store.getTurnByRequestId(input.requestId) || store.listSteering(input.projectId, input.conversationId).some(request => request.requestId === input.requestId)
      : !alive || !!alive.db.prepare("SELECT 1 FROM idempotency_keys WHERE request_id=? AND operation='research-loop.transition'").get(input.requestId);
    const priorGoalControl = getRunEventBySource(`goal-owner-control:${workloadId(input.projectId)}`, `owner-control:${input.requestId}`);
    grantable = grantable && !priorRequest && !priorGoalControl;
  } catch { grantable = false; /* Observation failure never blocks ordinary domain acceptance. */ }
  const token = Object.freeze({});
  ownerObservations.set(token, { ...input, agentId, lifePresent, grantable,
    barrier, bindingRuntimeChatId: binding?.runtimeChatId ?? null });
  return token;
}

/** Only the authenticated native command dispatcher calls this after accepting an owner intent.
 * Domain resume clears Stop first; model tools and runtime callbacks never receive this adapter. */
export function recordScienceAliveOwnerControl(input: {
  projectId: string; conversationId: string; requestId: string; control: "resume" | "message";
  /** An explicit loop Continue pins that loop; a new message uses the current persisted attachment. */
  resumeLoopSessionId?: string;
  observation: ScienceAliveOwnerObservation;
}): void {
  if (!["resume", "message"].includes(input.control) || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(input.requestId)) return fail();
  const store = scienceStore(), binding = store.getConversationRuntimeBinding(input.projectId, input.conversationId);
  if (!binding) return fail();
  const observed = ownerObservations.get(input.observation);
  if (!observed || observed.projectId !== input.projectId || observed.conversationId !== input.conversationId
    || observed.requestId !== input.requestId || (observed.bindingRuntimeChatId !== null && observed.bindingRuntimeChatId !== binding.runtimeChatId)) return fail();
  if (!observed.grantable || observed.control !== input.control) return;
  let candidate: unknown;
  try { candidate = store.aliveLifetime(); }
  catch (error) { if ((error as { code?: string })?.code === "science_alive_core_unavailable") return; throw error; }
  // An old optional host cannot mint a canonical authorization or create a new lifetime here.
  if (!(candidate instanceof AliveLifetimeStore)) return;
  const alive = candidate, agentId = store.scienceAliveAgentId(input.projectId);
  alive.db.transaction(() => {
    const agent = alive.get(agentId);
    if (!agent) return;
    if (!alive.owns(agentId)) return fail();
    const attachments = alive.attachments(agentId).filter(a => a.domain === "science" && a.status === "attached"
      && a.scope.projectId === input.projectId && a.scope.conversationId === input.conversationId);
    if (attachments.length !== 1) return fail();
    const loopId = attachments[0]!.scope.loopSessionId;
    const loop = typeof loopId === "string" ? store.getLoopSessionForProject(input.projectId, loopId) : null;
    const activeLoop = store.getActiveLoopSession(input.projectId);
    if ((loopId !== null && typeof loopId !== "string") || (typeof loopId === "string" && (!loop || loop.runtimeChatId !== binding.runtimeChatId))
      || (activeLoop && activeLoop.id !== loopId) || (input.resumeLoopSessionId !== undefined && input.resumeLoopSessionId !== loopId)) return fail();
    // Reusing this intent can never authorize a later barrier, including after a crash/restart.
    if (alive.events(agentId).some(e => e.kind === "owner.resume-uncertain" && e.payload?.intentId === input.requestId)) return;
    const barrier = alive.resumeBarrier(agentId);
    if (observed.bindingRuntimeChatId === null || !observed.lifePresent || observed.agentId !== agentId || !observed.barrier || !barrier
      || observed.barrier.wakeId !== barrier.wakeId || observed.barrier.settledSequence !== barrier.settledSequence) return;
    const authority = store.aliveResearchContinuationAuthority(input.projectId, input.conversationId);
    if (agent.status !== "enabled" || authority.stopped || !authority.fullAutonomyStanding
      || alive.activeWakes().some(w => w.agentId === agentId) || alive.pendingActions().some(a => a.agentId === agentId)) return fail();
    alive.authorizeOwnerResume(agentId, input.requestId, barrier, Date.now());
  }).immediate();
}
