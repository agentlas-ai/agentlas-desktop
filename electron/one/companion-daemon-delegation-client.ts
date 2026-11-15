import {createHash} from "node:crypto";
import {isIP} from "node:net";
import {isBlockedAddress} from "../net/public-address-guard";
import {companionDaemonDelegationBytes,type CompanionDaemonDelegation} from "../../shared/companion-daemon-delegation";

type Target=Pick<CompanionDaemonDelegation,"userId"|"workspaceId"|"authEpoch"|"accountSubject"|"familyId"|"deviceId"|"deviceGeneration"|"sessionGeneration"|"hostId"|"oneId">;
const targetFields=["userId","workspaceId","authEpoch","accountSubject","familyId","deviceId","deviceGeneration","sessionGeneration","hostId","oneId"] as const;
const signature=(x:unknown):x is string=>typeof x==="string"&&/^[A-Za-z0-9_-]{86}$/.test(x)&&Buffer.from(x,"base64url").toString("base64url")===x;
const exact=(x:Record<string,unknown>,fields:string[])=>Object.keys(x).sort().join(",")===[...fields].sort().join(",");
const sync=(fn:()=>void)=>{const result=fn() as unknown;if(result!==undefined){if(result&&typeof(result as {then?:unknown}).then==="function")void Promise.resolve(result).catch(()=>{});throw Error("daemon_owner_not_synchronous");}};
function validTarget(target:Target):boolean {
  if(!target||typeof target!=="object"||Array.isArray(target)||!exact(target as unknown as Record<string,unknown>,[...targetFields]))return false;
  return [target.userId,target.workspaceId,target.accountSubject,target.familyId,target.hostId,target.oneId].every(v=>typeof v==="string"&&/^[A-Za-z0-9_.:@-]{1,128}$/.test(v))&&
    typeof target.deviceId==="string"&&/^[A-Za-z0-9_-]{8,96}$/.test(target.deviceId)&&Number.isSafeInteger(target.authEpoch)&&target.authEpoch>=0&&
    Number.isSafeInteger(target.deviceGeneration)&&target.deviceGeneration>=1&&Number.isSafeInteger(target.sessionGeneration)&&target.sessionGeneration>=0&&target.sessionGeneration<Number.MAX_SAFE_INTEGER;
}
/** Transport only: signatures come from purpose-scoped, locally authorized
 * signers; verifying a Main attestation is not the user's approval. */
