import { readFileSync } from "node:fs";
import { createHash, createPublicKey } from "node:crypto";
import type Database from "better-sqlite3";
import { getAuthenticatedSessionBinding, getSessionCookieHeader, onAuthSessionOwnershipChanged, webBaseUrl } from "../auth";
import { userDataDir } from "../runtime-paths";
import { MobileBridgePairingManager, mobileBridgeHostIdentityPath } from "../mobile-bridge/pairing";
import { MobileBridgeAccountPairingClient } from "../mobile-bridge/account-pairing";
import { MOBILE_BRIDGE_PROTOCOL_VERSION } from "../../shared/mobile-bridge";
import { captureNativeAuthBinding, loadNativeGuiCredential, signNativeCompanionDirectPoll, signNativeCompanionDirectClaim,
  signNativeCompanionDirectLifecycle, signNativeCompanionDirectLease } from "../daemon/native-auth-credentials";
import { CompanionIntakeRetryAfter, createCompanionDirectIntakeClient } from "./companion-direct-intake-client";
import { createWorkLeaseAuthorityVerifier } from "./companion-work-lease-authority";
import { createAttestedCompanionLeaseVerifier, createCompanionDirectLeaseStore, prepareCompanionDirectLease } from "./companion-direct-lease";
import { createCompanionGuiWorker } from "./companion-gui-worker";
import { loadCompanionWorkKey } from "./companion-work-key";
import { invocationProvenNotStarted } from "../store/invocation-admissions";
import { pullOwnerChip } from "./companion-permission-cap";
import { localHoldsCommand, readDirectHolding } from "./companion-poll-holding";
import { computerMayServe, computerStandingForSweep, directPollPaused, noteComputerGate, noteDirectPollRefused, noteTakeError, startWaitEnded, type ComputerVerdict } from "./companion-computer-gate";

type ChannelIdentity={bootId:string;connection:string;generation:string};
type WorkRow={binding_json:string;run_id:string;phase:"claimed"|"starting"|"running"|"held"};
/** Runs in GUI Main only. A signed native channel and current account are
 * required for every claim and every short-lived daemon lease. */
