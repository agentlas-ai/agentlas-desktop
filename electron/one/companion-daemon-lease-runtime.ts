import { readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import type Database from "better-sqlite3";
import { getAuthenticatedSessionBinding } from "../auth";
import { userDataDir } from "../runtime-paths";
import { MobileBridgePairingManager, mobileBridgeHostIdentityPath } from "../mobile-bridge/pairing";
import { MobileBridgeAccountPairingClient } from "../mobile-bridge/account-pairing";
import { MOBILE_BRIDGE_PROTOCOL_VERSION } from "../../shared/mobile-bridge";
import { captureNativeAuthBinding, loadNativeDaemonCredential } from "../daemon/native-auth-credentials";
import { createAttestedCompanionLeaseVerifier } from "./companion-direct-lease";
import { loadCompanionWorkKey } from "./companion-work-key";

/** Daemon accepts only the GUI's short-lived, server-attested lease for this
 * account, native boot and exact run. The GUI private credential is never read. */
export function createCompanionDaemonLeaseRuntime(options:{db:Database.Database;oneId():string;bootId:string;assertOwner():void;noStartProof(runId:string):boolean}) {
  const dir=userDataDir(),pairing=new MobileBridgePairingManager(dir),account=new MobileBridgeAccountPairingClient();
  function hostId():string|null {try{const row:unknown=JSON.parse(readFileSync(mobileBridgeHostIdentityPath(dir),"utf8"));
    if(!row || typeof row!=="object" || Array.isArray(row))return null;const v=row as {version?:unknown;hostId?:unknown;createdAt?:unknown};
    return Object.keys(row).sort().join(",")==="createdAt,hostId,version" && v.version===MOBILE_BRIDGE_PROTOCOL_VERSION &&
      typeof v.hostId==="string" && /^host_[a-f0-9]{32}$/.test(v.hostId) && typeof v.createdAt==="string" && Number.isFinite(Date.parse(v.createdAt)) ? v.hostId:null;
  }catch{return null;}}
  async function lifecycle(purpose:"start"|"status",binding:Record<string,unknown>,runId:string):Promise<string|null> {
    try {
      options.assertOwner();const session=getAuthenticatedSessionBinding(),host=hostId(),one=options.oneId();
      if(!session || !host || !one || typeof binding.deviceId!=="string" || typeof binding.commandId!=="string" || binding.userId!==session.userId ||
        binding.workspaceId!==session.workspaceId || binding.hostId!==host || binding.oneId!==one)return null;
      const device=pairing.deviceAccountBinding(binding.deviceId);if(!device || device.ownerUserId!==session.userId || device.workspaceId!==session.workspaceId ||
        device.accountSubject!==binding.accountSubject || device.accountAuthorityOrigin!==account.origin)return null;
      const commandId=binding.commandId,deviceId=binding.deviceId;
      const guard=()=>{options.assertOwner();const actor=getAuthenticatedSessionBinding(),pair=pairing.deviceAccountBinding(deviceId);
        if(!actor || actor.sessionId!==session.sessionId || actor.userId!==session.userId || actor.workspaceId!==session.workspaceId ||
          !pair || pair.issuedAt!==device.issuedAt || pair.ownerUserId!==session.userId || pair.workspaceId!==session.workspaceId ||
          pair.accountSubject!==device.accountSubject || pair.accountAuthorityOrigin!==device.accountAuthorityOrigin || hostId()!==host || options.oneId()!==one)
          throw new Error("companion_daemon_scope_changed");
        const row=options.db.prepare(`SELECT h.binding_json,q.run_id,q.phase,r.state FROM one_companion_handoffs h
          JOIN one_supervisor_work_jobs q ON q.command_id=h.command_id JOIN one_supervisor_requests r ON r.command_id=h.command_id WHERE h.command_id=?`).get(commandId) as
          {binding_json:string;run_id:string;phase:string;state:string}|undefined;
        if(!row || row.run_id!==runId || JSON.stringify(JSON.parse(row.binding_json))!==JSON.stringify(binding) ||
          (purpose==="start" ? row.phase!=="claimed" || row.state!=="stored" || !options.noStartProof(runId) : !["starting","running","held"].includes(row.phase)))
          throw new Error("companion_daemon_run_changed");
      };
      guard();const [credential,serverKey]=await Promise.all([loadNativeDaemonCredential(captureNativeAuthBinding()),loadCompanionWorkKey()]);guard();
      if(!serverKey)return null;const guiPublicKey=createPublicKey(credential.peerPublicKey),deadline=Date.now()+(purpose==="start" ? 8000:0);
      do {
        guard();const row=options.db.prepare("SELECT scope_key,lease_json,signature,authority_token,expires_at FROM one_companion_direct_leases WHERE command_id=? AND run_id=?").get(commandId,runId) as
          {scope_key:string;lease_json:string;signature:string;authority_token:string;expires_at:number}|undefined;
        if(row && row.expires_at>Date.now()){
          const scope=row.scope_key,verify=createAttestedCompanionLeaseVerifier({guiPublicKey,serverPublicKey:serverKey,assertCurrent:guard,
            target:()=>({binding,runId,daemonBootId:options.bootId,scopeKey:scope})});
          if(verify(JSON.parse(row.lease_json),row.signature,row.authority_token)){guard();return purpose==="start"?"authorized":"active";}
        }
        if(purpose!=="start" || Date.now()>=deadline)return null;
        await new Promise<void>(resolve=>setTimeout(resolve,200));
      }while(true);
    }catch{return null;}
  }
  return Object.freeze({lifecycle});
}
