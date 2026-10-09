import type Database from "better-sqlite3";
import {createHash} from "node:crypto";
import {supervisorIdentifier,supervisorObject,supervisorError} from "../../shared/one-supervisor";
import type {OneBudgetConfigureInput,OneBudgetConfigureReceipt,OneBudgetListInput,OneBudgetPolicy,OneBudgetSnapshot,OneBudgetUsage} from "../../shared/one-budget";

type PolicyRow={one_id:string;budget_id:string;revision:number;limit_micros:number|null;reserve_micros:number;ttl_ms:number};
export interface OneBudgetReservation {
  command_id:string;one_id:string;task_id:string|null;run_id:string;chat_id:string;budget_id:string|null;
  binding_hash:string;policy_revision:number|null;reserve_micros:number;
  state:"attempted"|"reconciling";expires_at:number;terminal_hash:string|null;
}
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Constructed only before the native dispatch function was called. */
export class OneBudgetAdmissionDenied extends Error {
  readonly code:string;
  constructor(code:string){super(code);this.code=code;}
}
function micros(value:unknown):number {
  if(typeof value!=="number" || !Number.isFinite(value) || value<0 || value>1_000_000_000
    || Math.abs(value*1_000_000-Math.round(value*1_000_000))>0.0001)throw supervisorError("supervisor_budget_amount_invalid");
  return Math.round(value*1_000_000);
}
function revision(value:unknown):number {
  if(!Number.isSafeInteger(value) || (value as number)<0)throw supervisorError("supervisor_budget_revision_invalid");
  return value as number;
}
/** Host-only ledger in the authoritative One database. A timeout or Stop is
 * never billing evidence, so attempted reservations are never auto-refunded. */
