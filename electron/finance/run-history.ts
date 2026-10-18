import fs from 'node:fs/promises';
import type { Dir } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { FinanceMonitorRun, FinanceMonitorRunsResult } from '../../shared/finance';
import type { FinanceScope } from './store';
import { financeHash, financePrivateDirectory, readFinanceJsonFile, writeFinanceJsonFile } from './archive';

const uuid=z.string().regex(/^[a-f0-9-]{36}$/),time=z.string().datetime({offset:true});
const runSchema=z.object({id:uuid,monitorId:z.string().min(1).max(200),status:z.enum(['running','succeeded','partial','failed','cancelled']),startedAt:time,finishedAt:time.nullable(),reportId:z.string().min(1).max(200).nullable(),summary:z.string().max(20000),warnings:z.array(z.string().max(20000)).max(100),error:z.string().max(20000).nullable(),sourceRevision:z.number().int().nonnegative()}).strict();
const cursorSchema=z.object({version:z.literal(1),context:z.string().regex(/^[a-f0-9]{64}$/),snapshot:z.number().int().nonnegative(),beforeTime:time,beforeId:uuid}).strict();
type Indexed={id:string;sequence:number;started_at:string;status:string};
function historyError(error:unknown):unknown{const code=(error as NodeJS.ErrnoException)?.code,number=(error as {errcode?:number})?.errcode;if(code==='SQLITE_BUSY'||code==='SQLITE_LOCKED'||number===5||number===6)return new Error('finance_history_busy');if(code==='ERR_DLOPEN_FAILED')return new Error('finance_history_runtime_unavailable');if(code?.startsWith('SQLITE_'))return new Error('finance_history_index_invalid');return error;}
const MAX_RUN_BYTES=1000000,MAX_PAGE_BYTES=2*1024*1024,MIGRATION_BATCH=100;
/** Derived SQLite index only. Canonical UUID records are preserved and never pruned. */
export class FinanceRunHistory {
  private iterator:Dir|undefined;
  private stepping:Promise<boolean>|undefined;
  constructor(private readonly directory:string,private readonly monitorId:string){}
  private async open():Promise<Database.Database>{
    await financePrivateDirectory(this.directory);const directory=path.join(this.directory,'_index');await financePrivateDirectory(directory);
    const file=path.join(directory,'runs.sqlite');
    for(const suffix of ['','-wal','-shm','-journal'])try{const stat=await fs.lstat(file+suffix);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('finance_history_index_invalid');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    let db:Database.Database;try{db=new Database(file,{timeout:1000});}catch(error){throw historyError(error);}try{await fs.chmod(file,0o600);
    db.pragma('busy_timeout = 1000');db.pragma('journal_mode = DELETE');
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY,sequence INTEGER NOT NULL UNIQUE,started_at TEXT NOT NULL,status TEXT NOT NULL); CREATE INDEX IF NOT EXISTS runs_order ON runs(started_at DESC,id DESC); CREATE INDEX IF NOT EXISTS runs_status ON runs(status);');
    db.transaction(()=>{if(this.get(db,'count')===undefined)this.set(db,'count',String((db.prepare('SELECT COUNT(*) AS value FROM runs').get() as {value:number}).value));})();
    return db;}catch(error){db.close();throw historyError(error);}
  }
  private get(db:Database.Database,key:string):string|undefined{return (db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value:string}|undefined)?.value;}
  private set(db:Database.Database,key:string,value:string):void{db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  private indexed(db:Database.Database,run:FinanceMonitorRun):void{
    db.transaction(()=>{const previous=db.prepare('SELECT sequence FROM runs WHERE id=?').get(run.id);if(previous){db.prepare('UPDATE runs SET started_at=?,status=? WHERE id=?').run(new Date(run.startedAt).toISOString(),run.status,run.id);return;}
      const max=(db.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM runs').get() as {value:number}).value;
      db.prepare('INSERT INTO runs(id,sequence,started_at,status) VALUES(?,?,?,?)').run(run.id,max+1,new Date(run.startedAt).toISOString(),run.status);this.set(db,'count',String(Number(this.get(db,'count')??0)+1));})();
  }
  private async read(id:string):Promise<FinanceMonitorRun>{const run=runSchema.parse(await readFinanceJsonFile(path.join(this.directory,`${uuid.parse(id)}.json`),MAX_RUN_BYTES));if(run.id!==id||run.monitorId!==this.monitorId)throw new Error('finance_monitor_run_invalid');return run;}
  private async step(db:Database.Database):Promise<boolean>{
    if(this.get(db,'ready')==='1')return true;
    if(this.stepping)return this.stepping;
    this.stepping=(async()=>{
      this.iterator??=await fs.opendir(this.directory);let visited=0,records=0;
      while(visited<400&&records<MIGRATION_BATCH){const entry=await this.iterator.read();if(!entry){await this.iterator.close();this.iterator=undefined;this.set(db,'ready','1');return true;}visited++;
        if(!/^[a-f0-9-]{36}\.json$/.test(entry.name))continue;
        const run=await this.read(entry.name.slice(0,-5));this.indexed(db,run);records++;
        if(records%20===0)await new Promise<void>(resolve=>setImmediate(resolve));
      }return false;
    })();
    try{return await this.stepping;}catch(error){await this.iterator?.close().catch(()=>undefined);this.iterator=undefined;throw error;}finally{this.stepping=undefined;}
  }
  async prepare(scope:FinanceScope):Promise<{ready:boolean;indexedCount:number}>{scope.assertCurrent();const db=await this.open();try{const ready=await this.step(db);scope.assertCurrent();return {ready,indexedCount:Number(this.get(db,'count')??0)};}catch(error){throw historyError(error);}finally{db.close();}}
  /** Only called while the service holds the monitor execution lease. */
  async recover(scope:FinanceScope):Promise<boolean>{
    const db=await this.open();try{
      const pending=this.get(db,'pending');if(pending){scope.assertCurrent();if(Buffer.byteLength(pending)>MAX_RUN_BYTES)throw new Error('finance_monitor_run_invalid');const run=runSchema.parse(JSON.parse(pending));if(run.monitorId!==this.monitorId)throw new Error('finance_monitor_run_invalid');
        // A terminal canonical fallback is newer than an abandoned running journal.
        let canonical:FinanceMonitorRun|undefined;
        try{canonical=await this.read(run.id);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        scope.assertCurrent();
        if(run.status==='running'&&canonical&&canonical.status!=='running')this.indexed(db,canonical);
        else{await writeFinanceJsonFile(path.join(this.directory,`${run.id}.json`),run);this.indexed(db,run);}
        this.set(db,'pending','');}
      const live=db.prepare("SELECT id FROM runs WHERE status='running' LIMIT 101").all() as {id:string}[];
      for(const item of live.slice(0,100)){scope.assertCurrent();const current=await this.read(item.id);if(current.status==='running'){
        const interrupted:FinanceMonitorRun={...current,status:'failed',finishedAt:new Date().toISOString(),error:'finance_monitor_interrupted',summary:'이전 실행의 잠금이 유지되지 않아 완료 여부를 확인할 수 없습니다. 자료를 다시 조회하세요.'};
        this.set(db,'pending',JSON.stringify(interrupted));await writeFinanceJsonFile(path.join(this.directory,`${item.id}.json`),interrupted);this.indexed(db,interrupted);this.set(db,'pending','');
      }else this.indexed(db,current);}
      return live.length<=100;
    }catch(error){throw historyError(error);}finally{db.close();}
  }
  /** Caller holds the monitor lease; journal -> canonical record -> index, so crash gaps are recoverable. */
  async write(run:FinanceMonitorRun):Promise<void>{
    runSchema.parse(run);if(run.monitorId!==this.monitorId)throw new Error('finance_monitor_run_invalid');const json=JSON.stringify(run);if(Buffer.byteLength(json)>MAX_RUN_BYTES)throw new Error('finance_monitor_run_invalid');
    const db=await this.open();try{this.set(db,'pending',json);await writeFinanceJsonFile(path.join(this.directory,`${run.id}.json`),run);this.indexed(db,run);this.set(db,'pending','');}catch(error){throw historyError(error);}finally{db.close();}
  }
  /** Caller holds the monitor lease. Preserve a saved report even when the derived index is unavailable. */
  async writeTerminalFallback(scope:FinanceScope,run:FinanceMonitorRun):Promise<void>{
    scope.assertCurrent();runSchema.parse(run);
    if(run.monitorId!==this.monitorId||run.status==='running'||!run.finishedAt||!run.reportId||Buffer.byteLength(JSON.stringify(run))>MAX_RUN_BYTES)throw new Error('finance_monitor_run_invalid');
    await writeFinanceJsonFile(path.join(this.directory,`${run.id}.json`),run);scope.assertCurrent();
  }
  async hasRunning():Promise<boolean>{const db=await this.open();try{return !!this.get(db,'pending')||!!db.prepare("SELECT id FROM runs WHERE status='running' LIMIT 1").get();}catch(error){throw historyError(error);}finally{db.close();}}
  async page(scope:FinanceScope,input:{cursor?:string;limit?:number}):Promise<FinanceMonitorRunsResult>{
    scope.assertCurrent();const db=await this.open();try{
      const ready=await this.step(db),indexedCount=Number(this.get(db,'count')??0);
      if(!ready)return {runs:[],nextCursor:null,indexStatus:'building',indexedCount};
      const limit=input.limit??50;if(!Number.isInteger(limit)||limit<1||limit>50)throw new Error('finance_history_cursor_invalid');
      const context=financeHash(path.resolve(this.directory)),max=(db.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM runs').get() as {value:number}).value;
      let cursor:z.infer<typeof cursorSchema>|undefined;
      if(input.cursor){if(input.cursor.length>2000)throw new Error('finance_history_cursor_invalid');try{cursor=cursorSchema.parse(JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8')));}catch{throw new Error('finance_history_cursor_invalid');}
        if(cursor.context!==context||cursor.snapshot>max)throw new Error('finance_history_cursor_invalid');}
      const snapshot=cursor?.snapshot??max;
      const indexed=(cursor?db.prepare('SELECT id,sequence,started_at,status FROM runs WHERE sequence<=? AND (started_at<? OR (started_at=? AND id<?)) ORDER BY started_at DESC,id DESC LIMIT ?').all(snapshot,cursor.beforeTime,cursor.beforeTime,cursor.beforeId,limit+1):db.prepare('SELECT id,sequence,started_at,status FROM runs WHERE sequence<=? ORDER BY started_at DESC,id DESC LIMIT ?').all(snapshot,limit+1)) as Indexed[];
      const runs:FinanceMonitorRun[]=[];let bytes=0;
      for(const item of indexed.slice(0,limit)){const stat=await fs.lstat(path.join(this.directory,`${uuid.parse(item.id)}.json`));if(bytes+stat.size>MAX_PAGE_BYTES&&runs.length)break;const run=await this.read(item.id);runs.push(run);bytes+=stat.size;}
      const last=runs.at(-1),more=indexed.length>runs.length;
      const nextCursor=last&&more?Buffer.from(JSON.stringify({version:1,context,snapshot,beforeTime:new Date(last.startedAt).toISOString(),beforeId:last.id})).toString('base64url'):null;
      scope.assertCurrent();return {runs,nextCursor,snapshotSequence:snapshot,indexStatus:'ready',indexedCount};
    }catch(error){throw historyError(error);}finally{db.close();}
  }
}