export function createCompanionGuiRuntime(options:{db:Database.Database;oneId():string;channel():ChannelIdentity|null;
  admit(value:{binding:Record<string,unknown>;payload:string;grant:string}):Promise<unknown>;
  /** TR-desktop 3: closes a taken Work that was never started (supervisor `companion.work.retireUnstarted`, the same local close the executor's "cancel" uses). */
  retireUnstarted?(value:{userId:string;workspaceId:string;oneId:string;commandId:string;runId:string}):Promise<unknown>}) {
  if(process.env.ELECTRON_RUN_AS_NODE==="1")throw new Error("companion_gui_runtime_gui_only");
  const dir=userDataDir(),pairing=new MobileBridgePairingManager(dir),account=new MobileBridgeAccountPairingClient();
  // T1-3: the sweep's own note of a refused poll (see companion-computer-gate.ts directPollPaused): the key of the phone being asked and whether any phone was refused in this look.
  let unregistered=false;const pollKeys=new Map<string,string>();
  let retryAt=0,cache:{scope:string;until:number;credential:Awaited<ReturnType<typeof loadNativeGuiCredential>>;serverKey:NonNullable<Awaited<ReturnType<typeof loadCompanionWorkKey>>>}|null=null;
  function hostId():string|null {
    try{const x:unknown=JSON.parse(readFileSync(mobileBridgeHostIdentityPath(dir),"utf8"));
      if(!x || typeof x!=="object" || Array.isArray(x))return null;const row=x as {version?:unknown;hostId?:unknown;createdAt?:unknown};
      return Object.keys(x).sort().join(",")==="createdAt,hostId,version" && row.version===MOBILE_BRIDGE_PROTOCOL_VERSION &&
        typeof row.hostId==="string" && /^host_[a-f0-9]{32}$/.test(row.hostId) && typeof row.createdAt==="string" && Number.isFinite(Date.parse(row.createdAt)) ? row.hostId : null;
    }catch{return null;}
  }
  function context() {
    const session=getAuthenticatedSessionBinding();if(!session || !getSessionCookieHeader())return null;
    const channel=options.channel(),host=hostId(),one=options.oneId();
    if(!channel || !host || !one)return null;
    const scope=createHash("sha256").update(JSON.stringify(["companion.gui.scope.v1",session.userId,session.workspaceId,session.sessionId,host,one,channel.bootId,channel.connection,channel.generation])).digest("hex");
    return {session,channel,host,one,scope};
  }
  function guard(scope:string) {const current=context();if(!current || current.scope!==scope)throw new Error("companion_gui_scope_changed");return current;}
  function row(commandId:string):WorkRow|null {
    return options.db.prepare(`SELECT h.binding_json,q.run_id,q.phase FROM one_companion_handoffs h JOIN one_supervisor_work_jobs q ON q.command_id=h.command_id
      WHERE h.command_id=? AND q.phase IN ('claimed','starting','running','held')`).get(commandId) as WorkRow|undefined ?? null;
  }
  function target(scope:string,commandId:string,runId:string) {
    const current=guard(scope),work=row(commandId);if(!work || work.run_id!==runId)return null;
    const binding=JSON.parse(work.binding_json) as Record<string,unknown>;
    if(typeof binding.deviceId!=="string" || binding.commandId!==commandId || binding.userId!==current.session.userId ||
      binding.workspaceId!==current.session.workspaceId || binding.hostId!==current.host || binding.oneId!==current.one)return null;
    const device=pairing.deviceAccountBinding(binding.deviceId);
    if(!device || device.ownerUserId!==current.session.userId || device.workspaceId!==current.session.workspaceId ||
      device.accountSubject!==binding.accountSubject || device.accountAuthorityOrigin!==account.origin)return null;
    return {binding,work,device,current};
  }
  async function credentials(scope:string) {
    guard(scope);if(cache && cache.scope===scope && cache.until>Date.now())return cache;
    const [credential,serverKey]=await Promise.all([loadNativeGuiCredential(captureNativeAuthBinding()),loadCompanionWorkKey()]);guard(scope);
    if(!serverKey)throw new Error("companion_gui_key_unavailable");
    cache={scope,until:Date.now()+60_000,credential,serverKey};return cache;
  }
  function client(scope:string,credential:Awaited<ReturnType<typeof loadNativeGuiCredential>>,mayTake?:(deviceId:string)=>boolean) {
    return createCompanionDirectIntakeClient({webOrigin:webBaseUrl(),cookie:getSessionCookieHeader,assertCurrent:()=>{guard(scope)},
      ...(mayTake?{mayTake}:{}),holding:target=>readDirectHolding(options.db,target),held:id=>localHoldsCommand(options.db,"direct",id),   // R5/R8: read from the durable store on every poll
      onPollRefused:deviceId=>{unregistered=true;const key=pollKeys.get(deviceId);if(key)noteDirectPollRefused(key);},
      signPoll:v=>signNativeCompanionDirectPoll(credential,v),signClaim:(b,c)=>signNativeCompanionDirectClaim(credential,b,c),
      signLifecycle:(kind,b,c,run)=>signNativeCompanionDirectLifecycle(credential,kind,b,c,run)});
  }
  const leaseStore=createCompanionDirectLeaseStore({db:options.db,assertScope:scope=>{guard(scope)},verify:(lease,signature,token)=>{
    if(!cache || !lease || typeof lease!=="object")return false;
    const item=lease as {binding?:{commandId?:unknown};runId?:unknown};if(typeof item.binding?.commandId!=="string" || typeof item.runId!=="string")return false;
    const scope=cache.scope,found=target(scope,item.binding.commandId,item.runId);if(!found)return false;
    const guiPublicKey=createPublicKey(cache.credential.publicKey);
    return createAttestedCompanionLeaseVerifier({guiPublicKey,serverPublicKey:cache.serverKey,assertCurrent:()=>{guard(scope)},
      target:()=>{const live=target(scope,item.binding!.commandId as string,item.runId as string);return live ? {binding:live.binding,runId:live.work.run_id,daemonBootId:live.current.channel.bootId,scopeKey:scope}:null;}})(lease,signature,token);
  }});
  const worker=createCompanionGuiWorker({scope:()=>context()?.scope ?? null,assertCurrent:scope=>{guard(scope)},onOwnershipChanged:onAuthSessionOwnershipChanged,
    poll:async scope=>{
      if(Date.now()<retryAt)return null;
      const current=guard(scope);
      // TR-desktop (trust-root.md E1 1-2): not the confirmed home = no key loaded and no request; a phone whose pairing may not vouch is skipped the same way.
      const standing=computerStandingForSweep(current.host);if(!standing.ok){noteComputerGate("take",standing);return null;}
      const keys=await credentials(scope);let served=false,refusal:ComputerVerdict|null=null;unregistered=false;
      for(const item of pairing.listDevices().filter(device=>device.revokedAt===null)){
        guard(scope);const bound=pairing.deviceAccountBinding(item.deviceId);
        if(!bound || bound.ownerUserId!==current.session.userId || bound.workspaceId!==current.session.workspaceId || bound.accountAuthorityOrigin!==account.origin)continue;
        const may=computerMayServe(item.deviceId,current.host);if(!may.ok){refusal??=may;continue;}
        // T1-3: a phone the service refused (403: this computer is not registered for it) is not asked again until a signal or one window (companion-computer-gate.ts directPollPaused).
        const pollKey=`${item.deviceId}|${bound.issuedAt}|${current.session.sessionId}|${current.host}|${current.one}`;
        if(directPollPaused(pollKey)){refusal??={ok:false,why:"not_registered"};continue;}served=true;pollKeys.set(item.deviceId,pollKey);
        try{const payload=await client(scope,keys.credential,id=>id===item.deviceId).receive({userId:current.session.userId,deviceId:item.deviceId,hostId:current.host,oneId:current.one},
          b=>b.userId===current.session.userId && b.workspaceId===current.session.workspaceId && b.accountSubject===bound.accountSubject && b.deviceId===item.deviceId && b.hostId===current.host && b.oneId===current.one);
          guard(scope);const latest=pairing.deviceAccountBinding(item.deviceId);
          if(!latest || latest.issuedAt!==bound.issuedAt || latest.accountSubject!==bound.accountSubject || latest.accountAuthorityOrigin!==bound.accountAuthorityOrigin)continue;
          if(payload)return payload;
        }catch(error){if(error instanceof CompanionIntakeRetryAfter)retryAt=Math.max(retryAt,Date.now()+error.retryAfterMs);else noteTakeError("take",error);return null;}
      }noteComputerGate("take",unregistered?{ok:false,why:"not_registered"}:served||!refusal?{ok:true}:refusal);return null;
    },
    admit:async(scope,value)=>{guard(scope);await options.admit(value as {binding:Record<string,unknown>;payload:string;grant:string});guard(scope);},
    pending:async scope=>{const current=guard(scope);if(!options.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_companion_handoffs'").get())return [];
      const rows=options.db.prepare(`SELECT h.command_id,q.run_id,q.phase FROM one_companion_handoffs h JOIN one_supervisor_work_jobs q ON q.command_id=h.command_id
        WHERE q.one_id=? AND q.phase IN ('claimed','starting','running','held') ORDER BY q.updated_at LIMIT 100`).all(current.one) as Array<{command_id:string;run_id:string;phase:WorkRow["phase"]}>;
      return rows.filter(x=>!!target(scope,x.command_id,x.run_id)).map(x=>({commandId:x.command_id,runId:x.run_id,phase:x.phase}));},
    authorize:async(scope,commandId,runId,phase)=>{
      if(Date.now()<retryAt)return null;const found=target(scope,commandId,runId);if(!found)return null;const keys=await credentials(scope),api=client(scope,keys.credential);
      try{
        const ensurePair=()=>{const live=target(scope,commandId,runId);if(!live || live.device.issuedAt!==found.device.issuedAt ||
          live.device.accountSubject!==found.device.accountSubject || live.device.accountAuthorityOrigin!==found.device.accountAuthorityOrigin)throw new Error("companion_gui_device_changed");};
        ensurePair();
        if(phase==="claimed") {
          // TR-desktop (trust-root.md E1): a taken Work starts only while this computer is the confirmed home and the pairing may vouch (null = waited out, not cancelled).
          const may=computerMayServe(found.binding.deviceId,found.current.host);noteComputerGate("start",may);
          if(!may.ok){
            // The wait has the same end as the direct road (companion-computer-gate.ts startWaitEnded: a day after it was stored): the unstarted Work is closed locally.
            const row=options.db.prepare("SELECT created_at FROM one_supervisor_requests WHERE command_id=?").get(commandId) as {created_at?:string}|undefined;
            if(options.retireUnstarted && startWaitEnded(may,row?.created_at)){
              try{await options.retireUnstarted({userId:found.current.session.userId,workspaceId:found.current.session.workspaceId,oneId:found.current.one,commandId,runId});}catch{/* tried again at the next look */}
            }
            return null;
          }
          if(found.work.phase!=="claimed" || invocationProvenNotStarted(runId)!==true)return null;
          // Desktop E2E-1: THIS process is the only one that can read the owner window's permission chip (the background service that will run the Work has no window and reads the last copy in `meta`). A chip changed while the window stays open
          // is copied at the window's load / close and before a Main-run start - and a Work the service runs never passes that last place, so it ran with the chip of the last load. The copy is refreshed here, just before the start is asked
          // for (the same read, its own 5 s limit, one `meta` row only when the value changed); the service reads the row when it starts.
          await pullOwnerChip();
          const start=await api.lifecycle("start",found.binding,runId);ensurePair();
          if(start!=="authorized" && start!=="existing")return null;
          const after=target(scope,commandId,runId);
          if(!after || after.work.phase!=="claimed" || invocationProvenNotStarted(runId)!==true)return null;
        }
        const response=await api.leaseAuthority(found.binding,runId);ensurePair();if(!response)return null;
        const fingerprint=createHash("sha256").update(createPublicKey(keys.credential.publicKey).export({type:"spki",format:"der"})).digest("hex");
        const verify=createWorkLeaseAuthorityVerifier({publicKey:keys.serverKey,assertCurrent:ensurePair,target:()=>{
          const live=target(scope,commandId,runId);return live ? {binding:live.binding,runId,deviceKeyFingerprint:fingerprint,executeChallenge:response.executeChallenge}:null;}});
        return verify(response.token);
      }catch(error){if(error instanceof CompanionIntakeRetryAfter)retryAt=Math.max(retryAt,Date.now()+error.retryAfterMs);return null;}
    },
    issue:async(scope,commandId,runId,authority)=>{const keys=await credentials(scope),found=target(scope,commandId,runId);if(!found)throw new Error("companion_gui_scope_changed");
      const permit=prepareCompanionDirectLease(authority,{daemonBootId:()=>guard(scope).channel.bootId,scopeKey:()=>guard(scope).scope,assertCurrent:()=>{guard(scope)}});
      if(!permit)throw new Error("companion_gui_authority_changed");const signed=signNativeCompanionDirectLease(keys.credential,permit);
      leaseStore.put(scope,signed.lease,signed.signature,signed.authorityToken);},
    revoke:(scope,commandId)=>{leaseStore.revoke(scope,commandId);if(!commandId)cache=null;}});
  return worker;
}
