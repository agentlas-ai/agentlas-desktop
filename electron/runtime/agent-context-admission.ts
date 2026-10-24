import { carryRunnerTurnContext } from "./runner-turn-context-binding";
import { carrySurfaceMemoryRequest } from "../memory/surface-recall";
import { createHash } from "node:crypto";
import { getAuthenticatedActorIds, onAuthSessionInvalidated, onAuthSessionRestored } from "../auth";
import { onDesktopStoreChange } from "../store/change-bus";
import { aliveDecisionProfileForRequest } from "./alive-decision-context";
import { captureNativeAuthBinding } from "../daemon/native-auth-credentials";
import { createDaemonAgentContextHost } from "../daemon/agent-context-host";
import { getDb } from "../store/db";
import { invocationProcessOwner, invocationRunOwners, assertInvocationRunOwner } from "../store/invocation-run-owners";
import { createAgentContextCapability, agentContextHostBinding, bootstrapAgentContextHistory, markAgentContextHostAuthored, copyAgentContextHostAuthored,
  markAgentContextChannel, copyAgentContextChannel, copyAgentContextForwardGeneration, reconcileInterruptedAgentContext, nextAgentContextTurnOrdinal, openAgentContextTurnId, recordAgentContextScopeAdoption, recordAgentContextScopeFailure, importSharedChatHistory, type AgentContextCapability } from "./agent-context";
import { markRefusedBeforeDispatch, type Runner, type RunnerEvents, type RunnerRequest } from "./runner";
import { resolveSessionScope, rosterSessionIsCurrent, workingSessionIsCurrent, taskforceSessionScopeIsCurrent, assertProjectWorkSessionFacts, assertWorkingSessionBindingCurrent, requiresProjectWorkingSessionScope } from "./session-scope";
import { acquireAgentContextTurnSlot, AgentContextTurnWaitError, type AgentContextTurnSlot } from "./agent-context-turn-order";
import { createTurnLine, type TurnLineDb } from "./agent-context-turn-line";
import { listPendingToolApprovals } from "./tool-approval";
import { listPendingAskUserRequests } from "../confirm/ask-user";
import { CHAT_BUSY_OTHER_HOST_CODE, ensureChatHostHandover } from "./chat-host-handover";
import { agentContextKey } from "../store/agent-context";
import { tStatus } from "./status-i18n";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
export function agentContextOwnerBinding() {
  const native = captureNativeAuthBinding(), actor = getAuthenticatedActorIds();
  // Custody follows the store the journal lives in (install, user-data directory and store path: native.scope), not the
  // store file's device number that the service identity hashes: macOS renumbers it at every mount, and after the
  // 2026-10-12 reboot every agent's journal was started again.
  return { serviceIdentity: digest(["agentlas.agent-context.custody.v1", native.scope]), ownerScope: digest([native.scope, actor?.userId ?? null, actor?.workspaceId ?? null]) };
}
/** Only the original host dispatch calls this function. A context is data
 * custody, never a replacement for the invocation's effect/tool authority. */
