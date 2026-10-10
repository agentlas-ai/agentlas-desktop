import { OneVaultError, type OneVaultRequest, type OneVaultEnvelope } from '../../shared/one-vault';
import { oneVaultDigest } from './one-vault-crypto';
export interface OneVaultSqlite {
  exec(sql:string):unknown;
  prepare(sql:string):{get(...args:unknown[]):unknown;all(...args:unknown[]):unknown[];run(...args:unknown[]):{changes:number|bigint}};
  transaction<T>(fn:()=>T):{():T;immediate():T};
}
export interface OneVaultOperation {
  operationId:string; requestId:string; requestDigest:string; envelopeDigest:string; nonce:string; slotId:string;
  action:'store'|'delete'; expectedGeneration:number; generation:number; credentialRef:string;
  previousRef:string|null; state:'reserved'|'store_unknown'|'saved'|'deleted'|'failed'; errorCode:string|null;
}
export function oneVaultSlot(request:OneVaultRequest):string {
  const b=request.binding;
  return oneVaultDigest([b.scope,b.scope==='personal'?b.principalId:b.organizationId,b.workspaceId,b.resourceId,b.provider,b.providerWorkspace,b.region,b.storage]);
}
/** The sole Main credential effect journal, attached to the existing Supervisor DB.
 * Not a request authority, execution queue, Business journal, or replacement for legacy recovery-state. */
export class OneVaultJournal {
  constructor(private readonly db:OneVaultSqlite) {
    db.exec(`CREATE TABLE IF NOT EXISTS one_vault_slots(slotId TEXT PRIMARY KEY,generation INTEGER NOT NULL,credentialRef TEXT,pendingOperation TEXT);
      CREATE TABLE IF NOT EXISTS one_vault_operations(operationId TEXT PRIMARY KEY,requestId TEXT NOT NULL,requestDigest TEXT NOT NULL UNIQUE,envelopeDigest TEXT NOT NULL,nonce TEXT NOT NULL UNIQUE,slotId TEXT NOT NULL,action TEXT NOT NULL,expectedGeneration INTEGER NOT NULL,generation INTEGER NOT NULL,credentialRef TEXT NOT NULL,previousRef TEXT,state TEXT NOT NULL,errorCode TEXT);
      CREATE TABLE IF NOT EXISTS one_vault_status_nonces(nonce TEXT PRIMARY KEY,expiresAt INTEGER NOT NULL);`);
  }
  get(operationId:string):OneVaultOperation|null { return (this.db.prepare('SELECT * FROM one_vault_operations WHERE operationId=?').get(operationId) as OneVaultOperation|undefined)??null; }
  forRequest(requestDigest:string):OneVaultOperation|null {return (this.db.prepare('SELECT * FROM one_vault_operations WHERE requestDigest=?').get(requestDigest) as OneVaultOperation|undefined)??null;}
  current(slotId:string):{generation:number;credentialRef:string|null;pendingOperation:string|null} {
    return (this.db.prepare('SELECT generation,credentialRef,pendingOperation FROM one_vault_slots WHERE slotId=?').get(slotId) as ReturnType<OneVaultJournal['current']>|undefined)??{generation:0,credentialRef:null,pendingOperation:null};
  }
  reserve(r:OneVaultRequest,e:OneVaultEnvelope):{operation:OneVaultOperation;duplicate:boolean} {
    return this.db.transaction(()=>{
      const prior=this.get(e.operationId), digest=oneVaultDigest(e);
      if(prior) { if(prior.envelopeDigest!==digest || prior.requestDigest!==oneVaultDigest(r)) throw new OneVaultError('replay_conflict'); return {operation:prior,duplicate:true}; }
      if(this.db.prepare('SELECT 1 FROM one_vault_operations WHERE requestDigest=? OR nonce=?').get(oneVaultDigest(r),r.nonce)) throw new OneVaultError('request_consumed');
      const slotId=oneVaultSlot(r),current=this.current(slotId);
      if(current.generation!==r.binding.expectedGeneration || current.pendingOperation) throw new OneVaultError('generation_conflict');
      // Main-derived opaque immutable slot/generation ref. User cannot choose arbitrary Vault accounts.
      const generation=current.generation+1,credentialRef=`one-vault:${slotId}:${generation}`;
      const op:OneVaultOperation={operationId:e.operationId,requestId:r.binding.requestId,requestDigest:oneVaultDigest(r),envelopeDigest:digest,nonce:r.nonce,slotId,action:e.action,expectedGeneration:current.generation,generation,credentialRef,previousRef:current.credentialRef,state:'reserved',errorCode:null};
      this.db.prepare('INSERT OR IGNORE INTO one_vault_slots VALUES(?,0,NULL,NULL)').run(slotId);
      const cas=this.db.prepare('UPDATE one_vault_slots SET pendingOperation=? WHERE slotId=? AND generation=? AND pendingOperation IS NULL').run(e.operationId,slotId,current.generation);
      if(Number(cas.changes)!==1) throw new OneVaultError('generation_conflict');
      this.db.prepare('INSERT INTO one_vault_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...[op.operationId,op.requestId,op.requestDigest,op.envelopeDigest,op.nonce,op.slotId,op.action,op.expectedGeneration,op.generation,op.credentialRef,op.previousRef,op.state,op.errorCode].slice(0));
      return {operation:op,duplicate:false};
    }).immediate();
  }
  unknown(operationId:string):OneVaultOperation {
    this.db.prepare("UPDATE one_vault_operations SET state='store_unknown',errorCode='store_unknown' WHERE operationId=? AND state IN ('reserved','store_unknown')").run(operationId);
    const op=this.get(operationId); if(!op) throw new OneVaultError('not_found'); return op;
  }
  finish(operationId:string,state:'saved'|'deleted'|'failed',errorCode:string|null=null):OneVaultOperation {
    return this.db.transaction(()=>{
      const op=this.get(operationId); if(!op) throw new OneVaultError('not_found');
      if(!['reserved','store_unknown'].includes(op.state)) return op;
      const committed=state==='saved'||state==='deleted';
      const changed=this.db.prepare('UPDATE one_vault_slots SET generation=?,credentialRef=?,pendingOperation=NULL WHERE slotId=? AND generation=? AND pendingOperation=?').run(committed?op.generation:op.expectedGeneration,committed?(state==='saved'?op.credentialRef:null):op.previousRef,op.slotId,op.expectedGeneration,operationId);
      if(Number(changed.changes)!==1) throw new OneVaultError('generation_conflict');
      this.db.prepare('UPDATE one_vault_operations SET state=?,errorCode=? WHERE operationId=?').run(state,errorCode,operationId);
      return this.get(operationId)!;
    }).immediate();
  }
  consumeStatusNonce(nonce:string,expiresAt:number,now:number):void {
    this.db.transaction(()=>{
      this.db.prepare('DELETE FROM one_vault_status_nonces WHERE expiresAt<?').run(now);
      if(this.db.prepare('SELECT 1 FROM one_vault_status_nonces WHERE nonce=?').get(nonce)) throw new OneVaultError('replay_conflict');
      this.db.prepare('INSERT INTO one_vault_status_nonces VALUES(?,?)').run(nonce,expiresAt);
    }).immediate();
  }
  /** Called only after existing Supervisor establishes sole-host ownership at restart.
   * A reserved write may have reached OS Vault: never retry or infer absence automatically. */
  recoverAfterExclusiveRestart():void { this.db.prepare("UPDATE one_vault_operations SET state='store_unknown',errorCode='store_unknown' WHERE state='reserved'").run(); }
}
