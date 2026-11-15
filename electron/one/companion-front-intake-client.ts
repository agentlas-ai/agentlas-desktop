import { isIP } from "node:net";
import { isBlockedAddress } from "../net/public-address-guard";
import { companionHandoffProofBytes, COMPANION_HANDOFF_PROOF_FIELDS } from "../../shared/companion-handoff-proof";
import { CompanionIntakeRetryAfter, INTAKE_DEFAULT_RETRY_MS } from "./companion-direct-intake-client";
import { companionFrontRetirementBytes, type FrontRetirementProof } from "../../shared/companion-front-retirement";
import { isCompanionPollHolding } from "../../shared/companion-poll-holding";
import { pollVersion } from "./companion-poll-holding";

const METHOD = "one.front-turn.send.v1";
class CompanionFrontUnsendable extends Error {}
export type FrontReply<S extends string> = {kind:"ok";status:S}|{kind:"closed"}|{kind:"retry";afterMs?:number};
const object = (x:unknown): x is Record<string,unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const exact = (x:Record<string,unknown>, keys:string[]) => Object.keys(x).sort().join(",") === keys.sort().join(",");
const challenge = (x:unknown): x is string => typeof x === "string" && x.length >= 16 && x.length <= 4096 && /^fc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(x);
function retryDelay(response:Response):number {
  const value=response.headers.get("retry-after")?.trim();
  if(value && /^\d+$/.test(value))return Math.min(Number.MAX_SAFE_INTEGER-Date.now(),Math.max(1_000,Number(value)*1_000));
  const at=value?Date.parse(value):NaN;return Number.isFinite(at)?Math.max(1_000,at-Date.now()):60_000;
}
function approvedOrigin(raw:string, allowLoopback:boolean): URL|null {
  try {
    const u=new URL(raw),host=u.hostname.toLowerCase().replace(/^\[|\]$/g,""),loop=["localhost","127.0.0.1","::1"].includes(host),ip=isIP(host);
    if (u.username || u.password || u.search || u.hash || u.pathname !== "/" ||
        (u.protocol !== "https:" && !(allowLoopback && loop && u.protocol === "http:")) ||
        (!(allowLoopback && loop) && (loop || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
          (!ip && !host.includes(".")) || (ip !== 0 && isBlockedAddress(host,ip as 4|6))))) return null;
    return u;
  } catch { return null; }
}
async function json(response:Response,max:number):Promise<Record<string,unknown>|null> {
  if (!response.body) return null;
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try { for (;;) { const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>max)return null;chunks.push(p.value); }
    const result:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8"));return object(result)?result:null;
  } catch { return null; } finally { await reader.cancel().catch(()=>undefined); }
}

/** Front proofs use a separate domain and never accept the Work method. The
 * server origin comes only from the configured Web discovery endpoint. */
