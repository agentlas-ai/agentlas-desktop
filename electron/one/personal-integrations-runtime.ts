import { createHistoryRuntimeFences, type HistoryRuntimeFencePorts, type HistoryRuntimeFence } from './history-runtime-fences';
import { getDb } from '../store/db';
import { getAuthenticatedSessionBinding } from '../auth';
import { getOneProfile } from '../store/one-profile';
import { oneNativeHostIdentity } from './host-identity';
import { oneSupervisor, currentOneNativeWorkBudget } from './supervisor';
import { personalDataError, personalDataHash, personalDataTarget } from './personal-data-store';
import { createOnePersonalIntegrationOwner, createExistingPersonalOwnerWake, PERSONAL_INTEGRATION_METHODS, createDefaultGmailNativeDialogReview } from './personal-integrations-glue';
import { createNativeGmailPersonalRegistration, type NativeGmailRegistrationOptions } from '../plugins/gmail-personal-registration';
import { createNativeHistoryEvolution, type NativeHistoryEvolutionOptions, type NativeHistoryEvolutionService } from './history-evolution-native';
import { createDefaultHistoryNativeExecution, type HistoryNativeExecutionPorts, type HistoryNativeRunToken } from './history-native-execution-glue';
import type { PersonalDataTarget } from '../../shared/one-personal-data';

/** Only native composition can provide these capabilities. There is no IPC setter or serialized allow flag. */
export interface OnePersonalIntegrationNativePolicy {
  gmail?: Omit<NativeGmailRegistrationOptions, 'reviewNative' | 'subscribeOwnerWake'>;
  history?: Omit<NativeHistoryEvolutionOptions, 'materialize'>;
  historyToolResources?: HistoryNativeExecutionPorts['resolveToolResources'];
  historyToolReference?:HistoryRuntimeFencePorts['canonicalToolReference'];
}
let policy: OnePersonalIntegrationNativePolicy | null = null;
let history: NativeHistoryEvolutionService | null = null;
let owner: ReturnType<typeof createOnePersonalIntegrationOwner> | null = null;
let wake: ReturnType<typeof createExistingPersonalOwnerWake> | null = null;
let execution: Awaited<ReturnType<typeof createDefaultHistoryNativeExecution>> | null = null;
let initializing: Promise<void> | null = null;
let epoch = 0;
let runtimeFences:ReturnType<typeof createHistoryRuntimeFences>|null=null;
export function currentOnePersonalIntegrationEpoch(): number { return epoch; }

