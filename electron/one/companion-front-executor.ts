import type Database from "better-sqlite3";
import {companionWorkPermission,pullOwnerChip} from "./companion-permission-cap";
import type { InvocationRunReceipt, McpInvocationRequest, RuntimeSelection } from "../../shared/types";

type Row = {command_id:string;one_id:string;chat_id:string;run_id:string;binding_json:string;user_text:string;state:string;updated_at?:string};
/** Audit 62 (bridge B13): a turn that is `starting` or `held` with NO proof that the run ever started (the runtime's own `noStartProof`) and no receipt, for this long, goes back to `stored`: it was never begun, so it may be begun (its start checks the same proofs again). */
const UNSTARTED_RETRY_AFTER_MS = 120_000;
type Terminal = InvocationRunReceipt & {status:"completed"|"failed"|"cancelled"|"interrupted"};
const terminal = (receipt: InvocationRunReceipt | null): receipt is Terminal => !!receipt && ["completed","failed","cancelled","interrupted"].includes(receipt.status);

/** A front turn remains independent of Work and cannot start until the service
 * and the local owner both authorize the same command/run. The caller must
 * establish profile, memory and attachment parity before returning memoryReady. */
export function createCompanionFrontExecutor(options: {
  db:Database.Database; assertOwner():void; assertBinding(binding:Record<string,unknown>):void; memoryReady(binding:Record<string,unknown>,runId:string):Promise<boolean>;
  lifecycle(purpose:"start"|"status",binding:Record<string,unknown>,runId:string):Promise<string|null>;
  candidates():Promise<RuntimeSelection[]>; locale():"ko"|"en"; hostKind:"desktop-main"|"work-daemon";
  runtime:{ start(request:McpInvocationRequest):{runId:string}|Promise<{runId:string}>; cancel(runId:string):unknown;
    receipt(runId:string):InvocationRunReceipt|null; noStartProof(runId:string):boolean;
    onSettled(listener:(event:{runId:string;chatId:string;receipt:InvocationRunReceipt})=>void):()=>void };
  onOwnershipChanged(listener:()=>void):()=>void; isSameOwner(binding:Record<string,unknown>):boolean;
  intervalMs?:number;
}) {
  async function memoryCurrent(binding:Record<string,unknown>,runId:string):Promise<boolean> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([Promise.resolve().then(()=>options.memoryReady(binding,runId)).catch(()=>false),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),5_000);timer.unref?.();})]);}
    finally{if(timer)clearTimeout(timer);}
  }
  const active = new Map<string,{binding:Record<string,unknown>;runId:string;chatId:string;stop:boolean}>();
  const busy = new Set<string>(), busyOne = new Set<string>(); let stopped = false, timer:ReturnType<typeof setInterval>|null = null;
  const stopRun = (run:{runId:string;stop:boolean}) => { run.stop = true; try { const result=options.runtime.cancel(run.runId); if (result && typeof (result as Promise<unknown>).then === "function") void Promise.resolve(result).catch(()=>undefined); } catch { /* terminal proof remains necessary */ } };
  const removeOwner = options.onOwnershipChanged(() => {
    for (const run of active.values()) {
      let same = false;
      try { same = options.isSameOwner(run.binding); } catch { /* Unknown ownership still requires a stop. */ }
      if (!same) stopRun(run);
    }
  });
  function finish(row:Row, receipt:InvocationRunReceipt | null): boolean {
    if (!terminal(receipt) || receipt.runId !== row.run_id || receipt.chatId !== row.chat_id) return false;
    options.assertOwner();
    const changed = options.db.prepare(`UPDATE one_companion_front_turns SET state='terminal',terminal_receipt_json=?,updated_at=?
      WHERE command_id=? AND run_id=? AND chat_id=? AND state IN ('starting','running','held')`)
      .run(JSON.stringify(receipt),new Date().toISOString(),row.command_id,row.run_id,row.chat_id);
    if (changed.changes === 1) active.delete(row.command_id);
    return changed.changes === 1;
  }
  const removeSettled = options.runtime.onSettled(event => {
    try { const row=options.db.prepare("SELECT * FROM one_companion_front_turns WHERE run_id=? AND chat_id=?").get(event.runId,event.chatId) as Row|undefined;
      if (row) finish(row,event.receipt); } catch { /* Durable receipt is checked on the next owner sweep. */ }
  });
  async function process(row:Row):Promise<void> {
    if (stopped || busy.has(row.command_id) || busyOne.has(row.one_id)) return; busy.add(row.command_id); busyOne.add(row.one_id);
    try {
      options.assertOwner();
      const binding = JSON.parse(row.binding_json) as Record<string,unknown>;
      options.assertBinding(binding);
      if (binding.commandId !== row.command_id || binding.oneId !== row.one_id) throw new Error("companion_front_binding_changed");
      if (finish(row,options.runtime.receipt(row.run_id))) return;
      if ((row.state === "starting" || row.state === "held") && options.runtime.receipt(row.run_id) === null && options.runtime.noStartProof(row.run_id)
          && Date.now() - Date.parse(row.updated_at ?? "") > UNSTARTED_RETRY_AFTER_MS) {
        // Nothing ran (the runtime proves it) and nobody is left to settle this row (a restart, a start that threw): it is stored again, never replayed over a run that may exist.
        const back=options.db.prepare("UPDATE one_companion_front_turns SET state='stored',updated_at=? WHERE command_id=? AND run_id=? AND chat_id=? AND state IN ('starting','held')")
          .run(new Date().toISOString(),row.command_id,row.run_id,row.chat_id);
        if (back.changes !== 1) return;
        active.delete(row.command_id); row.state = "stored";   // and on, in this pass: the turn behind it must not overtake it
      }
      if (row.state === "starting" || row.state === "running" || row.state === "held") {
        const run=active.get(row.command_id);
        if (!run) return; // Restart without native ownership is an unknown, never an automatic replay.
        const status=await Promise.resolve().then(()=>options.lifecycle("status",binding,row.run_id)).catch(()=>null);
        if (stopped || status !== "active") {stopRun(run);return;}
        const memoryStillCurrent=await memoryCurrent(binding,row.run_id);
        let same=false;try{same=options.isSameOwner(binding);}catch{/* Unknown ownership requires a stop. */}
        if (stopped || !memoryStillCurrent || !same) stopRun(run);
        return;
      }
      if (row.state !== "stored" || !options.isSameOwner(binding) || !options.runtime.noStartProof(row.run_id) ||
          !await memoryCurrent(binding,row.run_id) || stopped) return;
      if (options.db.prepare("SELECT 1 FROM one_companion_front_turns WHERE one_id=? AND command_id<>? AND state IN ('starting','running','held') LIMIT 1")
          .get(row.one_id,row.command_id)) return;
      const selections=(await options.candidates()).filter(selection=>selection.kind !== "agentlas"); if (stopped || !selections.length) return;
      options.assertOwner(); options.assertBinding(binding);
      if (!options.isSameOwner(binding) || !options.runtime.noStartProof(row.run_id) || options.runtime.receipt(row.run_id)) return;
      const verdict=await Promise.resolve().then(()=>options.lifecycle("start",binding,row.run_id)).catch(()=>null);
      options.assertOwner(); options.assertBinding(binding);
      if (stopped || (verdict !== "authorized" && verdict !== "existing") || !options.isSameOwner(binding) || !await memoryCurrent(binding,row.run_id) || stopped) return;
      options.assertOwner(); options.assertBinding(binding);
      if (stopped || !options.isSameOwner(binding) || !options.runtime.noStartProof(row.run_id) || options.runtime.receipt(row.run_id)) return;
      const changed=options.db.prepare("UPDATE one_companion_front_turns SET state='starting',host_kind=?,updated_at=? WHERE command_id=? AND run_id=? AND chat_id=? AND state='stored'")
        .run(options.hostKind,new Date().toISOString(),row.command_id,row.run_id,row.chat_id);
      if (changed.changes !== 1) return;
      const run={binding,runId:row.run_id,chatId:row.chat_id,stop:false}; active.set(row.command_id,run);
      // TR-desktop (trust-root.md section 5): a turn the server handed over runs with this computer's own permission setting when that is narrower than "full".
      await pullOwnerChip();const permission=companionWorkPermission("full","conversation");
      const request:McpInvocationRequest={runId:row.run_id,chatId:row.chat_id,userPrompt:row.user_text,oneMode:true,taskIntent:"conversation",
        permissions:permission,onePermissionMode:permission,toolMode:"computer-use",locale:options.locale(),runtimeSelection:selections[0]};
      try {
        const issued=options.runtime.start(request);
        void Promise.resolve(issued).then(started => {
        let same=false;
        try { same=options.isSameOwner(binding); } catch { /* Unknown ownership still requires a stop. */ }
        if (run.stop || !same) stopRun(run);
        if (started.runId !== row.run_id) throw new Error("companion_front_run_mismatch");
        options.assertOwner(); options.assertBinding(binding);
        options.db.prepare("UPDATE one_companion_front_turns SET state='running',updated_at=? WHERE command_id=? AND run_id=? AND state='starting'")
          .run(new Date().toISOString(),row.command_id,row.run_id);
        }).catch(() => {
          try { options.assertOwner(); options.db.prepare("UPDATE one_companion_front_turns SET state='held',updated_at=? WHERE command_id=? AND run_id=? AND state='starting'")
            .run(new Date().toISOString(),row.command_id,row.run_id); } catch { /* Ownership changed; retain the uncertain start. */ }
        });
      } catch {
        options.db.prepare("UPDATE one_companion_front_turns SET state='held',updated_at=? WHERE command_id=? AND run_id=? AND state='starting'")
          .run(new Date().toISOString(),row.command_id,row.run_id);
      }
    } finally { busy.delete(row.command_id); busyOne.delete(row.one_id); }
  }
  async function sweep() {
    if (stopped) return; options.assertOwner();
    const rows=options.db.prepare("SELECT * FROM one_companion_front_turns WHERE state IN ('stored','starting','running','held') ORDER BY rowid LIMIT 50").all() as Row[];
    await Promise.all(rows.map(row=>process(row).catch(()=>undefined)));
  }
  function start() { if (stopped || timer) return; timer=setInterval(()=>{void sweep().catch(()=>undefined)},options.intervalMs ?? 5_000); timer.unref?.(); void sweep().catch(()=>undefined); }
  function close() { stopped=true; if(timer)clearInterval(timer);timer=null;for(const run of active.values())stopRun(run);removeSettled();removeOwner(); }
  return Object.freeze({start,sweep,close});
}
