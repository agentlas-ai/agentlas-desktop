import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { userDataPath } from '../runtime-paths';
import { getDb } from '../store/db';
import { getOneProfile } from '../store/one-profile';
import { getAuthenticatedSessionBinding } from '../auth';
import { getCanonicalTask, hasPassedTaskForceExecutionVerification } from '../store/tasks';
import { getInvocationRunReceipt } from '../store/run-events';
import { getDurableOneSurfaceResult } from '../store/one-surface-results';
import { invocationRunOwners } from '../store/invocation-run-owners';
import { supervisorExactResult } from './supervisor-presentation';
import { oneSupervisor, currentOneNativeWorkControl } from './supervisor';
import type { SupervisorRequestRow } from './supervisor-store';
import type { NativeHistoryExactManifest, NativeHistoryArtifact } from './history-evolution-native';
import { beforeOnePersonalHistoryPageRead, dispatchOnePersonalIntegrationNative } from './personal-integrations-runtime';
import { PERSONAL_INTEGRATION_METHODS } from './personal-integrations-glue';
import { oneNativeHostIdentity } from './host-identity';
import { currentOneActionAuthority, oneBusinessAuthorityConnected } from './action-authority';
import { OnePersonalDataStore, personalDataError, personalDataHash, personalDataTarget } from './personal-data-store';
import { OnePersonalDataService, type PersonalDataAuthorityRequest, type PersonalDataExactResult } from './personal-data-service';
import { OnePersonalDataConnectorRegistry, type PersonalDataSourcePort } from './personal-data-connector';
import type { OnePersonalDataBootstrap, OnePersonalDataNativeAPI } from '../../shared/one-personal-native';
import type { PersonalDataTarget, PersonalDataSourceBinding, PersonalDataSpaceLink } from '../../shared/one-personal-data';
import type { OneActionAuthorityRequest } from '../../shared/one-authority';

interface SourceRegistration { label: string; port: PersonalDataSourcePort; assertConsent(target: PersonalDataTarget): string }
const registrations = new Map<string, SourceRegistration>();
const connectors = new OnePersonalDataConnectorRegistry();
let instance: OnePersonalDataService | null = null;
/** Installed optional plugins provide discovered read contracts and CURRENT native consent.
 * A catalog item, OAuth token or mock capability never registers a ready source by itself. */
