import type Database from "better-sqlite3";
import { getAuthenticatedSessionBinding } from "../auth";
import { createCompanionGuiRuntime } from "./companion-gui-runtime";
import { createCompanionGuiDeliveryRuntime } from "./companion-gui-delivery-runtime";

type Channel={bootId:string;connection:string;generation:string};
/** The GUI owns its signing worker only while the enrolled daemon channel
 * identifies the current personal-domain owner. No daemon key is exported. */
export function createCompanionGuiCoordinator(options:{db:Database.Database;oneId():string;channel():Channel|null;
  admit(value:{binding:Record<string,unknown>;payload:string;grant:string}):Promise<unknown>;
  retireUnstarted(value:{userId:string;workspaceId:string;oneId:string;commandId:string;runId:string}):Promise<unknown>;executionEvidence?:boolean}) {
  let stopped=false,timer:ReturnType<typeof setInterval>|null=null;
  const intake=createCompanionGuiRuntime(options);
  const deliveries=new Map<string,ReturnType<typeof createCompanionGuiDeliveryRuntime>>();
  function sweep():void {
    if(stopped)return;
    try {
      const channel=options.channel(),actor=getAuthenticatedSessionBinding();
      // A replaced/lost authenticated channel fences all workers created for it.
      if(!channel){for(const worker of deliveries.values())void worker.stop();deliveries.clear();return;}
      for(const [key,worker] of deliveries){const [boot,connection,generation]=JSON.parse(key) as string[];
        if(boot!==channel.bootId || connection!==channel.connection || generation!==channel.generation){deliveries.delete(key);void worker.stop();}}
      if(!actor)return;const one=options.oneId();if(!one)return;
      const owner=options.db.prepare("SELECT one_id,owner_epoch,owner_kind,generation,phase,lease_until FROM one_supervisor_runtime_owner WHERE slot='personal'").get() as
        {one_id:string;owner_epoch:string;owner_kind:string;generation:number;phase:string;lease_until:number}|undefined;
      if(!owner || owner.one_id!==one || owner.owner_epoch!==channel.bootId || owner.owner_kind!=="work-daemon" || owner.phase!=="active" || owner.lease_until<=Date.now())return;
      const key=JSON.stringify([channel.bootId,channel.connection,channel.generation,actor.userId,actor.workspaceId,actor.sessionId,one,owner.generation]);
      if(deliveries.has(key))return;
      // Old account workers retain only their original retirement lane; their
      // normal result lane is fenced by the captured account and session.
      const worker=createCompanionGuiDeliveryRuntime(options);deliveries.set(key,worker);worker.start();
      for(const [oldKey,oldWorker] of deliveries){if(oldKey===key)continue;const old=JSON.parse(oldKey) as Array<string|number>;
        if(old[3]===actor.userId && old[4]===actor.workspaceId && old[6]===one){deliveries.delete(oldKey);void oldWorker.stop();}}
    }catch { /* Auth/owner not ready: next tick retries without issuing. */ }
  }
  function start():void {if(stopped || timer)return;intake.start();timer=setInterval(sweep,2000);timer.unref?.();sweep();}
  async function stop():Promise<void> {if(stopped)return;stopped=true;if(timer)clearInterval(timer);timer=null;
    await Promise.allSettled([intake.stop(),...Array.from(deliveries.values(),worker=>worker.stop())]);deliveries.clear();}
  return Object.freeze({start,stop,sweep});
}
