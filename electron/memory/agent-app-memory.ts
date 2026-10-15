import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { getMemoryDb, getMemoryStoreInfo } from "./database";
import type { OwnerMemoryRecord } from "./owner-mutations";
import { assertMemoryWriteAllowed } from "./revocations";
import { nativeTextsFor } from "./native-text";
import { onDesktopStoreChange } from "../store/change-bus";
import { clearSelectedMemoryContextCache, registerMemoryRecallCacheInvalidator } from "./selected-context-cache";
import { looksSecret } from "../../shared/secret-patterns";
import { sameMemoryActor } from "../../shared/memory-actor-family";
import { bindSurfaceMemoryRequest, readSurfaceMemory, SURFACE_MEMORY_AUDIENCE_VERSION, type SurfaceMemoryCustody, type SurfaceMemoryRecall } from "./surface-recall";
import type { ResolvedOrg } from "../../shared/types";
import type { DesktopMemoryTarget, DesktopMemoryMutationResult } from "../../shared/desktop-memory-inspector";
import type { AgentAppMemoryChoice, AgentAppMemoryReceiver, AgentAppMemorySharing, AgentAppMemorySharingInput } from "../../shared/agent-app-memory";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (): never => { throw new Error("memory_owner_app_binding_changed"); };
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)));
// Main-only registration/setting readers stay lazy: generic daemon/Terminal
// imports have no Site/Electron dependency and never manufacture an App profile.
function owners(): typeof import("./owner-mutations") { return require("./owner-mutations"); }
function siteReaders(): typeof import("../site/store") { return require("../site/store"); }
type Host = { appId: string; projectId: string; chatId: string; revision: string; label: string; actors: Map<string, string> };

/** Uses existing registered targets and stored organizations only; no resolver/model. */
function appHost(projectId: string): Host {
  const {getAgentApp}=require("../store/agent-apps") as typeof import("../store/agent-apps");
  const {getChat}=require("../store/chats") as typeof import("../store/chats");
  const {getFirm}=require("../store/firms") as typeof import("../store/firms");
  const {getResolvedOrg}=require("../store/org-spec") as typeof import("../store/org-spec");
  const {listInstalledAgentsReadOnly}=require("../mcp/registry") as typeof import("../mcp/registry");
  const {getRoute}=require("../agents/routes") as typeof import("../agents/routes");
  const project = siteReaders().getSiteProject(projectId), artifact = project.agentAppArtifact, target = project.agentAppTarget;
  if (!artifact || artifact.status !== "ready" || !target) return fail();
  const app = getAgentApp(artifact.appRecordId), chat = app && getChat(app.chatId);
  if (!app || !chat || app.surfaceId !== `site:${project.id}` || path.resolve(app.rootPath) !== path.resolve(artifact.rootPath)
    || (target.kind === "firm" ? chat.firmId !== target.id : chat.agentId !== target.id || Boolean(chat.firmId))) return fail();
  const registeredAgents = new Map(listInstalledAgentsReadOnly().map(agent=>[agent.id,agent]));
  let org: ResolvedOrg | null = null, firmMembers: Set<string> | null = null, originalFirm: unknown = null;
  if (target.kind === "firm") { const firm = getFirm(target.id); if (!firm) return fail(); org = getResolvedOrg(firm); firmMembers = new Set([firm.ceoAgentId,...firm.orgChart.map(node=>node.agentId)]); originalFirm = [firm.id,firm.ceoAgentId,firm.orgChart]; }
  else {
    const agent = registeredAgents.get(target.id); if (!agent) return fail();
    if (agent.kind === "team") return { appId: app.id, projectId: project.id, chatId: chat.id, label: project.name, actors: new Map(), revision: hash([app, target, project.agentAppContract]) };
  }
  const nodeIds = org ? [org.ceo, ...org.divisions.flatMap(node => [node, ...node.specialists])].map(node => node.agentId).filter(id) : target.kind === "agent" ? [target.id] : [];
  const actors = new Map<string, string>();
  for (const actorId of nodeIds) { const agent = registeredAgents.get(actorId); if (agent && agent.kind !== "team" && (!firmMembers || firmMembers.has(actorId))) actors.set(actorId, agent.name); }
  const membership = [...actors].map(([actorId]) => [actorId, getRoute(actorId), registeredAgents.get(actorId)?.kind]);
  return { appId: app.id, projectId: project.id, chatId: chat.id, label: project.name, actors,
    revision: hash([app.id, app.chatId, app.rootPath, target, project.agentAppContract, originalFirm, org, membership]) };
}

