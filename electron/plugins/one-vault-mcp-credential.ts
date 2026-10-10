import { oneVaultDigest, verifyOneVault } from '../secrets/one-vault-crypto';
import { oneVaultSlot } from '../secrets/one-vault-journal';
import { currentOnePersonalNativeOriginal, type OnePersonalNativeOriginal } from '../secrets/one-personal-native-entry';
import { authorizeSupervisorNativeOrigin } from '../one/supervisor-native-runtime';
import { mcpServerConfigurationDigest } from '../mcp-tools/prepared-transport';
import type { OneVaultRuntime, OneVaultRuntimeAnchor } from '../secrets/one-vault-runtime';
import type { OneVaultRequest } from '../../shared/one-vault';
import type { OneVaultScopedConsumerReceipt, OneVaultPersonalAdapterPorts } from '../secrets/one-vault-personal-adapter';
import type { InstalledMcpServer } from '../../shared/types';

/** Issued by the existing native original/source selection owner, never manifest
 * prose, a renderer label, env-list result or a guessed provider account. */
export interface OneMcpApprovedCredentialUse {
 readonly commandId: string; readonly serverId: string; readonly configurationDigest: string;
 readonly pluginReleaseDigest: string; readonly sourceRevision: string; readonly nativeConsentReceiptId: string;
 readonly toolId: 'elevenlabs-audio'; readonly envKey: 'ELEVENLABS_API_KEY';
 readonly provider: 'elevenlabs-audio'; readonly providerWorkspace: string; readonly resourceId: string;
 readonly scope: 'personal' | 'organization'; readonly organizationId: string | null;
 readonly region: string; readonly credentialRef: string; readonly generation: number;
 readonly audience: 'owner' | 'organization'; readonly operations: readonly string[];
 stillCurrent(): boolean;
}
/** Exact lease shape returned by the already issued stored-reference bridge.
 * This adapter never mints/serializes a stored-reference proof or reads its value. */
export interface OneMcpStoredReferenceLease {
 readonly commandId: string; readonly request: Readonly<OneVaultRequest>; readonly operationId: string;
 readonly slotId: string; readonly credentialRef: string; readonly generation: number;
 readonly installationRevision: string; stillCurrent(): boolean;
 authorizeRead?(): Promise<{ stillCurrent(): boolean } | null>;
}
export interface OneMcpCredentialReference {
 readonly schema: 'agentlas.one-mcp-credential-reference.v1';
 readonly sourceRevision: string; readonly nativeConsentReceiptId: string;
 readonly serverId: string; readonly configurationDigest: string; readonly pluginReleaseDigest: string;
 readonly provider: 'elevenlabs-audio'; readonly providerWorkspace: string; readonly resourceId: string;
 readonly scope: 'personal' | 'organization'; readonly organizationId: string | null;
 readonly region: string; readonly audience: 'owner' | 'organization'; readonly operations: readonly string[];
 readonly consumer: Readonly<OneVaultScopedConsumerReceipt>;
}
/** Mandatory existing native plugin consumer owner. It consumes refs only
 * inside Main/current native transport. No raw-key reader or installation
 * ledger is invented here; a missing/lost ACK remains unavailable. */
export interface OneMcpCredentialNativeOwners {
 current(original: Readonly<OnePersonalNativeOriginal>, anchor: Readonly<OneVaultRuntimeAnchor>,
   server: Readonly<InstalledMcpServer>, envKey: string): OneMcpApprovedCredentialUse | null;
 consumer: NonNullable<OneVaultPersonalAdapterPorts['consumer']>;
 /** Adapt only createOneVaultStoredReferenceBridge.current plus its genuine
  * inspectOneVaultStoredReference(runtime,proof), never a DTO reconstruction. */
 storedReference?: {
  current(commandId: string, toolId: string, keyName: string): object | null;
  inspect(runtime: OneVaultRuntime, proof: object): OneMcpStoredReferenceLease | null;
 };
}
function fail(code: string): never { throw new Error(code); }
const unavailable = 'one_mcp_credential_native_owner_unbound';
function text(v: unknown): v is string { return typeof v === 'string' && v.length > 0 && v.length <= 512 && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v); }
/** Inert construction, no discovery/list/read/write/install/approval/queue.
 * Default missing owners stays unavailable; no legacy readEnvVar fallback. */