export function createCompanionFrontIntakeClient(options:{webOrigin:string;cookie():string|null;assertCurrent():void;
  signPoll(value:Record<string,unknown>):string;signClaim(binding:Record<string,unknown>,challenge:string):string;
  signLifecycle?(purpose:"start"|"status",binding:Record<string,unknown>,challenge:string,runId:string):string;
  signTurnAuthority?(permit:object):string;
  /** TR-desktop (trust-root.md E1): see companion-direct-intake-client.ts - `receive` makes no request without it. */
  mayTake?(deviceId:string):boolean;
  /** direct-work-capacity R5 / R8: see companion-direct-intake-client.ts `holding` / `held` (the front's own turns; companion-poll-holding.ts `readFrontHolding`). */
  holding?(target:{userId:string;deviceId:string;hostId:string;oneId:string}):string[]|null;
  held?(commandId:string):boolean;
  fetchImpl?:typeof fetch;allowLoopback?:boolean}) {
  const loop=options.allowLoopback === true && process.env.AGENTLAS_E2E === "1",web=approvedOrigin(options.webOrigin,loop);
  if (!web) throw new Error("companion_front_origin_invalid");
  const fetcher=options.fetchImpl ?? fetch;
  let lastStatus=0;   // the HTTP status of the answer `post` read last (read by `receive` right after its poll, nothing else)
  async function postRaw(origin:URL,path:string,value:unknown,cookie?:string):Promise<{http:number;response:Response;retryAfterMs?:number}> {
    options.assertCurrent();const body=JSON.stringify(value);if(Buffer.byteLength(body)>96*1024)throw new CompanionFrontUnsendable();
    const response=await fetcher(new URL(path,origin),{method:"POST",redirect:"error",cache:"no-store",signal:AbortSignal.timeout(10_000),
      headers:{"content-type":"application/json",...(cookie?{cookie,origin:web!.origin}:{})},body});
    options.assertCurrent();
    return {http:response.status,response,...(response.status===429||response.status===503?{retryAfterMs:retryDelay(response)}:{})};
  }
  async function post(origin:URL,path:string,value:unknown,cookie?:string):Promise<Record<string,unknown>|null> {
    let sent;lastStatus=0;try{sent=await postRaw(origin,path,value,cookie);}catch(error){if(error instanceof CompanionFrontUnsendable)return null;throw error;}
    const {response}=sent;lastStatus=sent.http;
    if(response.status===429){await response.body?.cancel().catch(()=>undefined);throw new CompanionIntakeRetryAfter(sent.retryAfterMs ?? INTAKE_DEFAULT_RETRY_MS);}
    // T1-3 (the sibling): a service that does not mount the front routes (its front switch is off) answered every 5 s sweep with a 404 for ever; it is waited out like a "not now" answer, once per window.
    if(response.status===404 && path.startsWith("/v2/front/direct/")){await response.body?.cancel().catch(()=>undefined);throw new CompanionIntakeRetryAfter(INTAKE_DEFAULT_RETRY_MS);}
    if (!response.ok || new URL(response.url).origin !== origin.origin) {await response.body?.cancel().catch(()=>undefined);return null;}
    return json(response,100*1024);
  }
  /** direct-work-capacity R8, the same classes as the work receipts (companion-work-delivery-client.ts): 200 + a named `status` = the server has it; 403 = it cannot verify
   * these bytes, ever (`closed`); 429, 5xx, no answer, anything else = retry (`afterMs` = Retry-After). No answer text is read. */
  async function submit<S extends string>(path:string,value:unknown,statuses:readonly S[],shape:(r:Record<string,unknown>)=>boolean):Promise<FrontReply<S>> {
    try {
      const companion=await discover();if(!companion)return {kind:"retry"};
      const sent=await postRaw(companion,path,value);const {response}=sent;
      const wait=sent.retryAfterMs;
      if(response.status===403){await response.body?.cancel().catch(()=>undefined);return {kind:"closed"};}
      if(!response.ok || new URL(response.url).origin!==companion.origin){await response.body?.cancel().catch(()=>undefined);return {kind:"retry",...(wait!==undefined?{afterMs:wait}:{})};}
      const result=await json(response,100*1024);
      if(!result||result.ok!==true||!(statuses as readonly string[]).includes(String(result.status))||!shape(result))return {kind:"retry"};
      return {kind:"ok",status:result.status as S};
    } catch(error){if(error instanceof CompanionIntakeRetryAfter)return {kind:"retry",afterMs:error.retryAfterMs};return {kind:"retry"};}
  }
  async function discover():Promise<URL|null> {
    options.assertCurrent();
    const discovery=await fetcher(new URL("/api/mobile-pair/v1/companion/work-delivery-origin",web!),{method:"GET",redirect:"error",cache:"no-store",signal:AbortSignal.timeout(5_000)});
    options.assertCurrent();
    if(discovery.status===429){const delay=retryDelay(discovery);await discovery.body?.cancel().catch(()=>undefined);throw new CompanionIntakeRetryAfter(delay);}
    if (!discovery.ok || new URL(discovery.url).origin !== web!.origin) {await discovery.body?.cancel().catch(()=>undefined);return null;}
    const found=await json(discovery,2048);
    if (!found || !exact(found,["schema","origin"]) || found.schema !== "agentlas.companion.work-delivery-origin.v1" || typeof found.origin !== "string") return null;
    return approvedOrigin(found.origin,loop);
  }
  async function receive(target:{userId:string;deviceId:string;hostId:string;oneId:string},matches:(b:Record<string,unknown>)=>boolean) {
    try {
      if(!options.mayTake || options.mayTake(target.deviceId)!==true)return null;   // before any request
      const companion=await discover();if(!companion)return null;
      const first=await post(companion,"/v2/front/direct/challenge",target);
      if(!first || !exact(first,["ok","challenge","expiresAt"]) || first.ok !== true || !challenge(first.challenge) ||
        !Number.isSafeInteger(first.expiresAt) || Number(first.expiresAt)<=Math.floor(Date.now()/1000) || Number(first.expiresAt)>Math.floor(Date.now()/1000)+60) return null;
      const proof={...target,challenge:first.challenge};
      let holding:string[]|null=null;
      if(options.holding && !pollVersion.isV1("front",web!.origin)){try{const list=options.holding(target);holding=isCompanionPollHolding(list)?list:null;}catch{holding=null;}}
      const sendPoll=(list:string[]|null)=>{const body=list?{...proof,holding:list}:proof;return post(companion,"/v2/front/direct/poll",{...body,signature:options.signPoll(body)});};
      let pending=await sendPoll(holding);
      // Same as the direct poll: a service that does not read `holding` refuses the 7-key poll with the 403 of an unregistered computer; the v1 poll of the same challenge tells them apart.
      if(!pending && lastStatus===403 && holding){
        pending=await sendPoll(null);
        if(pending && pending.ok===true){pollVersion.noteV1("front",web!.origin);try{console.warn("[companion-poll] the service refused the v2 front poll and took the v1 poll: this service is polled with v1 until the app restarts");}catch{/* no log sink */}}
      }
      if(!pending || pending.ok!==true)return null;
      if(exact(pending,["ok","binding"]) && pending.binding===null)return null;
      if(!exact(pending,["ok","binding","claimChallenge"]) || !object(pending.binding) || pending.binding.method!==METHOD || !challenge(pending.claimChallenge))return null;
      companionHandoffProofBytes({...pending.binding,method:"one.work-handoff.send.v1"});
      if(!matches(pending.binding))return null;
      if(options.held?.(String(pending.binding.commandId))===true)return null;   // R8: received already - no claim request is made
      const cookie=options.cookie();if(!cookie || !/^agentlas_session=[^;\r\n]{8,4096}$/.test(cookie))return null;
      options.assertCurrent();const signed=options.signClaim(pending.binding,pending.claimChallenge);
      const claimed=await post(web!,"/api/companion/front/direct-claim",{binding:pending.binding,claimChallenge:pending.claimChallenge,signature:signed},cookie);
      if(!claimed || !exact(claimed,["ok","status","binding","payload","grant"]) || claimed.ok!==true || !["claimed","existing"].includes(String(claimed.status)) ||
        !object(claimed.binding) || COMPANION_HANDOFF_PROOF_FIELDS.some(field=>(claimed.binding as Record<string,unknown>)[field] !== (pending.binding as Record<string,unknown>)[field]) ||
        typeof claimed.payload!=="string" || typeof claimed.grant!=="string")return null;
      options.assertCurrent();return {binding:claimed.binding,payload:claimed.payload,grant:claimed.grant};
    } catch (error) {if(error instanceof CompanionIntakeRetryAfter)throw error;return null;}
  }
  async function lifecycle(purpose:"start"|"status",binding:Record<string,unknown>,runId:string):Promise<string|null> {
    try {
      if(!options.signLifecycle || (purpose!=="start" && purpose!=="status") || binding.method!==METHOD || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(runId))return null;
      companionHandoffProofBytes({...binding,method:"one.work-handoff.send.v1"});
      const companion=await discover();if(!companion)return null;
      const target={userId:binding.userId,deviceId:binding.deviceId,hostId:binding.hostId,oneId:binding.oneId};
      const first=await post(companion,"/v2/front/direct/start-challenge",target);
      if(!first || !exact(first,["ok","challenge","expiresAt"]) || first.ok!==true || !challenge(first.challenge) ||
        !Number.isSafeInteger(first.expiresAt) || Number(first.expiresAt)<=Math.floor(Date.now()/1000) || Number(first.expiresAt)>Math.floor(Date.now()/1000)+60)return null;
      const cookie=options.cookie();if(!cookie || !/^agentlas_session=[^;\r\n]{8,4096}$/.test(cookie))return null;
      options.assertCurrent();const signature=options.signLifecycle(purpose,binding,first.challenge,runId);
      const result=await post(web!,`/api/companion/front/direct-${purpose}`,{binding,challenge:first.challenge,runId,signature},cookie);
      if(!result || !exact(result,["ok","status"]) || result.ok!==true || typeof result.status!=="string")return null;
      options.assertCurrent();return (purpose==="start" ? ["authorized","existing","cancel"] : ["active","cancel"]).includes(result.status) ? result.status:null;
    } catch(error){if(error instanceof CompanionIntakeRetryAfter)throw error;return null;}
  }
  /** Direct Companion can only confirm cancellation when a web session has
   * disappeared. Network failures remain unknown, never cancellation proof. */
  async function retirement(binding:Record<string,unknown>,runId:string):Promise<boolean> {
    try {
      if(!options.signLifecycle || binding.method!==METHOD || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(runId))return false;
      companionHandoffProofBytes({...binding,method:"one.work-handoff.send.v1"});
      const companion=await discover();if(!companion)return false;
      const target={userId:binding.userId,deviceId:binding.deviceId,hostId:binding.hostId,oneId:binding.oneId};
      const first=await post(companion,"/v2/front/direct/start-challenge",target);
      if(!first || !exact(first,["ok","challenge","expiresAt"]) || first.ok!==true || !challenge(first.challenge) ||
        !Number.isSafeInteger(first.expiresAt) || Number(first.expiresAt)<=Math.floor(Date.now()/1000) || Number(first.expiresAt)>Math.floor(Date.now()/1000)+60)return false;
      options.assertCurrent();const signature=options.signLifecycle("status",binding,first.challenge,runId);
      const result=await post(companion,"/v2/front/direct/status",{binding,challenge:first.challenge,runId,signature});
      options.assertCurrent();return !!result && exact(result,["ok","status"]) && result.ok===true && result.status==="cancel";
    }catch(error){if(error instanceof CompanionIntakeRetryAfter)throw error;return false;}
  }
  /** Current front context authority is distinct from registration or consent. */
  async function turnAuthority(input:{binding:Record<string,unknown>;runId:string;requestNonce:string;permit:object}):Promise<string|null> {
    try {
      if(!options.signTurnAuthority)return null;
      const {companionFrontTurnAuthorityRequestBytes}=require("../../shared/companion-front-turn-authority") as typeof import("../../shared/companion-front-turn-authority");
      companionFrontTurnAuthorityRequestBytes(input.binding,input.runId,input.requestNonce);
      const cookie=options.cookie();if(!cookie || !/^agentlas_session=[^;\r\n]{8,4096}$/.test(cookie))return null;
      options.assertCurrent();const desktopSignature=options.signTurnAuthority(input.permit);
      const result=await post(web!,"/api/companion/front-transfer/turn-authority",{binding:input.binding,runId:input.runId,requestNonce:input.requestNonce,desktopSignature},cookie);
      if(!result||!exact(result,["ok","status","attestation","expiresAt"])||result.ok!==true||result.status!=="issued"||typeof result.attestation!=="string"||
         !Number.isSafeInteger(result.expiresAt)||Number(result.expiresAt)<=Math.floor(Date.now()/1000)||Number(result.expiresAt)>Math.floor(Date.now()/1000)+15)return null;
      options.assertCurrent();return result.attestation;
    }catch(error){if(error instanceof CompanionIntakeRetryAfter)throw error;return null;}
  }
  async function submitReceipt(receipt:Record<string,unknown>,signature:string):Promise<FrontReply<"recorded"|"existing"|"settled">> {
    try {
      const {companionFrontReceiptBytes}=require("../../shared/companion-front-receipt") as typeof import("../../shared/companion-front-receipt");
      companionFrontReceiptBytes(receipt);if(typeof signature!=="string"||!/^[A-Za-z0-9_-]{86}$/.test(signature))return {kind:"retry"};
    }catch{return {kind:"retry"};}
    return submit("/v2/front/direct/receipt",{receipt,signature},["recorded","existing","settled"] as const,result=>
      exact(result,["ok","status"]) || (exact(result,["ok","status","seq"]) && Number.isSafeInteger(result.seq) && Number(result.seq)>0) ||
      (exact(result,["ok","status","retirement"]) && result.retirement===true) || (exact(result,["ok","status","fullResultPending"]) && result.fullResultPending===true));
  }
  async function submitFullChunk(chunk:Record<string,unknown>,signature:string):Promise<FrontReply<"recorded"|"existing"|"complete"|"settled">> {
    try {
      const {companionFrontFullChunkBytes}=require("../../shared/companion-front-receipt") as typeof import("../../shared/companion-front-receipt");
      companionFrontFullChunkBytes(chunk);if(typeof signature!=="string"||!/^[A-Za-z0-9_-]{86}$/.test(signature))return {kind:"retry"};
    }catch{return {kind:"retry"};}
    return submit("/v2/front/full-chunk",{chunk,signature},["recorded","existing","complete","settled"] as const,()=>true);
  }
  /** The caller must obtain the signature from the GUI's one-use local proof;
   * this transport cannot manufacture a no-start or terminal receipt. */
  async function submitRetirement(binding:Record<string,unknown>,runId:string,proof:FrontRetirementProof,signature:string):Promise<FrontReply<"recorded"|"existing"|"settled">> {
    try {
      companionFrontRetirementBytes(binding,runId,proof);
      if(typeof signature!=="string"||!/^[A-Za-z0-9_-]{86}$/.test(signature))return {kind:"retry"};
    }catch{return {kind:"retry"};}
    return submit("/v2/front/direct/retirement",{binding,runId,proof,signature},["recorded","existing","settled"] as const,result=>exact(result,["ok","status"]));
  }
  return Object.freeze({receive,lifecycle,retirement,submitRetirement,turnAuthority,submitReceipt,submitFullChunk});
}
