import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { FinanceMonitorRun } from '../../shared/finance';

/** A cycle keeps its exact selection and resumes under the monitor's existing lease. */
const pendingSchema = z.object({ offset: z.number().int().nonnegative(), count: z.number().int().min(1).max(3), reportId: z.string().min(1).max(200), reportDigest: z.string().regex(/^[a-f0-9]{64}$/), expectedRevision: z.number().int().nonnegative() }).strict();
const runSchema = z.object({ id: z.string().uuid(), monitorId: z.string().min(1).max(200), status: z.enum(['running','succeeded','partial','failed','cancelled']), startedAt: z.string().datetime({offset:true}), finishedAt: z.string().datetime({offset:true}).nullable(), reportId: z.string().min(1).max(200).nullable(), summary: z.string().max(20000), warnings: z.array(z.string().max(20000)).max(100), error: z.string().max(20000).nullable(), sourceRevision: z.number().int().nonnegative() }).strict();
const progressSchema = z.object({ version: z.literal(1), definition: z.string().regex(/^[a-f0-9]{64}$/), cycleId: z.string().uuid(), total: z.number().int().min(1).max(10000), nextOffset: z.number().int().nonnegative(), partial: z.boolean(), warnings: z.array(z.string().max(20000)).max(80), lastReportId: z.string().min(1).max(200).nullable(), pending: pendingSchema.nullable(), completedCallerRunId: z.string().min(1).max(200).nullable(), completedRun: runSchema.nullable() }).strict().superRefine((value, ctx) => {
  if (value.nextOffset > value.total || (value.nextOffset>0)!==Boolean(value.lastReportId) || value.pending && (value.pending.offset !== value.nextOffset || value.pending.offset + value.pending.count > value.total) || value.completedCallerRunId && !value.completedRun || value.completedRun && (value.nextOffset !== value.total || value.pending || value.completedRun.finishedAt===null || !['succeeded','partial'].includes(value.completedRun.status) || value.completedRun.reportId!==value.lastReportId)) ctx.addIssue({code:z.ZodIssueCode.custom,message:'invalid coverage position'});
});
export type FinanceMonitorProgress = z.infer<typeof progressSchema>;
export const FINANCE_MONITOR_ASSET_BATCH = 3;
export const FINANCE_MONITOR_MAX_WORK_MS = 145000;
export const FINANCE_MONITOR_BATCH_TIMEOUT_MS = 120000;
/** Old writers allowed 80 + 100 warnings of 20,000 UTF-16 units, plus JSON escaping. */
export const FINANCE_MONITOR_LEGACY_PROGRESS_MAX_BYTES = 24 * 1024 * 1024;
export const FINANCE_MONITOR_PROGRESS_MAX_BYTES = 512 * 1024;
export const FINANCE_MONITOR_WARNING_MAX_JSON_BYTES = 2048;
export const FINANCE_MONITOR_WARNINGS_MAX_JSON_BYTES = 16 * 1024;
const WARNING_TRUNCATED = 'finance_monitor_warnings_truncated';
const MAX_PROGRESS_WARNINGS = 40;

/** Scope is checked synchronously with the final rename, so a session change on
 * this event loop cannot commit a checkpoint or run receipt into the old owner. */