export function createOneMcpScopedCredentialAdapter(runtime: OneVaultRuntime, owners: OneMcpCredentialNativeOwners | null) {
 const ownerCurrent = owners?.current, consumer = owners?.consumer;
 const readConsumer = consumer?.current, storedOwner = owners?.storedReference;
 const storedCurrent = storedOwner?.current, storedInspect = storedOwner?.inspect;
 function capture(server: Readonly<InstalledMcpServer>, envKey: string) {
  if (!owners || !consumer || owners.current !== ownerCurrent || consumer.current !== readConsumer || owners.storedReference !== storedOwner || storedOwner?.current !== storedCurrent || storedOwner?.inspect !== storedInspect) fail(unavailable);
  const original = currentOnePersonalNativeOriginal();
  if (!original?.request.runId || !original.request.chatId) fail('one_mcp_credential_original_required');
  authorizeSupervisorNativeOrigin(original.origin, original.request);
  const rows = runtime.sources.db.prepare("SELECT command_id FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND kind IN ('reply','work','follow-up','chat-send')").all(runtime.sources.oneId(), original.request.runId) as Array<{command_id: string}>;
  const anchor = rows.length === 1 ? runtime.anchor(rows[0].command_id) : null;
  const native = runtime.currentNativeOwner(), host = runtime.trust.currentHostMetadata();
  if (!anchor || !native || !host || anchor.runId !== original.request.runId || anchor.chatId !== original.request.chatId || native.hostId !== host.hostId) fail('one_mcp_credential_original_changed');
  if (envKey !== 'ELEVENLABS_API_KEY' || !server.envKeys.includes(envKey) || !server.enabled || server.configurationValid === false) fail('one_mcp_credential_contract_unavailable');
  const selection = owners.current(original, Object.freeze(anchor), server, envKey);
  if (!selection || !selection.stillCurrent() || selection.commandId !== anchor.commandId || selection.serverId !== server.id
    || selection.configurationDigest !== mcpServerConfigurationDigest(server) || !/^[a-f0-9]{64}$/.test(selection.pluginReleaseDigest)
    || ![selection.sourceRevision, selection.nativeConsentReceiptId, selection.providerWorkspace, selection.resourceId, selection.credentialRef, selection.region].every(text)
    || selection.toolId !== 'elevenlabs-audio' || selection.provider !== selection.toolId || selection.envKey !== envKey
    || !Number.isSafeInteger(selection.generation) || selection.generation < 1 || !selection.operations.length || selection.operations.some(v => !text(v) || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(v))
    || !['personal','organization'].includes(selection.scope) || selection.scope === 'personal' && (selection.organizationId !== null || selection.audience !== 'owner')
    || selection.scope === 'organization' && (!text(selection.organizationId) || selection.audience !== 'organization')) fail('one_mcp_credential_source_unavailable');
  const metadata = runtime.metadata.read(anchor.commandId);
  let request: Readonly<OneVaultRequest>, operationId: string, stored: OneMcpStoredReferenceLease | null = null;
  if (metadata?.operationId) { request = metadata.request; operationId = metadata.operationId; }
  else {
   const proof = owners.storedReference?.current(anchor.commandId, selection.toolId, envKey);
   stored = proof ? owners.storedReference!.inspect(runtime, proof) : null;
   if (!stored || stored.commandId !== anchor.commandId || !stored.stillCurrent() || !stored.authorizeRead) fail('one_mcp_credential_stored_reference_unbound');
   request = stored.request; operationId = stored.operationId;
  }
  const operation = runtime.journal.get(operationId), slotId = oneVaultSlot(request), slot = runtime.journal.current(slotId), b = request.binding;
  if (!verifyOneVault('request', request, host.signingPublicKey) || request.hostKeyId !== host.hostKeyId || request.recipientKeyId !== host.recipientKeyId || b.hostId !== host.hostId || b.trustGeneration !== host.generation
   || b.principalId !== native.principalId || b.workspaceId !== native.workspaceId || b.provider !== selection.provider || b.providerWorkspace !== selection.providerWorkspace
   || b.resourceId !== selection.resourceId || b.scope !== selection.scope || b.organizationId !== selection.organizationId || b.region !== selection.region || b.storage !== 'os-vault'
   || !operation || operation.state !== 'saved' || operation.action !== 'store' || operation.requestId !== b.requestId || operation.requestDigest !== oneVaultDigest(request)
   || operation.slotId !== slotId || operation.generation !== operation.expectedGeneration + 1 || operation.expectedGeneration !== b.expectedGeneration
   || slot.pendingOperation !== null || slot.generation !== operation.generation || slot.credentialRef !== operation.credentialRef
   || operation.credentialRef !== `one-vault:${slotId}:${operation.generation}`
   || !stored && (b.commandId !== anchor.commandId || b.taskId !== anchor.taskId || b.runId !== anchor.runId || b.controlVersion !== anchor.controlVersion || b.sessionId !== native.sessionId)
   || selection.credentialRef !== operation.credentialRef || selection.generation !== operation.generation
   || stored && (stored.slotId !== slotId || stored.credentialRef !== operation.credentialRef || stored.generation !== operation.generation)) fail('one_mcp_credential_generation_or_scope_changed');
  const context = stored ? null : runtime.resolveCommand(anchor.commandId);
  if (!stored && (!context || context.binding.expectedGeneration !== operation.generation || context.binding.providerWorkspace !== b.providerWorkspace
   || context.binding.resourceId !== b.resourceId || context.binding.scope !== b.scope || context.binding.organizationId !== b.organizationId || context.binding.provider !== b.provider)) fail('one_mcp_credential_current_request_changed');
  const receipt = {commandId: anchor.commandId, toolId: selection.toolId, keyName: envKey, requestDigest: operation.requestDigest,
   slotId, credentialRef: operation.credentialRef, generation: operation.generation, principalId: native.principalId, sessionId: native.sessionId,
   workspaceId: native.workspaceId, hostId: native.hostId, installationRevision: stored?.installationRevision ?? ''};
  const base = {schema: 'agentlas.one-mcp-credential-reference.v1' as const, sourceRevision: selection.sourceRevision, nativeConsentReceiptId: selection.nativeConsentReceiptId,
   serverId: selection.serverId, configurationDigest: selection.configurationDigest, pluginReleaseDigest: selection.pluginReleaseDigest,
   provider: selection.provider, providerWorkspace: selection.providerWorkspace, resourceId: selection.resourceId, scope: selection.scope,
   organizationId: selection.organizationId, region: selection.region, audience: selection.audience, operations: [...selection.operations], consumer: receipt};
  // Display labels never select an account or enter this identity digest.
  return {original, anchor, native, host, selection, stored, request, operation, slot, contextBinding: context?.binding ?? null, base};
 }
 return Object.freeze({
  /** Only Main's original native invocation may call this. Returns value-free
   * installation evidence; neither raw value nor env alias is produced here. */
  async prepareReference(server: Readonly<InstalledMcpServer>, envKey: string): Promise<Readonly<OneMcpCredentialReference>> {
   const state = capture(server, envKey), digest = oneVaultDigest({...state, original: state.original.request, selection: {...state.selection, stillCurrent: null}, stored: null});
   const selectionCurrent = state.selection.stillCurrent;
   const current = () => { try { const c = capture(server, envKey); return c.original.origin === state.original.origin && c.selection === state.selection && c.selection.stillCurrent === selectionCurrent
    && (!state.stored || state.stored.stillCurrent()) && oneVaultDigest({...c, original: c.original.request, selection: {...c.selection, stillCurrent: null}, stored: null}) === digest; } catch { return false; } };
   const grant = state.stored ? await state.stored.authorizeRead!() : await runtime.authority({...state.request.binding, ...state.contextBinding!}, 'provider-read');
   if (!grant?.stillCurrent() || !current()) fail('one_mcp_credential_read_authority_changed');
   const live = () => grant.stillCurrent() && current();
   const reference = Object.freeze(structuredClone(state.base));
   const receipt = consumer!.current(state.anchor.commandId, state.selection.toolId, envKey);
   // Current native registry readback is required; caller booleans, unknown ACKs
   // and catalog/key-presence flags cannot manufacture readiness.
   const revision = receipt?.installationRevision;
   if (!receipt || !text(revision) || oneVaultDigest(receipt) !== oneVaultDigest({...reference.consumer, installationRevision: revision})) fail('one_mcp_credential_installation_unconfirmed');
   const installed = Object.freeze({...reference, consumer: Object.freeze({...reference.consumer, installationRevision: revision})});
   const readback = consumer!.current(state.anchor.commandId, state.selection.toolId, envKey);
   if (!live() || !readback || oneVaultDigest(readback) !== oneVaultDigest(installed.consumer)) fail('one_mcp_credential_installation_unconfirmed');
   return installed;
  },
 });
}
