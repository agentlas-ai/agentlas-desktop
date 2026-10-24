import {createCompanyAgentSourceCustody} from './company-agent-source-custody';
import type {createOnePortableDefinitionSource} from './one-portable-definition';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type {OneVaultSqlite} from '../secrets/one-vault-journal';
import type {BusinessNativeAssociation} from '../../shared/business/native-sharing-wire';
import { createEmployeeAgentTransferCustody, employeeAgentTransferDigest, employeeAgentTransferReceiptMatches, readEmployeeAgentTransferFile, type CompanyAgentAssetOwner } from './employee-agent-transfer-custody';
import { employeeAgentChangeObject as object } from '../../shared/business/employee-agent-change';
import { isBusinessId } from '../../shared/business/context';
import { employeeAgentTransferPath, employeeAgentTransferSafeText, isEmployeeAgentTransferReceipt, isEmployeeAgentInstallationReceipt, type EmployeeAgentTransferKind, type EmployeeAgentTransferInbox, type EmployeeAgentTransferPackage } from '../../shared/business/employee-agent-transfer';
import { transferPackageSheet, registerAgentSheet, prepareDefinitionSheet, prepareFilesSheet } from './native-approval-sheets';
function fail(): never { throw Error('employee_agent_transfer_original_owner_required'); }
export interface EmployeeAgentInstallation {install(v:{agentId:string;displayName:string;definition:string},root:string):Promise<void>;installed(v:{agentId:string;displayName:string;definition:string},root:string):boolean}
export interface EmployeeAgentTransferOriginal {identityOwner:object;db:OneVaultSqlite;userDataPath(...segments:string[]):string;assertCurrent():void;installation:EmployeeAgentInstallation;
 connection:{current():BusinessNativeAssociation|null;refresh():Promise<unknown>;request(operation:string,value:unknown):Promise<unknown>}}