export function createCompanionDaemonDelegationClient(options:{webOrigin:string;cookie():string|null;assertCurrent():void;assertRetirement():void;
  verifyAttestation(token:string,binding:CompanionDaemonDelegation):boolean;fetchImpl?:typeof fetch;allowLoopback?:boolean;now?:()=>number}) {
  const web=(()=>{try{const u=new URL(options.webOrigin),host=u.hostname.toLowerCase().replace(/^\[|\]$/g,""),loop=["localhost","127.0.0.1","::1"].includes(host),ip=isIP(host);
    const test=options.allowLoopback===true&&process.env.AGENTLAS_E2E==="1"&&loop;
    if(u.username||u.password||u.pathname!=="/"||u.search||u.hash||(u.protocol!=="https:"&&!(test&&u.protocol==="http:"))||
      (!test&&(loop||host.endsWith(".localhost")||host.endsWith(".local")||host.endsWith(".internal")||(!ip&&!host.includes("."))||(ip!==0&&isBlockedAddress(host,ip as 4|6)))))return null;return u;}catch{return null;}})();
  if(!web||typeof options.assertCurrent!=="function"||typeof options.assertRetirement!=="function"||typeof options.verifyAttestation!=="function")throw new TypeError("daemon_delegation_client_config");
  const fetcher=options.fetchImpl??fetch,now=options.now??Date.now;
  async function post(path:string,body:unknown,retire=false):Promise<Record<string,unknown>|null>{
    try{const guard=retire?options.assertRetirement:options.assertCurrent;sync(guard);
      const cookie=retire?null:options.cookie();if(!retire&&(!cookie||!/^agentlas_session=[^;\r\n]{8,4096}$/.test(cookie)))return null;
      const raw=JSON.stringify(body);if(Buffer.byteLength(raw)>16*1024)return null;
      const response=await fetcher(new URL(`/api/companion/daemon/${path}`,web!),{method:"POST",redirect:"error",cache:"no-store",signal:AbortSignal.timeout(10_000),
        headers:{"content-type":"application/json",origin:web!.origin,...(cookie?{cookie}:{})},body:raw});
      sync(guard);if(!response.ok||new URL(response.url).origin!==web!.origin||!response.body){await response.body?.cancel().catch(()=>{});return null;}
      const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>8192)return null;parts.push(part.value);}}
      finally{await reader.cancel().catch(()=>{});}sync(guard);const value:unknown=JSON.parse(Buffer.concat(parts).toString("utf8"));
      return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:null;
    }catch{return null;}
  }
  async function challenge(target:Target){
    if(!validTarget(target))return null;const frozen=structuredClone(target),result=await post("delegation-challenge",{target:frozen});
    if(!result||!exact(result,["ok","status","nonce","expiresAt"])||result.ok!==true||result.status!=="issued"||typeof result.nonce!=="string"||
      !/^ddn_[A-Za-z0-9_-]{22}$/.test(result.nonce)||!Number.isSafeInteger(result.expiresAt)||Number(result.expiresAt)<=now()||Number(result.expiresAt)>now()+65_000)return null;
    return {nonce:result.nonce,expiresAt:Number(result.expiresAt)};
  }
  async function attest(binding:CompanionDaemonDelegation,requestSignature:string,daemonSignature:string){
    try{companionDaemonDelegationBytes("attestation-request",binding);if(!signature(requestSignature)||!signature(daemonSignature))return null;
      const frozen=structuredClone(binding),result=await post("delegation-attestation",{binding:frozen,requestSignature,daemonSignature});
      if(!result||!exact(result,["ok","status","attestation","expiresAt"])||result.ok!==true||result.status!=="issued"||typeof result.attestation!=="string"||
        !/^dda1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.attestation)||result.attestation.length>8192||!Number.isSafeInteger(result.expiresAt)||
        Number(result.expiresAt)*1000<=now()||Number(result.expiresAt)>Math.floor(now()/1000)+30||options.verifyAttestation(result.attestation,frozen)!==true)return null;
      sync(options.assertCurrent);return result.attestation;}catch{return null;}
  }
  async function register(binding:CompanionDaemonDelegation,guiSignature:string,daemonSignature:string){
    try{companionDaemonDelegationBytes("gui",binding);if(!signature(guiSignature)||!signature(daemonSignature))return null;
      const frozen=structuredClone(binding),result=await post("delegation-register",{binding:frozen,guiSignature,daemonSignature});
      if(!result||!exact(result,["ok","status","generation","daemonKeyFingerprint"])||result.ok!==true||!["registered","existing"].includes(String(result.status))||
        !Number.isSafeInteger(result.generation)||Number(result.generation)<1||result.daemonKeyFingerprint!==createHash("sha256").update(Buffer.from(frozen.daemonPublicKey,"base64url")).digest("hex"))return null;
      return {status:result.status as "registered"|"existing",generation:Number(result.generation),daemonKeyFingerprint:result.daemonKeyFingerprint as string};}catch{return null;}
  }
  async function revoke(binding:CompanionDaemonDelegation,guiSignature:string){
    try{companionDaemonDelegationBytes("revoke",binding);if(!signature(guiSignature))return null;
      const result=await post("delegation-revoke",{binding:structuredClone(binding),guiSignature},true);
      return result&&exact(result,["ok","status"])&&result.ok===true&&["revoked","existing"].includes(String(result.status))?result.status as "revoked"|"existing":null;}catch{return null;}
  }
  return Object.freeze({challenge,attest,register,revoke});
}
