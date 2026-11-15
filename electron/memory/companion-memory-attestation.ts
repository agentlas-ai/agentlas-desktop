import {randomBytes,verify,type KeyObject} from "node:crypto";
import {performance} from "node:perf_hooks";
import {companionLineageV2SnapshotDigest,type LineageV2Snapshot} from "./companion-memory-lineage-v2";

type Binding={userId:string;workspaceId:string;authEpoch:number;accountSubject:string;familyId:string;deviceId:string;deviceGeneration:number;hostId:string;oneId:string;approvalId:string;scope:string[]};
type Observation={binding:Binding;deviceKeyFingerprint:string;assertCurrent():void};
type Request={requestNonce:string};
type ChallengeRequest={clientNonce:string};
type Pending={observation:Observation;binding:Binding;wall:number;mono:number};
const fields=["userId","workspaceId","authEpoch","accountSubject","familyId","deviceId","deviceGeneration","hostId","oneId","approvalId","scope"] as const;
const claims=["audience",...fields,"deviceKeyFingerprint","generation","revision","forgetEpoch","snapshotDigest","requestNonce","leaseId","nonce","issuedAt","expiresAt"].sort();
const challengeClaims=["audience",...fields,"deviceKeyFingerprint","clientNonce","requestNonce","nonce","issuedAt","expiresAt"].sort();
const nat=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0&&(v as number)<Number.MAX_SAFE_INTEGER;
const tagged=(value:unknown,prefix:string):value is string=>{
  if(typeof value!=="string"||!value.startsWith(prefix))return false;const tail=value.slice(prefix.length);
  if(!/^[A-Za-z0-9_-]{22}$/.test(tail))return false;const bytes=Buffer.from(tail,"base64url");return bytes.length===16&&bytes.toString("base64url")===tail;
};
const id=(v:unknown)=>typeof v==="string"&&/^[A-Za-z0-9_.:@-]{1,128}$/.test(v);
const sync=(fn:()=>void)=>{const v=fn() as unknown;if(v!==undefined){if(v&&typeof(v as {then?:unknown}).then==="function")void Promise.resolve(v).catch(()=>{});throw Error("memory_snapshot_owner_not_synchronous");}};
function validBinding(value:unknown):value is Binding{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;const b=value as Record<string,unknown>,scope=b.scope;
  if(Object.keys(b).sort().join(",")!==[...fields].sort().join(",")||![b.userId,b.workspaceId,b.accountSubject,b.familyId,b.hostId,b.oneId,b.approvalId].every(id)||
    typeof b.deviceId!=="string"||!/^[A-Za-z0-9_-]{8,96}$/.test(b.deviceId)||!nat(b.authEpoch)||!nat(b.deviceGeneration)||b.deviceGeneration<1||
    !Array.isArray(scope)||!scope.includes("conversation")||!scope.includes("memory")||scope.length>3||
    !scope.every((v,i)=>["conversation","memory","profile"].includes(v)&&(i===0||scope[i-1]<v)))return false;
  return true;
}
const bindingBytes=(b:Binding)=>JSON.stringify(fields.map(field=>b[field]));
/** The first nonce is local and single-use. Main binds it in its signed
 * challenge; the later request nonce is issued by the Companion server. */
export function companionMemorySnapshotChallengeRequestBytes(input:unknown):Buffer|null{
  if(!input||typeof input!=="object"||Array.isArray(input))return null;const value=input as Record<string,unknown>;
  if(Object.keys(value).sort().join(",")!=="binding,clientNonce"||!validBinding(value.binding)||!tagged(value.clientNonce,"mci_"))return null;
  const binding=value.binding;return Buffer.from(JSON.stringify(["agentlas.companion.memory-snapshot.challenge-request.v1",...fields.map(field=>binding[field]),value.clientNonce]),"utf8");
}
/** The device signs only this closed request transcript; possession does not
 * imply memory consent or authorize applying the snapshot. */
export function companionMemorySnapshotRequestBytes(input:unknown):Buffer|null{
  if(!input||typeof input!=="object"||Array.isArray(input))return null;const value=input as Record<string,unknown>;
  if(Object.keys(value).sort().join(",")!=="binding,requestNonce"||!validBinding(value.binding)||!tagged(value.requestNonce,"msn_"))return null;
  const binding=value.binding;return Buffer.from(JSON.stringify(["agentlas.companion.memory-snapshot.request.v1",...fields.map(field=>binding[field]),value.requestNonce]),"utf8");
}

