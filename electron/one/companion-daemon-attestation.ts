import {createHash,createPublicKey,verify,type KeyObject} from "node:crypto";
import {companionDaemonDelegationBytes,type CompanionDaemonDelegation} from "../../shared/companion-daemon-delegation";

/** Only a trusted, current local account/device observation may supply these
 * fields. Verifying this server statement does not itself grant user consent. */
type Observation={binding:CompanionDaemonDelegation;guiPublicKey:KeyObject;daemonPublicKey:KeyObject;assertCurrent():void};
type Options={issuerKey:KeyObject;observe():Observation|null;now?:()=>number};
const keys=["attestationExpiresAt","attestationNonce","attestedAt","audience","binding","guiKeyFingerprint"].sort();
const sync=(fn:()=>void)=>{const value=fn() as unknown;if(value!==undefined){if(value&&typeof (value as {then?:unknown}).then==="function")void Promise.resolve(value).catch(()=>{});throw new Error("companion_daemon_attestation_async_guard");}};
function publicDer(key:KeyObject):Buffer {
  if(key?.type!=="public"||key.asymmetricKeyType!=="ed25519")throw new Error("companion_daemon_key_invalid");
  return createPublicKey(key.export({type:"spki",format:"pem"})).export({type:"spki",format:"der"}) as Buffer;
}
/** This verifies only the exact locally observed binding and expires with the
 * attestation. The actual GUI approval and daemon possession are separate. */
export function createCompanionDaemonAttestationVerifier(options:Options) {
  if(options.issuerKey?.type!=="public"||options.issuerKey.asymmetricKeyType!=="ed25519"||typeof options.observe!=="function")throw new TypeError("companion_daemon_attestation_config");
  const now=options.now??Date.now;
  return (token:unknown):boolean=>{
    try {
      const first=options.observe();if(!first||typeof first.assertCurrent!=="function")return false;sync(first.assertCurrent);
      const expected=companionDaemonDelegationBytes("gui",first.binding),guiDer=publicDer(first.guiPublicKey),daemonDer=publicDer(first.daemonPublicKey);
      if(daemonDer.toString("base64url")!==first.binding.daemonPublicKey)return false;
      const fingerprint=createHash("sha256").update(guiDer).digest("hex");
      if(typeof token!=="string"||token.length>8192)return false;const parts=token.split(".");
      if(parts.length!==3||parts[0]!=="dda1"||!parts.slice(1).every(x=>/^[A-Za-z0-9_-]+$/.test(x)))return false;
      const body=Buffer.from(parts[1],"base64url"),signature=Buffer.from(parts[2],"base64url");
      if(body.toString("base64url")!==parts[1]||signature.length!==64||signature.toString("base64url")!==parts[2]||
        !verify(null,Buffer.from(`dda1.${parts[1]}`,"ascii"),options.issuerKey,signature))return false;
      const decoded:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(body));
      if(!decoded||typeof decoded!=="object"||Array.isArray(decoded))return false;
      const claims=decoded as Record<string,unknown>,seconds=Math.floor(now()/1000);
      if(Object.keys(claims).sort().join(",")!==keys.join(",")||claims.audience!=="agentlas.companion.daemon-delegation-attestation.v1"||
        !companionDaemonDelegationBytes("gui",claims.binding).equals(expected)||claims.guiKeyFingerprint!==fingerprint||
        typeof claims.attestationNonce!=="string"||!/^dda_[A-Za-z0-9_-]{22}$/.test(claims.attestationNonce)||
        !Number.isSafeInteger(claims.attestedAt)||!Number.isSafeInteger(claims.attestationExpiresAt)||
        Number(claims.attestedAt)>seconds||Number(claims.attestationExpiresAt)*1000<=now()||
        Number(claims.attestationExpiresAt)-Number(claims.attestedAt)<1||Number(claims.attestationExpiresAt)-Number(claims.attestedAt)>30||
        Number(claims.attestationExpiresAt)>first.binding.expiresAt)return false;
      sync(first.assertCurrent);const latest=options.observe();if(!latest||typeof latest.assertCurrent!=="function")return false;sync(latest.assertCurrent);
      return companionDaemonDelegationBytes("gui",latest.binding).equals(expected)&&publicDer(latest.guiPublicKey).equals(guiDer)&&
        publicDer(latest.daemonPublicKey).equals(daemonDer)&&Number(claims.attestationExpiresAt)*1000>now();
    }catch{return false;}
  };
}
