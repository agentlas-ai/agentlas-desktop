import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { getMemoryStoreInfo } from "./database";
import type { Runner } from "../runtime/runner";

/** Opaque, process-local source custody. Neither a run-id DTO, reply hash nor
 * a provider/renderer object can mint an original model-source binding. */
export interface MemorySourceCustody { readonly schema: "agentlas.memory-source-custody.v1" }
type Metadata = { runId?: string | null; chatId?: string | null; nodeId?: string | null; agentId?: string | null };
type State = { ownerNamespace: string | null; epoch: number | null; metadata: Metadata; sourceStarted: boolean;
  kind: "foreground" | "intake" | "worker"; actors: Map<string, Set<string>> };
const states = new WeakMap<MemorySourceCustody, State>();
const scopes = new AsyncLocalStorage<MemorySourceCustody>();
// Common modules initialize at host boot; worker callbacks must not inherit a
// foreground timer's history/effect/model-call ALS or its stale source token.
const background = new AsyncResource("agentlas-memory-source-worker");
const UNAVAILABLE = "memory-source-unavailable";
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function mint(metadata: Metadata, kind: State["kind"]): MemorySourceCustody {
  let ownerNamespace: string | null = null, epoch: number | null = null;
  try { const info = getMemoryStoreInfo(); ownerNamespace = info.ownerNamespace; epoch = info.revocationEpoch; } catch { /* Memory failure does not stop a source model. */ }
  const token: MemorySourceCustody = Object.freeze({ schema: "agentlas.memory-source-custody.v1" });
  states.set(token, { ownerNamespace, epoch, metadata: { ...metadata }, sourceStarted: kind !== "foreground", kind, actors: new Map() });
  return token;
}
export function currentMemorySourceCustody(): MemorySourceCustody | null { return scopes.getStore() ?? null; }
export function memorySourceSnapshot(token: MemorySourceCustody | null | undefined): { ownerNamespace: string; intakeEpoch: number } | null {
  const state = token && states.get(token);
  return state?.ownerNamespace && state.epoch !== null ? { ownerNamespace: state.ownerNamespace, intakeEpoch: state.epoch } : null;
}
export function assertMemorySourceCustody(token: MemorySourceCustody | null | undefined, context: Metadata = {}): void {
  const state = token && states.get(token);
  if (!state || !state.ownerNamespace || state.epoch === null || !state.sourceStarted) fail(UNAVAILABLE);
  const now = getMemoryStoreInfo();
  if (now.ownerNamespace !== state.ownerNamespace || now.revocationEpoch !== state.epoch) fail("memory_source_custody_changed");
  if (state.metadata.runId && context.runId && state.metadata.runId !== context.runId) fail("memory_source_run_changed");
  // Canonical actors are supplied by the host's model-call scope. Session or
  // residency req.agentId is deliberately not equated with a memory actor.
  const actors = state.actors.get(context.nodeId ?? "root");
  if (actors && actors.size > 1) fail("memory_source_actor_ambiguous");
  if (actors?.size && context.agentId && !actors.has(context.agentId)) fail("memory_source_actor_changed");
}

/** The existing native model-call scope spans original inference and all
 * post-turn policy/semantic/failure paths. Child phases inherit the same token. */
export function withMemorySourceScope<T>(metadata: Metadata, action: () => T, options: { ownerTurnRoot?: boolean } = {}): T {
  const existing = scopes.getStore();
  if (!existing && !metadata.runId && !metadata.chatId) return action();
  // An owner-turn root (one invocation = one run) that starts inside ANOTHER run's scope (a Goal continuation, a teammate session or a
  // verification run started from the previous run's completion) is a new original source. Inheriting the outer token bound its own
  // curation to the outer run id and refused it with memory_source_run_changed (observed in use: 7 refused curations and
  // terminal receipts; the failure receipt was refused for the same reason, so nothing recorded why). Nested phases of the same
  // run, and scopes without a root flag, keep inheriting exactly as before.
  const outer = existing ? states.get(existing)?.metadata.runId : undefined;
  const detach = options.ownerTurnRoot === true && Boolean(metadata.runId) && Boolean(outer) && outer !== metadata.runId;
  const token = (detach ? undefined : existing) ?? mint(metadata, "foreground");
  // Only an explicitly supplied host actor belongs to this node. The ledger
  // may inherit a parent actor for accounting; that is not child authority.
  if (metadata.agentId) {
    const state = states.get(token)!, key = metadata.nodeId ?? "root";
    const actors = state.actors.get(key) ?? new Set<string>();
    actors.add(metadata.agentId); state.actors.set(key, actors);
  }
  return scopes.run(token, action);
}

