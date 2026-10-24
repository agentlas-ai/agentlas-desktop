import { createHash } from "node:crypto";
import type { AskUserRequestEvent } from "../../shared/types";
import { listPendingAskUserRequests, onAskUserLifecycle, submitAskUserAnswer } from "./ask-user";
import { getDb } from "../store/db";
import { getInvocationAdmission } from "../store/invocation-admissions";
import { invocationRunOwners } from "../store/invocation-run-owners";

/** Shared daemon broker projection. Native peer authentication happens before
 * these operations; original admission, lease, chat actor and account custody
 * are re-read here. No domain-specific question registry is created. */
export function createOwnedAskUserHost(options:{ownerId:string;assertOwner():void;ownerKey():string;notify():boolean;personalSource(chatId:string,runId:string):boolean}) {
  type Held={event:AskUserRequestEvent;runId:string;leaseId:string;actorId:string;ownerKey:string;revision:string;personal:boolean};
  const held=new Map<string,Held>();
  const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const chat=(id:string)=>getDb().prepare("SELECT agent_id,archived_at FROM chats WHERE id=?").get(id) as {agent_id:string;archived_at:string|null}|undefined;
  const current=(row:Held)=>{
    options.assertOwner();if(options.ownerKey()!==row.ownerKey||!row.event.chatId)return false;
    const actor=chat(row.event.chatId),admission=getInvocationAdmission(row.runId),owner=invocationRunOwners.getRunOwner(row.event.chatId,row.runId);
    return !!actor&&!actor.archived_at&&actor.agent_id===row.actorId&&!!admission&&admission.status==="admitted"
      &&admission.chatId===row.event.chatId&&admission.ownerProcessEpoch===options.ownerId
      &&!!owner&&owner.ownerKind==="daemon"&&owner.ownerId===options.ownerId&&owner.state==="active"&&owner.leaseId===row.leaseId;
  };
  const stop=onAskUserLifecycle(event=>{
    if(event.expiresAt<=Date.now()){if(held.delete(event.requestId))try{options.notify();}catch{}return false;}
    try{
      options.assertOwner();if(!event.chatId)return false;
      const owner=invocationRunOwners.getActiveOwner(event.chatId),actor=chat(event.chatId);
      if(!owner||!actor)return false;
      const row:Held={event:{...event,options:event.options.map(option=>({...option}))},runId:owner.runId,leaseId:owner.leaseId,
        actorId:actor.agent_id,ownerKey:options.ownerKey(),revision:digest(event),personal:options.personalSource(event.chatId,owner.runId)};
      if(!current(row))return false;
      held.set(event.requestId,row);return options.notify();
    }catch{return false;}
  });
  const pending=(id:string)=>{
    const row=held.get(id),question=listPendingAskUserRequests().find(item=>item.requestId===id);
    return row&&question&&question.expiresAt>Date.now()&&digest(question)===row.revision&&current(row)?row:null;
  };
  return {
    list():AskUserRequestEvent[]{options.assertOwner();return [...held.keys()].flatMap(id=>{const row=pending(id);return row?[{...row.event,options:row.event.options.map(option=>({...option}))}]:[];});},
    binding(id:string):{chatId:string;runId:string;personal:boolean}|null{const row=pending(id);return row?{chatId:row.event.chatId!,runId:row.runId,personal:row.personal}:null;},
    answer(id:string,answer:string|null):boolean{const row=pending(id);if(!row)return false;return submitAskUserAnswer(id,answer);},
    close(){stop();held.clear();},
  };
}