export function registerEmployeeAgentTransferMain(input: {
  ipc: Pick<IpcMain, 'handle'>; locale(): 'ko' | 'en';
  original(event?:IpcMainInvokeEvent): EmployeeAgentTransferOriginal;
  focused(event: IpcMainInvokeEvent): { window: BrowserWindow; check(): void };
  /** Personal One only; company-window and manual-folder owners return null. */
  personalOneSource?(event:IpcMainInvokeEvent):ReturnType<typeof createOnePortableDefinitionSource>|null;
}) {
  type Original = ReturnType<typeof input.original>;
  const custodians = new WeakMap<object, ReturnType<typeof createEmployeeAgentTransferCustody>>();
  const captured = [input.ipc, input.locale, input.original, input.focused, input.personalOneSource];
  function references() { if ([input.ipc, input.locale, input.original, input.focused, input.personalOneSource].some((v, i) => v !== captured[i])) fail(); }
  async function custody(o: Original) {
    if (custodians.has(o.connection)) return custodians.get(o.connection)!;
    const refs=[o.installation,o.installation.install,o.installation.installed,o.db,o.userDataPath];
    const check=()=>{references();o.assertCurrent();if([o.installation,o.installation.install,o.installation.installed,o.db,o.userDataPath].some((v,i)=>v!==refs[i]))fail();};
    const result=createEmployeeAgentTransferCustody({db:o.db,association:o.connection.current,assertNativeOwner:check,refresh:o.connection.refresh,userDataPath:o.userDataPath,
      installed(value,root){check();const definition=value.files.find(f=>value.ticket.files.find(d=>d.path===f.path)?.kind==='definition');return !!definition&&o.installation.installed({agentId:value.ticket.target.agentId,displayName:value.ticket.target.displayName,definition:definition.content},root);},
      async install(value,root){check();const definition=value.files.find(f=>value.ticket.files.find(d=>d.path===f.path)?.kind==='definition');if(!definition)fail();await o.installation.install({agentId:value.ticket.target.agentId,displayName:value.ticket.target.displayName,definition:definition.content},root);check();}
    });
    custodians.set(o.connection, result); return result;
  }
  const sourceOwners=new WeakMap<object,ReturnType<typeof createCompanyAgentSourceCustody>>();
  async function sourceCustody(o:Original){
    if(sourceOwners.has(o.identityOwner))return sourceOwners.get(o.identityOwner)!;
    const installation=o.installation,install=installation.install,installed=installation.installed;
    const check=()=>{o.assertCurrent();if(o.installation!==installation||installation.install!==install||installation.installed!==installed)fail();};
    const owner=createCompanyAgentSourceCustody(o,{
      installed(v,root){check();return installation.installed(v,root);},
      async install(v,root){check();await installation.install(v,root);check();}
    });sourceOwners.set(o.identityOwner,owner);return owner;
  }
  function selector(raw: unknown) {
    if (!object(raw, ['transferId']) || !isBusinessId(raw.transferId)) fail(); return raw.transferId;
  }
  async function review(f: ReturnType<typeof input.focused>, value: EmployeeAgentTransferPackage, direction: 'export' | 'import') {
    const ko = input.locale() === 'ko', t = value.ticket; f.check();
    const response = await (require('electron') as typeof import('electron')).dialog.showMessageBox(f.window, transferPackageSheet(ko, t, value.files, direction));
    f.check(); if (response.response !== 1) throw Error('employee_agent_transfer_review_declined');
    const until = Date.now() + 120000; return { receiptId: t.transferId, assertCurrent() { f.check(); if (Date.now() >= until) throw Error('employee_agent_transfer_review_expired'); } };
  }
  function snapshotSchema(o: Original) {
    o.db.exec(`CREATE TABLE IF NOT EXISTS one_business_agent_transfer_snapshots(
      snapshot_id TEXT PRIMARY KEY,association_id TEXT NOT NULL,state TEXT NOT NULL,root_path TEXT NOT NULL,manifest_json TEXT NOT NULL);`);
  }
  async function reconcileOwnedPortableSnapshots(o:Original,inbox:EmployeeAgentTransferInbox,f:ReturnType<typeof input.focused>){
    snapshotSchema(o);const association=o.connection.current();if(!association)fail();
    const base=o.userDataPath('company-agent-transfer-snapshots');
    const rows=o.db.prepare("SELECT snapshot_id,state,root_path,manifest_json FROM one_business_agent_transfer_snapshots WHERE association_id=? AND state IN ('attempted','prepared')").all(association.associationId) as Array<{snapshot_id:string;state:string;root_path:string;manifest_json:string}>;
    for(const row of rows){const manifest=JSON.parse(row.manifest_json) as {snapshotId?:unknown;sourceAgentResourceId?:unknown;files?:unknown;ownedPortableOne?:unknown};
      if(manifest.ownedPortableOne!==true)continue;
      if(row.root_path!==path.join(base,row.snapshot_id)||manifest.snapshotId!==row.snapshot_id||!Array.isArray(manifest.files)||manifest.files.length!==1)fail();
      const descriptor=manifest.files[0] as {path?:unknown;kind?:unknown;digest?:unknown;bytes?:unknown};
      if(descriptor.path!=='AGENT.md'||descriptor.kind!=='definition'||typeof descriptor.digest!=='string'||typeof descriptor.bytes!=='number')fail();
      const bytes=readEmployeeAgentTransferFile(row.root_path,'AGENT.md');
      if(bytes.length!==descriptor.bytes||createHash('sha256').update(bytes).digest('hex')!==descriptor.digest)fail();
      const matching=inbox.snapshots.filter(item=>item.snapshotId===row.snapshot_id);
      if(matching.length>1)fail();
      const listed=matching[0];
      if(listed&&(listed.sourceAgentResourceId!==manifest.sourceAgentResourceId||listed.fileCount!==1||listed.expiresAt<=Date.now()))fail();
      if(row.state==='prepared'&&listed)continue;
      let original:unknown;
      try{original=await o.connection.request('transfers/snapshot-receipt',{snapshotId:row.snapshot_id});}catch(error){
        if((error as {status?:unknown}).status===404)continue;
        throw error;
      }
      f.check();
      if(!object(original,['snapshotId','sourceAgentResourceId','files','reviewReceiptId','fileCount','expiresAt','state'])
        ||original.snapshotId!==row.snapshot_id||original.sourceAgentResourceId!==manifest.sourceAgentResourceId
        ||original.reviewReceiptId!==(manifest as {reviewReceiptId?:unknown}).reviewReceiptId||original.fileCount!==1
        ||typeof original.expiresAt!=='number'||!Array.isArray(original.files)||original.files.length!==1
        ||employeeAgentTransferDigest(original.files)!==employeeAgentTransferDigest(manifest.files))fail();
      if(original.state==='expired'&&original.expiresAt<=Date.now()&&!listed){
        o.db.prepare("UPDATE one_business_agent_transfer_snapshots SET state='expired' WHERE snapshot_id=? AND association_id=? AND state IN ('attempted','prepared')").run(row.snapshot_id,association.associationId);
        continue;
      }
      if(original.state==='prepared'&&original.expiresAt>Date.now()&&listed&&original.expiresAt===listed.expiresAt){
        o.db.prepare("UPDATE one_business_agent_transfer_snapshots SET state='prepared' WHERE snapshot_id=? AND association_id=? AND state='attempted'").run(row.snapshot_id,association.associationId);
        continue;
      }
      fail();
    }
  }
  input.ipc.handle('businessNative:transferInbox', async (event: IpcMainInvokeEvent) => {
    references(); const f = input.focused(event), o = input.original(event); await o.connection.refresh(); f.check();
    await (await sourceCustody(o)).reconcilePending();f.check();const result = await o.connection.request('transfers/inbox', {}) as EmployeeAgentTransferInbox; f.check();
    await reconcileOwnedPortableSnapshots(o,result,f);f.check();return result;
  });
  input.ipc.handle('businessNative:registerCompanyAgent',async(event:IpcMainInvokeEvent,raw:unknown)=>{
    if(!object(raw,['displayName','role'])||!employeeAgentTransferSafeText(raw.displayName)||!raw.displayName.trim()||raw.displayName.length>100||!employeeAgentTransferSafeText(raw.role)||raw.role.length>100)fail();
    references();const f=input.focused(event),o=input.original(event);await o.connection.refresh();f.check();
    const electron = require('electron') as typeof import('electron'), ko = input.locale() === 'ko';
    const folder = await electron.dialog.showOpenDialog(f.window, { title: ko ? '공유할 회사 에이전트 폴더' : 'Company agent folder', properties: ['openDirectory'] });
    f.check(); if (folder.canceled || folder.filePaths.length !== 1) throw Error('employee_agent_transfer_review_declined');
    const root = folder.filePaths[0], selected = await electron.dialog.showOpenDialog(f.window, { title: ko ? '공유할 파일만 선택하세요' : 'Select only files to share', defaultPath: root, properties: ['openFile', 'multiSelections'] });
    f.check(); if (selected.canceled || !selected.filePaths.length || selected.filePaths.length > 64) throw Error('employee_agent_transfer_review_declined');
    const read = () => selected.filePaths.map(absolute => {
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const kind = (['definition', 'skill', 'company-memory', 'work-artifact'] as EmployeeAgentTransferKind[]).find(k => employeeAgentTransferPath(relative, k));
      if (!kind) throw Error('employee_agent_transfer_private_path');
      const bytes = readEmployeeAgentTransferFile(root, relative), content = bytes.toString('utf8');
      if (!Buffer.from(content).equals(bytes) || !employeeAgentTransferSafeText(content)) throw Error('employee_agent_transfer_private_source');
      return { path: relative, kind, digest: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, content };
    });
    const initial=read(),pin=employeeAgentTransferDigest(initial),association=o.connection.current();if(!association)fail();
    const result=await electron.dialog.showMessageBox(f.window,registerAgentSheet(ko,{displayName:raw.displayName,role:raw.role},initial));
    f.check();if(result.response!==1)throw Error('employee_agent_transfer_review_declined');await o.connection.refresh();f.check();
    if(employeeAgentTransferDigest(read())!==pin||employeeAgentTransferDigest(o.connection.current())!==employeeAgentTransferDigest(association))fail();
    return (await sourceCustody(o)).propose(raw.displayName,raw.role,initial);
  });
  input.ipc.handle('businessNative:prepareAgentSnapshot', async (event: IpcMainInvokeEvent, raw: unknown) => {
    references(); if (!object(raw, ['sourceAgentResourceId']) || !isBusinessId(raw.sourceAgentResourceId)) fail();
    const id = raw.sourceAgentResourceId, f = input.focused(event), o = input.original(event); await o.connection.refresh(); f.check();
    const inbox = await o.connection.request('transfers/inbox', {}) as EmployeeAgentTransferInbox; f.check();
    const matching = inbox.sources.filter(row => row.resourceId === id), source = matching[0]; if (matching.length !== 1 || !source) fail();
    const electron = require('electron') as typeof import('electron'), ko = input.locale() === 'ko';
    const personal=input.personalOneSource?.(event);
    if(personal?.ownsAgent(source.agentId)){
      // A lost response may already have created the original snapshot. Only
      // the signed inbox can settle it; never issue a second POST for the same
      // personal resource while this association holds its original intent.
      await reconcileOwnedPortableSnapshots(o,inbox,f);
      const associationId=o.connection.current()?.associationId;if(!associationId)fail();
      const priorRows=o.db.prepare("SELECT snapshot_id,state,manifest_json FROM one_business_agent_transfer_snapshots WHERE association_id=? AND state IN ('attempted','prepared')").all(associationId) as Array<{snapshot_id:string;state:string;manifest_json:string}>;
      const prior=priorRows.filter(row=>{const manifest=JSON.parse(row.manifest_json) as {ownedPortableOne?:unknown;sourceAgentResourceId?:unknown};return manifest.ownedPortableOne===true&&manifest.sourceAgentResourceId===id});
      if(prior.length>1)fail();
      if(prior.length===1){const row=prior[0];if(row.state==='attempted')return{snapshotId:row.snapshot_id,fileCount:1,state:'unknown' as const};
        if(inbox.snapshots.some(item=>item.snapshotId===row.snapshot_id&&item.sourceAgentResourceId===id&&item.fileCount===1&&item.expiresAt>Date.now()))return{snapshotId:row.snapshot_id,fileCount:1,state:'prepared' as const};fail();}
      const selected=await personal.select(id);f.check();
      if(selected.oneId!==source.agentId||selected.displayName!==source.displayName||selected.role!==source.role)fail();
      const content=selected.content,bytes=Buffer.from(content,'utf8');
      if(!employeeAgentTransferSafeText(content)||!bytes.equals(Buffer.from(content,'utf8')))fail();
      const initial=[{path:'AGENT.md',kind:'definition' as const,digest:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,content}],initialDigest=employeeAgentTransferDigest(initial),association=o.connection.current();if(!association)fail();
      const reviewed=await electron.dialog.showMessageBox(f.window,prepareDefinitionSheet(ko,source,content));
      f.check();if(reviewed.response!==1)throw Error('employee_agent_transfer_review_declined');await o.connection.refresh();f.check();await selected.assertCurrent();
      if(employeeAgentTransferDigest(o.connection.current())!==employeeAgentTransferDigest(association)||employeeAgentTransferDigest(initial)!==initialDigest)fail();
      const snapshotId=randomUUID(),base=o.userDataPath('company-agent-transfer-snapshots'),root=path.join(base,snapshotId),file=path.join(root,'AGENT.md');
      const body={snapshotId,sourceAgentResourceId:id,files:initial.map(({content:_content,...part})=>part),reviewReceiptId:randomUUID()};
      fs.mkdirSync(base,{recursive:true,mode:0o700});const baseStat=fs.lstatSync(base);
      if(!baseStat.isDirectory()||baseStat.isSymbolicLink()||fs.realpathSync.native(base)!==base||fs.existsSync(root))fail();
      fs.mkdirSync(root,{mode:0o700});const rootStat=fs.lstatSync(root);let fileStat:fs.Stats|null=null,dispatched=false,inserted=false;
      const cleanup=()=>{const now=fs.lstatSync(root);if(!now.isDirectory()||now.isSymbolicLink()||now.dev!==rootStat.dev||now.ino!==rootStat.ino)fail();
        if(fileStat){const current=fs.lstatSync(file);if(!current.isFile()||current.isSymbolicLink()||current.dev!==fileStat.dev||current.ino!==fileStat.ino)fail();fs.unlinkSync(file);}
        fs.rmdirSync(root);};
      try{
        const fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|(fs.constants.O_NOFOLLOW??0),0o600);
        try{fileStat=fs.fstatSync(fd);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
        fileStat=fs.lstatSync(file);if(!fileStat.isFile()||fileStat.isSymbolicLink()||!readEmployeeAgentTransferFile(root,'AGENT.md').equals(bytes))fail();
        await selected.assertCurrent();f.check();if(employeeAgentTransferDigest(o.connection.current())!==employeeAgentTransferDigest(association))fail();
        snapshotSchema(o);o.db.prepare("INSERT INTO one_business_agent_transfer_snapshots VALUES(?,?,'attempted',?,?)").run(snapshotId,association.associationId,root,JSON.stringify({...body,ownedPortableOne:true}));inserted=true;
        await selected.assertCurrent();f.check();dispatched=true;
        const result=await o.connection.request('transfers/snapshot',body) as {snapshotId:string;fileCount:number;state:'prepared'};f.check();
        if(result.snapshotId!==snapshotId||result.state!=='prepared'||result.fileCount!==1)fail();
        o.db.prepare("UPDATE one_business_agent_transfer_snapshots SET state='prepared' WHERE snapshot_id=? AND association_id=?").run(snapshotId,association.associationId);
        return result;
      }catch(error){
        if(dispatched)return{snapshotId,fileCount:1,state:'unknown' as const};
        if(inserted)o.db.prepare("DELETE FROM one_business_agent_transfer_snapshots WHERE snapshot_id=? AND association_id=? AND state='attempted'").run(snapshotId,association.associationId);
        cleanup();throw error;
      }
    }
    const folder = await electron.dialog.showOpenDialog(f.window, { title: ko ? '공유할 회사 에이전트 폴더' : 'Company agent folder', properties: ['openDirectory'] });
    f.check(); if (folder.canceled || folder.filePaths.length !== 1) throw Error('employee_agent_transfer_review_declined');
    const root = folder.filePaths[0], selected = await electron.dialog.showOpenDialog(f.window, { title: ko ? '공유할 파일만 선택하세요' : 'Select only files to share', defaultPath: root, properties: ['openFile', 'multiSelections'] });
    f.check(); if (selected.canceled || !selected.filePaths.length || selected.filePaths.length > 64) throw Error('employee_agent_transfer_review_declined');
    const read = () => selected.filePaths.map(absolute => {
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const kind = (['definition', 'skill', 'company-memory', 'work-artifact'] as EmployeeAgentTransferKind[]).find(k => employeeAgentTransferPath(relative, k));
      if (!kind) throw Error('employee_agent_transfer_private_path');
      const bytes = readEmployeeAgentTransferFile(root, relative), content = bytes.toString('utf8');
      if (!Buffer.from(content).equals(bytes) || !employeeAgentTransferSafeText(content)) throw Error('employee_agent_transfer_private_source');
      return { path: relative, kind, digest: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, content };
    });
    const initial = read();
    if (initial.filter(v => v.kind === 'definition').length !== 1 || initial.reduce((n, v) => n + v.bytes, 0) > 196608
      || new Set(initial.map(v => v.path.toLowerCase())).size !== initial.length) throw Error('employee_agent_transfer_selection_invalid');
    const initialDigest = employeeAgentTransferDigest(initial), association = o.connection.current(); if (!association) fail();
    const reviewed = await electron.dialog.showMessageBox(f.window, prepareFilesSheet(ko, source, initial));
    f.check(); if (reviewed.response !== 1) throw Error('employee_agent_transfer_review_declined'); await o.connection.refresh(); f.check();
    if (employeeAgentTransferDigest(o.connection.current()) !== employeeAgentTransferDigest(association) || employeeAgentTransferDigest(read()) !== initialDigest) throw Error('employee_agent_transfer_selected_source_changed');
    const snapshotId = randomUUID(), body = { snapshotId, sourceAgentResourceId: id, files: initial.map(({ content: _content, ...file }) => file), reviewReceiptId: randomUUID() };
    snapshotSchema(o); o.db.prepare("INSERT INTO one_business_agent_transfer_snapshots VALUES(?,?,'attempted',?,?)")
      .run(snapshotId, association.associationId, root, JSON.stringify(body));
    try {
      const result = await o.connection.request('transfers/snapshot', body) as { snapshotId: string; fileCount: number; state: 'prepared' }; f.check();
      if (result.snapshotId !== snapshotId || result.state !== 'prepared' || result.fileCount !== initial.length) fail();
      o.db.prepare("UPDATE one_business_agent_transfer_snapshots SET state='prepared' WHERE snapshot_id=? AND association_id=?")
        .run(snapshotId, association.associationId); return result;
    } catch { return { snapshotId, fileCount: initial.length, state: 'unknown' as const }; }
  });
  input.ipc.handle('businessNative:exportAgent', async (event: IpcMainInvokeEvent, raw: unknown) => {
    references(); const id = selector(raw), f = input.focused(event), o = input.original(event); await o.connection.refresh(); f.check();
    const ticket = await o.connection.request('transfers/prepare', { transferId: id }); f.check();
    if (!object(ticket) || typeof ticket.snapshotId !== 'string') fail(); snapshotSchema(o);
    let snapshot = o.db.prepare("SELECT * FROM one_business_agent_transfer_snapshots WHERE snapshot_id=? AND state='prepared' AND association_id=?")
      .get(ticket.snapshotId, o.connection.current()?.associationId) as { root_path: string; manifest_json: string } | undefined;
    if (!snapshot) {
      const attempted=o.db.prepare("SELECT manifest_json FROM one_business_agent_transfer_snapshots WHERE snapshot_id=? AND state='attempted' AND association_id=?")
        .get(ticket.snapshotId,o.connection.current()?.associationId) as {manifest_json:string}|undefined;
      if (attempted && (JSON.parse(attempted.manifest_json) as {ownedPortableOne?:unknown}).ownedPortableOne===true) {
        const inbox=await o.connection.request('transfers/inbox',{}) as EmployeeAgentTransferInbox;f.check();await reconcileOwnedPortableSnapshots(o,inbox,f);
        snapshot=o.db.prepare("SELECT * FROM one_business_agent_transfer_snapshots WHERE snapshot_id=? AND state='prepared' AND association_id=?")
          .get(ticket.snapshotId,o.connection.current()?.associationId) as {root_path:string;manifest_json:string}|undefined;
      }
    }
    if (!snapshot) throw Error('employee_agent_transfer_original_snapshot_required');
    const manifest = JSON.parse(snapshot.manifest_json) as { files: unknown[] };
    if (!Array.isArray(ticket.files) || employeeAgentTransferDigest(ticket.files.map(file => { const {source:_source,...descriptor}=file; return descriptor; })) !== employeeAgentTransferDigest(manifest.files)) fail();
    const owner = await custody(o); f.check();
    await owner.acceptExport(ticket, snapshot.root_path, value => review(f, value, 'export')); f.check();
    const original = owner.markAttempt(id); f.check();
    try {
      const receipt = await o.connection.request('transfers/commit', { package: original.value, acceptance: original.acceptance }); f.check();
      if (!isEmployeeAgentTransferReceipt(receipt)) fail(); owner.settleExport(id, receipt);
      return { acceptanceId: original.acceptance.nativeReviewReceiptId, transferId: id, state: 'exported' as const };
    } catch {
      return { acceptanceId: original.acceptance.nativeReviewReceiptId, transferId: id, state: 'unknown' as const };
    }
  });
  input.ipc.handle('businessNative:transferReceipt', async (event: IpcMainInvokeEvent, raw: unknown) => {
    references(); const id = selector(raw), f = input.focused(event), o = input.original(event); await o.connection.refresh(); f.check();
    let receipt: unknown;
    try { receipt = await o.connection.request('transfers/receipt', { transferId: id }); }
    catch (error) {
      const denied = error as { status?: number; code?: string };
      if (denied.status === 403 && denied.code === 'grant_missing' && (await custody(o)).installedTransfer(id)) { f.check(); return { transferId: id, state: 'recipient-renewal-required' as const }; }
      throw error;
    }
    f.check();
    if (receipt === null) return null; if (!isEmployeeAgentTransferReceipt(receipt) || receipt.transferId !== id) fail();
    const owner = await custody(o);
    // Only the original source ledger can settle an exported package. A target
    // lookup is still useful and never manufactures an export/installation.
    try { const original = owner.originalExport(id); if (employeeAgentTransferReceiptMatches(receipt, original.value)) owner.settleExport(id, receipt); } catch { /* Not this device's export. */ }
    f.check(); return receipt;
  });
  input.ipc.handle('businessNative:importAgent', async (event: IpcMainInvokeEvent, raw: unknown) => {
    references(); const id = selector(raw), f = input.focused(event), o = input.original(event); await o.connection.refresh(); f.check();
    const response = await o.connection.request('transfers/package', { transferId: id }); f.check();
    if (!object(response, ['package', 'receipt']) || !isEmployeeAgentTransferReceipt(response.receipt)) fail();
    const owner = await custody(o); f.check();
    const result = await owner.importCommitted(response.package, response.receipt, value => review(f, value, 'import'), async () => {
      f.check(); const receipt = await o.connection.request('transfers/receipt', { transferId: id }); f.check(); if (!isEmployeeAgentTransferReceipt(receipt)) fail(); return receipt;
    });
    f.check();
    try {
      const installation = owner.installationAck(id);
      const receipt = installation.state === 'accepted'
        ? await o.connection.request('transfers/install-ack', owner.claimInstallationAck(id))
        : await o.connection.request('transfers/installation-receipt', {transferId:id});
      f.check(); if(!isEmployeeAgentInstallationReceipt(receipt))fail();
      const settled=owner.settleInstallationAck(id,receipt);
      return {...result,installationState:'confirmed' as const,installationReceiptId:settled.receiptId};
    } catch { return {...result,installationState:'unknown' as const,installationReceiptId:null}; }
  });
  const assetOwners = new WeakMap<object, {o:Original;read(cap:object):ReturnType<CompanyAgentAssetOwner['read']>;refresh(cap:object):Promise<void>}>();
  async function receiptFor(o: Original, transferId: string) {
    const result = await o.connection.request('transfers/receipt', { transferId });
    if (!isEmployeeAgentTransferReceipt(result)) fail(); return result;
  }
  const companyAgents = Object.freeze<CompanyAgentAssetOwner>({ protocol: 'agentlas.business.original-company-agent.v1',
    async capture(agentId) {
      references(); const o = input.original(); await o.connection.refresh(); const owner = await custody(o);
      const source=await sourceCustody(o),original=await source.capture(agentId);if(original){assetOwners.set(original,{o,read:source.read,refresh:source.refresh});return original;}
      const cap = await owner.captureInstalledAgent(agentId, transferId => receiptFor(o, transferId));
      if (cap) assetOwners.set(cap, {o,read:owner.readInstalledAgent,refresh:cap=>owner.refreshInstalledAgent(cap,transferId=>receiptFor(o,transferId))});return cap;
    },
    read(capability) { const held = assetOwners.get(capability); if (!held) return null;
      try { references(); held.o.assertCurrent();
        return held.read(capability); } catch { return null; }
    },
    assertCurrent(capability) { if (!companyAgents.read(capability)) fail(); },
    async refresh(capability) { const held = assetOwners.get(capability); if (!held) fail(); companyAgents.assertCurrent(capability);
      await held.refresh(capability); companyAgents.assertCurrent(capability);
    },
    async request(capability: object, requestInput: Parameters<CompanyAgentAssetOwner['request']>[1]) {
      const held = assetOwners.get(capability); if (!held || !object(requestInput, ['operation', 'payload'])
        || !['admit', 'claim', 'refresh', 'settle', 'receipt', 'cancel','review','policies'].includes(requestInput.operation)) fail();
      companyAgents.assertCurrent(capability); const asset = companyAgents.read(capability); if (!asset) fail();
      const result = await held.o.connection.request(`company-work/${requestInput.operation}`, { asset: {
        sourceKind:asset.sourceKind,registrationId:asset.registrationId,transferId: asset.transferId, agentId: asset.agentId, agentResourceId: asset.agentResourceId,
        packageDigest: asset.packageDigest, targetRevision: asset.targetRevision }, payload: requestInput.payload });
      companyAgents.assertCurrent(capability); return result;
    },
  });
  return Object.freeze({ companyAgents });
}
