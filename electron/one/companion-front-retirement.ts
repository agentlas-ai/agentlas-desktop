import type Database from "better-sqlite3";
import type { InvocationRunReceipt } from "../../shared/types";
import { companionFrontRetirementBytes, type FrontRetirementProof } from "../../shared/companion-front-retirement";

type Owner={binding:Record<string,unknown>;runId:string;proof:FrontRetirementProof;assertCurrent():void};
const permits=new WeakMap<object,Owner>();
type Row={command_id:string;one_id:string;chat_id:string;run_id:string;binding_json:string;state:string;terminal_receipt_json:string|null};
function syncBoolean(result:unknown):boolean {if(result&&typeof(result as {then?:unknown}).then==="function")void Promise.resolve(result).catch(()=>{});return result===true;}
function syncVoid(result:unknown):void {if(result!==undefined){if(result&&typeof(result as {then?:unknown}).then==="function")void Promise.resolve(result).catch(()=>{});throw new Error("front_retirement_guard_not_synchronous");}}
function syncReceipt(result:unknown):InvocationRunReceipt|null {
  if(result&&typeof(result as {then?:unknown}).then==="function"){void Promise.resolve(result).catch(()=>{});throw new Error("front_retirement_receipt_not_synchronous");}
  return result as InvocationRunReceipt|null;
}
/** Atomically fence an unstarted row, or require the exact run's observed
 * terminal interruption. A failed/unobserved start never becomes proof. */
export function createCompanionFrontRetirementOwner(options:{db:Database.Database;assertOwner():void;assertBinding(binding:Record<string,unknown>):void;
  noStartProof(runId:string):boolean;receipt(runId:string):InvocationRunReceipt|null}) {
  const {db}=options;
  return function retire(commandId:string,runId:string,kind:FrontRetirementProof):object|null {
    try {
      if(typeof commandId!=="string"||typeof runId!=="string"||(kind!=="not_started"&&kind!=="interrupted"))return null;
      return db.transaction(()=>{
        syncVoid(options.assertOwner());
        const row=db.prepare("SELECT command_id,one_id,chat_id,run_id,binding_json,state,terminal_receipt_json FROM one_companion_front_turns WHERE command_id=? AND run_id=?").get(commandId,runId) as Row|undefined;
        if(!row)return null;
        const binding=JSON.parse(row.binding_json) as Record<string,unknown>;
        if(binding.commandId!==commandId||binding.oneId!==row.one_id)throw new Error("front_retirement_binding_changed");
        companionFrontRetirementBytes(binding,runId,kind);syncVoid(options.assertBinding(binding));
        db.exec(`CREATE TABLE IF NOT EXISTS one_companion_front_retirements(
          command_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,chat_id TEXT NOT NULL,proof TEXT NOT NULL CHECK(proof IN ('not_started','interrupted')),
          binding_json TEXT NOT NULL,FOREIGN KEY(command_id) REFERENCES one_companion_front_turns(command_id) ON DELETE CASCADE)`);
        const prior=db.prepare("SELECT run_id,chat_id,proof,binding_json FROM one_companion_front_retirements WHERE command_id=?").get(commandId) as {run_id:string;chat_id:string;proof:string;binding_json:string}|undefined;
        if(prior && (prior.run_id!==runId||prior.chat_id!==row.chat_id||prior.proof!==kind||prior.binding_json!==row.binding_json))throw new Error("front_retirement_conflict");
        const check=()=>{
          syncVoid(options.assertOwner());syncVoid(options.assertBinding(binding));
          const live=db.prepare("SELECT chat_id,binding_json,state,terminal_receipt_json FROM one_companion_front_turns WHERE command_id=? AND run_id=?").get(commandId,runId) as Pick<Row,"chat_id"|"binding_json"|"state"|"terminal_receipt_json">|undefined;
          if(!live||live.chat_id!==row.chat_id||live.binding_json!==row.binding_json)throw new Error("front_retirement_owner_changed");
          if(kind==="not_started") {
            if(!["stored","terminal"].includes(live.state)||!syncBoolean(options.noStartProof(runId))||syncReceipt(options.receipt(runId))!==null)throw new Error("front_retirement_not_proven");
          } else {
            const actual=syncReceipt(options.receipt(runId));
            const stored=live.terminal_receipt_json?JSON.parse(live.terminal_receipt_json) as InvocationRunReceipt:null;
            // A receipt may infer interruption after a lost owner; that is not
            // proof of termination. Require the latest explicit terminal event.
            const terminal=db.prepare(`SELECT chat_id,kind FROM run_events WHERE run_id=? AND kind IN
              ('invoke_waiting','invoke_completed','mcp_final','invoke_cancelled','invoke_interrupted','invoke_failed','invoke_threw','mcp_error')
              ORDER BY seq DESC LIMIT 1`).get(runId) as {chat_id:string|null;kind:string}|undefined;
            if(live.state!=="terminal"||!actual||!stored||actual.runId!==runId||actual.chatId!==row.chat_id||
              (actual.status!=="cancelled"&&actual.status!=="interrupted")||stored.runId!==actual.runId||stored.chatId!==actual.chatId||stored.status!==actual.status||
              !terminal||terminal.chat_id!==row.chat_id||terminal.kind!==(actual.status==="cancelled"?"invoke_cancelled":"invoke_interrupted"))
              throw new Error("front_retirement_not_proven");
          }
        };
        check();
        if(!prior) {
          if(kind==="not_started") {
            const changed=db.prepare("UPDATE one_companion_front_turns SET state='terminal',updated_at=? WHERE command_id=? AND run_id=? AND chat_id=? AND state='stored'")
              .run(new Date().toISOString(),commandId,runId,row.chat_id);
            if(changed.changes!==1)throw new Error("front_retirement_start_race");
          }
          db.prepare("INSERT INTO one_companion_front_retirements(command_id,run_id,chat_id,proof,binding_json) VALUES(?,?,?,?,?)").run(commandId,runId,row.chat_id,kind,row.binding_json);
        }
        check();
        const assertCurrent=()=>{check();const live=db.prepare("SELECT run_id,chat_id,proof,binding_json FROM one_companion_front_retirements WHERE command_id=?").get(commandId) as {run_id:string;chat_id:string;proof:string;binding_json:string}|undefined;
          if(!live||live.run_id!==runId||live.chat_id!==row.chat_id||live.proof!==kind||live.binding_json!==row.binding_json)throw new Error("front_retirement_owner_changed");};
        assertCurrent();const capability=Object.freeze({});permits.set(capability,{binding:structuredClone(binding),runId,proof:kind,assertCurrent});return capability;
      }).immediate();
    }catch{return null;}
  };
}
export function takeCompanionFrontRetirementPermit(value:unknown):Owner|null {
  if(!value||typeof value!=="object")return null;const held=permits.get(value);permits.delete(value);if(!held)return null;
  try{held.assertCurrent();return held}catch{return null;}
}