export function currentOnePersonalIntegrationActor() {
  const session = getAuthenticatedSessionBinding();
  if (!session || session.expiresAt !== null && session.expiresAt <= Date.now()) throw personalDataError('personal_integration_sign_in_required');
  return { principalId: session.userId, sessionId: session.sessionId, workspaceId: session.workspaceId, oneId: getOneProfile().oneId, hostId: oneNativeHostIdentity().hostId };
}
function assertOwner(): void { currentOnePersonalIntegrationActor(); oneSupervisor().assertHostWriteAuthority(getOneProfile().oneId); }
export function assertOnePersonalIntegrationCurrentOwner(): void { assertOwner(); }
function hasHistoryProvenance(target: PersonalDataTarget): boolean {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_personal_data_pages'").get()) return false;
  const page = db.prepare('SELECT r.value_json FROM one_personal_data_revisions r JOIN one_personal_data_pages p ON p.target_key=r.target_key AND p.current_revision=r.revision WHERE p.target_key=?').get(personalDataHash(target)) as { value_json: string } | undefined;
  const proposals = db.prepare('SELECT value_json FROM one_personal_data_proposals WHERE target_key=?').all(personalDataHash(target)) as Array<{ value_json: string }>;
  return [page, ...proposals].some(row => row && /"(?:sourceId|connectorId)":"he-source:/.test(row.value_json));
}
/** Native policy binding is separate from account/OAuth/security activation. No reads occur here. */
export function configureOnePersonalIntegrationPolicy(next: OnePersonalIntegrationNativePolicy): void {
  if (policy && policy !== next || owner || initializing) throw personalDataError('personal_integration_already_configured');
  policy = next;
}
function assertBudget(binding: Parameters<HistoryNativeExecutionPorts['assertCurrentBudget']>[0], stage: Parameters<HistoryNativeExecutionPorts['assertCurrentBudget']>[1]): void {
  const budget = oneSupervisor().budgets({ oneId: binding.target.oneId, budgetId: binding.envelope.budgetId })[0];
  if (!budget) throw personalDataError('history_native_budget_binding_required');
  if (stage === 'claim') {
    if (budget.limitUsd !== null && (budget.availableUsd ?? 0) < budget.reserveUsd) throw personalDataError('history_native_budget_binding_required');
  } else {
    const admitted = currentOneNativeWorkBudget(binding.commandId, binding.envelope.budgetId);
    if (admitted?.admitted !== true || admitted.revision !== budget.revision) throw personalDataError('history_native_budget_binding_required');
  }
}
async function initialize(): Promise<void> {
  if (owner) { assertOwner(); return; }
  if (initializing) return initializing;
  const originalEpoch = epoch, actorDigest = personalDataHash(currentOnePersonalIntegrationActor());
  initializing = (async () => {
    assertOwner();
    const nextWake = createExistingPersonalOwnerWake(assertOwner), nextOwner = createOnePersonalIntegrationOwner({ assertOwner, hasHistoryProvenance });
    let nextHistory: NativeHistoryEvolutionService | null = null;
    try {
      const gmailPolicy = policy?.gmail ?? { discovery: () => null, custody: () => ({ decision: 'unknown' as const, permissionRevision: '', audienceGrantRevision: '', credentialGeneration: '', expectedAccountRef: '', prepared: null }), personalAuthority: { current: () => ({ decision: 'unknown' as const, revision: '', reason: 'gmail_personal_native_grant_required' }) } };
      const gmail = await createNativeGmailPersonalRegistration({
        ...gmailPolicy,
        custody: (selection, actor) => { assertOwner(); return epoch === originalEpoch ? gmailPolicy.custody(selection, actor) : { decision: 'deny', permissionRevision: '', audienceGrantRevision: '', credentialGeneration: '', expectedAccountRef: '', prepared: null }; },
        personalAuthority: { current: request => { assertOwner(); return epoch === originalEpoch ? gmailPolicy.personalAuthority.current(request) : { decision: 'deny', revision: '', reason: 'personal_integration_authority_changed' }; } },
        reviewNative: createDefaultGmailNativeDialogReview(currentOnePersonalIntegrationActor), subscribeOwnerWake: nextWake.subscribeOwnerWake,
      });
      if (epoch !== originalEpoch || personalDataHash(currentOnePersonalIntegrationActor()) !== actorDigest) { gmail.close(); throw personalDataError('personal_integration_session_changed'); }
      nextOwner.configureGmail(gmail);
      if (policy?.history) {
        const runtime = await import('./personal-data-runtime');
        const historyPolicy = policy.history;
        nextHistory = await createNativeHistoryEvolution({ ...historyPolicy, personalAuthority: { current: request => { assertOwner(); return epoch === originalEpoch ? historyPolicy.personalAuthority.current(request) : { decision: 'deny', revision: '', reason: 'personal_integration_authority_changed' }; } }, materialize: runtime.materializeOneHistoryExactResult });
        nextOwner.configureNativeHistory(nextHistory);
      }
      const nextExecution = await createDefaultHistoryNativeExecution({ service: () => history, assertCurrentBudget: assertBudget, resolveToolResources: input => policy?.historyToolResources?.(input) ?? null });
      assertOwner();
      if (epoch !== originalEpoch || personalDataHash(currentOnePersonalIntegrationActor()) !== actorDigest) { nextExecution.close(); throw personalDataError('personal_integration_session_changed'); }
      history = nextHistory; execution = nextExecution; wake = nextWake; owner = nextOwner;
    } catch (error) { nextOwner.close(); nextHistory?.close(); nextWake.close(); throw error; }
  })();
  try { await initializing; } finally { initializing = null; }
}
export async function dispatchOnePersonalIntegrationNative(method: string, value?: unknown): Promise<unknown> {
  if (!(PERSONAL_INTEGRATION_METHODS as readonly string[]).includes(method)) throw personalDataError('personal_integration_method_invalid');
  await initialize(); assertOwner();
  const actor = personalDataHash(currentOnePersonalIntegrationActor()), originalEpoch = epoch;
  const result = await owner!.dispatch(method, value);
  assertOwner();
  if (epoch !== originalEpoch || actor !== personalDataHash(currentOnePersonalIntegrationActor())) throw personalDataError('personal_integration_session_changed');
  return result;
}
export async function prepareOnePersonalIntegrationsNative(): Promise<void> { await initialize(); }
export function beforeOnePersonalHistoryPageRead(target: PersonalDataTarget): void {
  personalDataTarget(target);
  if (!hasHistoryProvenance(target)) return;
  if (!owner) throw personalDataError('personal_integration_history_required');
  owner.beforePageRead(target);
}
export function assertOneHistoryCommandCurrent(commandId: string, stage: 'claim' | 'dispatch'): void {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_history_native_bindings'").get() || !db.prepare('SELECT 1 FROM one_history_native_bindings WHERE command_id=?').get(commandId)) return;
  if (!execution) throw personalDataError('history_native_execution_adapter_required');
  execution.assertCommand(commandId, stage);
}
export async function bindOneHistoryNativeRun(input: { runId: string; chatId: string }): Promise<HistoryNativeRunToken | null> {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_history_native_bindings'").get() || !db.prepare('SELECT 1 FROM one_history_native_bindings b JOIN one_supervisor_requests r ON r.command_id=b.command_id WHERE r.run_id=?').get(input.runId)) return null;
  await initialize(); return execution!.bindRun(input);
}
export function currentOneHistoryExecution() { return execution; }
export function assertOneHistoryRunCurrent(input: { runId: string; chatId: string }): void {
  if (execution) { execution.assertRun(input); return; }
  const db = getDb();
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_history_native_bindings'").get() && db.prepare('SELECT 1 FROM one_history_native_bindings b JOIN one_supervisor_requests r ON r.command_id=b.command_id WHERE r.run_id=?').get(input.runId)) throw personalDataError('history_native_execution_adapter_required');
}
export function wakeOnePersonalIntegrationsFromExistingCheckin(): void { wake?.wakeFromExistingCheckin(); }
export function invalidateOnePersonalIntegrations(): void { owner?.invalidateCurrent(); closeOnePersonalIntegrations(); }
export function closeOnePersonalIntegrations(): void { epoch++; owner?.close(); execution?.close(); wake?.close(); owner = null; history = null; execution = null; wake = null; }

/** Existing native invocation lease is already claimed by InvocationService. No renderer scope. */
export async function withOneHistoryNativeInvocation<T>(input:{runId:string;chatId:string},execute:()=>Promise<T>):Promise<T>{const token=await bindOneHistoryNativeRun(input);if(!token)return execute();runtimeFences??=createHistoryRuntimeFences({bindRun:bindOneHistoryNativeRun,execution:currentOneHistoryExecution,canonicalToolReference:i=>policy?.historyToolReference?.(i)??null});return runtimeFences.withInvocation(input,()=>execute());}