/** Only inspections: a valid signature does not enable recall or authorize an
 * apply. The host must separately establish fresh lease status and ACK rules. */
export function createCompanionMemoryAttestationVerifier(options:{issuerKey:KeyObject;observe():Observation|null;wallNow?:()=>number;monotonicNow?:()=>number}){
  if(options.issuerKey?.type!=="public"||options.issuerKey.asymmetricKeyType!=="ed25519"||typeof options.observe!=="function")throw new TypeError("memory_snapshot_verifier_config");
  const wallNow=options.wallNow??Date.now,monotonicNow=options.monotonicNow??(()=>performance.now()),pending=new WeakMap<object,Pending>(),challenges=new WeakMap<object,Pending>();
  // A verifier belongs to this process lifetime. A reboot or clock change
  // requires a new online challenge; wall time alone never extends a nonce.
  const baseWall=wallNow(),baseMono=monotonicNow(),seen=new Map<string,number>();
  const clockOk=(wall:number,mono:number)=>Number.isFinite(wall)&&Number.isFinite(mono)&&Number.isFinite(baseWall)&&Number.isFinite(baseMono)&&
    wall>=baseWall&&mono>=baseMono&&Math.abs((wall-baseWall)-(mono-baseMono))<=2_000;
  function createChallengeRequest():ChallengeRequest|null {
    try{const observation=options.observe();if(!observation||!validBinding(observation.binding)||!/^[a-f0-9]{64}$/.test(observation.deviceKeyFingerprint)||typeof observation.assertCurrent!=="function")return null;
      sync(observation.assertCurrent);const binding=structuredClone(observation.binding);Object.freeze(binding.scope);Object.freeze(binding);
      const wall=wallNow(),mono=monotonicNow();if(!clockOk(wall,mono))return null;
      const request=Object.freeze({clientNonce:`mci_${randomBytes(16).toString("base64url")}`});challenges.set(request,{observation,binding,wall,mono});return request;
    }catch{return null;}
  }
  function begin(requestHandle:unknown,challenge:unknown):Request|null {
    if(!requestHandle||typeof requestHandle!=="object")return null;const origin=challenges.get(requestHandle);challenges.delete(requestHandle);if(!origin)return null;
    try{const {observation,binding}=origin;sync(observation.assertCurrent);
      const wall=wallNow(),mono=monotonicNow();if(!clockOk(wall,mono)||mono-origin.mono>30_000||typeof challenge!=="string"||challenge.length>8192)return null;
      const parts=challenge.split(".");if(parts.length!==3||parts[0]!=="msc1"||!parts.slice(1).every(x=>/^[A-Za-z0-9_-]+$/.test(x)))return null;
      const body=Buffer.from(parts[1],"base64url"),signature=Buffer.from(parts[2],"base64url");
      if(body.toString("base64url")!==parts[1]||signature.length!==64||signature.toString("base64url")!==parts[2]||
        !verify(null,Buffer.from(`msc1.${parts[1]}`,"ascii"),options.issuerKey,signature))return null;
      const decoded:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(body));if(!decoded||typeof decoded!=="object"||Array.isArray(decoded))return null;
      const c=decoded as Record<string,unknown>,bound=Object.fromEntries(fields.map(field=>[field,c[field]])) as Binding,seconds=Math.floor(wall/1000);
      if(Object.keys(c).sort().join(",")!==challengeClaims.join(",")||c.audience!=="agentlas.companion.memory-snapshot-challenge.v1"||!validBinding(bound)||
        bindingBytes(bound)!==bindingBytes(binding)||c.deviceKeyFingerprint!==observation.deviceKeyFingerprint||c.clientNonce!==(requestHandle as ChallengeRequest).clientNonce||!tagged(c.clientNonce,"mci_")||!tagged(c.requestNonce,"msn_")||!tagged(c.nonce,"msc_")||
        !nat(c.issuedAt)||!nat(c.expiresAt)||c.issuedAt>seconds||c.expiresAt*1000<=wall||c.expiresAt-c.issuedAt<1||c.expiresAt-c.issuedAt>30)return null;
      for(const [nonce,until] of seen)if(until<=mono)seen.delete(nonce);
      if(seen.has(`challenge:${c.nonce}`)||seen.has(`request:${c.requestNonce}`)||seen.size>=4096)return null;
      const seenUntil=mono+(c.expiresAt*1000-wall);seen.set(`challenge:${c.nonce}`,seenUntil);seen.set(`request:${c.requestNonce}`,seenUntil);
      const latest=options.observe();if(!latest||!validBinding(latest.binding)||typeof latest.assertCurrent!=="function"||bindingBytes(latest.binding)!==bindingBytes(binding)||
        latest.deviceKeyFingerprint!==observation.deviceKeyFingerprint)return null;sync(latest.assertCurrent);sync(observation.assertCurrent);
      if(!clockOk(wallNow(),monotonicNow())||wallNow()>=c.expiresAt*1000)return null;
      const request=Object.freeze({requestNonce:c.requestNonce});pending.set(request,{observation,binding,wall,mono});return request;
    }catch{return null;}
  }
  function inspect(request:unknown,token:unknown,raw:unknown):{leaseId:string;generation:string;revision:number;forgetEpoch:number;snapshotDigest:string}|null {
    if(!request||typeof request!=="object")return null;const held=pending.get(request);pending.delete(request);if(!held)return null;
    try{
      sync(held.observation.assertCurrent);const latest=options.observe();if(!latest||!validBinding(latest.binding)||typeof latest.assertCurrent!=="function")return null;sync(latest.assertCurrent);
      if(bindingBytes(latest.binding)!==bindingBytes(held.binding)||latest.deviceKeyFingerprint!==held.observation.deviceKeyFingerprint)return null;
      if(typeof token!=="string"||token.length>8192)return null;const parts=token.split(".");
      if(parts.length!==3||parts[0]!=="mls1"||!parts.slice(1).every(x=>/^[A-Za-z0-9_-]+$/.test(x)))return null;
      const bytes=Buffer.from(parts[1],"base64url"),sig=Buffer.from(parts[2],"base64url");
      if(bytes.toString("base64url")!==parts[1]||sig.length!==64||sig.toString("base64url")!==parts[2]||!verify(null,Buffer.from(`mls1.${parts[1]}`,"ascii"),options.issuerKey,sig))return null;
      const value:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));if(!value||typeof value!=="object"||Array.isArray(value))return null;
      const c=value as Record<string,unknown>,bound=Object.fromEntries(fields.map(field=>[field,c[field]])) as Binding;
      const snapshot=structuredClone(raw) as LineageV2Snapshot,digest=companionLineageV2SnapshotDigest(snapshot);
      const wall=wallNow(),mono=monotonicNow(),wallElapsed=wall-held.wall,elapsed=mono-held.mono,seconds=Math.floor(wall/1000);
      if(Object.keys(c).sort().join(",")!==claims.join(",")||c.audience!=="agentlas.companion.memory-snapshot.v1"||!validBinding(bound)||bindingBytes(bound)!==bindingBytes(held.binding)||
        c.deviceKeyFingerprint!==held.observation.deviceKeyFingerprint||snapshot?.userId!==bound.userId||snapshot?.workspaceId!==bound.workspaceId||!digest||
        c.snapshotDigest!==digest||c.generation!==snapshot.generation||c.revision!==snapshot.revision||c.forgetEpoch!==snapshot.forgetEpoch||
        c.requestNonce!==(request as Request).requestNonce||!tagged(c.leaseId,"msl_")||!tagged(c.nonce,"mls_")||!nat(c.issuedAt)||!nat(c.expiresAt)||
        c.issuedAt>seconds||c.expiresAt*1000<=wall||c.expiresAt-c.issuedAt<1||c.expiresAt-c.issuedAt>15||
        !clockOk(wall,mono)||!Number.isFinite(elapsed)||!Number.isFinite(wallElapsed)||elapsed<0||elapsed>15_000||wallElapsed<0||Math.abs(wallElapsed-elapsed)>2_000)return null;
      sync(held.observation.assertCurrent);sync(latest.assertCurrent);const final=options.observe();
      if(!final||!validBinding(final.binding)||typeof final.assertCurrent!=="function"||bindingBytes(final.binding)!==bindingBytes(held.binding)||
        final.deviceKeyFingerprint!==held.observation.deviceKeyFingerprint)return null;sync(final.assertCurrent);
      const finalWall=wallNow(),finalMono=monotonicNow();
      if(!clockOk(finalWall,finalMono)||finalWall>=c.expiresAt*1000||finalMono<held.mono||finalWall<held.wall||
        finalMono-held.mono>15_000||Math.abs((finalWall-held.wall)-(finalMono-held.mono))>2_000)return null;
      return {leaseId:c.leaseId,generation:snapshot.generation,revision:snapshot.revision,forgetEpoch:snapshot.forgetEpoch,snapshotDigest:digest};
    }catch{return null;}
  }
  return Object.freeze({createChallengeRequest,begin,inspect});
}