export async function writeMonitorOwnedJson(file: string, value: unknown, assertCurrent: () => void): Promise<void> {
  assertCurrent();
  try { const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink())throw new Error('finance_private_file_invalid'); }
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const temp=`${file}.${randomUUID()}.tmp`;
  let handle:Awaited<ReturnType<typeof fs.promises.open>>|undefined;
  try {
    handle=await fs.promises.open(temp,'wx',0o600);assertCurrent();
    await handle.writeFile(JSON.stringify(value));await handle.sync();await handle.close();handle=undefined;
    assertCurrent();fs.renameSync(temp,file);
  } finally {
    try{if(handle)await handle.close();}
    finally{try{fs.unlinkSync(temp);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  }
}

export function monitorDefinitionDigest(definition: string): string { return createHash('sha256').update(definition).digest('hex'); }
export function parseMonitorProgress(value: unknown): FinanceMonitorProgress {
  try {
    // Reject large hostile arrays before asking Zod to visit every element.
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();
    const raw=value as Record<string,unknown>,run=raw.completedRun;
    if(!Array.isArray(raw.warnings)||raw.warnings.length>80)throw new Error();
    if(run!==null&&(typeof run!=='object'||Array.isArray(run)||!run||!Array.isArray((run as Record<string,unknown>).warnings)||((run as Record<string,unknown>).warnings as unknown[]).length>100))throw new Error();
    const parsed=progressSchema.parse(value);
    // Zod returns a detached object: clipping metadata never edits caller/provider data.
    const result={...parsed,warnings:monitorWarnings(parsed.warnings),completedRun:parsed.completedRun?{...parsed.completedRun,warnings:monitorWarnings(parsed.completedRun.warnings)}:null};
    if(Buffer.byteLength(JSON.stringify(result),'utf8')>FINANCE_MONITOR_PROGRESS_MAX_BYTES)throw new Error();
    return result;
  } catch { throw new Error('finance_monitor_progress_invalid'); }
}
/** Bound both reads and writes to the same normalized UTF-8 representation. */
export async function writeMonitorProgress(file:string,value:unknown,assertCurrent:()=>void):Promise<void> {
  const normalized=parseMonitorProgress(value);
  if(Buffer.byteLength(JSON.stringify(normalized),'utf8')>FINANCE_MONITOR_PROGRESS_MAX_BYTES)throw new Error('finance_monitor_progress_invalid');
  await writeMonitorOwnedJson(file,normalized,assertCurrent);
}
/** Preserve the exact old checkpoint before starting a new source/consent cycle. */
export async function preserveMonitorProgress(file:string,expected:FinanceMonitorProgress,expectedRawDigest:string,assertCurrent:()=>void):Promise<void>{
  const checked=parseMonitorProgress(expected);assertCurrent();const initial=await fs.promises.lstat(file);if(!initial.isFile()||initial.isSymbolicLink()||initial.size>FINANCE_MONITOR_LEGACY_PROGRESS_MAX_BYTES)throw new Error('finance_monitor_progress_invalid');
  const source=await fs.promises.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));let bytes:Buffer;
  try{const stat=await source.stat();if(!stat.isFile()||stat.size>FINANCE_MONITOR_LEGACY_PROGRESS_MAX_BYTES||(await fs.promises.lstat(file)).isSymbolicLink())throw new Error('finance_monitor_progress_invalid');bytes=await source.readFile();}
  finally{await source.close();}
  assertCurrent();if(bytes.length>FINANCE_MONITOR_LEGACY_PROGRESS_MAX_BYTES)throw new Error('finance_monitor_progress_invalid');
  let parsed:FinanceMonitorProgress,raw:unknown;try{raw=JSON.parse(bytes.toString('utf8'));parsed=parseMonitorProgress(raw);}catch{throw new Error('finance_monitor_progress_invalid');}
  if(!/^[a-f0-9]{64}$/.test(expectedRawDigest)||createHash('sha256').update(JSON.stringify(raw)).digest('hex')!==expectedRawDigest||JSON.stringify(parsed)!==JSON.stringify(checked))throw new Error('finance_monitor_progress_changed');
  const destination=path.join(path.dirname(file),`briefing-progress-before-restart-${checked.cycleId}.json`),temporary=`${destination}.${randomUUID()}.tmp`;
  let handle:Awaited<ReturnType<typeof fs.promises.open>>|undefined;
  try{
    handle=await fs.promises.open(temporary,'wx',0o600);assertCurrent();await handle.writeFile(bytes);await handle.sync();await handle.close();handle=undefined;
    assertCurrent();
    try{fs.linkSync(temporary,destination);}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const info=await fs.promises.lstat(destination);if(!info.isFile()||info.isSymbolicLink())throw new Error('finance_monitor_progress_archive_conflict');
      const prior=await fs.promises.open(destination,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
      try{const stat=await prior.stat();if(!stat.isFile()||stat.size!==bytes.length||(await fs.promises.lstat(destination)).isSymbolicLink()||!(await prior.readFile()).equals(bytes))throw new Error('finance_monitor_progress_archive_conflict');}
      finally{await prior.close();}
      assertCurrent();
    }
    if(process.platform!=='win32'){const directory=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
  }finally{try{if(handle)await handle.close();}finally{try{fs.unlinkSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}}
}
export function newMonitorProgress(definition: string, total: number): FinanceMonitorProgress {
  return parseMonitorProgress({version:1,definition:monitorDefinitionDigest(definition),cycleId:randomUUID(),total,nextOffset:0,partial:false,warnings:[],lastReportId:null,pending:null,completedCallerRunId:null,completedRun:null});
}
export function monitorBatchReportId(progress: FinanceMonitorProgress): string { return `monitor-report-${createHash('sha256').update(`${progress.cycleId}:${progress.nextOffset}`).digest('hex')}`; }

/** Stable content digest allows crash recovery to recognize the exact saved report. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([,item])=>item !== undefined).sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0).map(([key,item])=>[key,canonical(item)]));
  return value;
}
export function monitorReportDigest(report: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(report))).digest('hex'); }
function boundedWarning(value:string):{text:string;truncated:boolean} {
  if(Buffer.byteLength(JSON.stringify(value),'utf8')<=FINANCE_MONITOR_WARNING_MAX_JSON_BYTES)return {text:value,truncated:false};
  let text='',bytes=2;
  for(const point of value){const next=Buffer.byteLength(JSON.stringify(point),'utf8')-2;if(bytes+next>FINANCE_MONITOR_WARNING_MAX_JSON_BYTES)break;text+=point;bytes+=next;}
  return {text,truncated:true};
}
/** Full provider warnings remain in the frozen report; this is bounded run metadata. */
export function monitorWarnings(values: readonly string[]): string[] {
  const out:string[]=[],seen=new Set<string>();let truncated=false;
  for(const value of values){
    if(value===WARNING_TRUNCATED){truncated=true;continue;}
    if(seen.has(value))continue;seen.add(value);
    if(out.length>=MAX_PROGRESS_WARNINGS-1){truncated=true;continue;}
    const item=boundedWarning(value);truncated ||= item.truncated;
    // Reserve one item and its bytes for the truncation marker.
    if(Buffer.byteLength(JSON.stringify([...out,item.text,WARNING_TRUNCATED]),'utf8')>FINANCE_MONITOR_WARNINGS_MAX_JSON_BYTES){truncated=true;continue;}
    out.push(item.text);
  }
  if(truncated)out.push(WARNING_TRUNCATED);
  return out;
}

/** A missing pending report is only safe to retry at the exact pre-commit revision. */
export function reconcileMonitorPending(progress: FinanceMonitorProgress, revision: number, report: unknown | undefined): 'none'|'committed'|'retry'|'uncertain' {
  const pending=progress.pending;
  if (!pending) return 'none';
  if (report !== undefined) return monitorReportDigest(report) === pending.reportDigest ? 'committed' : 'uncertain';
  return revision === pending.expectedRevision ? 'retry' : 'uncertain';
}
export function cachedMonitorRun(progress: FinanceMonitorProgress, callerRunId?: string): FinanceMonitorRun | null {
  return callerRunId && progress.completedCallerRunId === callerRunId ? progress.completedRun : null;
}
