import {memoryDatabaseForOriginalSource as memorySource} from '../memory/database';
import {getWorkEvaluationIdentity} from './employee-agent-work-evaluator';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { EMPLOYEE_AGENT_WORK_PURPOSE,assertWorkAssociation,workFail,workId,workObject,workSnapshot,type WorkAssociationPins,type WorkMaterializationReceipt,type WorkOracle,type WorkLocalChangeRequest,type WorkLocalAppliedReceipt } from '../../shared/business/employee-agent-work';
import { employeeAgentChangePath,employeeAgentChangeCanonical } from '../../shared/business/employee-agent-change';
import { parseWorkProgram,workDigest,produceWorkSemantics } from './employee-agent-work-semantics';
import { validateWorkOracle,evaluateWorkPrograms } from './employee-agent-work-evaluator';
import { looksSecret } from '../../shared/secret-patterns';
import {createDedicatedWorkspaceMaterializer, DedicatedWorkspaceMaterializationError} from '../agents/dedicated-workspace-materializer';

/** C's original local authority must supply this receiver. No report association,
 * serialized allow, renderer DTO or fallback supplier is installed in B. Root final
 * admission/recording is a distinct authority, never this local exclusion. */
export interface EmployeeAgentWorkAdmission {
 readonly protocol:'agentlas.business.original-work-local-admission.v1';
 capture():object|null;
 read(capability:object):WorkAssociationPins|null;
 assertCurrent(capability:object):void;
 refreshCurrent?(capability?:object):Promise<void>;
}
export interface EmployeeAgentWorkReview {
 request(kind:'materialize'|'oracle'|'change',digest:string,detail:string):Promise<object>;
 consume(capability:object,kind:'materialize'|'oracle'|'change',digest:string):{receiptId:string;expiresAt:number;assertCurrent():void};
}
/** Installed only by C's actual original invocation receiver. The source remains
 * unavailable in B shipping; copied command metadata is never an origin. */
export interface EmployeeAgentWorkCommandSource {
 readonly protocol:'agentlas.business.original-work-command.v1';
 read(capability:object):{commandId:string;oneId:string;taskId:string;runId:string;controlVersion:string;originChatId:string;chatId:string;leaseId:string;ownerId:string;nativeInputDigest:string;inputRevision:string;payloadHash:string;operationId:string;requestDigest:string}|null;
 assertCurrent(capability:object):void;
 refreshCurrent?(capability:object):Promise<void>;
}
type OriginalSources={db:typeof import('../store/db');routes:typeof import('../agents/routes');files:typeof import('../agents/files');
 workspace:typeof import('../agents/workspace-service');guard:typeof import('../agents/workspace-guard');snapshot:typeof import('../agents/workspace-snapshot');paths:typeof import('../runtime-paths')};
type Selection={sourceAgentId:string;root:string;row:string;route:string;files:Array<{path:string;bytes:Buffer;hash:string;mode:number}>;digest:string;association:WorkAssociationPins;authority:object};
type Asset={receipt:WorkMaterializationReceipt;root:string;store:string;authority:object};
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const originalRows=(db:OriginalSources['db']['getDb'] extends ()=>infer T?T:never,id:string)=>db.prepare('SELECT id,slug,builtin,visibility FROM installed_agents WHERE id=?').get(id) as {id:string;slug:string;builtin:number;visibility:string}|undefined;
function bytes(root:string,relative:string):Buffer{
 if(!employeeAgentChangePath(relative))workFail('private_path');let current=root;
 for(const component of relative.split('/')){current=path.join(current,component);const s=fs.lstatSync(current);if(s.isSymbolicLink()||s.nlink!==1&&!s.isDirectory())workFail('unsafe_file')}
 const fd=fs.openSync(current,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const a=fs.fstatSync(fd);if(!a.isFile()||a.nlink!==1||a.size>200000)workFail('unsafe_file');
 const b=fs.readFileSync(fd),z=fs.fstatSync(fd),live=fs.lstatSync(current);if([z,live].some(v=>v.dev!==a.dev||v.ino!==a.ino||v.size!==a.size||v.mtimeMs!==a.mtimeMs||v.ctimeMs!==a.ctimeMs||v.nlink!==1)||b.length!==a.size)workFail('source_changed');return b}finally{fs.closeSync(fd)}
}
function directory(root:string){const s=fs.lstatSync(root);if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync.native(root)!==path.resolve(root))workFail('unsafe_root')}
/** Inert construction; even imports of original storage are delayed until a focused
 * action has a genuine dedicated WORK authority. No queue, observer or timer. */