export function bindInvocationAgentContext(request: RunnerRequest, input: {
  chatId: string; agentId: string; runId: string; attempt: number;
  aliveController: boolean; assertCurrent(): void;
  workingScopeRequired?: boolean;
  /** Typed purpose when the host, not the owner, wrote this turn's input (a Goal continuation); replay compacts it. */
  hostAuthored?: string;
}): RunnerRequest {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) fail("agent_context_attempt_identity_required");
  const owner = invocationRunOwners.getRunOwner(input.chatId, input.runId), processOwner = invocationProcessOwner();
  if (!owner || owner.ownerId !== processOwner.ownerId || owner.ownerKind !== processOwner.ownerKind) fail("agent_context_original_invocation_owner_required");
  const row = getDb().prepare("SELECT agent_id,kind,parent_chat_id,archived_at,origin_surface AS origin,project_id,seat_id,seat_kind FROM chats WHERE id=?").get(input.chatId) as
    { agent_id: string; kind: string | null; parent_chat_id: string | null; archived_at:string|null; origin:string|null; project_id:string|null; seat_id: string | null; seat_kind: string | null } | undefined;
  if (!row || row.agent_id !== input.agentId || row.archived_at) fail("agent_context_original_agent_required");
  const identity = agentContextOwnerBinding();
  // Which journal this conversation's turns belong to (session-scope.ts): its own, as before, except a one-to-one seat
  // conversation, which continues its seat's journal of this agent, and the dispatch child of a roster member, which is the same
  // session. A failure there returns the old formula, except for those two kinds, whose turn is refused instead.
  const scope = resolveSessionScope(getDb(), { chatId: input.chatId, agentId: input.agentId, kind: row.kind, parentChatId: row.parent_chat_id,
    aliveController: input.aliveController, ownerScope: identity.ownerScope, persist: true,
    workingScopeRequired: input.workingScopeRequired === true || requiresProjectWorkingSessionScope({origin:row.origin,projectId:row.project_id,kind:row.kind,parentChatId:row.parent_chat_id}),
    chat: { agentId: row.agent_id, kind: row.kind, origin: row.origin, seatId: row.seat_id, seatKind: row.seat_kind } });
  if (scope.unavailable) {
    // A seat conversation or a member's dispatch child whose journal could not be resolved is not started on a journal of its own:
    // that turn would be missing from the shared session for good. The cause is a run event; the owner reads a plain sentence and sends again.
    recordAgentContextScopeFailure(`agent-context-turn:${JSON.stringify([input.chatId, input.runId, input.attempt])}`, input.agentId,
      { scopeKind: row.kind === "division" ? "roster" : "seat", causeCode: scope.failure?.causeCode ?? "session_scope_resolve_failed" });
    throw markRefusedBeforeDispatch(Object.assign(new Error(tStatus(request.locale === "ko" ? "ko" : "en", "sessionScopeUnavailable")), { code: "session_scope_unavailable" }));
  }
  const visibilityDomain = scope.visibilityDomain;
  const assertCurrent = () => {
    request.signal?.throwIfAborted(); input.assertCurrent(); assertInvocationRunOwner(owner);
    const latest = agentContextOwnerBinding();
    if (latest.ownerScope !== identity.ownerScope || latest.serviceIdentity !== identity.serviceIdentity) fail("agent_context_owner_binding_changed");
    if (scope.workBinding) assertWorkingSessionBindingCurrent(getDb(),scope.workBinding);
    if (scope.projectWork) assertProjectWorkSessionFacts(getDb(), scope.projectWork);
    if(scope.taskforce && !taskforceSessionScopeIsCurrent(getDb(),scope.taskforce,input.agentId))fail("agent_context_taskforce_visibility_changed");
    const current = getDb().prepare("SELECT agent_id,kind,parent_chat_id,archived_at,origin_surface AS origin,seat_id,seat_kind FROM chats WHERE id=?").get(input.chatId) as typeof row;
    if (!current || current.agent_id !== row.agent_id || current.kind !== row.kind || current.parent_chat_id !== row.parent_chat_id || current.origin !== row.origin || current.archived_at) fail("agent_context_visibility_changed");
    // The seat is part of a seat scope's identity; for every other conversation it is not looked at (as before).
    if (scope.seat && (current.seat_id !== scope.seat.seatId || current.seat_kind !== scope.seat.seatKind)) fail("agent_context_visibility_changed");
  };
  const contextIdentity = { ...identity, agentId: input.agentId, visibilityDomain };
  // One run may invoke this chat's agent more than once (graph agent steps on their automation chat): each invocation's
  // attempt counter restarts at 1, so the turn ordinal continues after every turn of this run the journal already holds.
  const ordinal = nextAgentContextTurnOrdinal(contextIdentity, input.chatId, input.runId, input.attempt);
  const turnId = `agent-context-turn:${JSON.stringify([input.chatId, input.runId, ordinal])}`;
  const capability = createAgentContextCapability(contextIdentity, { turnId, assertCurrent });
  if (scope.shared) sharedSessionCapabilities.add(capability);
  // A session several conversations share is told where this turn is spoken (runtime/session-channel.ts); no other turn is.
  markAgentContextChannel(capability, scope.shared ? scope.channel : null);
  if (scope.assignment?.created && scope.assignment.outcome !== "existing") recordAgentContextScopeAdoption(turnId, contextIdentity,
    { outcome: scope.assignment.outcome, scopeKind: scope.kind, retainedDomains: scope.assignment.retainedDomains });
  // Initial migration belongs to this exact authorized chat only. The journal
  // becomes authoritative afterwards; chat projections are not imported again.
  bootstrapAgentContextHistory(capability, request.history);
  markAgentContextHostAuthored(capability, input.hostAuthored);
  return carryRunnerTurnContext(request, { ...request, agentContext: capability });
}
/**
 * Whether this conversation's turns will run on a journal several conversations share (read only; admission stores the assignment).
 * For prompt text that must exist only for such a session. Any failure answers false: the same failure refuses the turn at admission.
 */
