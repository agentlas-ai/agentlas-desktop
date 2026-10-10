import { AsyncResource } from "node:async_hooks";
import { invocationProcessOwner } from "../store/invocation-run-owners";
import { agentContextKey, type AgentContextIdentity } from "../store/agent-context";
import { createAgentContextCapability, type AgentContextCapability } from "../runtime/agent-context";
import {
  admitAwakeAgentResidency, admitWarmAgentResidency, isAgentContextResidencyAdmissionCurrent, isAwakeAgentResidencyAdmission, releaseAwakeAgentResidency, retireAwakeAgentResidencyAdapter, withAwakeAgentResidency,
  agentResidencyBudget, holdingAgentResidency, type AwakeAgentResidencyAdmission,
} from "../runtime/agent-residency";
import { onHostShutdown } from "../host-lifecycle";

type ActorState = "awake" | "paused" | "stopped";
export interface DaemonAgentContextTurn {
  turnId: string;
  /** Exact host-selected adapter/config identity, never the invocation ID. */
  adapterKey?: string;
  /** The original invocation still owns workspace, task, Goal and tool grants. */
  assertCurrent(): void;
  signal?: AbortSignal;
}
export interface DaemonAgentContextActor {
  contextKey: string;
  agentId: string;
  generation: number;
  state: ActorState;
  retention: "awake" | "warm";
  activeTurnId: string | null;
  pendingTurns: number;
  /** Zero is admitted context only, never proof of a live provider process. */
  residentResources: number;
}
interface Job {
  turnId: string;
  controller: AbortController;
  execute(): Promise<void>;
  reject(error: unknown): void;
  detachAbort(): void;
}
interface Actor {
  key: string;
  identity: AgentContextIdentity;
  generation: number;
  state: ActorState;
  admission?: AwakeAgentResidencyAdmission;
  /** Stop revokes admission immediately; an active physical owner may still
   * be settling and must remain visible until its pool releases it. */
  retiringAdmission?: AwakeAgentResidencyAdmission;
  active: Job | null;
  queue: Job[];
  /** Bounded transport dedupe; InvocationService retains durable admission. */
  turns: Map<string, { promise: Promise<unknown>; settled: boolean }>;
  adapterKey?: string;
}
function failure(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
function fail(code: string): never { throw failure(code); }

/** Abandon the wait promptly on stop/pause without cancelling the physical
 * termination receipt or releasing its capacity. */
function awaitRetirement(completion: void | Promise<void>, signal: AbortSignal): Promise<void> {
  if (!completion) { signal.throwIfAborted(); return Promise.resolve(); }
  return new Promise<void>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? failure("agent_context_turn_cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    void completion.then(() => { signal.removeEventListener("abort", abort); resolve(); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

/** One authenticated daemon owns the actors and their resident reservations.
 * This is not a second invocation/effect service. The callback enters the
 * original prepared invocation with an additional context capability only. */
export function createDaemonAgentContextHost(options: {
  bootId: string;
  ownerScope: string;
  serviceIdentity: string;
  assertOwner(): void;
  /** Trusted daemon resolver only. A current roster/life fence grants awake
   * retention; ordinary chat contexts default to normal warm-session LRU. */
  awakeLifetime?(identity: AgentContextIdentity): { assertCurrent(): void } | null;
  maxPendingTurns?: number;
  maxRetainedTurns?: number;
  maxRetainedActors?: number;
}) {
  const actors = new Map<string, Actor>();
  let closed = false;
  const maxPending = options.maxPendingTurns ?? agentResidencyBudget();
  const maxRetained = options.maxRetainedTurns ?? 256;
  const maxActors = options.maxRetainedActors ?? 256;
  if (![options.bootId, options.ownerScope, options.serviceIdentity].every(value => typeof value === "string" && value.trim())
    || !Number.isSafeInteger(maxPending) || maxPending < 1 || !Number.isSafeInteger(maxRetained) || maxRetained < 1
    || !Number.isSafeInteger(maxActors) || maxActors < 1) {
    fail("agent_context_host_configuration_invalid");
  }
  function currentHost(): void {
    if (closed) fail("agent_context_host_closed");
    options.assertOwner();
    const owner = invocationProcessOwner();
    if (owner.ownerKind !== "daemon" || owner.ownerId !== options.bootId) fail("agent_context_daemon_owner_required");
  }
  currentHost();
  function key(identity: AgentContextIdentity): string {
    if (identity.ownerScope !== options.ownerScope || identity.serviceIdentity !== options.serviceIdentity) fail("agent_context_owner_scope_changed");
    return agentContextKey(identity);
  }
  function reserve(actor: Actor): void {
    const generation = actor.generation;
    const lifetime = options.awakeLifetime?.(actor.identity) ?? null;
    lifetime?.assertCurrent();
    actor.admission = (lifetime ? admitAwakeAgentResidency : admitWarmAgentResidency)({ contextKey: actor.key, agentId: actor.identity.agentId,
      ownerEpoch: options.bootId, generation, assertCurrent() {
        currentHost();
        lifetime?.assertCurrent();
        if (actors.get(actor.key) !== actor || actor.generation !== generation || actor.state === "stopped") {
          fail("agent_context_actor_generation_changed");
        }
      } });
  }
  function resolve(identity: AgentContextIdentity): Actor {
    currentHost();
    const contextKey = key(identity);
    const found = actors.get(contextKey);
    if (found) {
      if (found.state === "awake" && !isAgentContextResidencyAdmissionCurrent(found.admission)) {
        if (found.active) fail("agent_context_turn_settling");
        if (found.admission) releaseAwakeAgentResidency(found.admission);
        found.admission = undefined;
        reserve(found);
      }
      actors.delete(contextKey); actors.set(contextKey, found);
      return found;
    }
    if (actors.size >= maxActors) {
      const retired = [...actors.values()].find(actor => !actor.active && !actor.queue.length
        && (actor.state === "stopped" || !isAwakeAgentResidencyAdmission(actor.admission)));
      if (!retired) fail("agent_context_actor_capacity");
      stopActor(retired);
      actors.delete(retired.key);
    }
    const actor: Actor = { key: contextKey, identity: { ...identity }, generation: 1, state: "awake",
      active: null, queue: [], turns: new Map() };
    actors.set(contextKey, actor);
    try { reserve(actor); } catch (error) { actors.delete(contextKey); throw error; }
    return actor;
  }
  function view(actor: Actor): DaemonAgentContextActor {
    return { contextKey: actor.key, agentId: actor.identity.agentId, generation: actor.generation,
      state: actor.state, retention: isAwakeAgentResidencyAdmission(actor.admission) ? "awake" : "warm", activeTurnId: actor.active?.turnId ?? null, pendingTurns: actor.queue.length,
      residentResources: holdingAgentResidency().filter(entry => entry.awakeAdmission !== undefined
        && (entry.awakeAdmission === actor.admission || entry.awakeAdmission === actor.retiringAdmission)).length };
  }
  function trim(actor: Actor): void {
    for (const [turnId, turn] of actor.turns) {
      if (actor.turns.size <= maxRetained) return;
      if (turn.settled) actor.turns.delete(turnId);
    }
  }
  function pump(actor: Actor): void {
    if (closed || actor.state !== "awake" || actor.active) return;
    const job = actor.queue.shift();
    if (!job) return;
    actor.active = job;
    // execute owns every rejection, including authority failure before dispatch.
    void job.execute().finally(() => {
      job.detachAbort();
      if (actor.active === job) actor.active = null;
      const receipt = actor.turns.get(job.turnId);
      if (receipt) receipt.settled = true;
      trim(actor);
      pump(actor);
    });
  }
  function rejectQueued(actor: Actor, code: string): void {
    for (const job of actor.queue.splice(0)) {
      job.controller.abort(failure(code));
      job.detachAbort();
      job.reject(failure(code));
      const receipt = actor.turns.get(job.turnId);
      if (receipt) receipt.settled = true;
    }
    trim(actor);
  }
  function stopActor(actor: Actor): void {
    if (actor.state !== "stopped") actor.generation += 1;
    actor.state = "stopped";
    // Captured terminal controls are unconditional, even after the socket or
    // owner fence expires. They never start work or import another authority.
    actor.active?.controller.abort(failure("agent_context_stopped"));
    rejectQueued(actor, "agent_context_stopped");
    if (actor.admission) {
      actor.retiringAdmission = actor.admission;
      releaseAwakeAgentResidency(actor.admission);
    }
    actor.admission = undefined;
  }
  const detachShutdown = onHostShutdown(() => close());
  function close(): void {
    if (closed) return;
    closed = true;
    for (const actor of actors.values()) stopActor(actor);
    detachShutdown();
  }

  return {
    /** Roster reconciliation admits a bounded actor without claiming a process
     * was opened. Existing adapter attach/first turn supplies that evidence. */
    admit(identity: AgentContextIdentity): DaemonAgentContextActor { return view(resolve(identity)); },
    runTurn<T>(identity: AgentContextIdentity, turn: DaemonAgentContextTurn,
      execute: (capability: AgentContextCapability, signal: AbortSignal) => Promise<T>): Promise<T> {
      let actor: Actor;
      try {
        if (!turn?.turnId?.trim() || typeof turn.assertCurrent !== "function") fail("agent_context_turn_binding_required");
        turn.signal?.throwIfAborted();
        turn.assertCurrent();
        actor = resolve(identity);
        if (actor.state !== "awake") fail(`agent_context_${actor.state}`);
        const known = actor.turns.get(turn.turnId);
        if (known) return known.promise as Promise<T>;
        if (actor.queue.length >= maxPending) fail("agent_context_mailbox_capacity");
      } catch (error) { return Promise.reject(error); }
      const generation = actor.generation;
      const controller = new AbortController();
      let resolveResult!: (value: T) => void;
      let rejectResult!: (error: unknown) => void;
      const promise = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
      // A queued job is pumped by the previous job's settlement continuation.
      // Preserve this admission's original invocation/tool/History scopes;
      // only re-entering Awake ALS would otherwise borrow the previous turn.
      const invocationScope = new AsyncResource("AgentlasAgentContextTurn", { requireManualDestroy: true });
      let scopeDestroyed = false;
      const abort = () => {
        controller.abort(turn.signal?.reason);
        if (actor.active !== job) {
          const index = actor.queue.indexOf(job);
          if (index >= 0) actor.queue.splice(index, 1);
          job.detachAbort();
          job.reject(controller.signal.reason ?? failure("agent_context_turn_cancelled"));
          const receipt = actor.turns.get(job.turnId);
          if (receipt) receipt.settled = true;
          trim(actor);
        }
      };
      const job: Job = { turnId: turn.turnId, controller, reject: rejectResult,
        detachAbort() {
          turn.signal?.removeEventListener("abort", abort);
          // Queued cancellation ends now; active cancellation stays retained
          // until execute actually settles and pump calls this cleanup.
          if (!scopeDestroyed) { scopeDestroyed = true; invocationScope.emitDestroy(); }
        },
        execute: () => invocationScope.runInAsyncScope(async () => {
          try {
            const assertCurrent = () => {
              currentHost();
              controller.signal.throwIfAborted();
              if (actors.get(actor.key) !== actor || actor.generation !== generation || actor.state !== "awake" || actor.active !== job) {
                fail("agent_context_actor_generation_changed");
              }
              turn.assertCurrent();
            };
            assertCurrent();
            if (!actor.admission) fail("agent_context_awake_admission_required");
            if (turn.adapterKey !== undefined) {
              if (!turn.adapterKey.trim()) fail("agent_context_adapter_identity_invalid");
              if (actor.adapterKey !== undefined && actor.adapterKey !== turn.adapterKey) {
                await awaitRetirement(retireAwakeAgentResidencyAdapter(actor.admission), controller.signal);
                assertCurrent();
              }
              actor.adapterKey = turn.adapterKey;
            }
            const capability = createAgentContextCapability(actor.identity, { turnId: turn.turnId, assertCurrent });
            const value = await withAwakeAgentResidency(actor.admission, () => execute(capability, controller.signal), assertCurrent);
            // Late output after Stop or ownership change cannot be reported as
            // a current actor turn. The existing invocation keeps its receipt.
            assertCurrent();
            resolveResult(value);
          } catch (error) { rejectResult(error); }
        }) };
      actor.turns.set(turn.turnId, { promise, settled: false });
      actor.queue.push(job);
      turn.signal?.addEventListener("abort", abort, { once: true });
      if (turn.signal?.aborted) abort();
      pump(actor);
      return promise;
    },
    pause(identity: AgentContextIdentity): DaemonAgentContextActor {
      currentHost();
      const actor = actors.get(key(identity));
      if (!actor) fail("agent_context_actor_missing");
      if (actor.state === "stopped") return view(actor);
      actor.state = "paused";
      actor.active?.controller.abort(failure("agent_context_paused"));
      rejectQueued(actor, "agent_context_paused");
      return view(actor);
    },
    resume(identity: AgentContextIdentity): DaemonAgentContextActor {
      currentHost();
      const actor = actors.get(key(identity));
      if (!actor) return view(resolve(identity));
      if (actor.active) fail("agent_context_turn_settling");
      if (actor.state === "awake") return view(actor);
      const previous = actor.state;
      actor.state = "awake";
      try { if (!isAgentContextResidencyAdmissionCurrent(actor.admission)) reserve(actor); }
      catch (error) { actor.state = previous; throw error; }
      return view(actor);
    },
    stop(identity: AgentContextIdentity): DaemonAgentContextActor | null {
      const actor = actors.get(key(identity));
      if (!actor) return null;
      stopActor(actor);
      return view(actor);
    },
    release(identity: AgentContextIdentity): DaemonAgentContextActor | null {
      const actor = actors.get(key(identity));
      if (!actor) return null;
      stopActor(actor);
      // Retain a settling writer until it acknowledges stop; a replacement
      // actor with the same key must not race a still-active old callback.
      if (!actor.active) actors.delete(actor.key);
      return view(actor);
    },
    /** Captured maintenance control stays usable after an owner fence expires.
     * Active or queued work is retained until its own terminal control settles. */
    releaseIdle(): { releasedActors: number; activeActors: number } {
      let releasedActors = 0;
      for (const actor of [...actors.values()]) {
        if (actor.active || actor.queue.length) continue;
        stopActor(actor); actors.delete(actor.key); releasedActors += 1;
      }
      return { releasedActors, activeActors: actors.size };
    },
    snapshot(): DaemonAgentContextActor[] { return [...actors.values()].map(view); },
    close,
  };
}