export class OneBudgetStore {
  constructor(readonly db:Database.Database,private readonly assertOwner:(oneId:string)=>void,private readonly now=Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS one_budget_policies (
      one_id TEXT NOT NULL,budget_id TEXT NOT NULL,revision INTEGER NOT NULL,
      limit_micros INTEGER,reserve_micros INTEGER NOT NULL,ttl_ms INTEGER NOT NULL,
      PRIMARY KEY(one_id,budget_id));
      CREATE TABLE IF NOT EXISTS one_budget_commands (
        command_id TEXT PRIMARY KEY,one_id TEXT NOT NULL,intent_hash TEXT NOT NULL,receipt_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS one_budget_task_bindings (
        one_id TEXT NOT NULL,task_id TEXT NOT NULL,budget_id TEXT NOT NULL,PRIMARY KEY(one_id,task_id));
      CREATE TABLE IF NOT EXISTS one_budget_reservations (
        command_id TEXT PRIMARY KEY,one_id TEXT NOT NULL,task_id TEXT,run_id TEXT NOT NULL UNIQUE,chat_id TEXT NOT NULL,
        budget_id TEXT,binding_hash TEXT NOT NULL,policy_revision INTEGER,reserve_micros INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('attempted','reconciling')),expires_at INTEGER NOT NULL,terminal_hash TEXT);
      CREATE TABLE IF NOT EXISTS one_budget_usage (
        source_id TEXT PRIMARY KEY,one_id TEXT NOT NULL,run_id TEXT NOT NULL,digest TEXT NOT NULL,
        cost_micros INTEGER,receipt_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS one_budget_reservation_scope ON one_budget_reservations(one_id,budget_id);
      CREATE INDEX IF NOT EXISTS one_budget_usage_run ON one_budget_usage(one_id,run_id);`);
  }
  private policy(row:PolicyRow):OneBudgetPolicy{return {oneId:row.one_id,budgetId:row.budget_id,revision:row.revision,
    limitUsd:row.limit_micros===null?null:row.limit_micros/1_000_000,reserveUsd:row.reserve_micros/1_000_000,reservationTtlMs:row.ttl_ms};}
  private row(oneId:string,budgetId:string):PolicyRow|undefined {
    return this.db.prepare("SELECT * FROM one_budget_policies WHERE one_id=? AND budget_id=?").get(oneId,budgetId) as PolicyRow|undefined;
  }
  configure(raw:OneBudgetConfigureInput):OneBudgetConfigureReceipt {
    const value=supervisorObject(raw,["commandId","oneId","budgetId","expectedRevision","limitUsd","reserveUsd","reservationTtlMs"]);
    const commandId=supervisorIdentifier(value.commandId),oneId=supervisorIdentifier(value.oneId),budgetId=supervisorIdentifier(value.budgetId);
    const expectedRevision=revision(value.expectedRevision),limit=value.limitUsd===null?null:micros(value.limitUsd),reserve=micros(value.reserveUsd);
    const ttl=value.reservationTtlMs??3_600_000;
    if(reserve<=0 || !Number.isSafeInteger(ttl) || (ttl as number)<1_000 || (ttl as number)>7*24*3_600_000)throw supervisorError("supervisor_budget_reservation_invalid");
    const digest=hash([oneId,budgetId,expectedRevision,limit,reserve,ttl]);
    return this.db.transaction(()=>{
      this.assertOwner(oneId);
      const prior=this.db.prepare("SELECT * FROM one_budget_commands WHERE command_id=?").get(commandId) as {one_id:string;intent_hash:string;receipt_json:string}|undefined;
      if(prior){if(prior.one_id!==oneId || prior.intent_hash!==digest)throw supervisorError("supervisor_budget_command_conflict");return JSON.parse(prior.receipt_json);}
      const current=this.row(oneId,budgetId);
      if((current?.revision??0)!==expectedRevision)throw supervisorError("supervisor_budget_revision_conflict");
      this.db.prepare(`INSERT INTO one_budget_policies VALUES(?,?,?,?,?,?) ON CONFLICT(one_id,budget_id) DO UPDATE SET
        revision=excluded.revision,limit_micros=excluded.limit_micros,reserve_micros=excluded.reserve_micros,ttl_ms=excluded.ttl_ms`)
        .run(oneId,budgetId,expectedRevision+1,limit,reserve,ttl);
      const receipt={commandId,policy:this.policy(this.row(oneId,budgetId)!)};
      this.db.prepare("INSERT INTO one_budget_commands VALUES(?,?,?,?)").run(commandId,oneId,digest,JSON.stringify(receipt));
      return receipt;
    }).immediate();
  }
  bindTask(oneId:string,taskId:string,budgetId:string):void {
    this.assertOwner(oneId);supervisorIdentifier(taskId);supervisorIdentifier(budgetId);
    if(!this.row(oneId,budgetId))throw supervisorError("supervisor_budget_missing");
    const prior=this.taskBudget(oneId,taskId);
    if(prior && prior!==budgetId)throw supervisorError("supervisor_budget_task_binding_conflict");
    this.db.prepare("INSERT OR IGNORE INTO one_budget_task_bindings VALUES(?,?,?)").run(oneId,taskId,budgetId);
  }
  taskBudget(oneId:string,taskId:string):string|null {
    return (this.db.prepare("SELECT budget_id FROM one_budget_task_bindings WHERE one_id=? AND task_id=?").get(oneId,taskId) as {budget_id:string}|undefined)?.budget_id??null;
  }
  snapshot(raw:OneBudgetListInput):OneBudgetSnapshot[] {
    const value=supervisorObject(raw,["oneId","budgetId"]),oneId=supervisorIdentifier(value.oneId);
    this.assertOwner(oneId);
    const rows=this.db.prepare(`SELECT * FROM one_budget_policies WHERE one_id=?${value.budgetId===undefined?"":" AND budget_id=?"} ORDER BY budget_id`)
      .all(oneId,...(value.budgetId===undefined?[]:[supervisorIdentifier(value.budgetId)])) as PolicyRow[];
    return rows.map(row=>{
      const totals=this.totals(oneId,row.budget_id);
      return {...this.policy(row),admissionMode:row.limit_micros===null?"observe":"reservation",knownSubtotalUsd:totals.known/1_000_000,
        reservedUsd:totals.reserved/1_000_000,availableUsd:row.limit_micros===null?null:Math.max(0,row.limit_micros-totals.known-totals.reserved)/1_000_000,
        unknownCount:totals.unknown,unresolvedRuns:totals.runs,providerCapEnforced:false};
    });
  }
  private totals(oneId:string,budgetId:string):{known:number;reserved:number;unknown:number;runs:number} {
    const reservations=this.db.prepare("SELECT run_id,reserve_micros FROM one_budget_reservations WHERE one_id=? AND budget_id=?")
      .all(oneId,budgetId) as Array<{run_id:string;reserve_micros:number}>;
    let known=0,reserved=0,unknown=0;
    for(const row of reservations){
      const usage=this.db.prepare("SELECT cost_micros FROM one_budget_usage WHERE one_id=? AND run_id=?").all(oneId,row.run_id) as Array<{cost_micros:number|null}>;
      const subtotal=usage.reduce((sum,item)=>sum+(item.cost_micros??0),0);
      known+=subtotal;reserved+=Math.max(0,row.reserve_micros-subtotal);
      unknown+=Math.max(1,usage.filter(item=>item.cost_micros===null).length);
    }
    if(!Number.isSafeInteger(known+reserved))throw supervisorError("supervisor_budget_overflow");
    return {known,reserved,unknown,runs:reservations.length};
  }
  forRun(runId:string):OneBudgetReservation|null {return this.db.prepare("SELECT * FROM one_budget_reservations WHERE run_id=?").get(runId) as OneBudgetReservation|undefined??null;}
  /** Reserve and cross the attempted boundary together, before preparation can
   * run even a paid judge. Expiry later changes reconciliation urgency only. */
  admit(input:{commandId:string;oneId:string;taskId:string|null;runId:string;chatId:string;bindingHash:string}):OneBudgetReservation {
    const digest=hash(input);
    return this.db.transaction(()=>{
      this.assertOwner(input.oneId);
      const prior=this.db.prepare("SELECT * FROM one_budget_reservations WHERE command_id=?").get(input.commandId) as OneBudgetReservation|undefined;
      if(prior){if(prior.binding_hash!==digest)throw supervisorError("supervisor_budget_reservation_conflict");return prior;}
      const budgetId=input.taskId?this.taskBudget(input.oneId,input.taskId):null,policy=budgetId?this.row(input.oneId,budgetId):null;
      if(budgetId&&!policy)throw supervisorError("supervisor_budget_missing");
      if(policy?.limit_micros!=null){
        const totals=this.totals(input.oneId,budgetId!);
        if(totals.known+totals.reserved+policy.reserve_micros>policy.limit_micros)throw supervisorError("supervisor_budget_reservation_exhausted");
      }
      this.db.prepare("INSERT INTO one_budget_reservations VALUES(?,?,?,?,?,?,?,?,?,'attempted',?,NULL)")
        .run(input.commandId,input.oneId,input.taskId,input.runId,input.chatId,budgetId,digest,policy?.revision??null,policy?.reserve_micros??0,this.now()+(policy?.ttl_ms??3_600_000));
      return this.forRun(input.runId)!;
    }).immediate();
  }
  /** Input is read from a host-written source event by budget-runtime only.
   * A changed original receipt conflicts; it cannot overwrite a prior debit. */
  usage(oneId:string,receipt:OneBudgetUsage):void {
    this.db.transaction(()=>{
    const reservation=this.forRun(receipt.runId);
    if(!reservation || reservation.one_id!==oneId)throw supervisorError("supervisor_budget_usage_binding_invalid");
    this.assertOwner(oneId);supervisorIdentifier(receipt.sourceId);
    const amount=receipt.cost.status==="measured" && receipt.cost.sourceRef ? micros(receipt.cost.usd) : null;
    const normalized={...receipt,cost:amount===null?{status:"unknown" as const,usd:null,sourceRef:null}:{status:"measured" as const,usd:amount/1_000_000,sourceRef:receipt.cost.sourceRef}};
    const digest=hash(normalized);
    const prior=this.db.prepare("SELECT digest FROM one_budget_usage WHERE source_id=?").get(receipt.sourceId) as {digest:string}|undefined;
    if(prior){if(prior.digest!==digest)throw supervisorError("supervisor_budget_usage_conflict");return;}
    this.db.prepare("INSERT INTO one_budget_usage VALUES(?,?,?,?,?,?)").run(receipt.sourceId,oneId,receipt.runId,digest,amount,JSON.stringify(normalized));
    }).immediate();
  }
  terminal(input:{oneId:string;runId:string;chatId:string;status:string}):void {
    this.db.transaction(()=>{
    this.assertOwner(input.oneId);
    const reservation=this.forRun(input.runId);
    if(!reservation || reservation.one_id!==input.oneId || reservation.chat_id!==input.chatId)throw supervisorError("supervisor_budget_terminal_binding_invalid");
    const digest=hash(input);
    if(reservation.terminal_hash && reservation.terminal_hash!==digest)throw supervisorError("supervisor_budget_terminal_conflict");
    this.db.prepare("UPDATE one_budget_reservations SET state='reconciling',terminal_hash=? WHERE run_id=?").run(digest,input.runId);
    }).immediate();
  }
  expire(oneId:string):void {this.assertOwner(oneId);this.db.prepare("UPDATE one_budget_reservations SET state='reconciling' WHERE one_id=? AND state='attempted' AND expires_at<=?").run(oneId,this.now());}
  pending(oneId:string):OneBudgetReservation[]{return this.db.prepare("SELECT * FROM one_budget_reservations WHERE one_id=? ORDER BY rowid").all(oneId) as OneBudgetReservation[];}
}
