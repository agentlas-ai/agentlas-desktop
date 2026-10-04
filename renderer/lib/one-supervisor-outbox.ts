import type { OneSupervisorAPI, SupervisorCommandReceipt } from "../../shared/one-supervisor";
export type SupervisorWrite = Exclude<keyof OneSupervisorAPI,"snapshot">;
export interface PendingSupervisorWrite { commandId:string; method:SupervisorWrite; input:Record<string,unknown> }
const METHODS:SupervisorWrite[]=["send","startWork","startScience","control","stopReply","appearance"];
/** UI outbox only. The Desktop journal remains authoritative; replay always keeps the same intent key. */
export class SupervisorOutbox {
  private pending:PendingSupervisorWrite[];
  private readonly key:string;
  constructor(private readonly oneId:string,private readonly storage:Pick<Storage,"getItem"|"setItem">) {
    this.key=`agentlas.one.supervisor.outbox.${oneId}`;
    const saved=storage.getItem(this.key);
    const value=saved ? JSON.parse(saved) : [];
    if (!Array.isArray(value) || value.some(item=>!item || !METHODS.includes(item.method) || typeof item.commandId !== "string" || item.input?.commandId !== item.commandId)) throw new Error("supervisor_saved_request_invalid");
    this.pending=value;
  }
  list():PendingSupervisorWrite[] {return this.pending.map(item=>({...item,input:{...item.input}}));}
  private persist(next:PendingSupervisorWrite[]):void {this.storage.setItem(this.key,JSON.stringify(next));this.pending=next;}
  reconcile(receipts:SupervisorCommandReceipt[]):void {
    const received=new Set(receipts.map(item=>item.commandId));
    if(this.pending.some(item=>received.has(item.commandId)))this.persist(this.pending.filter(item=>!received.has(item.commandId)));
  }
  prepare(method:SupervisorWrite,input:Record<string,unknown>):PendingSupervisorWrite {
    const prior=this.pending.find(item=>item.method===method && JSON.stringify({...item.input,commandId:undefined})===JSON.stringify(input));
    if(prior)return prior;
    if(this.pending.length>=20)throw new Error("supervisor_saved_request_capacity");
    const commandId=crypto.randomUUID();const intent={commandId,method,input:{...input,commandId}};
    this.persist([...this.pending,intent]);return intent;
  }
  async deliver(api:OneSupervisorAPI,intent:PendingSupervisorWrite):Promise<SupervisorCommandReceipt> {
    const action=api[intent.method] as (input:Record<string,unknown>)=>Promise<SupervisorCommandReceipt>;
    const receipt=await action.call(api,{...intent.input,oneId:intent.input.oneId ?? this.oneId});
    if(receipt.commandId!==intent.commandId)throw new Error("supervisor_receipt_identity_unconfirmed");
    this.reconcile([receipt]);return receipt;
  }
}