export function conversationSharesSession(chatId: string, agentId: string): boolean {
  try {
    const row = getDb().prepare("SELECT agent_id,kind,parent_chat_id,origin_surface AS origin,project_id,seat_id,seat_kind FROM chats WHERE id=?").get(chatId) as
      { agent_id: string; kind: string | null; parent_chat_id: string | null; origin: string | null; project_id:string|null; seat_id: string | null; seat_kind: string | null } | undefined;
    if (!row || row.agent_id !== agentId) return false;
    return resolveSessionScope(getDb(), { chatId, agentId, kind: row.kind, parentChatId: row.parent_chat_id, aliveController: false,
      ownerScope: agentContextOwnerBinding().ownerScope, persist: false,
      workingScopeRequired: requiresProjectWorkingSessionScope({origin:row.origin,projectId:row.project_id,kind:row.kind,parentChatId:row.parent_chat_id}),
      chat: { agentId: row.agent_id, kind: row.kind, origin: row.origin, seatId: row.seat_id, seatKind: row.seat_kind } }).shared;
  } catch { return false; }
}
/** Capabilities whose journal is shared by several conversations (a seat scope): their turns run one after the other. */
const sharedSessionCapabilities = new WeakSet<object>();
export function isSharedSessionCapability(value: unknown): boolean { return !!value && typeof value === "object" && sharedSessionCapabilities.has(value); }
/** The open delivery's turn when it belongs to a run of ANOTHER conversation that is still going: its turn will settle by itself. */
function otherConversationTurn(turnId: string, ownChatId: string): { chatId: string; runId: string } | null {
  try {
    const ref = turnRunRef(turnId);
    if (!ref || !ref.chatId || !ref.runId || ref.chatId === ownChatId) return null;
    const owner = invocationRunOwners.getRunOwner(ref.chatId, ref.runId);
    return owner && owner.state !== "released" ? ref : null;
  } catch { return null; }
}
function assertPreviousTurnTerminal(turnId: string): void {
  if (!turnId.startsWith("agent-context-turn:")) fail("agent_context_prior_turn_unsettled");
  let source: unknown;
  try { source = JSON.parse(turnId.slice("agent-context-turn:".length)); } catch { fail("agent_context_prior_turn_unsettled"); }
  if (!Array.isArray(source) || source.length !== 3 || typeof source[0] !== "string" || typeof source[1] !== "string") fail("agent_context_prior_turn_unsettled");
  const [chatId, runId] = source, owner = invocationRunOwners.getRunOwner(chatId, runId);
  if (!owner || owner.state !== "released") fail("agent_context_prior_turn_unsettled");
  // Exact owner release follows execution drainage or the existing dead-host
  // fence. A missing historical receipt cannot hold a distinct new turn;
  // preserve the old delivery and external effects as uncertain, without replay.
}
let daemon: { key: string; host: ReturnType<typeof createDaemonAgentContextHost> } | null = null;
const awakeIdentities=new Map<string,ReturnType<typeof agentContextHostBinding>["identity"]>();
/**
 * Whether the background service keeps this journal's resident process awake: the journal is a roster member's. Two shapes:
 * the member's own dispatch child (`one-team:<room>:session:<child>`, as before), or the member's seat session as the seat scope
 * assigned it (session-scope.ts: the one-to-one conversations and the dispatch children share it, whatever domain string it has).
 * Either needs the member to be on the roster now; the fence is read again at every admission.
 */
