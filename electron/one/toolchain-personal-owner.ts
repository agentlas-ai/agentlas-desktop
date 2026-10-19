














import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { sha256Value } from "../../shared/graph-execution-digest";
import { BUSINESS_TOOLCHAIN_EFFECT_PROTOCOL, BUSINESS_TOOLCHAIN_REQUEST_SCHEMA, type BusinessPreparedNativeAction,
  type BusinessToolchainEffectIdentity, type BusinessToolchainEffectResult, type BusinessToolchainNativeRequest } from "../../shared/business/native-action-ports";
import type { BusinessOpaqueSource } from "../../shared/business/native-registry";
import type { ToolchainAsset, ToolchainAssetVersion, ToolchainCallReceipt, ToolchainGenerationResult } from "../../shared/toolchain-asset";
import { COLD_START_POLICY, type ToolchainReport } from "../../shared/toolchain";
import type { InvocationRunOwner } from "../store/invocation-owner-core";
import { configureOneToolchainNativeOwnerPorts, currentOneToolchainNativeInvocation, type OneToolchainExecutionOwnerPort,
  type OneToolchainPreparationOwnerPort } from "./toolchain-native-runtime";
import type { OneToolchainAudienceRegistration, OneToolchainBusinessFacade, OneToolchainNativeActor,
  OneToolchainOriginalWork, OneToolchainOwnedPhaseInput, OneToolchainPersonalTurnPorts, OneToolchainReleaseRef,
  OneToolchainReportAdmissionRequest, OneToolchainReportIntentRegistration, OneToolchainResourceOwnerPort,
  OneToolchainResourceRegistration, OneToolchainRetainedCallRegistration } from "./toolchain-native-registration";
import { ASSET_FRESH_TEST_BUDGET_MS, configureNativeAssetPublicationResolver, type AssetPublicationBinding,
  type NativeAssetPublicationAuthority, type NativeAssetPublicationLease, type NativeAssetPublicationResolver } from "../toolchains/asset-cold-start";
import { configureNativeAssetRepairEvidencePorts, type NativeAssetRepairAcceptance, type NativeAssetRepairContext,
  type NativeAssetRepairEvidencePorts } from "../toolchains/reports";
import type { ToolchainPreparationProducer } from "../toolchains/preparation";

const ASSET_PREFIX = "toolchain.native-asset.v1:";
const CALL_PREFIX = "toolchain.native-call.v1:";
const REPORT_PREFIX = "toolchain.native-report-id.v1:";
const AUTHORITY = "agentlas.personal-toolchain-owner.v1";
const SOURCE_AUTHORITY = "agentlas.personal-library.v1";
const PERSONAL_GRANT = "personal-owner.v1";

export interface PersonalToolchainOwnerHost {
  readonly host: "main" | "daemon";
  /** Main only: the trusted owner window sent this IPC (main.ts). The daemon serves no renderer. */
  readonly isOwnerIpcSender?: (event: unknown) => boolean;
}

