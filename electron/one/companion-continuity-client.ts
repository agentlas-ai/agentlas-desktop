import { isIP } from "node:net";
import { isBlockedAddress } from "../net/public-address-guard";
import { companionContinuityBytes, type CompanionContinuityBinding } from "../../shared/companion-continuity-proof";

/** Only the authenticated configured Main origin can attest a phone's current
 * registration. This request is possession proof, never user consent. */
export function createCompanionContinuityClient(options:{webOrigin:string;cookie():string|null;assertCurrent():void;
  signRequest(binding:CompanionContinuityBinding):string;fetchImpl?:typeof fetch;allowLoopback?:boolean}) {
  const web=(()=>{try{const url=new URL(options.webOrigin),host=url.hostname.toLowerCase().replace(/^\[|\]$/g,""),loop=["localhost","127.0.0.1","::1"].includes(host),ip=isIP(host);
    const test=options.allowLoopback===true && process.env.AGENTLAS_E2E==="1" && loop;
    if(url.username || url.password || url.pathname!=="/" || url.search || url.hash || (url.protocol!=="https:" && !(test && url.protocol==="http:")) ||
      (!test && (loop || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || (!ip && !host.includes(".")) ||
        (ip!==0 && isBlockedAddress(host,ip as 4|6)))))return null;return url;}catch{return null;}})();
  if(!web)throw new Error("continuity_origin_invalid");const fetcher=options.fetchImpl ?? fetch;
  async function attest(binding:CompanionContinuityBinding):Promise<string|null> {
    try {
      companionContinuityBytes("attestation-request",binding);options.assertCurrent();
      const cookie=options.cookie();if(!cookie || !/^agentlas_session=[^;\r\n]{8,4096}$/.test(cookie))return null;
      const desktopSignature=options.signRequest(binding);options.assertCurrent();
      const response=await fetcher(new URL("/api/companion/continuity/attestation",web!),{method:"POST",redirect:"error",cache:"no-store",signal:AbortSignal.timeout(10_000),
        headers:{"content-type":"application/json",cookie,origin:web!.origin},body:JSON.stringify({binding,desktopSignature})});
      options.assertCurrent();if(!response.ok || new URL(response.url).origin!==web!.origin){await response.body?.cancel().catch(()=>undefined);return null;}
      if(!response.body)return null;const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>8192)return null;chunks.push(part.value);}}
      finally{await reader.cancel().catch(()=>undefined);}
      const result:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8"));options.assertCurrent();
      if(!result || typeof result!=="object" || Array.isArray(result))return null;const value=result as Record<string,unknown>,now=Math.floor(Date.now()/1000);
      if(Object.keys(value).sort().join(",")!=="attestation,expiresAt,ok,status" || value.ok!==true || value.status!=="issued" || typeof value.attestation!=="string" ||
        value.attestation.length>4096 || !/^cca1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.attestation) || !Number.isSafeInteger(value.expiresAt) ||
        Number(value.expiresAt)<=now || Number(value.expiresAt)>now+30)return null;
      return value.attestation;
    }catch{return null;}
  }
  return Object.freeze({attest});
}