const policyKeys = new Set(["scope", "projectIds", "projectPathHash", "actorId", "chatId", "recallChannel", "enabled", "compatibilityScope", "visibilityDomain", "audience"]);
function policy(row: OwnerMemoryRecord): Record<string, unknown> {
  let value: Record<string, unknown>; try { value = JSON.parse(row.applicability_json ?? "{}"); } catch { return fail(); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !policyKeys.has(key))
    || (value.enabled !== undefined && typeof value.enabled !== "boolean") || value.enabled === false || value.compatibilityScope !== undefined || (value.recallChannel !== undefined && value.recallChannel !== "default")
    || (value.scope !== undefined && value.scope !== row.scope) || (value.projectPathHash !== undefined && value.projectPathHash !== null)) return fail();
  return value;
}
function declared(value: Record<string, unknown>): AgentAppMemoryReceiver | null {
  const audience = value.audience;
  if (audience === undefined) return null;
  if (!exact(audience, ["schemaVersion", "receiver", "visibilityDomain"]) || audience.schemaVersion !== SURFACE_MEMORY_AUDIENCE_VERSION) return fail();
  const receiver = audience.receiver;
  if (!exact(receiver, ["kind", "appId", "projectId", "actorId"]) || receiver.kind !== "agent-app"
    || !id(receiver.appId) || !id(receiver.projectId) || !id(receiver.actorId) || audience.visibilityDomain !== `agent-app:${receiver.appId}`) return fail();
  return receiver as unknown as AgentAppMemoryReceiver;
}
function target(input: DesktopMemoryTarget): OwnerMemoryRecord {
  const current = getMemoryStoreInfo();
  if (!input || !id(input.memoryId) || !Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 0 || typeof input.expectedRevision !== "string" || input.ownerRef !== owners().currentMemoryOwnerRef() || input.expectedEpoch !== current.revocationEpoch) return fail();
  const row = owners().ownedMemoryRecord(input.memoryId);
  if (owners().learningActor(row) !== input.actorId || owners().memoryTargetRevision(row) !== input.expectedRevision || row.superseded_at || !row.content
    || row.owner_namespace !== current.ownerNamespace || row.sensitivity === "secret" || looksSecret(row.content) || !["agent_repo", "project"].includes(row.scope)) return fail();
  const native=nativeTextsFor("memory_entry",[row.id]).get(row.id);if(native&&looksSecret(native))return fail();
  policy(row); return row;
}
function eligible(row: OwnerMemoryRecord, receiver: AgentAppMemoryReceiver): boolean {
  const value = policy(row);
  if (row.scope === "agent_repo" && !sameMemoryActor(owners().learningActor(row), receiver.actorId)) return false;
  if (row.scope === "project" && row.project_id !== receiver.projectId) return false;
  if (value.actorId !== undefined && value.actorId !== null && (!id(value.actorId) || (row.scope === "agent_repo" && !sameMemoryActor(value.actorId, receiver.actorId)))) return false;
  if (value.projectIds !== undefined && (!Array.isArray(value.projectIds) || value.projectIds.some(value => !id(value) || value !== receiver.projectId))) return false;
  if (value.chatId !== undefined && value.chatId !== null && value.chatId !== row.chat_id) return false;
  if (value.visibilityDomain !== undefined && value.visibilityDomain !== `agent-app:${receiver.appId}`) return false;
  return true;
}
export function inspectAppMemorySharing(input: DesktopMemoryTarget): AgentAppMemorySharing {
  if(!exact(input,["memoryId","ownerRef","actorId","expectedRevision","expectedEpoch"]))return fail();
  const row = target(input), current = declared(policy(row)), choices: AgentAppMemoryChoice[] = [];
  for (const project of siteReaders().listSiteProjects().slice(0, 256)) { try {
    const host = appHost(project.id);
    for (const [actorId, name] of host.actors) { const receiver: AgentAppMemoryReceiver = { kind: "agent-app", appId: host.appId, projectId: host.projectId, actorId };
      if (eligible(row, receiver)) choices.push({ ...receiver, label: `${host.label} · ${name}`, revision: host.revision }); }
  } catch { /* Unavailable original registrations are not selectable. */ } }
  return { current, choices: choices.slice(0, 256), canRevoke: current !== null };
}
/** The trusted owner IPC is the sole product setting caller, never a curator. */
export function setAppMemorySharing(input: AgentAppMemorySharingInput): DesktopMemoryMutationResult {
  if (!exact(input, ["memoryId", "ownerRef", "actorId", "expectedRevision", "expectedEpoch", "receiver"])) return fail();
  const db = getMemoryDb();
  const receipt = db.transaction(() => {
    const row = target(input), value = policy(row), prior = declared(value);
    if (input.receiver === null) { if (!prior) return fail(); delete value.audience; }
    else {
      if (!exact(input.receiver, ["kind", "appId", "projectId", "actorId", "label", "revision"]) || input.receiver.kind !== "agent-app"
        || !id(input.receiver.appId) || !id(input.receiver.projectId) || !id(input.receiver.actorId) || !id(input.receiver.label) || !/^[a-f0-9]{64}$/.test(input.receiver.revision)) return fail();
      const host = appHost(input.receiver.projectId);
      if (host.appId !== input.receiver.appId || host.revision !== input.receiver.revision || !host.actors.has(input.receiver.actorId) || !eligible(row, input.receiver)) return fail();
      value.audience = { schemaVersion: SURFACE_MEMORY_AUDIENCE_VERSION, receiver: { kind: "agent-app", appId: host.appId, projectId: host.projectId, actorId: input.receiver.actorId }, visibilityDomain: `agent-app:${host.appId}` };
    }
    assertMemoryWriteAllowed({ scope: row.scope, kind: row.kind, content: row.content, agentId: row.agent_id ?? owners().learningActor(row), projectId: row.project_id, projectPath: row.project_path, chatId: row.chat_id,
      intakeEpoch: input.expectedEpoch });
    db.prepare("UPDATE memory_identity_bindings SET applicability_json=?,revision=revision+1 WHERE memory_id=? AND owner_namespace=?").run(JSON.stringify(value), row.id, getMemoryStoreInfo().ownerNamespace);
    db.prepare("UPDATE memory_store_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
    db.prepare("INSERT INTO memory_origin_links(memory_id,source_kind,source_id,source_revision,relation) VALUES(?,'owner-setting',?,?,'audience-setting')").run(row.id,randomUUID(),hash([input.ownerRef,input.expectedRevision,value.audience??null]));
    db.prepare("DELETE FROM memory_relation_edges WHERE from_memory_id=? OR to_memory_id=?").run(row.id, row.id);
    const now = new Date().toISOString(), current = getMemoryStoreInfo();
    db.prepare("INSERT INTO memory_projection_outbox(outbox_id,memory_id,authority_revision,state,payload_json,created_at,updated_at) VALUES(?,?,?,'queued','{}',?,?)").run(randomUUID(), row.id, current.revision, now, now);
    return { ok: true as const, memoryId: row.id, replacementId: null, revocationEpoch: current.revocationEpoch, authorityRevision: current.revision, affectedMemoryIds: [row.id] };
  }).immediate();
  clearSelectedMemoryContextCache(); return receipt;
}

type RunProfile = { host: Host; custody: SurfaceMemoryCustody | null; assertHost(): void; selections: SurfaceMemoryRecall[]; byActor: Map<string,SurfaceMemoryRecall>; invalidated: boolean };
const runs = new Map<string, RunProfile>();
/** Called only after the original Site loopback authorization and target binding. */
export function registerAppMemoryRun(input: { runId: string; projectId: string; chatId: string; custody: SurfaceMemoryCustody | null; assertHost(): void; onInvalidated?(): void }): { assertCurrent(): void; close(): void } {
  input.assertHost(); const host = appHost(input.projectId);
  if (!id(input.runId) || host.chatId !== input.chatId || runs.has(input.runId)) return fail();
  const profile: RunProfile = { host, custody: input.custody, assertHost: input.assertHost, selections: [], byActor: new Map(), invalidated: false };
  const assert = () => { if (profile.invalidated || runs.get(input.runId) !== profile) return fail(); input.assertHost(); input.custody?.assertCurrent(); if (appHost(host.projectId).revision !== host.revision) return fail(); for (const selection of profile.selections) selection.assertCurrent(); };
  runs.set(input.runId, profile); try { assert(); } catch(error) {runs.delete(input.runId);throw error;}
  const invalidate = () => {if(profile.invalidated || runs.get(input.runId)!==profile)return;
    try {assert();} catch {profile.invalidated=true;input.onInvalidated?.();}};
  const detachMemory=registerMemoryRecallCacheInvalidator(invalidate);
  const detachStore=onDesktopStoreChange(change=>{if(["agent","firm","chat","project","surface","one-profile","one-org"].includes(change.entity))invalidate();});
  return { assertCurrent: assert, close() {detachMemory();detachStore();if (runs.get(input.runId) === profile) runs.delete(input.runId); } };
}
/** Per actual installed member, never broadcast a leader's private memory. */
export function appRunMemory(input: { runId?: string; chatId: string; actorId: string | null; query: string }): SurfaceMemoryRecall | null {
  const profile = input.runId ? runs.get(input.runId) : null;
  if (!profile) return null;
  if(profile.invalidated)return fail();
  profile.assertHost(); profile.custody?.assertCurrent();
  if (input.chatId !== profile.host.chatId || appHost(profile.host.projectId).revision !== profile.host.revision) return fail();
  if (!input.actorId || !profile.host.actors.has(input.actorId) || !profile.custody) return null;
  const selection = readSurfaceMemory({ receiver: { kind: "agent-app", appId: profile.host.appId, projectId: profile.host.projectId, actorId: input.actorId }, visibilityDomain: `agent-app:${profile.host.appId}`,
    custody: profile.custody, assertHost: () => { if(profile.invalidated || runs.get(input.runId!)!==profile)return fail(); profile.assertHost(); if (appHost(profile.host.projectId).revision !== profile.host.revision) return fail(); }, chatId: input.chatId, query: input.query, maxApproxTokens: 256 });
  if(profile.selections.length>=128)return fail();
  profile.selections.push(selection); profile.byActor.set(input.actorId,selection); return selection;
}

export function assertAppMemoryRun(runId: string | undefined, chatId: string): void {
  const profile = runId ? runs.get(runId) : null;
  if (!profile) return;
  if(profile.invalidated)return fail();
  profile.assertHost(); profile.custody?.assertCurrent();
  if (chatId !== profile.host.chatId || appHost(profile.host.projectId).revision !== profile.host.revision) return fail();
  for (const selection of profile.selections) selection.assertCurrent();
}

export function appMemoryRunGuard(runId: string | undefined, chatId: string): () => void {
  const profile = runId ? runs.get(runId) : null;
  return () => {if(profile && runs.get(runId!)!==profile)return fail();assertAppMemoryRun(runId,chatId);};
}

/** Existing host-selected member recall only; never a provider seat/DTO grant. */
export function bindAppMemoryRequest<T extends object>(request:T,input:{runId?:string;chatId:string;actorId:string|null}):T {
  const profile=input.runId?runs.get(input.runId):null;if(!profile)return request;
  assertAppMemoryRun(input.runId,input.chatId);
  if(!input.actorId)return request;
  const memory=profile.byActor.get(input.actorId);if(!memory)return request;
  return bindSurfaceMemoryRequest(request,memory);
}