function fail(code: string): never { throw new Error(code); }
const digest = (value: unknown): string => sha256Value(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
function db(): Database.Database { return (require("../store/db") as typeof import("../store/db")).getDb(); }
function readMeta<T>(key: string): T | null {
  const row = db().prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.value) as T; } catch { return null; }
}
function writeMeta(key: string, value: unknown): void {
  db().prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
}
const assets = () => require("../toolchains/assets") as typeof import("../toolchains/assets");
const calls = () => require("../toolchains/calls") as typeof import("../toolchains/calls");
const chats = () => require("../store/chats") as typeof import("../store/chats");
const ledger = (toolchainId: string) => (require("../toolchains/store") as typeof import("../toolchains/store")).readToolchainState(`asset:${toolchainId}`);
function liveChat(chatId: string | null | undefined) {
  const chat = chatId ? chats().getChat(chatId) : null;
  return chat && !chat.archivedAt ? chat : null;
}
/** The signed-in local owner. The personal native family (Vault, History) requires the same session. */
function currentPrincipal(): string | null {
  const session = (require("../auth") as typeof import("../auth")).getAuthenticatedSessionBinding();
  return session && (session.expiresAt === null || session.expiresAt > Date.now()) ? session.userId : null;
}
function hasTable(name: string): boolean {
  return Boolean(db().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
/** The run's stored lease, active and held by THIS process. */
function leaseHeldHere(runId: string): InvocationRunOwner | null {
  const owners = require("../store/invocation-run-owners") as typeof import("../store/invocation-run-owners");
  const row = db().prepare("SELECT chat_id FROM invocation_run_owners WHERE run_id=?").get(runId) as { chat_id: string } | undefined;
  const lease = row ? owners.invocationRunOwners.getRunOwner(row.chat_id, runId) : null;
  const process = owners.invocationProcessOwner();
  return lease && lease.state === "active" && lease.ownerId === process.ownerId && lease.ownerKind === process.ownerKind ? lease : null;
}
function assertOriginalLive(original: Readonly<OneToolchainOriginalWork>): void {
  const lease = leaseHeldHere(original.runId);
  if (!lease || lease.leaseId !== original.leaseId) fail("toolchain_native_invocation_custody_required");
}

// ── The original run's cancellation (preparation and execution lifetime) ─────────────────────────────────────────
// Stop aborts the run and the run settles; a Toolchain call or preparation it started must not outlive it.
const runControllers = new Map<string, AbortController>();
let settledSubscribed = false;
function runSignal(original: Readonly<OneToolchainOriginalWork>): AbortSignal {
  if (!settledSubscribed) {
    settledSubscribed = true;
    const { invocationService } = require("../invocation/service") as typeof import("../invocation/service");
    invocationService.onSettled(envelope => {
      const controller = runControllers.get(envelope.runId);
      if (controller) { runControllers.delete(envelope.runId); controller.abort(new Error("toolchain_native_original_run_settled")); }
    });
  }
  for (const [runId, controller] of runControllers) {
    if (!leaseHeldHere(runId)) { runControllers.delete(runId); controller.abort(new Error("toolchain_native_original_run_settled")); }
  }
  let controller = runControllers.get(original.runId);
  if (!controller) { controller = new AbortController(); runControllers.set(original.runId, controller); }
  if (!leaseHeldHere(original.runId)) { runControllers.delete(original.runId); controller.abort(new Error("toolchain_native_original_run_settled")); }
  return controller.signal;
}

// ── Personal original work: turns and the personal budget (registration core lookupTurn) ─────────────────────────
function budgetPolicyConfigured(oneId: string): boolean {
  return hasTable("one_budget_policies") && Boolean(db().prepare("SELECT 1 FROM one_budget_policies WHERE one_id=? LIMIT 1").get(oneId));
}
const personalBudgetId = (runId: string) => `personal-turn:${runId}`;
const turns: OneToolchainPersonalTurnPorts = {
  liveRunOwner(runId) {
    const { invocationService } = require("../invocation/service") as typeof import("../invocation/service");
    return invocationService.liveRunOwner(runId);
  },
  assertChat(chatId) { if (!liveChat(chatId)) fail("toolchain_native_original_work_required"); },
  // A personal install has no budget policy: the admitted run is the spending authority for the bounded preparation
  // it starts (3 generalization rounds within 300 s; 2 fresh-session calls within 300 s). A configured policy wins.
  turnBudget({ oneId, runId }) { return budgetPolicyConfigured(oneId) ? null : { budgetId: personalBudgetId(runId), revision: 0 }; },
  currentTurnBudget({ oneId, runId, budgetId }) {
    if (budgetId !== personalBudgetId(runId)) return null;
    return !budgetPolicyConfigured(oneId) && leaseHeldHere(runId) ? { admitted: true, revision: 0 } : { admitted: false, revision: null };
  },
};

// ── Canonical release registry (shared meta rows: one registry for Main and the daemon) ──────────────────────────
interface StoredAssetRegistration extends OneToolchainResourceRegistration {
  readonly schema: "agentlas.toolchain-native-asset.v1";
  readonly producer: { kind: "one" | "owner"; chatId: string | null; runId: string | null };
  readonly at: string;
}
const assetKey = (ref: Readonly<OneToolchainReleaseRef>) => `${ASSET_PREFIX}${ref.toolchainId}@${ref.version}`;
function releaseOf(ref: Readonly<OneToolchainReleaseRef>): { asset: ToolchainAsset; release: ToolchainAssetVersion } | null {
  const asset = assets().getToolchainAsset(ref.toolchainId), release = asset?.versions.find(v => v.version === ref.version);
  return asset && release && release.contentHash === ref.contentHash ? { asset, release } : null;
}
/** The genuine source manifest of a produced release: its frozen source graph and its implementation carrier. */
function releaseSources(release: ToolchainAssetVersion): BusinessOpaqueSource[] {
  return [
    { resourceId: `automation:${release.provenance.sourceAutomationId}`, revision: release.provenance.sourceDefinitionDigest, sourceAuthorityId: SOURCE_AUTHORITY },
    { resourceId: `implementation:${release.implementation.automationId}`, revision: release.contentHash, sourceAuthorityId: SOURCE_AUTHORITY },
  ];
}
function storedAsset(ref: Readonly<OneToolchainReleaseRef>): StoredAssetRegistration | null {
  const stored = readMeta<StoredAssetRegistration>(assetKey(ref));
  return stored?.schema === "agentlas.toolchain-native-asset.v1" && digest(stored.release) === digest({ toolchainId: ref.toolchainId, version: ref.version, contentHash: ref.contentHash }) ? stored : null;
}
function registerRelease(ref: Readonly<OneToolchainReleaseRef>, principalId: string, producer: StoredAssetRegistration["producer"],
  manifest: readonly BusinessOpaqueSource[]): StoredAssetRegistration {
  const found = releaseOf(ref) ?? fail("toolchain_native_immutable_release_changed");
  if (digest(manifest) !== digest(releaseSources(found.release))) fail("toolchain_native_source_manifest_required");
  const prior = storedAsset(ref);
  if (prior) {
    // Re-registration of the same immutable release keeps its identity; another principal cannot take it over.
    if (prior.ownerPrincipalId !== principalId) fail("toolchain_native_canonical_resource_required");
    return prior;
  }
  const release = { toolchainId: ref.toolchainId, version: ref.version, contentHash: ref.contentHash };
  const body = { release, resourceId: `toolchain:${ref.toolchainId}@${ref.version}`, ownerPrincipalId: principalId,
    scope: "personal" as const, organizationId: null, projectId: null, sources: manifest.map(source => ({ ...source })),
    permissionRevision: PERSONAL_GRANT, consentRevision: PERSONAL_GRANT, tombstoneRevision: "live", credentialGeneration: null };
  const record: StoredAssetRegistration = { schema: "agentlas.toolchain-native-asset.v1", registrationId: `tcreg_${randomUUID()}`,
    revision: digest(body), ...body, producer, at: new Date().toISOString() };
  db().transaction(() => { if (!storedAsset(ref)) writeMeta(assetKey(ref), record); }).immediate();
  return storedAsset(ref) ?? fail("toolchain_native_canonical_resource_required");
}
function assetCurrent(registration: Readonly<OneToolchainResourceRegistration>, principalId: string | null): boolean {
  const stored = storedAsset(registration.release);
  return Boolean(stored && principalId && stored.registrationId === registration.registrationId && stored.revision === registration.revision
    && stored.ownerPrincipalId === principalId && releaseOf(registration.release));
}

/** Main IPC only: an owner-authored release from the Toolchains screen is the owner's own production. */
export function registerOwnerProducedToolchainRelease(result: Readonly<ToolchainGenerationResult>): void {
  if (!installedHost || result.decision === "reuse") return;
  const principalId = currentPrincipal();
  const release = result.asset.versions.find(version => version.version === result.version);
  if (!principalId || !release) return;
  registerRelease({ toolchainId: result.asset.id, version: release.version, contentHash: release.contentHash }, principalId,
    { kind: "owner", chatId: null, runId: null }, releaseSources(release));
}

// ── Call registry ────────────────────────────────────────────────────────────────────────────────────────────────
interface StoredCallRegistration extends OneToolchainRetainedCallRegistration { readonly schema: "agentlas.toolchain-native-call.v1" }
const callKey = (callId: string) => `${CALL_PREFIX}${callId}`;
function storedCall(callId: string): StoredCallRegistration | null {
  const stored = readMeta<StoredCallRegistration>(callKey(callId));
  return stored?.schema === "agentlas.toolchain-native-call.v1" ? stored : null;
}

// ── Report identity and intents ──────────────────────────────────────────────────────────────────────────────────
const reportRevision = (report: ToolchainReport) => digest(report);
const intents = new Map<string, OneToolchainReportIntentRegistration>();
const effectsByRequest = new Map<string, BusinessToolchainEffectIdentity>();
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  while (map.size > 512) map.delete(map.keys().next().value as K);
}
/** Repair contexts this process issued, by maker conversation and source call (selects the report under repair). */
const repairContexts = new Map<string, { context: NativeAssetRepairContext; reportId: string; reportRevision: string }>();
const repairKey = (callerChatId: string, toolchainId: string, callId: string | null) => digest([callerChatId, toolchainId, callId]);
const phaseNames = { report: "report", notice: "passive-notice", "read-reports": "report-read", repair: "repair-draft" } as const;
const wireHash = (value: string) => /^sha256:([a-f0-9]{64})$/.exec(value)?.[1] ?? fail("toolchain_native_canonical_hash_encoding_required");
function reportIdentity(phase: Readonly<OneToolchainOwnedPhaseInput>, request: Readonly<OneToolchainReportAdmissionRequest>,
  call: ToolchainCallReceipt): { reportId: string; reportRevision: string | null } {
  const reports = ledger(call.toolchainId).reports ?? [];
  const repair = repairContexts.get(repairKey(request.callerChatId, call.toolchainId, call.id));
  if (repair && repair.context.current() && (phase.phase === "repair" || phase.phase === "notice" || phase.phase === "read-reports" && !request.reportId))
    return { reportId: repair.reportId, reportRevision: repair.reportRevision };
  if (phase.phase === "repair") fail("toolchain_native_report_intent_owner_required");
  if (phase.phase === "read-reports") {
    if (request.reportId) {
      const report = reports.find(row => row.id === request.reportId) ?? fail("toolchain_native_report_intent_owner_required");
      return { reportId: report.id, reportRevision: reportRevision(report) };
    }
    return { reportId: `tcread_${digest([request.callerChatId, call.id, request.bodyDigest]).slice(7, 39)}`, reportRevision: null };
  }
  // report + its passive notice: the reporter's existing report on this call, or one owner-issued id kept across retries.
  const prior = reports.find(row => row.reporterChatId === request.callerChatId && row.eventId === call.id);
  if (prior) return { reportId: prior.id, reportRevision: reportRevision(prior) };
  const key = `${REPORT_PREFIX}${digest([call.toolchainId, call.id, request.callerChatId]).slice(7)}`;
  const issued = readMeta<{ reportId: string }>(key);
  if (issued && id(issued.reportId)) return { reportId: issued.reportId, reportRevision: null };
  const reportId = `tcrep_${randomUUID()}`;
  writeMeta(key, { reportId, at: new Date().toISOString() });
  return { reportId, reportRevision: null };
}

const resourceOwners: OneToolchainResourceOwnerPort = {
  async registerProduced({ original, release, sourceManifest }) {
    const found = releaseOf(release);
    if (!found || found.release.provenance.creatorChatId !== original.chatId) return null;
    return registerRelease(release, original.actor.principalId, { kind: "one", chatId: original.chatId, runId: original.runId }, sourceManifest);
  },
  async resolveAsset(ref) { return releaseOf(ref) ? storedAsset(ref) : null; },
  async resolveAudience({ original, asset, chatId }) {
    const chat = liveChat(chatId);
    if (!chat || asset.scope !== "personal" || asset.ownerPrincipalId !== original.actor.principalId) return null;
    const body = { chatId: chat.id, resourceId: `chat:${chat.id}`, principalId: original.actor.principalId, scope: "personal" as const,
      organizationId: null, projectId: null, assetRegistrationId: asset.registrationId };
    return { registrationId: `tcaud_${digest([chat.id, asset.registrationId]).slice(7, 39)}`, revision: digest(body), resourceId: body.resourceId,
      chatId: body.chatId, principalId: body.principalId, scope: body.scope, organizationId: null, projectId: null };
  },
  async registerCall({ original, asset, call }) {
    // Only the call's own producer run registers it: running first, then its terminal receipt.
    if (call.callerChatId !== original.chatId || call.parentRunId !== original.runId || !assetCurrent(asset, original.actor.principalId)) return null;
    const prior = storedCall(call.id);
    if (prior && (prior.producer.runId !== original.runId || prior.producer.chatId !== original.chatId || prior.assetRegistrationId !== asset.registrationId)) return null;
    const body = { call: { ...call }, producerRunId: original.runId, producerChatId: original.chatId, assetRegistrationId: asset.registrationId, assetRegistrationRevision: asset.revision };
    const record: StoredCallRegistration = { schema: "agentlas.toolchain-native-call.v1", registrationId: prior?.registrationId ?? `tccall_${randomUUID()}`,
      revision: digest(body), call: { ...call }, producer: structuredClone(original), assetRegistrationId: asset.registrationId, assetRegistrationRevision: asset.revision };
    writeMeta(callKey(call.id), record);
    return record;
  },
  async resolveCall({ asset, call }) {
    const stored = storedCall(call.id);
    return stored && stored.assetRegistrationId === asset.registrationId && digest(stored.call) === digest(call) ? stored : null;
  },
  currentCall(registration, asset, original) {
    const stored = storedCall(registration.call.id);
    return Boolean(stored && stored.registrationId === registration.registrationId && stored.revision === registration.revision
      && stored.assetRegistrationId === asset.registrationId && assetCurrent(asset, original.actor.principalId));
  },
  async resolveReportIntent({ phase, request }) {
    const call = request.ref.callId ? calls().getToolchainCall(request.ref.callId) : null;
    if (!call || call.toolchainId !== request.ref.toolchainId || call.version !== request.ref.version || call.contentHash !== request.ref.contentHash) return null;
    const actor = phase.original.actor, identity = reportIdentity(phase, request, call);
    const business: BusinessToolchainNativeRequest = { schema: BUSINESS_TOOLCHAIN_REQUEST_SCHEMA, phase: phaseNames[request.action],
      principalId: actor.principalId, sessionId: actor.sessionId, hostId: actor.hostId, organizationId: `personal:${actor.principalId}`,
      scope: { kind: "personal", principalId: actor.principalId }, workspaceId: actor.workspaceId, projectId: phase.asset.projectId,
      originalWorkRef: phase.original.commandId, callerChatId: phase.original.chatId, sourceCallCallerChatId: call.callerChatId as string,
      assetId: call.toolchainId, assetVersion: call.version, assetContentHash: wireHash(call.contentHash),
      callerCallId: call.id, callerInputHash: wireHash(call.inputHash), callerParentRunId: call.parentRunId as string, callerCallRunId: call.runId,
      reportId: identity.reportId, reportRevision: identity.reportRevision, recipientChatId: request.recipientChatId,
      bodyDigest: request.bodyDigest, purpose: `toolchain-${phaseNames[request.action]}`, payerId: `personal:${actor.principalId}` };
    const effect: BusinessToolchainEffectIdentity = { authorityId: AUTHORITY, domainId: `toolchain-ledger:${call.toolchainId}`,
      effectId: identity.reportId, revision: digest([phase.asset.registrationId, phase.asset.revision, phase.recipient.registrationId]) };
    const intent: OneToolchainReportIntentRegistration = { registrationId: `tcint_${randomUUID()}`, revision: digest({ business, effect }),
      request: business, reportId: identity.reportId, reportRevision: identity.reportRevision, effect };
    remember(intents, intent.registrationId, intent);
    remember(effectsByRequest, digest(business), effect);
    return intent;
  },
  currentReportIntent(intent, phase) {
    const issued = intents.get(intent.registrationId);
    return Boolean(issued && issued.revision === intent.revision && digest(issued) === digest(intent)
      && phase.original.actor.principalId === currentPrincipal() && leaseHeldHere(phase.original.runId));
  },
  ownerConversation(actor: Readonly<OneToolchainNativeActor>) {
    if (!hasTable("one_supervisor_conversations")) return null;
    const row = db().prepare("SELECT chat_id FROM one_supervisor_conversations WHERE one_id=?").get(actor.oneId) as { chat_id: string } | undefined;
    return liveChat(row?.chat_id)?.id ?? null;
  },
  currentAsset(registration, original) { return assetCurrent(registration, original.actor.principalId) && original.actor.principalId === currentPrincipal(); },
  currentAudience(registration: Readonly<OneToolchainAudienceRegistration>, original: Readonly<OneToolchainOriginalWork>) {
    return Boolean(liveChat(registration.chatId) && registration.principalId === original.actor.principalId
      && original.actor.principalId === currentPrincipal() && registration.scope === "personal");
  },
};

// ── Serialized effect domain (the Business facade of a personal install) ─────────────────────────────────────────
const business: OneToolchainBusinessFacade = {
  async prepareCurrentAction(request): Promise<BusinessPreparedNativeAction> {
    const principal = currentPrincipal();
    const known = effectsByRequest.has(digest(request));
    const allowed = known && request.schema === BUSINESS_TOOLCHAIN_REQUEST_SCHEMA && request.scope.kind === "personal"
      && request.scope.principalId === principal && request.principalId === principal;
    let released = false;
    return Object.freeze({ decision: allowed ? "allow" as const : "deny" as const, revision: allowed ? digest([AUTHORITY, request]) : "",
      reason: allowed ? "" : "toolchain_personal_owner_request_unknown",
      stillCurrent: () => allowed && !released && currentPrincipal() === principal, release: () => { released = true; } });
  },
  async withCurrentExclusion<T>(requests: readonly Readonly<BusinessToolchainNativeRequest>[], reducer: (exclusion: Readonly<{ protocol: typeof BUSINESS_TOOLCHAIN_EFFECT_PROTOCOL;
    effect: BusinessToolchainEffectIdentity; admissions: readonly never[]; current(): boolean }>) => T): Promise<BusinessToolchainEffectResult<T>> {
    const effects = requests.map(request => effectsByRequest.get(digest(request)));
    const effect = effects[0];
    if (!requests.length || !effect || effects.some(item => !item || digest(item) !== digest(effect))
      || requests.some(request => request.scope.kind !== "personal" || request.principalId !== currentPrincipal()))
      return { state: "denied", reason: "toolchain_personal_owner_effect_unknown", value: null };
    const store = db();
    let open = true;
    try {
      const value = store.transaction(() => reducer(Object.freeze({ protocol: BUSINESS_TOOLCHAIN_EFFECT_PROTOCOL, effect, admissions: [],
        current: () => open && store.inTransaction === true }))).immediate();
      return { state: "committed", reason: "", value };
    } catch (error) {
      return { state: "denied", reason: error instanceof Error ? error.message : "toolchain_personal_owner_effect_failed", value: null };
    } finally { open = false; }
  },
};

// ── Preparation and execution: the original run's own lifetime ──────────────────────────────────────────────────
const preparation: OneToolchainPreparationOwnerPort = {
  signal: original => runSignal(original),
  assertCurrent(original) { assertOriginalLive(original); },
  assertCandidate(original, _purpose, selection) {
    assertOriginalLive(original);
    // The candidate came from preparation's verified no-tools discovery of this owner's own runtimes.
    if (!selection || typeof selection.kind !== "string" || !selection.kind) fail("toolchain_native_runtime_candidate_required");
  },
  async withLifetime(original, body) {
    assertOriginalLive(original); runSignal(original).throwIfAborted();
    const value = await body();
    assertOriginalLive(original); return value;
  },
  async producedSources(_original, result) {
    const release = result.asset.versions.find(version => version.version === result.version) ?? fail("toolchain_native_immutable_release_changed");
    return releaseSources(release);
  },
  async withPreparedCommit(original, proposal, reducer) {
    assertOriginalLive(original);
    const store = db(), authorityRevision = digest([AUTHORITY, original.commandId, original.runId, original.leaseId, proposal.requestId, proposal.inputHash]);
    // current() is the authority (the original run's lease), read again after the commit returns: not "inside SQL".
    const value = store.transaction(() => reducer(Object.freeze({ authorityRevision,
      current: () => { try { assertOriginalLive(original); return true; } catch { return false; } } }))).immediate();
    return { state: "committed" as const, value };
  },
};
const execution: OneToolchainExecutionOwnerPort = {
  signal: original => runSignal(original),
  assertCurrent(original, call) {
    assertOriginalLive(original);
    if (call.callerChatId !== original.chatId || call.parentRunId !== original.runId) fail("toolchain_native_actual_call_producer_required");
  },
  async withLifetime(original, _call, body) {
    assertOriginalLive(original);
    const value = await body();
    return value;
  },
};

// ── Publication authority (toolchain_publish and the owner's "Validate examples & make callable") ─────────────────
function publicationCatalog(binding: Readonly<AssetPublicationBinding>): AssetPublicationBinding[] {
  const others = assets().listToolchainAssets().flatMap(asset => {
    const release = asset.versions.find(version => version.version === asset.stableVersion);
    return asset.id !== binding.id && asset.status === "callable" && release?.validation.state === "passed"
      ? [{ id: asset.id, version: release.version, contentHash: release.contentHash, assetRevision: asset.revision }] : [];
  }).sort((a, b) => b.assetRevision - a.assetRevision);
  return [{ ...binding }, ...others.slice(0, COLD_START_POLICY.maxCallable - 1)];
}
function lease(input: { binding: Readonly<AssetPublicationBinding>; registration: StoredAssetRegistration; actor: NativeAssetPublicationLease["actor"];
  retest: "reuse" | "fresh"; mode: NativeAssetPublicationLease["mode"]; budgetRevision: string; runtime: ToolchainPreparationProducer;
  live(): boolean; effectful(index: number): void }): NativeAssetPublicationLease {
  const found = releaseOf({ toolchainId: input.binding.id, version: input.binding.version, contentHash: input.binding.contentHash })
    ?? fail("toolchain_native_immutable_release_changed");
  let released = false;
  const current = () => !released && input.live() && assetCurrent(input.registration, currentPrincipal());
  const issued: NativeAssetPublicationLease = {
    registrationId: input.registration.registrationId, intentId: `tcpub_${randomUUID()}`, retest: input.retest,
    authorityRevision: digest([AUTHORITY, input.registration.registrationId, input.registration.revision, input.actor, input.binding]),
    budgetRevision: input.budgetRevision, deadlineAt: Date.now() + ASSET_FRESH_TEST_BUDGET_MS, actor: input.actor, mode: input.mode,
    catalog: publicationCatalog(input.binding), runtime: input.runtime,
    current, release() { released = true; },
    assertExample(index, inputHash, expectedOutputHash, effectful) {
      const example = found.release.contract.examples[index];
      if (!current() || !example || digest(example.input) !== inputHash || digest(example.expectedOutput) !== expectedOutputHash)
        fail("toolchain_publication_example_binding_changed");
      if (effectful) input.effectful(index);
    },
    async withCurrentExclusion(_resultDigest, reducer) {
      if (!current()) return { state: "denied" as const, value: null };
      const store = db();
      let open = true;
      try {
        const value = store.transaction(() => reducer(Object.freeze({ current: () => open && store.inTransaction === true && current() }))).immediate();
        return { state: "committed" as const, value };
      } finally { open = false; }
    },
  };
  return issued;
}
const publication: NativeAssetPublicationResolver = {
  async resolve(input): Promise<NativeAssetPublicationAuthority | null> {
    if (input.kind === "one") {
      const native = currentOneToolchainNativeInvocation(), original = native.assertCurrent();
      const caller = input.caller as { chatId?: unknown; permission?: unknown } | null;
      if (!caller || caller.chatId !== original.chatId || (caller.permission !== "write" && caller.permission !== "full")) return null;
      const prepared = native.preparation("fresh-session-evaluation");
      return { identity: {}, async prepare(binding) {
        const registration = storedAsset({ toolchainId: binding.id, version: binding.version, contentHash: binding.contentHash });
        if (!registration || registration.ownerPrincipalId !== original.actor.principalId) fail("toolchain_native_canonical_resource_required");
        return lease({ binding, registration, actor: { kind: "one", chatId: original.chatId }, retest: "reuse", mode: "register",
          budgetRevision: `${original.budgetId}:${original.budgetRevision}`, runtime: prepared.producer,
          live: () => { try { native.assertCurrent(); return true; } catch { return false; } },
          // Owner decision pending: an example that writes, uploads or sends runs for real during validation. The owner
          // approves that on the Toolchains screen; nothing approves it for a One turn yet.
          effectful: () => fail("toolchain_publication_effectful_example_owner_approval_required") });
      } };
    }
    const caller = input.caller as { event?: unknown; allowEffectfulValidation?: unknown } | null;
    if (!installedHost?.isOwnerIpcSender || !caller || !installedHost.isOwnerIpcSender(caller.event)) return null;
    const consent = caller.allowEffectfulValidation === true;
    return { identity: {}, async prepare(binding) {
      const principalId = currentPrincipal() ?? fail("toolchain_native_session_required");
      const ref = { toolchainId: binding.id, version: binding.version, contentHash: binding.contentHash };
      const found = releaseOf(ref) ?? fail("toolchain_native_immutable_release_changed");
      // Publishing is the owner's explicit act on this exact release; it registers the release if nothing produced it here.
      const registration = storedAsset(ref) ?? registerRelease(ref, principalId, { kind: "owner", chatId: null, runId: null }, releaseSources(found.release));
      let open = true;
      const live = () => open && currentPrincipal() === principalId;
      const owner: ToolchainPreparationProducer = {
        assertCurrent: () => { if (!live()) fail("toolchain_publication_authority_changed"); },
        assertCandidate: (_purpose, selection) => { if (!live() || !selection?.kind) fail("toolchain_publication_authority_changed"); },
      };
      const issued = lease({ binding, registration, actor: { kind: "owner", chatId: null }, retest: "fresh",
        mode: found.asset.status === "withdrawn" ? "owner-reregister" : "register", budgetRevision: "owner-explicit-publication",
        runtime: owner, live, effectful: () => { if (!consent) fail("toolchain_publication_effectful_example_owner_approval_required"); } });
      const release = issued.release;
      issued.release = () => { open = false; release(); };
      return issued;
    } };
  },
};

// ── Repair evidence (report → maker's repair draft → tested replacement settles the report) ──────────────────────
const issuedContexts = new WeakSet<object>(), issuedAcceptances = new WeakSet<object>();
function openReport(toolchainId: string, reportId: string): ToolchainReport | null {
  const report = (ledger(toolchainId).reports ?? []).find(row => row.id === reportId);
  return report && report.state === "open" ? report : null;
}
const repair: NativeAssetRepairEvidencePorts = {
  async prepareContext(query) {
    const native = currentOneToolchainNativeInvocation(), original = native.assertCurrent();
    if (original.chatId !== query.callerChatId) return null;
    if (original.budgetId === null || original.budgetRevision === null) fail("toolchain_native_admitted_repair_budget_required");
    const report = openReport(query.ref.toolchainId, query.reportId);
    if (!report) return null;
    const revision = reportRevision(report);
    const said = db().prepare("SELECT id, created_at FROM chat_messages WHERE chat_id=? AND role='user' ORDER BY created_at DESC LIMIT 1")
      .get(query.callerChatId) as { id: string; created_at: string } | undefined;
    let released = false;
    const key = repairKey(query.callerChatId, query.ref.toolchainId, query.ref.callId);
    const context: NativeAssetRepairContext = {
      reportId: report.id, reportRevision: revision, budgetRevision: `${original.budgetId}:${original.budgetRevision}`,
      assetRevision: query.assetRevision, ledgerRevision: query.ledgerRevision, observedAt: new Date().toISOString(),
      ownerMessage: said ? Object.freeze({ id: said.id, chatId: query.callerChatId, at: said.created_at, revision: digest([said.id, said.created_at]) }) : null,
      current() {
        if (released) return false;
        try { native.assertCurrent(); } catch { return false; }
        const now = openReport(query.ref.toolchainId, report.id);
        return Boolean(now && reportRevision(now) === revision);
      },
      release() { released = true; if (repairContexts.get(key)?.context === context) repairContexts.delete(key); },
    };
    issuedContexts.add(context);
    remember(repairContexts, key, { context, reportId: report.id, reportRevision: revision });
    return context;
  },
  assertContext(context, scope) {
    if (!issuedContexts.has(context) || scope.reportId !== context.reportId || scope.reportRevision !== context.reportRevision
      || context.current() !== true || !db().inTransaction) fail("toolchain_repair_report_authority_changed");
  },
  async prepareAcceptance(query) {
    const native = currentOneToolchainNativeInvocation(), original = native.assertCurrent();
    if (original.chatId !== query.callerChatId) return null;
    const report = openReport(query.ref.toolchainId, query.reportId);
    const state = ledger(query.ref.toolchainId) as { repairs?: Array<{ requestId?: string; reportId?: string; version?: number; contentHash?: string }> };
    const record = (state.repairs ?? []).find(row => row.requestId === query.repairRequestId && row.reportId === query.reportId);
    const asset = assets().getToolchainAsset(query.ref.toolchainId);
    const release = asset?.versions.find(version => version.version === record?.version && version.contentHash === record?.contentHash);
    // The replacement was tested and published under a native publication authority: that receipt is the approval.
    if (!report || !record || !asset || !release || asset.status !== "callable" || asset.stableVersion !== release.version
      || release.validation.state !== "passed" || !release.exposedBy) return null;
    const assetRevision = asset.revision;
    let released = false;
    const acceptance: NativeAssetRepairAcceptance = {
      reportId: report.id, reportRevision: reportRevision(report), toolchainId: asset.id, version: release.version, contentHash: release.contentHash,
      assetRevision, repairRequestId: query.repairRequestId, validationReceiptIds: [...release.validation.receipts],
      approvalRevision: digest([AUTHORITY, release.exposedBy, release.validation.receipts]),
      current() {
        if (released) return false;
        try { native.assertCurrent(); } catch { return false; }
        return assets().getToolchainAsset(asset.id)?.revision === assetRevision;
      },
      release() { released = true; },
    };
    issuedAcceptances.add(acceptance);
    return acceptance;
  },
  withAcceptedReplacement(context, evidence, scope, reducer) {
    if (!issuedContexts.has(context) || !issuedAcceptances.has(evidence) || scope.reportId !== context.reportId
      || evidence.reportId !== context.reportId || !db().inTransaction || evidence.current() !== true || context.current() !== true)
      fail("toolchain_repair_exact_acceptance_required");
    return reducer();
  },
};

let installedHost: PersonalToolchainOwnerHost | null = null;
/** Once per process, at personal startup. Construction reads nothing and calls no provider. */
export function installPersonalToolchainNativeOwner(host: PersonalToolchainOwnerHost): void {
  if (installedHost) { if (installedHost.host !== host.host) fail("toolchain_personal_owner_host_changed"); return; }
  configureOneToolchainNativeOwnerPorts({ owners: resourceOwners, business, preparation, execution, turns });
  configureNativeAssetPublicationResolver(publication);
  configureNativeAssetRepairEvidencePorts(repair);
  installedHost = host;
}
export function personalToolchainNativeOwnerInstalled(): PersonalToolchainOwnerHost["host"] | null { return installedHost?.host ?? null; }
