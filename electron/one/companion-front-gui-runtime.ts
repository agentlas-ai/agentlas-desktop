import {readFileSync} from "node:fs";
import {createHash,createPublicKey} from "node:crypto";
import type Database from "better-sqlite3";
import {getAuthenticatedSessionBinding,getSessionCookieHeader,onAuthSessionOwnershipChanged,webBaseUrl} from "../auth";
import {userDataDir} from "../runtime-paths";
import {MobileBridgePairingManager,mobileBridgeHostIdentityPath} from "../mobile-bridge/pairing";
import {MobileBridgeAccountPairingClient} from "../mobile-bridge/account-pairing";
import {MOBILE_BRIDGE_PROTOCOL_VERSION} from "../../shared/mobile-bridge";
import {captureNativeAuthBinding,loadNativeGuiCredential,signNativeCompanionFrontPoll,signNativeCompanionFrontClaim,
  signNativeCompanionFrontLifecycle,signNativeCompanionFrontTurnAuthority,signNativeCompanionFrontReceipt,signNativeCompanionFrontRetirement,signNativeCompanionFrontFullChunk} from "../daemon/native-auth-credentials";
import {invocationService} from "../invocation/service";
import {invocationProvenNotStarted} from "../store/invocation-admissions";
import {peekOneProfile} from "../store/one-profile";
import {createChat} from "../store/chats";
import {detectRuntimes} from "../runtime/detect";
import {createCompanionFrontAdmissionVerifier} from "./companion-front-admission";
import {createCompanionFrontInbox} from "./companion-front-inbox";
import {createCompanionFrontExecutor} from "./companion-front-executor";
import {createCompanionFrontIntakeClient} from "./companion-front-intake-client";
import {createCompanionFrontTurnAuthority} from "./companion-front-turn-authority";
import {readStoredCompanionFrontContext} from "./companion-front-context";
import {companionFrontOwnLane} from "./companion-front-runtime";
import {createCompanionFrontReceiptOwner} from "./companion-front-receipt";
import {createCompanionFrontRetirementOwner} from "./companion-front-retirement";
import {loadCompanionWorkKey} from "./companion-work-key";
import {CompanionIntakeRetryAfter} from "./companion-direct-intake-client";
import {createDeliveryWaits} from "./companion-work-delivery";
import {localHoldsCommand,readFrontHolding} from "./companion-poll-holding";
import {installCompanionDeliverySignalSources,onCompanionDeliverySignal} from "./companion-delivery-signals";
import {computerMayServe,computerStandingForSweep,noteComputerGate,dropEndedFrontTurn,type ComputerVerdict} from "./companion-computer-gate";

type Row={command_id:string;chat_id:string;run_id:string;binding_json:string;state:string;created_at:string};
/** GUI-hosted front lane. It only starts after signed admission and a fresh
 * server authority; a dropped login, device or status stops active work. */
