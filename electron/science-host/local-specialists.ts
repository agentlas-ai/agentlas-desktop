import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { scienceStore, specialistDigest, specialistScope, validateSpecialistPin } from "agentlas-science";
import type { ScienceLocalSpecialistHost, ScienceLocalSpecialistPin, ScienceLocalSpecialistScope, ScienceTurnToolScope } from "agentlas-science";
import { listInstalledAgentsReadOnly } from "../mcp/registry";
import { getRoute } from "../agents/routes";
import { buildEffectiveAgentSystemPrompt, computeAgentPackageHash } from "../agents/files";
import { readCanonicalPromptFromDirectory } from "../agents/prompt-authority";
import { getDb } from "../store/db";
import { agentContextOwnerBinding } from "../runtime/agent-context-admission";
import { workingSessionScope, resolveSessionScope, legacyVisibilityDomain } from "../runtime/session-scope";
import { invocationRunOwners } from "../store/invocation-run-owners";
import { getPendingInvocationAdmissionForChat } from "../store/invocation-admissions";
import { TURN_LINE_PREFIX } from "../runtime/agent-context-turn-line";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function fail(code: string): never { throw new Error(`science-local-specialist-${code}`); }
/** Domain custody only. The existing helper chat still enters InvocationService,
 * shared session admission, memory boundaries, tools and cancellation normally. */
