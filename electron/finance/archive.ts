import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FINANCE_WORKSPACE_LIMITS, parseFinanceEvidenceMetric, validateFinanceWorkspace, type FinanceArchiveItem, type FinanceArchiveRequest, type FinanceReport, type FinanceWorkspace } from '../../shared/finance';
import type { FinanceScope } from './store';

const id=z.string().min(1).max(200),archiveId=z.string().regex(/^[a-f0-9]{64}$/),revision=z.number().int().nonnegative();
const reportIds=z.array(id).max(FINANCE_WORKSPACE_LIMITS.reports).refine(ids=>new Set(ids).size===ids.length,'Duplicate report IDs');
export const FinanceArchiveRequestSchema=z.union([
  z.object({action:z.literal('create'),expectedRevision:revision,reportIds}).strict(),
  z.object({action:z.literal('list'),cursor:z.string().max(2000).optional(),limit:z.number().int().min(1).max(50).optional()}).strict(),
  z.object({action:z.literal('read'),archiveId}).strict(),z.object({action:z.literal('read'),reportId:id}).strict(),
  z.object({action:z.literal('restore'),archiveId,reportIds:reportIds.optional(),expectedRevision:revision}).strict(),
]);
export function financeScopeHash(scope:FinanceScope):string { scope.assertCurrent();if(!scope.workspaceId||!scope.userId)throw new Error('finance_sign_in_required');return createHash('sha256').update(JSON.stringify([scope.workspaceId,scope.userId])).digest('hex'); }
export const financeHash=(value:string|Buffer):string=>createHash('sha256').update(value).digest('hex');
/** Only host-derived directories are passed here. Existing links/junctions are never traversed. */
export async function financePrivateDirectory(directory:string):Promise<void> {
  try{const info=await fs.lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('finance_private_path_invalid');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await financePrivateDirectory(path.dirname(directory));try{await fs.mkdir(directory,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}const info=await fs.lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('finance_private_path_invalid');}
}
export async function readFinanceJsonFile(file:string,maxBytes:number):Promise<unknown> {
  const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>maxBytes)throw new Error('finance_private_file_invalid');
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const stat=await handle.stat();if(!stat.isFile()||stat.size>maxBytes)throw new Error('finance_private_file_invalid');const bytes=await handle.readFile();if(bytes.length>maxBytes)throw new Error('finance_private_file_invalid');try{return JSON.parse(bytes.toString('utf8'));}catch{throw new Error('finance_private_json_invalid');}}
  finally{await handle.close();}
}
/** Atomic host metadata write. Canonical evidence files are never removed as part of retention. */
export async function writeFinanceJsonFile(file:string,value:unknown):Promise<void> {
  try{const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink())throw new Error('finance_private_file_invalid');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const temp=`${file}.${randomUUID()}.tmp`,handle=await fs.open(temp,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
  await fs.rename(temp,file);
}
async function optionalJson(file:string,max:number):Promise<unknown|null>{try{return await readFinanceJsonFile(file,max);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
const itemSchema=z.object({archiveId,createdAt:z.string().datetime({offset:true}),sourceRevision:revision,sha256:archiveId,reportIds,reportTitles:z.array(z.string().max(300)).max(200),reportCount:revision,sourceCount:revision}).strict();
const headSchema=z.object({version:z.literal(1),lastSequence:revision}).strict();
const cursorSchema=z.object({owner:archiveId,snapshot:revision,before:z.number().int().positive()}).strict();
interface Edition {version:1;ownerScope:string;archiveId:string;createdAt:string;selectedReportIds:string[];workspaceJson:string;sha256:string}
const MAX_EDITION=52*1024*1024,PAGE_SIZE=50;

export function financeArchivePlan(workspace:FinanceWorkspace,selected:string[]):{workspace:FinanceWorkspace;reclaimed:{reports:number;sources:number}} {
  const ids=new Set(selected);if(ids.size!==selected.length||selected.some(id=>!workspace.reports.some(report=>report.id===id)))throw new Error('finance_report_not_found');
  for(const dashboard of workspace.dashboards)for(const widget of dashboard.widgets){const ref=parseFinanceEvidenceMetric(widget.metric);if(ref&&ids.has(ref.reportId))throw new Error('finance_evidence_is_referenced');}
  const reports=workspace.reports.filter(report=>!ids.has(report.id));
  const referenced=new Set([...workspace.holdings.map(row=>row.sourceId),...workspace.quotes.map(row=>row.sourceId),...reports.flatMap(report=>report.sections.flatMap(section=>section.projection?.sourceIds??[]))]);
  const sources=workspace.sources.filter(source=>referenced.has(source.id));
  return {workspace:{...workspace,reports,sources},reclaimed:{reports:selected.length,sources:workspace.sources.length-sources.length}};
}
export class FinanceArchives {
  constructor(private readonly root:string){}
  private async directory(scope:FinanceScope):Promise<string>{const directory=path.join(this.root,financeScopeHash(scope));await financePrivateDirectory(directory);for(const child of ['editions','catalog','report-links'])await financePrivateDirectory(path.join(directory,child));scope.assertCurrent();return directory;}
  private async head(directory:string):Promise<z.infer<typeof headSchema>> {return headSchema.parse(await optionalJson(path.join(directory,'catalog','head.json'),10000)??{version:1,lastSequence:0});}
  private page(directory:string,sequence:number):string{return path.join(directory,'catalog',`page-${String(Math.floor((sequence-1)/PAGE_SIZE)).padStart(12,'0')}.json`);}
  /** Called under the FinanceStore workspace lease. Persist+verify precedes all active removal. */
  async create(scope:FinanceScope,workspace:FinanceWorkspace,selectedReportIds:string[]):Promise<FinanceArchiveItem> {
    selectedReportIds=[...selectedReportIds].sort();
    const directory=await this.directory(scope),ownerScope=financeScopeHash(scope),workspaceJson=JSON.stringify(validateFinanceWorkspace(workspace));
    const sha256=financeHash(workspaceJson),archive=financeHash(JSON.stringify([ownerScope,workspace.revision,sha256,[...selectedReportIds].sort()]));
    const file=path.join(directory,'editions',`${archive}.json`);let edition:Edition;
    const existing=await optionalJson(file,MAX_EDITION);
    if(existing){edition=await this.verify(scope,archive,existing);if(edition.workspaceJson!==workspaceJson||JSON.stringify(edition.selectedReportIds)!==JSON.stringify(selectedReportIds))throw new Error('finance_archive_conflict');}
    else {edition={version:1,ownerScope,archiveId:archive,createdAt:new Date().toISOString(),selectedReportIds:[...selectedReportIds],workspaceJson,sha256};await writeFinanceJsonFile(file,edition);}
    edition=await this.verify(scope,archive,await readFinanceJsonFile(file,MAX_EDITION));
    const item:FinanceArchiveItem={archiveId:archive,createdAt:edition.createdAt,sourceRevision:workspace.revision,sha256,reportIds:[...selectedReportIds],reportTitles:selectedReportIds.map(id=>workspace.reports.find(report=>report.id===id)!.title),reportCount:selectedReportIds.length,sourceCount:workspace.sources.length};
    // A catalog receipt also makes an interrupted post-copy/pre-CAS operation inspectable.
    let head=await this.head(directory);const receiptFile=path.join(directory,'catalog',`${archive}.json`);
    if(!await optionalJson(receiptFile,300000)){
      let found:{sequence:number;item:FinanceArchiveItem}|undefined;
      if(head.lastSequence){const last=z.array(z.object({sequence:revision,item:itemSchema}).strict()).max(PAGE_SIZE).parse(await readFinanceJsonFile(this.page(directory,head.lastSequence),16*1024*1024));found=last.find(entry=>entry.item.archiveId===archive);}
      // A page may have been persisted just before a crash interrupted head publication.
      const pending=z.array(z.object({sequence:revision,item:itemSchema}).strict()).max(PAGE_SIZE).parse(await optionalJson(this.page(directory,head.lastSequence+1),16*1024*1024)??[]).find(entry=>entry.sequence===head.lastSequence+1);
      if(pending){await writeFinanceJsonFile(path.join(directory,'catalog','head.json'),{version:1,lastSequence:pending.sequence});await writeFinanceJsonFile(path.join(directory,'catalog',`${pending.item.archiveId}.json`),pending);head={version:1,lastSequence:pending.sequence};if(pending.item.archiveId===archive)found=pending;}
      if(found)await writeFinanceJsonFile(receiptFile,found);
      else{
        const sequence=head.lastSequence+1,pageFile=this.page(directory,sequence);
        const entries=z.array(z.object({sequence:revision,item:itemSchema}).strict()).max(PAGE_SIZE).parse(await optionalJson(pageFile,16*1024*1024)??[]);
        entries.push({sequence,item});await writeFinanceJsonFile(pageFile,entries);await writeFinanceJsonFile(path.join(directory,'catalog','head.json'),{version:1,lastSequence:sequence});await writeFinanceJsonFile(receiptFile,{sequence,item});
      }
    }
    for(const reportId of selectedReportIds){scope.assertCurrent();await writeFinanceJsonFile(path.join(directory,'report-links',`${financeHash(reportId)}.json`),{reportId,archiveId:archive});}
    scope.assertCurrent();return item;
  }
  private async verify(scope:FinanceScope,expected:string,value:unknown):Promise<Edition>{
    const edition=z.object({version:z.literal(1),ownerScope:archiveId,archiveId,createdAt:z.string().datetime({offset:true}),selectedReportIds:reportIds,workspaceJson:z.string().max(26*1024*1024),sha256:archiveId}).strict().parse(value);
    if(edition.ownerScope!==financeScopeHash(scope)||edition.archiveId!==expected||financeHash(edition.workspaceJson)!==edition.sha256)throw new Error('finance_archive_integrity_failed');
    const workspace=validateFinanceWorkspace(JSON.parse(edition.workspaceJson));
    if(workspace.ownerScope!==edition.ownerScope||edition.selectedReportIds.some(id=>!workspace.reports.some(report=>report.id===id)))throw new Error('finance_archive_integrity_failed');
    if(financeHash(JSON.stringify([edition.ownerScope,workspace.revision,edition.sha256,[...edition.selectedReportIds].sort()]))!==expected)throw new Error('finance_archive_integrity_failed');
    scope.assertCurrent();return edition;
  }
  async read(scope:FinanceScope,input:{archiveId:string}|{reportId:string}):Promise<{archiveId:string;workspaceSnapshot:FinanceWorkspace;reportIds:string[];sha256:string;warnings:string[]}> {
    const directory=await this.directory(scope);let selected:string;
    if('archiveId'in input)selected=archiveId.parse(input.archiveId);
    else{const reportId=id.parse(input.reportId);const rawLink=await optionalJson(path.join(directory,'report-links',`${financeHash(reportId)}.json`),10000);if(!rawLink)throw new Error('finance_report_not_found');const link=z.object({reportId:id,archiveId}).strict().parse(rawLink);if(link.reportId!==reportId)throw new Error('finance_report_not_found');selected=link.archiveId;}
    let raw:unknown;try{raw=await readFinanceJsonFile(path.join(directory,'editions',`${selected}.json`),MAX_EDITION);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('finance_archive_not_found');throw error;}
    const edition=await this.verify(scope,selected,raw),workspaceSnapshot=validateFinanceWorkspace(JSON.parse(edition.workspaceJson));
    if('reportId'in input&&!edition.selectedReportIds.includes(input.reportId))throw new Error('finance_report_not_found');
    return {archiveId:selected,workspaceSnapshot,reportIds:edition.selectedReportIds,sha256:edition.sha256,warnings:['finance_archive_read_only_snapshot']};
  }
  async list(scope:FinanceScope,input:{cursor?:string;limit?:number}):Promise<{items:FinanceArchiveItem[];nextCursor:string|null}> {
    const directory=await this.directory(scope),head=await this.head(directory),owner=financeScopeHash(scope),limit=input.limit??20;
    if(!Number.isInteger(limit)||limit<1||limit>50)throw new Error('finance_archive_cursor_invalid');
    let cursor={owner,snapshot:head.lastSequence,before:head.lastSequence+1};
    if(input.cursor){try{cursor=cursorSchema.parse(JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8')));}catch{throw new Error('finance_archive_cursor_invalid');}}
    if(cursor.owner!==owner||cursor.snapshot>head.lastSequence||cursor.before>cursor.snapshot+1)throw new Error('finance_archive_cursor_invalid');
    const items:FinanceArchiveItem[]=[];let before=cursor.before;
    while(before>1&&items.length<limit){const sequence=before-1,entries=z.array(z.object({sequence:revision,item:itemSchema}).strict()).max(PAGE_SIZE).parse(await readFinanceJsonFile(this.page(directory,sequence),16*1024*1024));
      const found=entries.filter(entry=>entry.sequence<before&&entry.sequence<=cursor.snapshot).sort((a,b)=>b.sequence-a.sequence).slice(0,limit-items.length);
      if(!found.length)throw new Error('finance_archive_catalog_invalid');items.push(...found.map(entry=>entry.item));before=found.at(-1)!.sequence;}
    scope.assertCurrent();return {items,nextCursor:before>1?Buffer.from(JSON.stringify({...cursor,before})).toString('base64url'):null};
  }
  restore(workspace:FinanceWorkspace,archived:FinanceWorkspace,selected:string[],additionalSourceIds:string[]=[]):{workspace:FinanceWorkspace;restored:{reports:number;sources:number}} {
    const ids=new Set(selected);if(ids.size!==selected.length||selected.some(id=>!archived.reports.some(report=>report.id===id)))throw new Error('finance_report_not_found');
    const reports=[...workspace.reports],sources=[...workspace.sources];let reportCount=0,sourceCount=0;
    const picked=archived.reports.filter(report=>ids.has(report.id)),needed=new Set([...additionalSourceIds,...picked.flatMap(report=>report.sections.flatMap(section=>section.projection?.sourceIds??[]))]);
    for(const report of picked){const existing=reports.find(item=>item.id===report.id);if(existing&&JSON.stringify(existing)!==JSON.stringify(report))throw new Error('finance_archive_report_conflict');if(!existing){reports.push(report);reportCount++;}}
    for(const sourceId of needed){const source=archived.sources.find(item=>item.id===sourceId);if(!source)throw new Error('finance_archive_source_missing');const existing=sources.find(item=>item.id===sourceId);if(existing&&JSON.stringify(existing)!==JSON.stringify(source))throw new Error('finance_archive_source_conflict');if(!existing){sources.push(source);sourceCount++;}}
    if(reports.length>FINANCE_WORKSPACE_LIMITS.reports||sources.length>FINANCE_WORKSPACE_LIMITS.sources)throw new Error('finance_workspace_capacity_reached');
    return {workspace:validateFinanceWorkspace({...workspace,reports,sources}),restored:{reports:reportCount,sources:sourceCount}};
  }
}
