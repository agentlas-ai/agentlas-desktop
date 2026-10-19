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
  reconcileInterruptedAgentContext, nextAgentContextTurnOrdinal, type AgentContextCapability } from "./agent-context";
import { markRefusedBeforeDispatch, type Runner, type RunnerRequest } from "./runner";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
export function agentContextOwnerBinding() {
  const native = captureNativeAuthBinding(), actor = getAuthenticatedActorIds();
  


  return { serviceIdentity: digest(["agentlas.agent-context.custody.v1", native.scope]), ownerScope: digest([native.scope, actor?.userId ?? null, actor?.workspaceId ?? null]) };
}
/** Only the original host dispatch calls this function. A context is data
 * custody, never a replacement for the invocation's effect/tool authority. */
export function bindInvocationAgentContext(request: RunnerRequest, input: {
  chatId: string; agentId: string; runId: string; attempt: number;
  aliveController: boolean; assertCurrent(): void;
  /** Typed purpose when the host, not the owner, wrote this turn's input (a Goal continuation); replay compacts it. */
  hostAuthored?: string;
}): RunnerRequest {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) fail("agent_context_attempt_identity_required");
  const owner = invocationRunOwners.getRunOwner(input.chatId, input.runId), processOwner = invocationProcessOwner();
  if (!owner || owner.ownerId !== processOwner.ownerId || owner.ownerKind !== processOwner.ownerKind) fail("agent_context_original_invocation_owner_required");
  const row = getDb().prepare("SELECT agent_id,kind,parent_chat_id,archived_at,origin_surface AS origin FROM chats WHERE id=?").get(input.chatId) as
    { agent_id: string; kind: string | null; parent_chat_id: string | null; archived_at:string|null; origin:string|null } | undefined;
  if (!row || row.agent_id !== input.agentId || row.archived_at) fail("agent_context_original_agent_required");
  const identity = agentContextOwnerBinding();
  const visibilityDomain = input.aliveController ? `alive-controller:${input.chatId}`
    : row.kind === "division" && row.parent_chat_id ? `one-team:${row.parent_chat_id}:session:${input.chatId}` : `chat:${input.chatId}`;
  const assertCurrent = () => {
    request.signal?.throwIfAborted(); input.assertCurrent(); assertInvocationRunOwner(owner);
    const latest = agentContextOwnerBinding();
    if (latest.ownerScope !== identity.ownerScope || latest.serviceIdentity !== identity.serviceIdentity) fail("agent_context_owner_binding_changed");
    const current = getDb().prepare("SELECT agent_id,kind,parent_chat_id,archived_at,origin_surface AS origin FROM chats WHERE id=?").get(input.chatId) as typeof row;
    if (!current || current.agent_id !== row.agent_id || current.kind !== row.kind || current.parent_chat_id !== row.parent_chat_id || current.origin !== row.origin || current.archived_at) fail("agent_context_visibility_changed");
  };
  const contextIdentity = { ...identity, agentId: input.agentId, visibilityDomain };
  // One run may invoke this chat's agent more than once (graph agent steps on their automation chat): each invocation's
  // attempt counter restarts at 1, so the turn ordinal continues after every turn of this run the journal already holds.
  const ordinal = nextAgentContextTurnOrdinal(contextIdentity, input.chatId, input.runId, input.attempt);
  const capability = createAgentContextCapability(contextIdentity,
    { turnId: `agent-context-turn:${JSON.stringify([input.chatId, input.runId, ordinal])}`, assertCurrent });
  // Initial migration belongs to this exact authorized chat only. The journal
  // becomes authoritative afterwards; chat projections are not imported again.
  bootstrapAgentContextHistory(capability, request.history);
  markAgentContextHostAuthored(capability, input.hostAuthored);
  return carryRunnerTurnContext(request, { ...request, agentContext: capability });
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
function awakeLifetime(identity:ReturnType<typeof agentContextHostBinding>["identity"]):{assertCurrent():void}|null {
  const match=/^one-team:([^:]+):session:(.+)$/.exec(identity.visibilityDomain);
  if(!match)return null;
  const [parent,chat]=match.slice(1);
  const active=()=>!!getDb().prepare(`SELECT 1 FROM chats c WHERE c.id=? AND c.parent_chat_id=?
    AND c.agent_id=? AND c.kind='division' AND c.origin_surface='one' AND c.archived_at IS NULL
    AND EXISTS(SELECT 1 FROM one_team_dispatches d JOIN one_org_members m ON m.id=d.member_id
      WHERE d.child_chat_id=c.id AND d.parent_chat_id=c.parent_chat_id
      AND m.installed_agent_id=c.agent_id AND m.archived_at IS NULL)`).get(chat,parent,identity.agentId);
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
 * Desktop compatibility calls retain context without claiming daemon residency. */
export function withDaemonAgentContext(runner: Runner, provider: { kind: string; backend?: string; configurationIdentity?: string }): Runner {
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
        return runner(carrySurfaceMemoryRequest(request, carryRunnerTurnContext(request, { ...request, agentContext: capability, signal })), events);
      });
  };
}