export function createScienceLocalSpecialistHost(): ScienceLocalSpecialistHost {
  const authorities = new WeakMap<object, { pin: ScienceLocalSpecialistPin; turnId: string; runId: string; chatId: string; owner: string }>();
  function task(scope: ScienceLocalSpecialistScope) {
    const store = scienceStore();
    const current = store.getAuthorResearchAssistantAssignmentTask({ projectId: scope.projectId,
      authorConversationId: scope.authorConversationId, taskId: scope.taskId });
    if (specialistDigest(specialistScope(current)) !== specialistDigest(scope)
      || store.scienceConversationStopped(scope.authorConversationId) || store.scienceConversationStopped(scope.conversationId)) fail("scope-stale");
    return current;
  }
  function currentTurn(scope: ScienceTurnToolScope, statuses: readonly string[]) {
    const store = scienceStore(), turn = store.getTurnForProject(scope.projectId, scope.turnId);
    const bound = store.getConversationRuntimeBinding(scope.projectId, scope.conversationId);
    if (!turn || turn.conversationId !== scope.conversationId || turn.invocationRunId !== scope.invocationRunId
      || bound?.runtimeChatId !== turn.runtimeChatId || !statuses.includes(turn.status)) fail("scope-stale");
    store.assertScienceTurnExecutionAuthority(turn);
    return turn;
  }
  function author(scope: ScienceTurnToolScope) {
    const turn = currentTurn(scope, ["running"]), store = scienceStore();
    if (store.getResearchAssistantTaskForConversation(scope.projectId, scope.conversationId)
      || store.peerReview().refereeRoleForConversation(scope.projectId, scope.conversationId)) fail("author-turn-required");
    return turn;
  }
  function installedPin(scope: ScienceLocalSpecialistScope, agentId: string): ScienceLocalSpecialistPin {
    const agent = listInstalledAgentsReadOnly().find(a => a.id === agentId), route = getRoute(agentId);
    if (!agent || agent.kind === "team" || agent.sourceMissingSince || !route || route.kind !== "agent" || route.missingSince
      || !path.isAbsolute(route.path) || !["local-import", "agent-cloud", "hub"].includes(route.source ?? "local-import")) fail("installed-agent-unavailable");
    const rootStat = fs.lstatSync(route.path);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("installed-package-root-invalid");
    const root = fs.realpathSync.native(route.path), canonical = readCanonicalPromptFromDirectory(root);
    if (!canonical || !canonical.content.trim()) fail("canonical-prompt-unavailable");
    const prompt = buildEffectiveAgentSystemPrompt(agentId, agent.systemPrompt);
    if (!prompt.trim()) fail("effective-prompt-unavailable");
    const source = route.source ?? "local-import";
    if (agent.assetSource && agent.assetSource !== source) fail("installed-source-mismatch");
    const payload: Omit<ScienceLocalSpecialistPin, "bindingSha256"> = {
      schema: "agentlas.science-local-specialist.v1", scope: { ...scope }, agentId, agentSlug: agent.slug, source,
      definitionSha256: specialistDigest({ agentId, slug: agent.slug, source,
        definitionHash: route.definitionHash ?? null, packageHash: route.packageHash ?? null,
        portableAssetsSha256: computeAgentPackageHash(agentId, canonical.relativePath) }),
      packageLocationSha256: sha(root), canonicalPromptSha256: sha(canonical.content), systemPromptSha256: sha(prompt),
      promptAsset: canonical.relativePath, permissionCeiling: "read", toolPolicy: "assigned-helper-only",
    };
    return { ...payload, bindingSha256: specialistDigest(payload) };
  }
  const custodyKey = (pin: ScienceLocalSpecialistPin) => `science-specialist-custody:${pin.bindingSha256}`;
  const custodyValue = (pin: ScienceLocalSpecialistPin) => JSON.stringify({v:1,ownerScope:agentContextOwnerBinding().ownerScope,pinSha256:specialistDigest(pin)});
  function assertCustody(pin: ScienceLocalSpecialistPin) {
    const row = getDb().prepare("SELECT value FROM meta WHERE key=?").get(custodyKey(pin)) as {value:string}|undefined;
    if (row?.value !== custodyValue(pin)) fail("owner-custody-unavailable");
  }
  function pinCurrent(pin: ScienceLocalSpecialistPin) {
    validateSpecialistPin(pin);
    assertCustody(pin);
    const assignment = task(pin.scope);
    if (assignment.executionAgent?.bindingSha256 !== pin.bindingSha256) fail("context-pin-mismatch");
    if (specialistDigest(installedPin(pin.scope, pin.agentId)) !== specialistDigest(pin)) fail("package-changed");
    return assignment;
  }
  function boundTurn(pin: ScienceLocalSpecialistPin, turnId: string, runId: string, chatId: string, completed = false) {
    const assignment = pinCurrent(pin);
    if (!["queued", "running", ...(completed ? ["completed"] : [])].includes(assignment.status)) fail("scope-stale");
    const turn = currentTurn({ projectId: pin.scope.projectId, conversationId: pin.scope.conversationId,
      turnId, invocationRunId: runId }, completed ? ["queued", "running", "completed"] : ["queued", "running"]);
    const range = workingSessionScope(getDb(), chatId);
    if (turn.runtimeChatId !== chatId || range?.projectId !== pin.scope.projectId || range.subSessionId !== pin.scope.conversationId) fail("runtime-scope-mismatch");
    const row = getDb().prepare("SELECT agent_id,kind,parent_chat_id,archived_at FROM chats WHERE id=?").get(chatId) as {agent_id:string;kind:string;parent_chat_id:string|null;archived_at:string|null}|undefined;
    if (!row || row.kind !== "division" || row.archived_at) fail("runtime-chat-unavailable");
    return row;
  }
  function assertCurrent(authority: object, runId: string, chatId: string, expectedPin?: ScienceLocalSpecialistPin) {
    const admitted = authorities.get(authority);
    if (!admitted || admitted.runId !== runId || admitted.chatId !== chatId
      || admitted.owner !== agentContextOwnerBinding().ownerScope) fail("main-authority-required");
    if (expectedPin && specialistDigest(expectedPin) !== specialistDigest(admitted.pin)) fail("context-pin-mismatch");
    const row = boundTurn(admitted.pin, admitted.turnId, runId, chatId);
    if (row.agent_id !== admitted.pin.agentId) fail("actor-changed");
  }
  const host: ScienceLocalSpecialistHost = {
    list(scope) {
      author(scope);
      return listInstalledAgentsReadOnly().flatMap(agent => {
        try {
          const route = getRoute(agent.id);
          if (agent.kind === "team" || agent.sourceMissingSince || !route || route.kind !== "agent" || route.missingSince
            || !readCanonicalPromptFromDirectory(route.path)) return [];
          return [{agentId:agent.id,agentSlug:agent.slug,name:agent.name,source:route.source ?? "local-import"}];
        } catch { return []; }
      });
    },
    prepare({requester, scope, agentId}) {
      author(requester);
      if (requester.projectId !== scope.projectId || requester.conversationId !== scope.authorConversationId) fail("author-scope-mismatch");
      task(scope);
      const pin = validateSpecialistPin(installedPin(scope, agentId), scope);
      getDb().prepare("INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)").run(custodyKey(pin),custodyValue(pin));
      assertCustody(pin);
      return pin;
    },
    bind({pin, runtimeChatId, turnId, invocationRunId}) {
      const db = getDb();
      db.transaction(() => {
        const row = boundTurn(pin, turnId, invocationRunId, runtimeChatId);
        if (row.agent_id !== pin.agentId) {
          if (invocationRunOwners.getActiveOwner(runtimeChatId) || getPendingInvocationAdmissionForChat(runtimeChatId)) fail("runtime-chat-already-owned");
          const oldScope = resolveSessionScope(db, {chatId:runtimeChatId,agentId:row.agent_id,kind:row.kind,
            parentChatId:row.parent_chat_id,aliveController:false,ownerScope:agentContextOwnerBinding().ownerScope,persist:false,workingScopeRequired:true});
          if (oldScope.unavailable) fail("runtime-chat-ownership-unavailable");
          const legacyDomain = legacyVisibilityDomain({chatId:runtimeChatId,kind:row.kind,parentChatId:row.parent_chat_id},false);
          if (db.prepare("SELECT 1 FROM agent_context_heads WHERE json_valid(identity_json) AND json_extract(identity_json,'$.visibilityDomain') IN (?,?) AND (json_type(identity_json,'$.agentId') IS NOT 'text' OR json_extract(identity_json,'$.agentId')<>?) LIMIT 1")
            .get(oldScope.visibilityDomain,legacyDomain,pin.agentId)
            || db.prepare("SELECT 1 FROM meta WHERE key LIKE ? AND json_valid(value) AND json_extract(value,'$.turn.chatId')=? LIMIT 1")
              .get(TURN_LINE_PREFIX + "%",runtimeChatId)) fail("runtime-chat-already-used");
          // A helper placeholder may be bound once before any actor has used it.
          // Reassigning a used chat would replay another actor's journal/native handle.
          for (const table of ["run_events", "chat_messages", "chat_runtime_sessions"])
            if (db.prepare(`SELECT 1 FROM ${table} WHERE chat_id=? LIMIT 1`).get(runtimeChatId)) fail("runtime-chat-already-used");
          const changed = db.prepare("UPDATE chats SET agent_id=? WHERE id=? AND agent_id=? AND kind='division' AND archived_at IS NULL")
            .run(pin.agentId, runtimeChatId, row.agent_id);
          if (changed.changes !== 1) fail("actor-changed");
        }
      })();
      const authority = Object.freeze({});
      authorities.set(authority, {pin:structuredClone(pin),turnId,runId:invocationRunId,chatId:runtimeChatId,owner:agentContextOwnerBinding().ownerScope});
      return {authority};
    },
    assertCurrent,
    assertTurnScope(scope) {
      const turn = currentTurn(scope, ["running"]), assignment = scienceStore().getResearchAssistantTaskForConversation(scope.projectId, scope.conversationId);
      if (!assignment?.executionAgent) fail("assignment-required");
      const row = boundTurn(assignment.executionAgent, turn.id, turn.invocationRunId, turn.runtimeChatId);
      if (row.agent_id !== assignment.executionAgent.agentId) fail("actor-changed");
    },
    verifyReturn(input) {
      const row = boundTurn(input.pin, input.turnId, input.invocationRunId, input.runtimeChatId, true);
      if (row.agent_id !== input.pin.agentId) fail("actor-changed");
      const db = getDb(), starts = db.prepare("SELECT agent_id,chat_id FROM run_events WHERE run_id=? AND kind='invoke_started'").all(input.invocationRunId) as Array<{agent_id:string;chat_id:string}>;
      if (starts.length !== 1 || starts[0].agent_id !== input.pin.agentId || starts[0].chat_id !== input.runtimeChatId) fail("producer-mismatch");
      const boundary = readInvocationEffectBoundary({invocationRunId:input.invocationRunId,expectedChatId:input.runtimeChatId,expectedSource:"science"});
      if (!boundary.terminal || boundary.effects !== "settled" || !boundary.terminalEventId || !boundary.receiptEventId) fail("effect-unconfirmed");
      const terminal = db.prepare("SELECT kind FROM run_events WHERE id=? AND run_id=?").get(boundary.terminalEventId,input.invocationRunId) as {kind:string}|undefined;
      if (terminal?.kind !== "invoke_completed") fail("terminal-unconfirmed");
      const finals = db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND kind='mcp_final'").all(input.invocationRunId) as {payload_json:string}[];
      if (finals.length !== 1 || JSON.parse(finals[0].payload_json).durableMessageId !== input.runtimeMessageId) fail("final-backlink-mismatch");
      const message = db.prepare("SELECT text,speaker_agent_id FROM chat_messages WHERE id=? AND chat_id=? AND role='assistant'")
        .get(input.runtimeMessageId,input.runtimeChatId) as {text:string;speaker_agent_id:string|null}|undefined;
      if (!message || message.speaker_agent_id !== input.pin.agentId || sha(message.text) !== input.rawContentSha256) fail("content-mismatch");
      return {bindingSha256:input.pin.bindingSha256,invocationRunId:input.invocationRunId,runtimeChatId:input.runtimeChatId,
        runtimeMessageId:input.runtimeMessageId,rawContentSha256:input.rawContentSha256,terminalEventId:boundary.terminalEventId,
        effectReceiptEventId:boundary.receiptEventId,scientificVerification:"unchecked"};
    },
  };
  return host;
}
export const scienceLocalSpecialistHost = createScienceLocalSpecialistHost();

/** Main-only entry fence. A copied execution context cannot bypass a durable helper pin. */
export function assertScienceSpecialistExecution(context: {source:string;science?: {projectId:string;conversationId:string;turnId:string;invocationRunId:string};scienceSpecialist?:object},
  runId: string, chatId: string, permission: string | undefined): void {
  if (context.source !== "science") {
    if (context.scienceSpecialist) fail("source-required");
    return;
  }
  const scope = context.science, store = scienceStore(), turn = store.getTurnByInvocationRunId(runId);
  const assignment = turn ? store.getResearchAssistantTaskForConversation(turn.projectId,turn.conversationId) : null;
  if (!assignment?.executionAgent) {
    if (context.scienceSpecialist) fail("assignment-required");
    return;
  }
  if (!scope || !turn || turn.runtimeChatId !== chatId || scope.projectId !== turn.projectId
    || scope.conversationId !== turn.conversationId || scope.turnId !== turn.id
    || scope.invocationRunId !== runId || permission !== "read" || !context.scienceSpecialist) fail("read-authority-required");
  scienceLocalSpecialistHost.assertCurrent(context.scienceSpecialist,runId,chatId,assignment.executionAgent);
}