export function createCompanionFrontGuiRuntime(options:{db:Database.Database;locale():"ko"|"en"}) {
  if(process.env.ELECTRON_RUN_AS_NODE==="1")throw new Error("companion_front_gui_only");
  const {db}=options,dir=userDataDir(),pairing=new MobileBridgePairingManager(dir),account=new MobileBridgeAccountPairingClient();
  let stopped=false,timer:ReturnType<typeof setInterval>|null=null,busy=false,retryAt=0,scopeWorker:{key:string;stop():void;sweep():Promise<void>}|null=null;
  function hostId():string|null {try{const x:unknown=JSON.parse(readFileSync(mobileBridgeHostIdentityPath(dir),"utf8"));
    if(!x||typeof x!=="object"||Array.isArray(x))return null;const r=x as {version?:unknown;hostId?:unknown;createdAt?:unknown};
    return Object.keys(x).sort().join(",")==="createdAt,hostId,version"&&r.version===MOBILE_BRIDGE_PROTOCOL_VERSION&&typeof r.hostId==="string"&&/^host_[a-f0-9]{32}$/.test(r.hostId)&&typeof r.createdAt==="string"&&Number.isFinite(Date.parse(r.createdAt))?r.hostId:null;
  }catch{return null;}}
  function scope(){const actor=getAuthenticatedSessionBinding(),profile=peekOneProfile(),host=hostId();
    if(!actor||!getSessionCookieHeader()||!host||profile.state!=="present"||profile.userId!==actor.userId||profile.workspaceId!==actor.workspaceId)return null;
    return {actor,host,oneId:profile.oneId,key:JSON.stringify([actor.userId,actor.workspaceId,actor.sessionId,host,profile.oneId])};}
  function guard(key:string){const value=scope();if(!value||value.key!==key||stopped)throw new Error("companion_front_owner_changed");return value;}
  function identity(key:string,b:Record<string,unknown>){const owner=guard(key);if(typeof b.deviceId!=="string")return null;
    const device=pairing.listDevices().find(x=>x.deviceId===b.deviceId&&x.revokedAt===null),paired=device&&pairing.deviceAccountBinding(b.deviceId);
    if(!paired||paired.ownerUserId!==owner.actor.userId||paired.workspaceId!==owner.actor.workspaceId||paired.accountAuthorityOrigin!==account.origin||
      b.userId!==owner.actor.userId||b.workspaceId!==owner.actor.workspaceId||b.hostId!==owner.host||b.oneId!==owner.oneId||b.accountSubject!==paired.accountSubject||
      !Number.isSafeInteger(b.authEpoch))return null;
    return {userId:owner.actor.userId,workspaceId:owner.actor.workspaceId,authEpoch:Number(b.authEpoch),accountSubject:paired.accountSubject,
      deviceId:b.deviceId,hostId:owner.host,oneId:owner.oneId,issuedAt:paired.issuedAt};}
  async function make(key:string) {
    const [credential,serverKey]=await Promise.all([loadNativeGuiCredential(captureNativeAuthBinding()),loadCompanionWorkKey()]);guard(key);if(!serverKey)throw new Error("companion_front_server_key_unavailable"); const trustedServerKey=serverKey;
    const guiPublic=createPublicKey(credential.publicKey),fingerprint=createHash("sha256").update(guiPublic.export({type:"spki",format:"der"})).digest("hex");
    let takeFor:string|null=null;
    const api=createCompanionFrontIntakeClient({webOrigin:webBaseUrl(),cookie:getSessionCookieHeader,assertCurrent:()=>{guard(key)},
      holding:target=>readFrontHolding(db,target),held:id=>localHoldsCommand(db,"front",id),   // R5/R8: read from the durable store on every poll
      mayTake:id=>id===takeFor,   // the phone the sweep just asked about (computerMayServe above), not read again
      signPoll:v=>signNativeCompanionFrontPoll(credential,v),signClaim:(b,c)=>signNativeCompanionFrontClaim(credential,b,c),
      signLifecycle:(kind,b,c,run)=>signNativeCompanionFrontLifecycle(credential,kind,b,c,run),signTurnAuthority:permit=>signNativeCompanionFrontTurnAuthority(credential,permit)});
    const assertBinding=(b:Record<string,unknown>)=>{if(!identity(key,b))throw new Error("companion_front_device_changed")};
    const inbox=createCompanionFrontInbox({db,assertOwner:()=>{guard(key)},createConversation:()=>createChat({originSurface:"one",kind:"division",taskMode:"conversation"}).id});
    db.exec(`CREATE TABLE IF NOT EXISTS one_companion_front_delivery_acks(command_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,acked_at TEXT NOT NULL)`);
    const ready=createCompanionFrontTurnAuthority({publicKey:trustedServerKey,assertOwner:()=>{guard(key)},observe:(b,runId)=>{
      const found=identity(key,b);if(!found)return null;const row=db.prepare("SELECT chat_id,binding_json FROM one_companion_front_turns WHERE command_id=? AND run_id=?").get(b.commandId,runId) as {chat_id:string;binding_json:string}|undefined;
      if(!row||row.binding_json!==JSON.stringify(b))return null;const context=readStoredCompanionFrontContext(db,runId,row.chat_id);if(!context)return null;
      return {context,deviceKeyFingerprint:fingerprint,assertCurrent(){const latest=identity(key,b);if(!latest||latest.issuedAt!==found.issuedAt)throw new Error("companion_front_pair_changed");}};
    },attest:request=>api.turnAuthority(request)});
    const executor=createCompanionFrontExecutor({db,assertOwner:()=>{guard(key)},assertBinding,memoryReady:ready,
      // TR-desktop (trust-root.md E1): a taken front turn starts only while this computer is the confirmed home and the pairing may vouch (null = waited out, not cancelled).
      lifecycle:(purpose,b,run)=>{if(purpose==="start"){const may=computerMayServe(b.deviceId,hostId());noteComputerGate("start",may);
        if(!may.ok){
          // Same end as the direct road (startWaitEnded: a day after it was stored): the front turn that never started is dropped, and only when the runtime proves nothing ran.
          dropEndedFrontTurn(db,String(b.commandId),run,may,invocationProvenNotStarted);
          return Promise.resolve(null);
        }}return api.lifecycle(purpose,b,run);},
      candidates:async()=>companionFrontOwnLane(await detectRuntimes()),locale:options.locale,hostKind:"desktop-main",
      runtime:{start:request=>invocationService.start(request),cancel:run=>invocationService.cancel(run),receipt:run=>invocationService.receipt(run),noStartProof:invocationProvenNotStarted,
        onSettled:listener=>invocationService.onSettled(listener)},onOwnershipChanged:onAuthSessionOwnershipChanged,isSameOwner:b=>!!identity(key,b)});
    const retire=createCompanionFrontRetirementOwner({db,assertOwner:()=>{guard(key)},assertBinding,noStartProof:invocationProvenNotStarted,receipt:run=>invocationService.receipt(run)});
    /** direct-work-capacity R8: the end of one delivery attempt. ok = the server has it or has nothing more to ask (a confirmation row is written); closed = HTTP 403, the
     * bytes cannot be verified, ever (a confirmation row and one log line; the result stays in the local conversation); retry = not taken (a per-row interval:
     * 60 s or Retry-After, doubled by each failure, never past a day; a signal starts again); idle = nothing was asked of the server. */
    type Outcome={kind:"ok"}|{kind:"closed"}|{kind:"retry";afterMs?:number}|{kind:"idle"};
    const IDLE:Outcome={kind:"idle"};
    async function deliver(row:Row):Promise<Outcome> {
      const b=JSON.parse(row.binding_json) as Record<string,unknown>,id=identity(key,b);if(!id)return IDLE;
      if(db.prepare("SELECT 1 FROM one_companion_front_delivery_acks WHERE command_id=? AND run_id=?").get(row.command_id,row.run_id))return {kind:"ok"};
      const assertPair=()=>{const live=identity(key,b);if(!live||live.issuedAt!==id.issuedAt)throw new Error("companion_front_pair_changed")};
      let reply:{kind:"ok";status:string}|{kind:"closed"}|{kind:"retry";afterMs?:number}|null=null,asked=false;
      const hasRetirement=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_companion_front_retirements'").get();
      const retirement=hasRetirement?db.prepare("SELECT proof FROM one_companion_front_retirements WHERE command_id=? AND run_id=?").get(row.command_id,row.run_id) as {proof?:string}|undefined:undefined;
      if(retirement?.proof==="not_started"||retirement?.proof==="interrupted"){
        const permit=retire(row.command_id,row.run_id,retirement.proof);if(!permit)return IDLE;
        reply=await api.submitRetirement(b,row.run_id,retirement.proof,signNativeCompanionFrontRetirement(credential,permit));
      } else if (["cancelled","interrupted"].includes(invocationService.receipt(row.run_id)?.status ?? "") && (asked=true,await api.retirement(b,row.run_id))) {
        // A confirmed remote cancellation is not itself a termination proof.
        // The owner checks the exact run's persisted terminal event before a
        // body-free retirement can be signed and retried.
        assertPair();const permit=retire(row.command_id,row.run_id,"interrupted");if(!permit)return {kind:"retry"};
        reply=await api.submitRetirement(b,row.run_id,"interrupted",signNativeCompanionFrontRetirement(credential,permit));
      } else {
        const owner=createCompanionFrontReceiptOwner({db,publicKey:guiPublic,identity:()=>identity(key,b),assertCurrent:assertPair,
          nativeReceipt:run=>invocationService.receipt(run),sign:permit=>signNativeCompanionFrontReceipt(credential,permit),signChunk:permit=>signNativeCompanionFrontFullChunk(credential,permit)});
        const result=owner.read(row.command_id);if(!result)return asked?{kind:"retry"}:IDLE;
        reply=await api.submitReceipt(result.receipt,result.signature);
        if(reply.kind==="ok" && reply.status!=="settled" && result.receipt.fullResultPending===true){
          const count=Number(result.receipt.fullCount);if(!Number.isSafeInteger(count)||count<1)return {kind:"retry"};
          let completed=false;for(let index=0;index<count;index++){assertPair();const part=owner.readFullChunk(row.command_id,index);if(!part)return {kind:"retry"};
            const sent=await api.submitFullChunk(part.chunk,part.signature);
            if(sent.kind==="retry")return sent;
            if(sent.kind==="closed"){completed=true;reply={kind:"closed"};break;}   // 403 on a chunk: the rest cannot be taken either
            if(sent.status==="complete"||sent.status==="settled"){completed=true;break;}}
          if(!completed)return {kind:"retry"};
        }
      }
      assertPair();
      if(reply.kind==="retry")return reply;
      if(reply.kind==="closed")console.warn(`[companion-delivery] front receipt not deliverable (HTTP 403): command ${row.command_id} - the result stays in the local conversation, nothing is sent again`);
      db.prepare("INSERT OR IGNORE INTO one_companion_front_delivery_acks(command_id,run_id,acked_at) VALUES(?,?,?)").run(row.command_id,row.run_id,new Date().toISOString());
      return reply.kind==="closed"?{kind:"closed"}:{kind:"ok"};
    }
    // The rows this process tried and the server did not take, each with its own interval (memory; bounded by the unacknowledged terminal rows, 100 at most).
    const waits=createDeliveryWaits(()=>Date.now());
    const offSignals=[installCompanionDeliverySignalSources(),onCompanionDeliverySignal(()=>{waits.clear();void sweepNow();})];
    let running=false,closed=false;
    async function sweep(){if(closed||running||Date.now()<retryAt)return;running=true;try{
      const current=guard(key);
      // TR-desktop (trust-root.md E1 1-2): not the confirmed home = no request for new turns (the executor below still finishes and delivers what was already taken);
      // a phone whose pairing may not vouch is skipped the same way.
      const standing=computerStandingForSweep(current.host);let served=false,refusal:ComputerVerdict|null=standing.ok?null:standing;
      if(standing.ok)for(const device of pairing.listDevices().filter(x=>x.revokedAt===null)){
        const paired=pairing.deviceAccountBinding(device.deviceId);if(!paired||paired.ownerUserId!==current.actor.userId||paired.workspaceId!==current.actor.workspaceId||paired.accountAuthorityOrigin!==account.origin)continue;
        const may=computerMayServe(device.deviceId,current.host);if(!may.ok){refusal??=may;continue;}served=true;
        takeFor=device.deviceId;let found;try{found=await api.receive({userId:current.actor.userId,deviceId:device.deviceId,hostId:current.host,oneId:current.oneId},b=>!!identity(key,b));}finally{takeFor=null;}guard(key);
        if(found){const verifier=createCompanionFrontAdmissionVerifier({publicKey:trustedServerKey,identity:()=>identity(key,found.binding),assertCurrent:()=>assertBinding(found.binding)});
          const capability=verifier(found);if(capability)inbox.admit(capability);}
      }
      noteComputerGate("take",served||!refusal?{ok:true}:refusal);
      await executor.sweep();guard(key);
      const rows=db.prepare("SELECT command_id,chat_id,run_id,binding_json,state,created_at FROM one_companion_front_turns WHERE one_id=? AND state IN ('stored','terminal') ORDER BY rowid LIMIT 100").all(current.oneId) as Row[];
      for(const row of rows){if(row.state==='stored' && Date.now()-Date.parse(row.created_at)>60_000 && invocationProvenNotStarted(row.run_id))retire(row.command_id,row.run_id,'not_started');
        const currentRow=db.prepare("SELECT command_id,chat_id,run_id,binding_json,state,created_at FROM one_companion_front_turns WHERE command_id=?").get(row.command_id) as Row|undefined;
        if(currentRow?.state==='terminal'){
          if(!waits.due(currentRow.command_id))continue;
          const out=await deliver(currentRow);
          if(out.kind==='retry')waits.retry(currentRow.command_id,out.afterMs);else if(out.kind!=='idle')waits.done(currentRow.command_id);}}
    }catch(error){if(error instanceof CompanionIntakeRetryAfter)retryAt=Math.max(retryAt,Date.now()+error.retryAfterMs);}finally{running=false;}}
    executor.start();
    function sweepNow(){return sweep();}
    return {key,sweep,stop(){closed=true;for(const off of offSignals.splice(0))off();executor.close();}};
  }
  async function sweep(){if(stopped||busy)return;busy=true;try{const owner=scope();if(!owner){scopeWorker?.stop();scopeWorker=null;return;}
    if(scopeWorker?.key!==owner.key){scopeWorker?.stop();scopeWorker=null;const created=await make(owner.key);try{guard(owner.key);scopeWorker=created;}catch(error){created.stop();throw error;}}await scopeWorker.sweep();
  }catch{/* Remain inactive until account, pair, server and signing key recover. */}finally{busy=false;}}
  const off=onAuthSessionOwnershipChanged(()=>{scopeWorker?.stop();scopeWorker=null;});
  function start(){if(stopped||timer)return;timer=setInterval(()=>{void sweep()},5000);timer.unref?.();void sweep();}
  function stop(){stopped=true;if(timer)clearInterval(timer);timer=null;scopeWorker?.stop();scopeWorker=null;off();}
  return Object.freeze({start,stop,sweep});
}