function awakeLifetime(identity:ReturnType<typeof agentContextHostBinding>["identity"]):{assertCurrent():void}|null {
  const match=/^one-team:([^:]+):session:(.+)$/.exec(identity.visibilityDomain);
  const childActive=()=>{
    if(!match)return false;
    const [parent,chat]=match.slice(1);
    return !!getDb().prepare(`SELECT 1 FROM chats c WHERE c.id=? AND c.parent_chat_id=?
      AND c.agent_id=? AND c.kind='division' AND c.origin_surface='one' AND c.archived_at IS NULL
      AND EXISTS(SELECT 1 FROM one_team_dispatches d JOIN one_org_members m ON m.id=d.member_id
        WHERE d.child_chat_id=c.id AND d.parent_chat_id=c.parent_chat_id
        AND m.installed_agent_id=c.agent_id AND m.archived_at IS NULL)`).get(chat,parent,identity.agentId);
  };
  const active=()=>childActive()||rosterSessionIsCurrent(getDb(),identity)||workingSessionIsCurrent(getDb(),identity);
  if(!active())return null;
  awakeIdentities.set(digest(identity),identity);
  return {assertCurrent(){if(!active())fail("agent_context_roster_lifetime_changed");}};
}
function closeDaemonContexts():void {daemon?.host.close();daemon=null;awakeIdentities.clear();}
function reconcileDaemonContexts():void {
  if(!daemon)return;
  const owner=invocationProcessOwner();
  if(owner.ownerKind!=="daemon" || daemon.key!==digest([owner.ownerId,agentContextOwnerBinding()])){closeDaemonContexts();return;}
  for(const [key,identity]of awakeIdentities){
    if(awakeLifetime(identity))continue;
    daemon.host.stop(identity);awakeIdentities.delete(key);
  }
}
// Same-account token refresh preserves context. A changed account/install or
// roster/archive retires captured resources without admitting another turn.
onAuthSessionInvalidated(reconcileDaemonContexts);
onAuthSessionRestored(reconcileDaemonContexts);
onDesktopStoreChange(change=>{if(["chat","one-org","agent"].includes(change.entity))reconcileDaemonContexts();});
export function daemonAgentContextSnapshot(){reconcileDaemonContexts();return daemon?.host.snapshot()??[];}
/** Captured maintenance affects idle owners only; active/queued turns settle
 * under their original controls and remain visible to the registry. */
export function releaseIdleDaemonAgentContexts(){reconcileDaemonContexts();return daemon?.host.releaseIdle()??{releasedActors:0,activeActors:0};}
/** The selection seam routes the actual runner through the daemon's actor.
 * Desktop compatibility calls retain context without claiming daemon residency.
 * A turn on a shared session (several conversations of a seat's agent) first waits for the turn that holds it. */
export function withDaemonAgentContext(runner: Runner, provider: { kind: string; backend?: string; configurationIdentity?: string }): Runner {
  const routed = routeAgentContextRunner(runner, provider);
  return (request, events) => {
    if (!isSharedSessionCapability(request.agentContext) || aliveDecisionProfileForRequest(request)) return routed(request, events);
    return (async () => {
      const slot = await waitForSharedSession(request, events);
      try {
        // The process that ran the session's last turn may still hold its idle resident process on the provider thread.
        await handOverSharedSessionHost(request);
        // Now no turn of this process holds the journal (and none of another): a conversation joining it late brings its own messages.
        try { if (request.chatId) importSharedChatHistory(request.agentContext as AgentContextCapability, request.chatId, request.history ?? []); }
        catch (error) { console.warn(`[session-scope] earlier messages of the conversation were not added to the shared journal: ${error instanceof Error ? error.message : String(error)}`); }
        return await routed(request, events);
      } finally { slot.release(); }
    })();
  };
}
/** `agent-context-turn:["<chat id>","<run id>",<ordinal>]` → the conversation and the run it names. */
function turnRunRef(turnId: string): { chatId: string; runId: string } | null {
  try {
    if (!turnId.startsWith("agent-context-turn:")) return null;
    const source: unknown = JSON.parse(turnId.slice("agent-context-turn:".length));
    return Array.isArray(source) && typeof source[0] === "string" && typeof source[1] === "string" ? { chatId: source[0], runId: source[1] } : null;
  } catch { return null; }
}
/** `work` unless the turn is stopped first: a Stop ends the wait at once (the work itself is bounded and finishes on its own). */
const untilAborted = <T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> => new Promise<T>((resolve, reject) => {
  const onAbort = (): void => reject(signal?.reason ?? new Error("agent_context_handover_cancelled"));
  if (signal?.aborted) { onAbort(); return; }
  signal?.addEventListener("abort", onAbort, { once: true });
  work.then(resolve, reject).finally(() => signal?.removeEventListener("abort", onAbort));
});
const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
/**
 * A provider allows one writer per thread (Codex: "already has an active writer"), and a resident runtime session of the
 * other process keeps the thread after its turn. The host handover (chat-host-handover.ts) frees it for a conversation's own
 * next turn in the other process, because the owner table names that conversation's previous run. A shared session is also
 * held by the turns of ANOTHER conversation, so the same ask is made for the conversation whose turn was the journal's last:
 * its idle resident process is released and this turn resumes the same thread.
 *
 * It decides nothing else. Only a turn of the other process (window process <-> background service) is asked about; the ask
 * is bounded and an unreachable or refusing peer changes nothing, so the runner's own writer handling answers as it did before.
 * A peer that still has the previous conversation's lease for a moment is asked again a few times (its run lease and its
 * resident process are put back one after the other), never refused for.
 */