export function createEmployeeAgentWorkOwner(options:{admission?:EmployeeAgentWorkAdmission;review:EmployeeAgentWorkReview}){
 let sourceReferences:unknown[]|null=null;
 let closed=false,loaded:Promise<OriginalSources>|null=null,originalDb:ReturnType<OriginalSources['db']['getDb']>|null=null;
 const admission=options.admission,review=options.review,refs=admission?[admission.capture,admission.read,admission.assertCurrent]:[];
 const materializerSource=createDedicatedWorkspaceMaterializer;
 const refreshReference=admission?.refreshCurrent;
 const reviewRefs=[review.request,review.consume],selections=new WeakMap<object,Selection>(),assets=new WeakMap<object,Asset>();
 function current(authority?:object,pins?:WorkAssociationPins){
  if(closed||materializerSource!==createDedicatedWorkspaceMaterializer||!admission||admission.protocol!=='agentlas.business.original-work-local-admission.v1'||options.admission!==admission||options.review!==review
   ||admission.refreshCurrent!==refreshReference||refs.some((v,i)=>v!==[admission.capture,admission.read,admission.assertCurrent][i])||reviewRefs.some((v,i)=>v!==[review.request,review.consume][i]))workFail('shipping_authority_unavailable');
  const cap=authority??admission.capture();if(!cap)workFail('shipping_authority_unavailable');admission.assertCurrent(cap);const value=admission.read(cap);assertWorkAssociation(value);
  if(pins&&workDigest(pins)!==workDigest(value))workFail('association_changed');admission.assertCurrent(cap);return{authority:cap,association:workSnapshot(value)};
 }
 async function source(){current();await admission?.refreshCurrent?.();current();if(!loaded)loaded=Promise.all([import('../store/db'),import('../agents/routes'),import('../agents/files'),import('../agents/workspace-service'),import('../agents/workspace-guard'),import('../agents/workspace-snapshot'),import('../runtime-paths')]).then(([db,routes,files,workspace,guard,snapshot,paths])=>({db,routes,files,workspace,guard,snapshot,paths}));
  const s=await loaded;current();const now=[s.db.getDb,s.routes.getRoute,s.routes.setRoute,s.files.resolveAgentPackageDir,s.workspace.initializeDedicatedBusinessWorkWorkspace,s.workspace.withAgentWorkspaceMutationLease,s.guard.agentWorkspaceStorePath,s.snapshot.snapshotAgentWorkspace,s.paths.userDataPath];
  if(sourceReferences&&now.some((v,i)=>v!==sourceReferences![i]))workFail('source_owner_changed');sourceReferences??=now;const db=s.db.getDb();if(originalDb&&db!==originalDb)workFail('database_changed');originalDb=db;return s;
 }
 function schema(s:OriginalSources){const db=s.db.getDb();if(db.inTransaction)workFail('rollbackable_transaction');db.exec(`
 CREATE TABLE IF NOT EXISTS one_business_work_assets(asset_id TEXT PRIMARY KEY,root_path TEXT NOT NULL,store_path TEXT NOT NULL,lineage TEXT NOT NULL,state TEXT NOT NULL,record_json TEXT NOT NULL,head_revision TEXT,head_digest TEXT,source_generation INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS one_business_work_intents(intent_id TEXT PRIMARY KEY,state TEXT NOT NULL,input_digest TEXT NOT NULL,association_json TEXT NOT NULL,receipt_json TEXT);
 CREATE TABLE IF NOT EXISTS one_business_work_artifacts(artifact_id TEXT PRIMARY KEY,asset_id TEXT NOT NULL,kind TEXT NOT NULL,digest TEXT NOT NULL,record_json TEXT NOT NULL);
 `)}
 function dedicatedSource(s:OriginalSources,agentId:string,root?:string):boolean{
  const db=s.db.getDb();
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_business_work_assets'").get()&&db.prepare('SELECT 1 FROM one_business_work_assets WHERE asset_id=?').get(agentId))return true;
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_history_work_assets'").get()&&db.prepare('SELECT 1 FROM one_history_work_assets WHERE asset_id=?').get(agentId))return true;
  const directory=root??s.routes.getRoute(agentId)?.path;if(!directory)return false;
  const actual=path.resolve(directory).normalize('NFC').toLowerCase();
  return ['business-work-assets','history-work-assets'].some(namespace=>{const parent=path.resolve(s.paths.userDataPath(namespace)).normalize('NFC').toLowerCase();return actual===parent||actual.startsWith(parent+path.sep)});
 }
 function select(s:OriginalSources,agentId:string,paths:readonly string[],authority:object,pins:WorkAssociationPins):Selection{
  current(authority,pins);if(!paths.length||paths.length>32||new Set(paths.map(p=>p.toLowerCase())).size!==paths.length||paths.some(p=>!employeeAgentChangePath(p)))workFail('selection_invalid');
  const db=s.db.getDb(),row=originalRows(db,agentId);if(!row||row.builtin!==0||row.visibility!=='visible'||memorySource(db).prepare('SELECT id FROM memory_entries WHERE agent_id=? LIMIT 1').get(agentId)||dedicatedSource(s,agentId))workFail('source_unavailable');
  const route=s.routes.getRoute(agentId),root=route?.path??s.files.resolveAgentPackageDir(agentId,row.slug).dir;if(dedicatedSource(s,agentId,root))workFail('source_unavailable');directory(root);
  const files=paths.map(p=>{const b=bytes(root,p),text=b.toString('utf8');if(!Buffer.from(text).equals(b)||looksSecret(text))workFail('private_source');parseWorkProgram(text);const stat=fs.lstatSync(path.join(root,p));if(stat.mode&0o111)workFail('executable_unsupported');return{path:p,bytes:b,hash:hash(b),mode:stat.mode}});
  if(!files.some(f=>/^agent\.md$/i.test(f.path)))workFail('canonical_entry_required');
  const result={sourceAgentId:agentId,root,row:JSON.stringify(row),route:JSON.stringify(route),files,digest:workDigest(files.map(f=>({path:f.path,hash:f.hash}))),association:pins,authority};
  if(JSON.stringify(originalRows(db,agentId))!==result.row||JSON.stringify(s.routes.getRoute(agentId))!==result.route||memorySource(db).prepare('SELECT id FROM memory_entries WHERE agent_id=? LIMIT 1').get(agentId))workFail('source_changed');current(authority,pins);return result;
 }
 async function inspectSelection(sourceAgentId:string,paths:readonly string[]){const a=current(),s=await source(),v=select(s,sourceAgentId,workSnapshot(paths),a.authority,a.association),cap=Object.freeze({});selections.set(cap,v);return{capability:cap,digest:v.digest,paths:v.files.map(f=>f.path),detail:v.files.map(f=>`${f.path}\n${f.bytes.toString('utf8')}`).join('\n\n')};}
  function checkSelection(s:OriginalSources,v:Selection){const now=[s.db.getDb,s.routes.getRoute,s.routes.setRoute,s.files.resolveAgentPackageDir,s.workspace.initializeDedicatedBusinessWorkWorkspace,s.workspace.withAgentWorkspaceMutationLease,s.guard.agentWorkspaceStorePath,s.snapshot.snapshotAgentWorkspace,s.paths.userDataPath];if(!sourceReferences||now.some((f,i)=>f!==sourceReferences![i]))workFail('source_owner_changed');const z=select(s,v.sourceAgentId,v.files.map(f=>f.path),v.authority,v.association);if(z.root!==v.root||z.row!==v.row||z.route!==v.route||z.digest!==v.digest)workFail('source_changed')}
 async function acceptSelection(capability:object,intentId:string){
  if(!workId(intentId))workFail('intent_invalid');const v=selections.get(capability);if(!v)workFail('selection_required');const s=await source();checkSelection(s,v);
  const reviewDigest=workDigest({kind:'materialize',intentId,sourceAgentId:v.sourceAgentId,digest:v.digest,association:v.association});
  const approved=await review.request('materialize',reviewDigest,JSON.stringify({kind:'materialize',files:v.files.map(f=>({path:f.path,content:f.bytes.toString('utf8')}))}));
  await admission?.refreshCurrent?.();checkSelection(s,v);const proof=review.consume(approved,'materialize',reviewDigest);proof.assertCurrent();schema(s);const db=s.db.getDb();
  if(db.prepare('SELECT intent_id FROM one_business_work_intents WHERE intent_id=?').get(intentId))workFail('receipt_lookup_required');
  db.prepare("INSERT INTO one_business_work_intents VALUES(?,'claimed',?,?,NULL)").run(intentId,reviewDigest,employeeAgentChangeCanonical(v.association));selections.delete(capability);
   let materializationAssetId:string|null=null;
   try{const materializer=materializerSource({namespace:'business-work',sources:{userDataPath:s.paths.userDataPath,agentWorkspaceStorePath:s.guard.agentWorkspaceStorePath,snapshotAgentWorkspace:s.snapshot.snapshotAgentWorkspace}}),{assetId,root,store}=materializer;materializationAssetId=assetId;
   const tree=materializer.materialize({files:v.files,assertCurrent(){checkSelection(s,v);proof.assertCurrent();if(materializerSource!==createDedicatedWorkspaceMaterializer)workFail('source_owner_changed')}});checkSelection(s,v);proof.assertCurrent();
   db.prepare('INSERT INTO one_business_work_assets(asset_id,root_path,store_path,lineage,state,record_json) VALUES(?,?,?,?,?,?)').run(assetId,root,store,'explicit-work-materialization-acceptance','materializing','{}');
   // Fresh id and slug only. No definition dedupe, orphan adoption or personal route replacement.
   db.prepare("INSERT INTO installed_agents(id,slug,name,tagline,system_prompt,mcp_servers_json,trust_grade,installed_at,tone,visibility,builtin) VALUES(?,?,?,?,?,'[]','A',?,'calm','visible',0)")
    .run(assetId,`work-${assetId}`,'WORK','Declarative WORK',v.files.find(f=>/^agent\.md$/i.test(f.path))!.bytes.toString('utf8'),new Date().toISOString());
   s.routes.setRoute({agentId:assetId,path:root,runtime:'generic',labels:['generic'],kind:'agent',importedAt:new Date().toISOString(),source:'local-import',definitionHash:tree.treeDigest});
   const revision=s.workspace.initializeDedicatedBusinessWorkWorkspace(assetId,tree.treeDigest);checkSelection(s,v);proof.assertCurrent();
   const receipt:WorkMaterializationReceipt={schema:'agentlas.business.work-materialization.v1',kind:'explicit-work-materialization-acceptance',acceptanceId:randomUUID(),intentId,assetId,assetRootId:randomUUID(),sourceAgentId:v.sourceAgentId,sourceDigest:v.digest,approvedPaths:v.files.map(f=>f.path),revisionId:revision.id,treeDigest:revision.treeDigest,reviewReceiptId:proof.receiptId,association:v.association,nativeState:'accepted',rootRecording:'not-submitted'};
   db.transaction(()=>{current(v.authority,v.association);proof.assertCurrent();if(s.snapshot.snapshotAgentWorkspace(root).treeDigest!==receipt.treeDigest)workFail('readback_changed');db.prepare("UPDATE one_business_work_assets SET state='accepted',record_json=?,head_revision=?,head_digest=? WHERE asset_id=? AND state='materializing'").run(employeeAgentChangeCanonical(receipt),receipt.revisionId,receipt.treeDigest,assetId);db.prepare("UPDATE one_business_work_intents SET state='accepted',receipt_json=? WHERE intent_id=? AND state='claimed'").run(employeeAgentChangeCanonical(receipt),intentId);}).immediate();
   const cap=Object.freeze({});assets.set(cap,{receipt,root,store,authority:v.authority});return{capability:cap,receipt:workSnapshot(receipt)};
   }catch(error){db.prepare("UPDATE one_business_work_intents SET state='unknown' WHERE intent_id=? AND state='claimed'").run(intentId);if(materializationAssetId)db.prepare("UPDATE one_business_work_assets SET state='unknown' WHERE asset_id=? AND state<>'accepted'").run(materializationAssetId);if(error instanceof DedicatedWorkspaceMaterializationError)workFail(error.reason);throw error}
 }
 function assetMetadata(s:OriginalSources,a:Asset){
  current(a.authority,a.receipt.association);const db=s.db.getDb(),row=originalRows(db,a.receipt.assetId);
  if(!row||row.builtin!==0||row.visibility!=='visible'||memorySource(db).prepare('SELECT id FROM memory_entries WHERE agent_id=? LIMIT 1').get(a.receipt.assetId))workFail('private_source');
  directory(a.root);directory(a.store);const found:string[]=[],names=new Set<string>();
  const walk=(dir:string,prefix:string)=>{for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const name=prefix+ent.name;
   if(!employeeAgentChangePath(name)||names.has(name.toLowerCase())||names.size>1024||ent.isSymbolicLink())workFail('private_path');names.add(name.toLowerCase());
   if(ent.isDirectory()){if(!a.receipt.approvedPaths.some(p=>p.startsWith(name+'/')))workFail('private_path');walk(path.join(dir,ent.name),name+'/')}
   else if(ent.isFile()&&a.receipt.approvedPaths.includes(name)&&fs.lstatSync(path.join(dir,ent.name)).nlink===1)found.push(name);else workFail('private_path');
  }};walk(a.root,'');if(workDigest(found.sort())!==workDigest([...a.receipt.approvedPaths].sort()))workFail('asset_changed');
 }
 function currentHead(s:OriginalSources,a:Asset,expected?:{id:string;digest:string}){
  const row=s.db.getDb().prepare("SELECT head_revision,head_digest,source_generation FROM one_business_work_assets WHERE asset_id=? AND state='accepted'").get(a.receipt.assetId) as {head_revision:string;head_digest:string;source_generation:number}|undefined;
  if(!row)workFail('asset_changed');const head=JSON.parse(bytes(a.store,'head.json').toString('utf8')),target=expected??{id:row.head_revision,digest:row.head_digest};
  if(head.id!==target.id||head.treeDigest!==target.digest||s.snapshot.snapshotAgentWorkspace(a.root).treeDigest!==target.digest)workFail('source_head_changed');return row;
 }
 async function asset(capability:object){const a=assets.get(capability);if(!a)workFail('asset_required');current(a.authority,a.receipt.association);const s=await source(),row=s.db.getDb().prepare("SELECT root_path,store_path,record_json FROM one_business_work_assets WHERE asset_id=? AND state='accepted'").get(a.receipt.assetId) as {root_path:string;store_path:string;record_json:string}|undefined;
  if(!row||row.root_path!==a.root||row.store_path!==a.store||row.record_json!==employeeAgentChangeCanonical(a.receipt)||s.routes.getRoute(a.receipt.assetId)?.path!==a.root)workFail('asset_changed');assetMetadata(s,a);currentHead(s,a);return{a,s};}
 function artifact<T>(s:OriginalSources,a:Asset,kind:string,value:T){const text=employeeAgentChangeCanonical(value),id=randomUUID(),digest=hash(text);s.db.getDb().prepare('INSERT INTO one_business_work_artifacts VALUES(?,?,?,?,?)').run(id,a.receipt.assetId,kind,digest,text);const row=s.db.getDb().prepare('SELECT digest,record_json FROM one_business_work_artifacts WHERE artifact_id=?').get(id) as {digest:string;record_json:string}|undefined;if(!row||row.digest!==digest||row.record_json!==text)workFail('artifact_unknown');return{id,digest,value:workSnapshot(value)}}
 async function acceptOracle(capability:object,input:unknown){const o=validateWorkOracle(input),{a,s}=await asset(capability),digest=workDigest({assetId:a.receipt.assetId,oracle:o});
  const cap=await review.request('oracle',digest,JSON.stringify({kind:'oracle',cases:o.cases}));await asset(capability);const proof=review.consume(cap,'oracle',digest);proof.assertCurrent();return s.db.getDb().transaction(()=>{current(a.authority,a.receipt.association);proof.assertCurrent();return artifact(s,a,'oracle',{schema:'agentlas.business.work-oracle-acceptance.v1',oracle:o,association:a.receipt.association,reviewReceiptId:proof.receiptId});}).immediate();}
 async function evaluate(capability:object,input:{oracleAcceptanceId:string;proposalId:string;proposalDigest:string;requestDigest:string;bindingDigest:string;envelopeDigest:string}){
  const {a,s}=await asset(capability),row=s.db.getDb().prepare("SELECT digest,record_json FROM one_business_work_artifacts WHERE artifact_id=? AND asset_id=? AND kind='oracle'").get(input.oracleAcceptanceId,a.receipt.assetId) as {digest:string;record_json:string}|undefined;
  if(!row||hash(row.record_json)!==row.digest)workFail('oracle_required');const accepted=JSON.parse(row.record_json) as {oracle:WorkOracle;association:WorkAssociationPins};current(a.authority,accepted.association);
  return s.workspace.withAgentWorkspaceMutationLease(a.receipt.assetId,lease=>{
   assetMetadata(s,a);const proposal=lease.getDiff(input.proposalId);
   if(proposal.memoryEntryIds.length||proposal.status!=='review_ready'||proposal.agentId!==a.receipt.assetId||proposal.proposalDigest!==input.proposalDigest||proposal.changes.length!==1
    ||!a.receipt.approvedPaths.includes(proposal.changes[0].path))workFail('proposal_changed');
   const change=proposal.changes[0],semantics=produceWorkSemantics(change.beforeContent,change.afterContent,{proposalId:input.proposalId,proposalDigest:input.proposalDigest,requestDigest:input.requestDigest,bindingDigest:input.bindingDigest}),result=evaluateWorkPrograms(semantics.before,semantics.after,accepted.oracle,{oracleAcceptanceId:input.oracleAcceptanceId,proposalDigest:input.proposalDigest,envelopeDigest:input.envelopeDigest});
   lease.assertHeld();current(a.authority,a.receipt.association);
   return s.db.getDb().transaction(()=>{current(a.authority,a.receipt.association);lease.assertHeld();const semanticArtifact=artifact(s,a,'semantics',semantics),evaluationArtifact=artifact(s,a,'evaluation',result);return{semanticArtifact,evaluationArtifact};}).immediate();
  });
 }
 /** Genuine local producer. It never emits a Root resource revision. Missing C
  * origin is refused before any claim, preparation or file effect. */
 async function change(capability:object,commandSource:EmployeeAgentWorkCommandSource|undefined,commandCapability:object,input:{request:WorkLocalChangeRequest;oracleAcceptanceId:string}){
  if(!commandSource||commandSource.protocol!=='agentlas.business.original-work-command.v1')workFail('original_command_unavailable');
  const methods=[commandSource.read,commandSource.assertCurrent,commandSource.refreshCurrent],request=workSnapshot(input.request),{a,s}=await asset(capability);
  if(!workObject(request,request?.kind==='edit'?['kind','path','currentContent','proposedContent']:['kind','historicalRevisionId'])||!['edit','restore'].includes(request.kind)||request.kind==='edit'&&(!employeeAgentChangePath(request.path)||!a.receipt.approvedPaths.includes(request.path)))workFail('request_invalid');
  await commandSource.refreshCurrent?.(commandCapability);
  const [supervisor,runs,owners,admissions]=await Promise.all([import('../one/supervisor'),import('../store/run-events'),import('../store/invocation-run-owners'),import('../store/invocation-admissions')]);
  const references=[supervisor.currentOneNativeWorkControl,runs.recordRunEvent,owners.invocationRunOwners,owners.invocationRunOwners.getRunOwner,admissions.getInvocationAdmission],initial=commandSource.read(commandCapability);
  if(!initial)workFail('original_command_unavailable');const op=workSnapshot(initial),intent=`work-change:${op.operationId}`,originalHead=currentHead(s,a);let appliedHead:{id:string;digest:string}|undefined;
  function check(){assetMetadata(s,a);if(workDigest(currentHead(s,a,appliedHead))!==workDigest(originalHead))workFail('source_head_changed');if(methods[0]!==commandSource!.read||methods[1]!==commandSource!.assertCurrent||methods[2]!==commandSource!.refreshCurrent||references[0]!==supervisor.currentOneNativeWorkControl||references[1]!==runs.recordRunEvent||references[2]!==owners.invocationRunOwners||references[3]!==owners.invocationRunOwners.getRunOwner||references[4]!==admissions.getInvocationAdmission)workFail('original_command_changed');
   commandSource!.assertCurrent(commandCapability);const now=commandSource!.read(commandCapability);if(!now||workDigest(now)!==workDigest(op)||op.requestDigest!==workDigest({assetId:a.receipt.assetId,request,oracleAcceptanceId:input.oracleAcceptanceId}))workFail('original_command_changed');
   const row=s.db.getDb().prepare('SELECT * FROM one_supervisor_requests WHERE command_id=?').get(op.commandId) as import('../one/supervisor-store').SupervisorRequestRow|undefined;
   if(!row||row.state!=='accepted'||row.kind!=='work'||row.one_id!==op.oneId||row.task_id!==op.taskId||row.run_id!==op.runId||row.origin_chat_id!==op.originChatId||row.payload_hash!==op.payloadHash||supervisor.currentOneNativeWorkControl(row,'active')!==op.controlVersion)workFail('original_command_changed');
   const lease=owners.invocationRunOwners.getRunOwner(op.chatId,op.runId),admitted=admissions.getInvocationAdmission(op.runId);
   if(!lease||lease.state!=='active'||lease.leaseId!==op.leaseId||lease.ownerId!==op.ownerId||lease.chatId!==op.chatId||lease.runId!==op.runId
    ||!admitted||admitted.status!=='admitted'||admitted.chatId!==op.chatId||admitted.ownerProcessEpoch!==op.ownerId||admitted.inputDigest!==op.nativeInputDigest||admitted.admittedAt!==op.inputRevision
    ||admitted.digestVersion!=='main-canonical-json-v1'||JSON.parse(row.payload_json).workerChatId!==op.chatId)workFail('original_execution_required');
   const own=s.db.getDb().prepare("SELECT record_json FROM one_business_work_assets WHERE asset_id=? AND state='accepted'").get(a.receipt.assetId) as {record_json:string}|undefined;
   if(!own||own.record_json!==employeeAgentChangeCanonical(a.receipt)||s.routes.getRoute(a.receipt.assetId)?.path!==a.root)workFail('asset_changed');
  }
  function audit(phase:string,receipt:unknown){check();const result=runs.recordRunEvent({runId:op.runId,kind:'business_work_original_change',chatId:op.chatId,agentId:null,
   sourceEventId:`work:${op.operationId}:${phase}`,evidencePhase:'observed',correlation:{taskId:op.taskId},payload:{workOperationId:op.operationId,workPhase:phase,workDigest:workDigest(receipt)}});
   const saved=s.db.getDb().prepare('SELECT payload_json FROM run_events WHERE id=? AND run_id=?').get(result.id,op.runId) as {payload_json:string}|undefined;
   if(!saved||JSON.parse(saved.payload_json).workDigest!==workDigest(receipt)||s.db.getDb().inTransaction)workFail('audit_unknown');check();
  }
  check();if(s.db.getDb().prepare('SELECT intent_id FROM one_business_work_intents WHERE intent_id=?').get(intent))workFail('receipt_lookup_required');
  // Persist a non-replayable intent before preparation. FS and SQLite are not a
  // transaction; every failure thereafter remains lookup-only unknown.
  s.db.getDb().prepare("INSERT INTO one_business_work_intents VALUES(?,'claimed',?,?,NULL)").run(intent,op.requestDigest,employeeAgentChangeCanonical(a.receipt.association));
  try{
   const proposal=await s.workspace.withAgentWorkspaceMutationLease(a.receipt.assetId,lease=>{check();audit('claim',op);if(request.kind==='restore'&&request.historicalRevisionId!==a.receipt.revisionId){const historical=s.db.getDb().prepare("SELECT digest,record_json FROM one_business_work_artifacts WHERE asset_id=? AND kind='native-applied' AND json_extract(record_json,'$.newRevisionId')=?").get(a.receipt.assetId,request.historicalRevisionId) as {digest:string;record_json:string}|undefined;if(!historical||hash(historical.record_json)!==historical.digest)workFail('restore_lineage_required')}const p=request.kind==='edit'?lease.prepareFileReplacement({targetPath:request.path,currentContent:request.currentContent,proposedContent:request.proposedContent}):lease.prepareRollback(request.historicalRevisionId);check();return p});
   const evaluated=await evaluate(capability,{oracleAcceptanceId:input.oracleAcceptanceId,proposalId:proposal.id,proposalDigest:proposal.proposalDigest,requestDigest:op.requestDigest,bindingDigest:workDigest(a.receipt),envelopeDigest:workDigest(a.receipt.association)});check();
   await admission?.refreshCurrent?.();await commandSource.refreshCurrent?.(commandCapability);check();
   if(!evaluated.evaluationArtifact.value.passed)workFail('evaluation_failed');
   const reviewDigest=workDigest({operation:op,proposal,evaluation:evaluated.evaluationArtifact.digest,association:a.receipt.association});
   const diff=await s.workspace.withAgentWorkspaceMutationLease(a.receipt.assetId,lease=>{check();return lease.getDiff(proposal.id)});
   const approval=await review.request('change',reviewDigest,JSON.stringify({kind:'change',changes:diff.changes.map(c=>({path:c.path,before:c.beforeContent,after:c.afterContent})),before:evaluated.evaluationArtifact.value.before,after:evaluated.evaluationArtifact.value.after,passed:evaluated.evaluationArtifact.value.passed,heldoutPassed:evaluated.evaluationArtifact.value.heldoutPassed,negativePassed:evaluated.evaluationArtifact.value.negativePassed}));check();
   await admission?.refreshCurrent?.();await commandSource.refreshCurrent?.(commandCapability);check();
   const proof=review.consume(approval,'change',reviewDigest);proof.assertCurrent();
   return await s.workspace.withAgentWorkspaceMutationLease(a.receipt.assetId,lease=>{
    check();proof.assertCurrent();if(workDigest(lease.getDiff(proposal.id))!==workDigest(diff))workFail('proposal_changed');
    audit('apply-claim',{proposalId:proposal.id,proposalDigest:proposal.proposalDigest,reviewReceiptId:proof.receiptId});
    check();proof.assertCurrent();const approvalReceiptId=lease.issueApprovalReceipt(proposal.id,proposal.proposalDigest),apply={proposalId:proposal.id,reviewedHash:proposal.proposalDigest,approvalReceiptId};
    const applied=lease.apply(apply);if(!applied.appliedRevisionId)workFail('apply_unknown');appliedHead={id:applied.appliedRevisionId,digest:applied.proposedTreeDigest};check();proof.assertCurrent();const readback=lease.readAppliedSnapshot(apply);check();proof.assertCurrent();
    const receipt:WorkLocalAppliedReceipt={schema:'agentlas.business.work-native-applied.v1',nativeState:'native-applied',rootRecording:'not-submitted',operationId:op.operationId,acceptanceId:randomUUID(),assetId:a.receipt.assetId,materializationAcceptanceId:a.receipt.acceptanceId,nativeSourceRevision:originalHead.source_generation+1,
     commandId:op.commandId,taskId:op.taskId,runId:op.runId,controlVersion:op.controlVersion,requestDigest:op.requestDigest,proposalId:proposal.id,proposalDigest:proposal.proposalDigest,baseRevisionId:proposal.baseRevisionId,newRevisionId:readback.currentRevisionId!,treeDigest:readback.treeDigest,
     approvalReceiptId,nativeReviewReceiptId:proof.receiptId,semanticArtifactId:evaluated.semanticArtifact.id,evaluationArtifactId:evaluated.evaluationArtifact.id,association:a.receipt.association};
    audit('accepted',receipt);check();proof.assertCurrent();s.db.getDb().transaction(()=>{check();proof.assertCurrent();lease.assertHeld();artifact(s,a,'native-applied',receipt);if(s.db.getDb().prepare("UPDATE one_business_work_assets SET head_revision=?,head_digest=?,source_generation=source_generation+1 WHERE asset_id=? AND head_revision=? AND head_digest=? AND state='accepted'").run(receipt.newRevisionId,receipt.treeDigest,a.receipt.assetId,originalHead.head_revision,originalHead.head_digest).changes!==1)workFail('source_head_changed');s.db.getDb().prepare("UPDATE one_business_work_intents SET state='accepted',receipt_json=? WHERE intent_id=? AND state='claimed'").run(employeeAgentChangeCanonical(receipt),intent)}).immediate();
    return workSnapshot(receipt);
   });
  }catch(error){s.db.getDb().prepare("UPDATE one_business_work_intents SET state='unknown' WHERE intent_id=? AND state='claimed'").run(intent);throw error}
 }
 async function restoreAsset(acceptanceId:string){const s=await source(),c=current();schema(s);const rows=s.db.getDb().prepare("SELECT root_path,store_path,record_json FROM one_business_work_assets WHERE state='accepted' AND json_extract(record_json,'$.acceptanceId')=?").all(acceptanceId) as Array<{root_path:string;store_path:string;record_json:string}>;
  if(rows.length!==1)workFail('asset_required');const row=rows[0],receipt=JSON.parse(row.record_json) as WorkMaterializationReceipt;current(c.authority,receipt.association);
  const cap=Object.freeze({});assets.set(cap,{receipt,root:row.root_path,store:row.store_path,authority:c.authority});await asset(cap);return{capability:cap,receipt:workSnapshot(receipt)};
 }
 async function lookup(intentId:string){const s=await source(),a=current();schema(s);const row=s.db.getDb().prepare('SELECT state,association_json,receipt_json FROM one_business_work_intents WHERE intent_id=?').get(intentId) as {state:string;association_json:string;receipt_json:string|null}|undefined;if(!row)return null;if(row.association_json!==employeeAgentChangeCanonical(a.association))workFail('association_changed');
  if(!row.receipt_json)return{nativeState:'unknown' as const,rootRecording:'not-submitted' as const};const r=JSON.parse(row.receipt_json) as WorkMaterializationReceipt|WorkLocalAppliedReceipt;if(workDigest(r.association)!==workDigest(a.association))workFail('association_changed');if(!s.db.getDb().prepare("SELECT asset_id FROM one_business_work_assets WHERE asset_id=? AND state='accepted'").get(r.assetId))workFail('asset_changed');return workSnapshot(r);}
 function originalArtifact(s:OriginalSources,a:Asset,id:string,kind:string){const row=s.db.getDb().prepare('SELECT digest,record_json FROM one_business_work_artifacts WHERE artifact_id=? AND asset_id=? AND kind=?').get(id,a.receipt.assetId,kind) as {digest:string;record_json:string}|undefined;if(!row||hash(row.record_json)!==row.digest)workFail('artifact_unknown');return{digest:row.digest,value:JSON.parse(row.record_json)}}
 function oracleProof(s:OriginalSources,a:Asset,id:string){const stored=originalArtifact(s,a,id,'oracle'),v=stored.value;current(a.authority,v.association);return{artifactId:id,artifactDigest:stored.digest,oracleId:v.oracle.oracleId,oracleRevision:v.oracle.revision,fixtureDigest:workDigest(v.oracle),reviewReceiptId:v.reviewReceiptId}}
 async function registrationProof(capability:object,oracleId:string){const{a,s}=await asset(capability);return s.workspace.withAgentWorkspaceMutationLease(a.receipt.assetId,lease=>{assetMetadata(s,a);currentHead(s,a);const oracle=oracleProof(s,a,oracleId),programs=a.receipt.approvedPaths.map(p=>({path:p,programDigest:workDigest(parseWorkProgram(bytes(a.root,p).toString('utf8')))}));lease.assertHeld();current(a.authority,a.receipt.association);return{receipt:workSnapshot(a.receipt),oracle,programs,evaluator:getWorkEvaluationIdentity()}})}
 async function appliedProof(capability:object,intentId:string){const{a,s}=await asset(capability),receipt=await lookup('work-change:'+intentId);if(!receipt||!('schema' in receipt)||receipt.schema!=='agentlas.business.work-native-applied.v1'||receipt.assetId!==a.receipt.assetId)workFail('applied_receipt_required');
  const sem=originalArtifact(s,a,receipt.semanticArtifactId,'semantics'),ev=originalArtifact(s,a,receipt.evaluationArtifactId,'evaluation'),v=ev.value;
  if(sem.value.proposalDigest!==receipt.proposalDigest||sem.value.requestDigest!==receipt.requestDigest||v.proposalDigest!==receipt.proposalDigest||!v.passed)workFail('artifact_changed');
  const result={receipt,semantic:{artifactId:receipt.semanticArtifactId,artifactDigest:sem.digest,beforeProgramDigest:sem.value.beforeDigest,afterProgramDigest:sem.value.afterDigest,proposalDigest:sem.value.proposalDigest,requestDigest:sem.value.requestDigest},evaluation:{artifactId:receipt.evaluationArtifactId,artifactDigest:ev.digest,evaluatorVersion:v.evaluatorVersion,evaluatorDigest:v.evaluatorDigest,oracleAcceptanceId:v.oracleAcceptanceId,fixtureDigest:v.fixtureDigest,before:v.before,after:v.after,passed:v.passed,heldoutPassed:v.heldoutPassed,negativePassed:v.negativePassed,resultDigest:v.resultDigest},oracle:oracleProof(s,a,v.oracleAcceptanceId)};
  await asset(capability);return workSnapshot(result);
 }
 async function readWorkFile(capability:object,targetPath:string){const{a,s}=await asset(capability);if(!a.receipt.approvedPaths.includes(targetPath))workFail('private_path');return s.workspace.withAgentWorkspaceMutationLease(a.receipt.assetId,lease=>{currentHead(s,a);const text=bytes(a.root,targetPath).toString('utf8');parseWorkProgram(text);lease.assertHeld();return text})}
 async function sources(){const s=await source();return (memorySource(s.db.getDb()).prepare("SELECT id,name FROM installed_agents WHERE builtin=0 AND visibility='visible' AND id NOT IN(SELECT agent_id FROM memory_entries WHERE agent_id IS NOT NULL) ORDER BY name LIMIT 200").all() as Array<{id:string;name:string}>).filter(v=>!dedicatedSource(s,v.id)).map(v=>({id:v.id,label:v.name}))}
 async function files(sourceId:string){const s=await source(),row=originalRows(s.db.getDb(),sourceId);if(!row||row.builtin!==0||row.visibility!=='visible'||memorySource(s.db.getDb()).prepare('SELECT id FROM memory_entries WHERE agent_id=? LIMIT 1').get(sourceId)||dedicatedSource(s,sourceId))workFail('source_unavailable');const root=s.routes.getRoute(sourceId)?.path??s.files.resolveAgentPackageDir(sourceId,row.slug).dir;if(dedicatedSource(s,sourceId,root))workFail('source_unavailable');directory(root);const list:string[]=[];
  const walk=(dir:string,prefix:string,depth:number)=>{if(depth>4)return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=prefix+entry.name;if(list.length>=200)return;if(!employeeAgentChangePath(p)||entry.isSymbolicLink())continue;if(entry.isDirectory())walk(path.join(dir,entry.name),p+'/',depth+1);else if(entry.isFile()&&/\.md$/i.test(p)&&fs.lstatSync(path.join(dir,entry.name)).nlink===1)list.push(p)}};walk(root,'',0);return list;
 }
 async function localAssets(){const s=await source(),c=current();schema(s);return(s.db.getDb().prepare("SELECT record_json FROM one_business_work_assets WHERE state='accepted'").all() as Array<{record_json:string}>).flatMap(row=>{const r=JSON.parse(row.record_json) as WorkMaterializationReceipt;return workDigest(r.association)===workDigest(c.association)?[{id:r.acceptanceId,label:originalRows(s.db.getDb(),r.sourceAgentId)?.slug??'WORK',paths:[...r.approvedPaths]}]:[]})}
 async function nativeHead(capability:object){const{a,s}=await asset(capability);return{revision:currentHead(s,a).source_generation,revisionId:currentHead(s,a).head_revision,paths:[...a.receipt.approvedPaths]}}
 return Object.freeze({availability:()=>admission&&!closed?'local-producer-ready':'shipping-authority-unavailable',inspectSelection,acceptSelection,acceptOracle,evaluate,lookup,restoreAsset,change,registrationProof,appliedProof,readWorkFile,sources,files,localAssets,nativeHead,
  async revoke(capability:object){const a=assets.get(capability);if(!a)return;try{originalDb?.prepare("UPDATE one_business_work_assets SET state='revoked' WHERE asset_id=?").run(a.receipt.assetId)}finally{assets.delete(capability)}},
  close(){closed=true},
 });
}