export function registerOnePersonalSource(id: string, registration: SourceRegistration): () => void {
  if (registrations.has(id)) throw personalDataError('personal_data_connector_conflict');
  const stop = connectors.register(id, registration.port); registrations.set(id, registration);
  return () => { stop(); if (registrations.get(id) === registration) registrations.delete(id); };
}
function schema(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS one_personal_data_acl(target_key TEXT PRIMARY KEY,target_json TEXT NOT NULL,principal_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS one_personal_data_native_bindings(command_id TEXT PRIMARY KEY,value_json TEXT NOT NULL,principal_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS one_personal_data_selected(principal_id TEXT PRIMARY KEY,target_key TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS one_personal_data_target_commands(command_id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,intent_hash TEXT NOT NULL,target_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS one_personal_data_result_files(target_key TEXT NOT NULL,command_id TEXT NOT NULL,principal_id TEXT NOT NULL,artifact_id TEXT NOT NULL,manifest_digest TEXT NOT NULL,file_digest TEXT NOT NULL,file_path TEXT NOT NULL,PRIMARY KEY(target_key,command_id));`);
}
function session() {
  const value = getAuthenticatedSessionBinding();
  if (!value) throw personalDataError('personal_data_sign_in_required');
  return value;
}
function originalTask(target: PersonalDataTarget, commandId: string, materialize = false, expected?: NativeHistoryExactManifest): PersonalDataExactResult | null {
  const db = getDb(), oneId = getOneProfile().oneId;
  const row = db.prepare('SELECT * FROM one_supervisor_requests WHERE command_id=? AND one_id=?').get(commandId, oneId) as SupervisorRequestRow | undefined;
  if (!row?.task_id || !row.run_id) return null;
  const task = getCanonicalTask(row.task_id), receipt = getInvocationRunReceipt(row.run_id);
  if (!task?.originChatId || receipt?.chatId !== task.originChatId || receipt.status !== 'completed' || task.status !== 'completed'
    || !hasPassedTaskForceExecutionVerification(row.run_id)) return null;
  const controlVersion = currentOneNativeWorkControl(row, 'result');
  if (!controlVersion) return null;
  const text = supervisorExactResult(db, task.originChatId, row.run_id)?.text;
  if (!text) return null;
  const durable = getDurableOneSurfaceResult({ taskId: task.id, chatId: task.originChatId, runId: row.run_id });
  if(!durable) return null;
  const revision = durable.manifest.manifestId;
  const manifestDigest=personalDataHash(durable.manifest), targetKey=personalDataHash(target), fileDigest=createHash('sha256').update(text,'utf8').digest('hex');
  // A stale supplied result must not create an artifact or mutate the durable ledger.
  if(expected && (expected.commandId!==commandId||expected.taskId!==task.id||expected.runId!==row.run_id||expected.chatId!==task.originChatId||expected.controlVersion!==controlVersion||expected.text!==text||expected.manifestDigest!==manifestDigest||personalDataHash(expected.manifest)!==manifestDigest))return null;
  const artifactId=`pd-result:${personalDataHash([targetKey,commandId,revision,fileDigest])}`;
  let file=db.prepare('SELECT * FROM one_personal_data_result_files WHERE target_key=? AND command_id=?').get(targetKey,commandId) as {principal_id:string;artifact_id:string;manifest_digest:string;file_digest:string;file_path:string}|undefined;
  if(materialize && !file) {
    if(db.inTransaction)throw personalDataError('personal_data_artifact_uncommitted');
    const directory=userDataPath('one','page-results',targetKey), destination=path.join(directory,`${fileDigest}.md`);
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    try{fs.writeFileSync(destination,text,{encoding:'utf8',flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw personalDataError('personal_data_artifact_write_unconfirmed');}
    if(createHash('sha256').update(fs.readFileSync(destination)).digest('hex')!==fileDigest)throw personalDataError('personal_data_artifact_readback_mismatch');
    const principal=session().userId;
    db.prepare('INSERT OR IGNORE INTO one_personal_data_result_files VALUES(?,?,?,?,?,?,?)').run(targetKey,commandId,principal,artifactId,manifestDigest,fileDigest,destination);
    file=db.prepare('SELECT * FROM one_personal_data_result_files WHERE target_key=? AND command_id=?').get(targetKey,commandId) as typeof file;
  }
  if(!file || file.principal_id!==session().userId || file.artifact_id!==artifactId || file.manifest_digest!==manifestDigest || file.file_digest!==fileDigest
    || createHash('sha256').update(fs.readFileSync(file.file_path)).digest('hex')!==fileDigest) return null;
  return { verified: true, state: 'completed', text, chatId: task.originChatId, anchor: {
    commandId, taskId: task.id, runId: row.run_id, controlVersion,
    artifactId, artifactRevision: revision, artifactDigest: fileDigest, chatId: task.originChatId,
  } };
}
/** Reuse the exact immutable artifact/ledger, after checking the current original native result. */
export async function materializeOneHistoryExactResult(target: PersonalDataTarget, exact: NativeHistoryExactManifest): Promise<NativeHistoryArtifact | null> {
  schema(); target = personalDataTarget(target);
  const actor = session(), db = getDb();
  oneSupervisor().assertHostWriteAuthority(target.oneId);
  const acl = db.prepare('SELECT principal_id FROM one_personal_data_acl WHERE target_key=?').get(personalDataHash(target)) as { principal_id: string } | undefined;
  if (acl?.principal_id !== actor.userId || target.oneId !== getOneProfile().oneId || target.deploymentId !== oneNativeHostIdentity().hostId) throw personalDataError('personal_data_page_acl_denied');
  const current = originalTask(target, exact.commandId, true, exact);
  const durable = getDurableOneSurfaceResult({ taskId: exact.taskId, chatId: exact.chatId, runId: exact.runId });
  if (!current || !durable || current.text !== exact.text || current.anchor.taskId !== exact.taskId || current.anchor.runId !== exact.runId || current.anchor.chatId !== exact.chatId || current.anchor.controlVersion !== exact.controlVersion || personalDataHash(durable.manifest) !== exact.manifestDigest || personalDataHash(exact.manifest) !== exact.manifestDigest || current.anchor.artifactRevision !== exact.manifest.manifestId) return null;
  return { anchor: current.anchor, readBackVerified: true };
}
function authority(input: PersonalDataAuthorityRequest) {
  const native = session(), host = oneNativeHostIdentity(), target = personalDataTarget(input.target), db = getDb();
  const acl = db.prepare('SELECT principal_id FROM one_personal_data_acl WHERE target_key=?').get(personalDataHash(target)) as { principal_id: string } | undefined;
  const request: OneActionAuthorityRequest = { principalId: native.userId, sessionId: native.sessionId, oneId: target.oneId, hostId: host.hostId,
    scope: target.scope, organizationId: target.organizationId, workspaceId: native.workspaceId, projectId: target.projectId,
    resourceId: `${target.spaceId}:${target.pageId}`, purpose: input.sources.map(s => s.purpose).join('; ') || 'editable-one-page', payerId: native.userId,
    action: input.action, taskId: input.anchor?.taskId ?? null, runId: input.anchor?.runId ?? null, controlVersion: input.anchor?.controlVersion ?? null,
    permissionRevision: personalDataHash(input.sources.map(s => s.permissionRevision)), credentialGeneration: input.sources.length ? personalDataHash(input.sources.map(s => s.credentialGeneration)) : null,
    sourceRefs: input.sources.map(s => s.sourceId), audience: target.audience };
  return currentOneActionAuthority(request, { current: () => {
    if (!acl || acl.principal_id !== native.userId) return { decision: 'deny', revision: '', reason: 'personal_data_page_acl_denied' };
    const revisions: string[] = [];
    for (const binding of input.sources) {
      const source = registrations.get(binding.connectorId);
      if (!source || personalDataHash(source.port.binding(target)) !== personalDataHash(binding)) return { decision: 'deny', revision: '', reason: 'personal_data_permission_changed' };
      revisions.push(source.assertConsent(target));
    }
    if (input.budgetId && !oneSupervisor().budgets({ oneId: target.oneId, budgetId: input.budgetId }).length) return { decision: 'deny', revision: '', reason: 'personal_data_budget_missing' };
    return { decision: 'allow', revision: personalDataHash([native, target, acl.principal_id, revisions]), reason: 'current_native_owner' };
  } });
}
export function onePersonalDataNativeService(): OnePersonalDataService {
  if (instance) return instance;
  schema(); const store = new OnePersonalDataStore(getDb());
  instance = new OnePersonalDataService({ store, connectors, deploymentId: oneNativeHostIdentity().hostId, oneId: () => getOneProfile().oneId,
    get organizationAuthorityConnected() { return oneBusinessAuthorityConnected(); }, authority: { check: authority }, supervisor: {
      startWork: input => oneSupervisor().startWork(input), followUp: input => {
        const db=getDb(),native=session();
        const original=db.prepare(`SELECT b.value_json,b.principal_id FROM one_personal_data_native_bindings b JOIN one_supervisor_requests r ON r.command_id=b.command_id
          WHERE r.task_id=? ORDER BY r.rowid LIMIT 1`).get(input.taskId) as {value_json:string;principal_id:string}|undefined;
        if(!original || original.principal_id!==native.userId)throw personalDataError('personal_data_follow_up_binding_missing');
        const source=JSON.parse(original.value_json) as {commandId:string;target:PersonalDataTarget;sourceBindings:PersonalDataSourceBinding[];sourceRevision:number;budgetId:string};
        const page=store.page(source.target);if(!page?.acceptedAnchor)throw personalDataError('personal_data_follow_up_anchor_mismatch');
        const binding={...source,commandId:input.commandId,acceptedPage:{revision:page.revision,digest:page.digest,anchor:page.acceptedAnchor}};
        const prior=db.prepare('SELECT value_json,principal_id FROM one_personal_data_native_bindings WHERE command_id=?').get(input.commandId) as {value_json:string;principal_id:string}|undefined;
        if(prior){if(prior.principal_id!==native.userId)throw personalDataError('personal_data_binding_conflict');}
        else db.prepare('INSERT INTO one_personal_data_native_bindings VALUES(?,?,?)').run(input.commandId,JSON.stringify(binding),native.userId);
        assertOnePersonalDataInvocationCurrent(input.commandId);
        return oneSupervisor().followUp(input);
      }, control: input => oneSupervisor().control(input),
      receipt: input => oneSupervisor().receipt(input), exactResult: (target, commandId) => originalTask(target,commandId),
      bindOccurrence: input => {
        const principal = session().userId, db = getDb();
        const prior = db.prepare('SELECT value_json,principal_id FROM one_personal_data_native_bindings WHERE command_id=?').get(input.commandId) as { value_json: string; principal_id: string } | undefined;
        const json = JSON.stringify(input);
        if (prior && (prior.value_json !== json || prior.principal_id !== principal)) throw personalDataError('personal_data_binding_conflict');
        db.prepare('INSERT OR IGNORE INTO one_personal_data_native_bindings VALUES(?,?,?)').run(input.commandId, json, principal);
      },
    } });
  return instance;
}
/** Queue claim, native admission, and each provider dispatch call the SAME current fence. */
export function assertOnePersonalDataInvocationCurrent(commandId: string): void {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_personal_data_native_bindings'").get()) return;
  const row = db.prepare('SELECT value_json,principal_id FROM one_personal_data_native_bindings WHERE command_id=?').get(commandId) as { value_json: string; principal_id: string } | undefined;
  if (!row) return;
  if (row.principal_id !== session().userId) throw personalDataError('personal_data_session_changed');
  const binding=JSON.parse(row.value_json) as Parameters<OnePersonalDataService['assertOccurrenceAuthority']>[0]&{acceptedPage?:{revision:number;digest:string;anchor:unknown}};
  onePersonalDataNativeService().assertOccurrenceAuthority(binding);
  if(binding.acceptedPage){const page=new OnePersonalDataStore(db).page(binding.target);
    if(!page || page.revision!==binding.acceptedPage.revision || page.digest!==binding.acceptedPage.digest || personalDataHash(page.acceptedAnchor)!==personalDataHash(binding.acceptedPage.anchor))throw personalDataError('personal_data_follow_up_page_changed');}
}
export function assertOnePersonalDataRunCurrent(runId?: string): void {
  if (!runId) return;
  const db = getDb(); if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_personal_data_native_bindings'").get()) return;
  const row = db.prepare('SELECT r.command_id FROM one_supervisor_requests r JOIN one_personal_data_native_bindings b ON b.command_id=r.command_id WHERE r.run_id=?').get(runId) as { command_id: string } | undefined;
  if (row) assertOnePersonalDataInvocationCurrent(row.command_id);
}
/** A Main-minted tool capability selects its original occurrence; input cannot choose a target/account. */
export function readOnePersonalDataForNativeRun(input: { commandId: string; chatId: string; runId: string; occurrenceId: string }): unknown {
  assertOnePersonalDataInvocationCurrent(input.commandId);
  const db = getDb(), binding = db.prepare('SELECT value_json FROM one_personal_data_native_bindings WHERE command_id=?').get(input.commandId) as { value_json: string } | undefined;
  const original = db.prepare('SELECT task_id,run_id FROM one_supervisor_requests WHERE command_id=?').get(input.commandId) as { task_id: string; run_id: string } | undefined;
  const custody = invocationRunOwners.getRunOwner(input.chatId, input.runId);
  if (!binding || original?.run_id !== input.runId || !custody || custody.state !== 'active' || custody.chatId !== input.chatId) throw personalDataError('personal_data_original_run_required');
  const parsed = JSON.parse(binding.value_json) as { target: PersonalDataTarget };
  const store = new OnePersonalDataStore(db), occurrence = store.occurrence(input.occurrenceId, parsed.target);
  if (occurrence?.commandId !== input.commandId) throw personalDataError('personal_data_occurrence_mismatch');
  return onePersonalDataNativeService().readSource(parsed.target, input.occurrenceId);
}
export function collectOnePersonalDataResult(runId: string): void {
  const db = getDb(); if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_personal_data_occurrences'").get()) return;
  const rows = db.prepare('SELECT o.value_json FROM one_personal_data_occurrences o JOIN one_supervisor_requests r ON json_extract(o.value_json,\'$.commandId\')=r.command_id WHERE r.run_id=?').all(runId) as Array<{ value_json: string }>;
  for (const row of rows) {
    const value = JSON.parse(row.value_json) as { target: PersonalDataTarget; occurrenceId: string; commandId:string };
    onePersonalDataNativeService().readSource(value.target,value.occurrenceId);
    if(!originalTask(value.target,value.commandId,true))throw personalDataError('personal_data_exact_result_missing');
    onePersonalDataNativeService().proposeFromResult(value);
  }
}
/** Passive exact-result reconciliation; never restarts a provider or inference. */
export function recoverOnePersonalDataResults(target?:PersonalDataTarget):void {
  schema();const db=getDb();
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_personal_data_occurrences'").get())return;
  const rows=db.prepare(`SELECT DISTINCT r.run_id FROM one_personal_data_occurrences o JOIN one_supervisor_requests r ON json_extract(o.value_json,'$.commandId')=r.command_id
    WHERE r.one_id=? AND r.state='completed' AND (? IS NULL OR o.target_key=?) ORDER BY r.updated_at DESC LIMIT 50`).all(getOneProfile().oneId,target?personalDataHash(target):null,target?personalDataHash(target):null) as Array<{run_id:string}>;
  for(const row of rows){try{collectOnePersonalDataResult(row.run_id);}catch{/* A stale, missing or revoked result stays unavailable; no inference replay. */}}
}
export function onePersonalDataFileToOpen(target:PersonalDataTarget,ref:string):string {
  beforeOnePersonalHistoryPageRead(target);
  const snapshot=onePersonalDataNativeService().snapshot({target});
  if(!snapshot.space?.links.some(link=>link.kind==='file'&&link.ref===ref))throw personalDataError('personal_data_space_link_missing');
  const file=getDb().prepare('SELECT file_path,file_digest,principal_id FROM one_personal_data_result_files WHERE target_key=? AND artifact_id=?').get(personalDataHash(target),ref) as {file_path:string;file_digest:string;principal_id:string}|undefined;
  const expectedDirectory=userDataPath('one','page-results',personalDataHash(target));
  if(!file || file.principal_id!==session().userId || path.dirname(file.file_path)!==expectedDirectory
    || fs.lstatSync(file.file_path).isSymbolicLink() || fs.realpathSync(file.file_path)!==path.join(fs.realpathSync(expectedDirectory),path.basename(file.file_path))
    || createHash('sha256').update(fs.readFileSync(file.file_path)).digest('hex')!==file.file_digest)throw personalDataError('personal_data_artifact_readback_mismatch');
  return file.file_path;
}
/** Native-owner resolution only. Paths never enter the renderer API or model context. */
export function resolveOnePersonalDataSpaceLink(input:{target:PersonalDataTarget;link:PersonalDataSpaceLink}):{kind:'page'}|{kind:'conversation';taskId:string}|{kind:'file';ref:string} {
  const target=personalDataTarget(input?.target),link=input?.link;
  beforeOnePersonalHistoryPageRead(target);
  if(!link || Object.keys(link).sort().join('|')!=='kind|label|ref' || !['page','conversation','file'].includes(link.kind))throw personalDataError('personal_data_invalid_input');
  const snapshot=onePersonalDataNativeService().snapshot({target});
  if(!snapshot.space?.links.some(value=>personalDataHash(value)===personalDataHash(link)))throw personalDataError('personal_data_space_link_missing');
  if(link.kind==='page') {if(link.ref!==target.pageId)throw personalDataError('personal_data_space_link_missing');return{kind:'page'};}
  if(link.kind==='file'){onePersonalDataFileToOpen(target,link.ref);return{kind:'file',ref:link.ref};}
  const records=getDb().prepare(`SELECT r.task_id FROM one_personal_data_result_files f JOIN one_supervisor_requests r ON r.command_id=f.command_id WHERE f.target_key=? AND f.principal_id=?`).all(personalDataHash(target),session().userId) as Array<{task_id:string|null}>;
  const task=records.flatMap(row=>row.task_id?[getCanonicalTask(row.task_id)]:[]).find(value=>value?.originChatId===link.ref);
  if(!task)throw personalDataError('personal_data_space_link_missing');return{kind:'conversation',taskId:task.id};
}
export async function dispatchOnePersonalDataNative(method: string, args: unknown[] = []): Promise<unknown> {
  schema(); const service = onePersonalDataNativeService(), oneId = getOneProfile().oneId;
  if ((PERSONAL_INTEGRATION_METHODS as readonly string[]).includes(method)) {
    if (args.length > 1) throw personalDataError('personal_integration_input_invalid');
    return dispatchOnePersonalIntegrationNative(method, args[0]);
  }
  if(method==='resolveSpaceLink')return resolveOnePersonalDataSpaceLink(args[0] as Parameters<typeof resolveOnePersonalDataSpaceLink>[0]);
  const allowed = ['snapshot','create','edit','collect','sourceControl','accept','cancelProposal','rebaseProposal','cancelInference','followUp'];
  if (allowed.includes(method)) {
    oneSupervisor().assertHostWriteAuthority(oneId);
    if(method==='snapshot') { const target = (args[0] as {target:PersonalDataTarget}).target; beforeOnePersonalHistoryPageRead(target); recoverOnePersonalDataResults(target); }
    // Terminal actions ignore revoked source grants, while retaining the native target owner fence.
    if(['sourceControl','cancelProposal','cancelInference'].includes(method)) {
      const target=personalDataTarget((args[0] as {target:PersonalDataTarget}).target);
      const native=session(),acl=getDb().prepare('SELECT principal_id FROM one_personal_data_acl WHERE target_key=?').get(personalDataHash(target)) as {principal_id:string}|undefined;
      if(!acl || acl.principal_id!==native.userId || target.oneId!==oneId || target.deploymentId!==oneNativeHostIdentity().hostId)throw personalDataError('personal_data_page_acl_denied');
    }
    return (service[method as keyof OnePersonalDataService] as (...values: unknown[]) => unknown).apply(service, args);
  }
  const native = session(), store = new OnePersonalDataStore(getDb());
  const list = (): OnePersonalDataBootstrap['targets'] => (getDb().prepare('SELECT target_json FROM one_personal_data_acl WHERE principal_id=?').all(native.userId) as Array<{ target_json: string }>).flatMap(row => {
    const target = JSON.parse(row.target_json) as PersonalDataTarget;
    if (target.oneId !== oneId || target.deploymentId !== oneNativeHostIdentity().hostId) return [];
    try { beforeOnePersonalHistoryPageRead(target); return [{ target, label: service.snapshot({ target }).page?.title || 'Page' }]; } catch { return []; }
  });
  const bootstrap = (targetKey?: string): OnePersonalDataBootstrap => {
    const targets = list();
    const selected = targetKey ?? (getDb().prepare('SELECT target_key FROM one_personal_data_selected WHERE principal_id=?').get(native.userId) as { target_key: string } | undefined)?.target_key;
    const target = targets.find(t => store.key(t.target) === selected)?.target ?? targets[0]?.target ?? null;
    const budgets = oneSupervisor().budgets({ oneId });
    return { state: 'ready', target, targets, creatableScopes: [{ scope: 'personal', organizationId: null, projectId: null, label: 'Personal' }],
      budgetId: budgets[0]?.budgetId ?? null, bindingKey: personalDataHash([native, target]), errorCode: null };
  };
  if (method === 'listTargets') return list();
  if (method === 'bootstrap') return bootstrap(args[0] as string | undefined);
  if (method === 'selectTarget') {
    const target = personalDataTarget((args[0] as { target: PersonalDataTarget }).target);
    service.snapshot({ target }); getDb().prepare('INSERT INTO one_personal_data_selected VALUES(?,?) ON CONFLICT(principal_id) DO UPDATE SET target_key=excluded.target_key').run(native.userId, store.key(target));
    return bootstrap(store.key(target));
  }
  if (method === 'createTarget') {
    oneSupervisor().assertHostWriteAuthority(oneId);
    const input = args[0] as { commandId: string; scope: PersonalDataTarget['scope']; organizationId: string | null; projectId: string | null; title: string };
    if (!input || typeof input.commandId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.commandId) || Object.keys(input).some(k => !['commandId','scope','organizationId','projectId','title'].includes(k))) throw personalDataError('personal_data_invalid_input');
    if(input.scope!=='personal' || input.organizationId!==null || input.projectId!==null)throw personalDataError('personal_data_target_authority_required');
    const previous = getDb().prepare('SELECT * FROM one_personal_data_target_commands WHERE command_id=?').get(input.commandId) as {principal_id:string;intent_hash:string;target_json:string}|undefined;
    if(previous){
      if(previous.principal_id!==native.userId || previous.intent_hash!==personalDataHash(input))throw personalDataError('personal_data_command_conflict');
      const original=personalDataTarget(JSON.parse(previous.target_json));service.snapshot({target:original});return bootstrap(store.key(original));
    }
    const target = personalDataTarget({ deploymentId: oneNativeHostIdentity().hostId, oneId, scope: input.scope, organizationId: input.organizationId, projectId: input.projectId,
      spaceId: `space:${randomUUID()}`, pageId: `page:${randomUUID()}`, audience: input.organizationId ? 'organization' : 'owner' });
    store.atomic(() => {
      getDb().prepare('INSERT INTO one_personal_data_acl VALUES(?,?,?)').run(store.key(target), JSON.stringify(target), native.userId);
      service.create({ commandId: input.commandId, target, title: input.title, text: '' });
      getDb().prepare('INSERT INTO one_personal_data_target_commands VALUES(?,?,?,?)').run(input.commandId,native.userId,personalDataHash(input),JSON.stringify(target));
    });
    return bootstrap(store.key(target));
  }
  if (method === 'connectorCatalog') {
    const target = (args[0] as { target: PersonalDataTarget }).target; service.snapshot({ target });
    const values: Array<{connectorId:string;label:string;state:'available'|'permission-required'|'unavailable'}> = [...registrations].map(([connectorId, registration]) => {
      let state: 'available' | 'permission-required' | 'unavailable' = 'available';
      try { registration.port.binding(target); registration.assertConsent(target); } catch { state = 'permission-required'; }
      return { connectorId, label: registration.label, state };
    });
    if (!values.some(v => v.connectorId === 'gmail')) values.push({ connectorId: 'gmail', label: 'Gmail · installed read contract and permission required', state: 'unavailable' });
    return values;
  }
  if (method === 'registerSource') {
    const input = args[0] as { target: PersonalDataTarget; connectorId: string }; service.snapshot({ target: input.target });
    const registration = registrations.get(input.connectorId); if (!registration) throw personalDataError('personal_data_installed_connector_required');
    registration.assertConsent(input.target); oneSupervisor().assertHostWriteAuthority(oneId);
    const existing=service.snapshot({target:input.target}).sources.find(s=>s.binding.connectorId===input.connectorId);
    if(existing)return existing;
    return service.registerSource(input.target, input.connectorId);
  }
  throw personalDataError('personal_data_method_invalid');
}
/** Main viewer forwards to the already authenticated native Supervisor owner; no local fallback after handoff. */
export function onePersonalDataEndpoint(): OnePersonalDataNativeAPI {
  return new Proxy({} as OnePersonalDataNativeAPI, { get(_target, method: string) { return async (...args: unknown[]) => {
    const runtime = await import('./supervisor-native-runtime');
    if (runtime.supervisorRuntimeMode() === 'handoff') throw personalDataError('personal_data_owner_handoff_pending');
    if (runtime.supervisorRuntimeMode() === 'daemon') return runtime.callOneSupervisorRuntime('personal.command', { method, args });
    return dispatchOnePersonalDataNative(method, args);
  }; } });
}