/** The custody check failed only because the store's revocation epoch moved: same owner namespace, same run, same actors. */
function custodyMovedByForgetOnly(error: unknown, token: MemorySourceCustody): boolean {
  if (!(error instanceof Error) || (error as { code?: unknown }).code !== "memory_source_custody_changed") return false;
  const state = states.get(token);
  if (!state?.ownerNamespace || state.epoch === null) return false;
  try {
    const now = getMemoryStoreInfo();
    return now.ownerNamespace === state.ownerNamespace && now.revocationEpoch !== state.epoch;
  } catch { return false; }
}

/** Actual selected runner dispatch, including callers without agentContext.
 * A reused runner has no mutable last-result owner; each host scope is distinct.
 * Unscoped dispatch may run but cannot authorize later unscoped memory writes. */
export function withMemorySourceRunner(runner: Runner): Runner {
  return async (request, events) => {
    if (request.judgmentOnly) return runner(request, events);
    const enclosing = scopes.getStore();
    const token = enclosing ?? mint({}, "foreground");
    const state = states.get(token)!;
    state.sourceStarted = true;
    // A scope may wait for admission/slots before actual inference. Rotation
    // during that wait must not expose the original source to the new owner.
    if (memorySourceSnapshot(token)) assertMemorySourceCustody(token);
    const result = await scopes.run(token, () => runner(request, events));
    // Keep the original token in the enclosing host scope on this failure; a
    // policy/terminal fallback cannot recapture the new account at registration.
    if (memorySourceSnapshot(token)) {
      try { assertMemorySourceCustody(token); }
      catch (error) {
        // The owner forgot or edited a memory entry (the store's revocation epoch moved, the owner's namespace did not) while this
        // model call ran. The reply is already in hand and discarding it undoes nothing; the fence only has to keep THIS turn
        // from recording what it learned, and it does: the enclosing host scope still holds the original token, so every later
        // memory write of the turn is refused by its own assertMemorySourceCustody, and a run that began before the forget has
        // its summary dropped (revocations.ts memoryRunPredatesAnyForget). Observed in use: a Goal wake's planner
        // call ended "claude-code runtime exit: memory_source_custody_changed" and the whole turn failed. An owner-namespace
        // change (account rotation), a token minted only for this call, and every other custody error still throw.
        if (!enclosing || !custodyMovedByForgetOnly(error, token)) throw error;
      }
    }
    return result;
  };
}

/** Only host-authored, explicit callback/context registration uses this intake
 * lane. Ordinary post-model registration supplies its original scope explicitly. */
export function captureTrustedMemoryIntake(context: Metadata): MemorySourceCustody { return scopes.getStore() ?? mint(context, "intake"); }
export function withMemorySourceCustody<T>(token: MemorySourceCustody | null | undefined, action: () => T): T {
  const current = scopes.getStore();
  if (current) { assertMemorySourceCustody(current); return action(); }
  assertMemorySourceCustody(token);
  return scopes.run(token!, action);
}
export function assertMemoryTicketSource(context: Metadata): void {
  const current = scopes.getStore();
  if (current) assertMemorySourceCustody(current, context);
  // Manual editor/import sources do not have a runtime run id. A runtime DTO
  // alone is not an original source capability, including policy-only paths.
  else if (context.runId) fail(UNAVAILABLE);
}

/** Queue processing owns a new captured canonical owner/epoch. Its SQL lease
 * and account-fenced facade independently validate the actual selected jobs. */
export function withIndependentMemoryWorker<T>(action: () => T): T {
  return background.runInAsyncScope(() => scopes.run(mint({}, "worker"), action));
}
