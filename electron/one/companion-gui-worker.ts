/** GUI-only coordinator for direct Work. Native admission and lease issuance
 * remain separate trusted ports; the daemon never receives a GUI private key. */
export function createCompanionGuiWorker(options:{
  scope():string|null; assertCurrent(scope:string):void;
  poll(scope:string):Promise<unknown|null>; admit(scope:string,grant:unknown):Promise<void>;
  pending(scope:string):Promise<Array<{commandId:string;runId:string;phase:"claimed"|"starting"|"running"|"held"}>>;
  /** Returns only an opaque, locally verified server authorization capability. */
  authorize(scope:string,commandId:string,runId:string,phase:"claimed"|"starting"|"running"|"held"):Promise<object|null>;
  issue(scope:string,commandId:string,runId:string,authority:object):Promise<void>;
  revoke(scope:string,commandId?:string):void; onOwnershipChanged(listener:()=>void):()=>void; intervalMs?:number;
}) {
  if(options.intervalMs!==undefined && (!Number.isSafeInteger(options.intervalMs) || options.intervalMs<1_000 || options.intervalMs>10_000))throw new TypeError("companion_gui_interval_invalid");
  let closed=false,timer:ReturnType<typeof setInterval>|null=null,running:Promise<void>|null=null,epoch=0,lastScope:string|null=null;
  function invalidate():void {epoch++;const old=lastScope;lastScope=null;if(old)options.revoke(old);}
  const detachOwner=options.onOwnershipChanged(()=>{try{if(options.scope()!==lastScope)invalidate();}catch{invalidate();}});
  async function sweep():Promise<void> {
    if(closed)return;if(running)return running;
    running=(async()=>{
      const scope=options.scope();
      if(scope!==lastScope){invalidate();lastScope=scope;}
      if(!scope)return;
      const generation=epoch;
      const guard=()=>{if(closed || epoch!==generation || options.scope()!==scope)throw new Error("companion_gui_scope_changed");options.assertCurrent(scope);};
      try {
        guard();
        const workItems=await options.pending(scope);guard();
        await Promise.all(workItems.map(async work=>{
          guard();
          try {
            const proof=await options.authorize(scope,work.commandId,work.runId,work.phase);guard();
            if(!proof){options.revoke(scope,work.commandId);return;}
            await options.issue(scope,work.commandId,work.runId,proof);guard();
          } catch {options.revoke(scope,work.commandId);}
        }));
        guard();const grant=await options.poll(scope);guard();if(grant){await options.admit(scope,grant);guard();}
      } catch { /* No verified authority is extended; existing leases expire. */ }
    })().finally(()=>{running=null});return running;
  }
  function start():void {if(closed || timer)return;timer=setInterval(()=>{void sweep().catch(()=>undefined)},options.intervalMs ?? 5_000);timer.unref?.();void sweep().catch(()=>undefined);}
  async function stop():Promise<void> {closed=true;if(timer)clearInterval(timer);timer=null;detachOwner();invalidate();await running?.catch(()=>undefined);}
  return Object.freeze({start,sweep,invalidate,stop});
}