async function handOverSharedSessionHost(request: RunnerRequest): Promise<void> {
  try {
    const capability = request.agentContext as AgentContextCapability, held = agentContextHostBinding(capability);
    const own = turnRunRef(held.turnId), local = invocationProcessOwner().ownerKind;
    if (!own || (local !== "desktop" && local !== "daemon")) return;
    const last = getDb().prepare("SELECT turn_id FROM agent_context_deliveries WHERE context_key=? AND turn_id<>? ORDER BY rowid DESC LIMIT 1")
      .get(agentContextKey(held.identity), held.turnId) as { turn_id: string } | undefined;
    const prior = last ? turnRunRef(last.turn_id) : null;
    // The same conversation's own previous turn is the host handover's business (invocation/service.ts handOverChatHost).
    if (!prior || prior.chatId === own.chatId) return;
    const previous = invocationRunOwners.getRunOwner(prior.chatId, prior.runId);
    if (!previous || previous.ownerKind === local) return;
    for (let attempt = 0; ; attempt += 1) {
      request.signal?.throwIfAborted();
      try {
        await untilAborted(ensureChatHostHandover({
          chatId: prior.chatId, runId: own.runId, localKind: local, previous: { ownerKind: previous.ownerKind },
          record(line, fields) {
            try {
              const { tryRecordRunEvent } = require("../store/run-events") as typeof import("../store/run-events");
              tryRecordRunEvent({ runId: own.runId, chatId: own.chatId, kind: "runtime_session_handover", payload: { line, ...fields } });
            } catch { /* the line below is the record */ }
            console.info(line);
          },
        }), request.signal);
        return;
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== CHAT_BUSY_OTHER_HOST_CODE || attempt >= 6) return;
        await untilAborted(pause(500), request.signal);
      }
    }
  } catch { /* nothing here may refuse a turn: the runner's own handling of a held thread stays as it was */ }
}
/** The durable line of turns on shared sessions (agent-context-turn-line.ts): the places live in the store both processes share. */
let sharedTurnLine: ReturnType<typeof createTurnLine> | null = null;
function turnLine(): ReturnType<typeof createTurnLine> {
  return sharedTurnLine ??= createTurnLine({
    db: () => getDb() as unknown as TurnLineDb,
    who: () => { const owner = invocationProcessOwner(); return { ownerId: owner.ownerId, ownerKind: owner.ownerKind, pid: process.pid }; },
    // The same evidence the run-owner code keeps: a turn whose run lease was released, or taken by a newer lease, is over.
    runEnded: turn => {
      const owner = invocationRunOwners.getRunOwner(turn.chatId, turn.runId);
      return !!owner && (owner.state === "released" || (!!turn.leaseId && owner.leaseId !== turn.leaseId));
    },
    // What this process's turn of a chat waits on a person for. Only live asks count: they block the run, a notice of a denied call does not.
    parkedOn: chatId => listPendingToolApprovals().some(request => request.chatId === chatId) ? "approval"
      : listPendingAskUserRequests().some(request => request.chatId === chatId) ? "question" : null,
  });
}
/** Test seam: limits shorter than the product's, to reach one through the real seam in seconds. null restores the product's. */
let sharedTurnWaitLimits: { maxWaitMs?: number; parkGraceMs?: number; stuckGraceMs?: number } = {};
export function setSharedTurnWaitLimitsForTest(limits: { maxWaitMs?: number; parkGraceMs?: number; stuckGraceMs?: number } | null): void { sharedTurnWaitLimits = limits ?? {}; }
/** The refusal a wait that ended without the session becomes: a plain sentence in the owner's language, the machine code kept on `code`. */
function turnWaitRefusal(error: AgentContextTurnWaitError, locale: "ko" | "en"): Error {
  const key = error.reason === "parked" ? (error.parkedOn === "question" ? "agentContextTurnParkedQuestion" : "agentContextTurnParkedApproval")
    : error.reason === "stuck" ? "agentContextTurnStuck" : "agentContextTurnWaitExpired";
  return Object.defineProperty(Object.assign(new Error(tStatus(locale, key)), { code: error.code }), "cause", { value: error, configurable: true, writable: true });
}
async function waitForSharedSession(request: RunnerRequest, events: RunnerEvents): Promise<AgentContextTurnSlot> {
  const locale = request.locale === "ko" ? "ko" : "en";
  try {
    const capability = request.agentContext as AgentContextCapability, held = agentContextHostBinding(capability);
    const own = turnRunRef(held.turnId), ownChatId = own?.chatId ?? "";
    let leaseId: string | null = null;
    if (own) { try { leaseId = invocationRunOwners.getRunOwner(own.chatId, own.runId)?.leaseId ?? null; } catch { leaseId = null; } }
    const key = agentContextKey(held.identity);
    const openHolder = (): { chatId: string; runId: string } | null => {
      const open = openAgentContextTurnId(capability);
      return open !== null && open !== held.turnId ? otherConversationTurn(open, ownChatId) : null;
    };
    return await acquireAgentContextTurnSlot(key, {
      signal: request.signal,
      blocked: () => openHolder() !== null,
      blockedTurn: openHolder,
      line: own ? () => turnLine().enqueue(key, { chatId: own.chatId, runId: own.runId, leaseId }) : undefined,
      onWait() { events.onStatus?.(tStatus(locale, "agentContextTurnWait")); },
      ...sharedTurnWaitLimits,
    });
  } catch (error) { throw markRefusedBeforeDispatch(error instanceof AgentContextTurnWaitError ? turnWaitRefusal(error, locale) : error); }
}
function routeAgentContextRunner(runner: Runner, provider: { kind: string; backend?: string; configurationIdentity?: string }): Runner {
  return async (request, events) => {
    if (!request.agentContext) return runner(request, events);
    if(aliveDecisionProfileForRequest(request))return runner(request,events);
    const held = agentContextHostBinding(request.agentContext as AgentContextCapability), owner = invocationProcessOwner();
    if (owner.ownerKind !== "daemon") {
      // An unsettled earlier turn refuses this one before anything is sent (typed RuntimeTurnDelivery "not-dispatched").
      try { reconcileInterruptedAgentContext(request.agentContext, assertPreviousTurnTerminal); }
      catch (error) { throw markRefusedBeforeDispatch(error); }
      return runner(request, events);
    }
    const binding = agentContextOwnerBinding(), key = digest([owner.ownerId, binding]);
    if (daemon?.key !== key) {
      daemon?.host.close();
      daemon = { key, host: createDaemonAgentContextHost({ bootId: owner.ownerId, ...binding, awakeLifetime, assertOwner() {
        const current = invocationProcessOwner(), auth = agentContextOwnerBinding();
        if (current.ownerId !== owner.ownerId || current.ownerKind !== "daemon"
          || auth.ownerScope !== binding.ownerScope || auth.serviceIdentity !== binding.serviceIdentity) fail("agent_context_daemon_owner_changed");
      } }) };
    }
    const adapterKey = digest([provider.kind, provider.backend ?? null, provider.configurationIdentity ?? null, request.runtimeSource ?? null,
      request.model ?? null, request.permission ?? null, request.planMode ?? false, request.cwd ?? null,
      request.mcpAllowedTools ?? null, request.workforceRuntimeToolGrant?.canonicalConfigSha256 ?? null]);
    return daemon.host.runTurn(held.identity, { turnId: held.turnId, adapterKey, assertCurrent: held.assertCurrent, signal: request.signal },
      (capability, signal) => {
        try { reconcileInterruptedAgentContext(capability, assertPreviousTurnTerminal); }
        catch (error) { throw markRefusedBeforeDispatch(error); }
        // The daemon admits the same turn under its own capability; the host-authored marker follows the turn.
        copyAgentContextHostAuthored(request.agentContext as AgentContextCapability, capability);
        copyAgentContextChannel(request.agentContext as AgentContextCapability, capability);
        copyAgentContextForwardGeneration(request.agentContext as AgentContextCapability, capability);
        return runner(carrySurfaceMemoryRequest(request, carryRunnerTurnContext(request, { ...request, agentContext: capability, signal })), events);
      });
  };
}
