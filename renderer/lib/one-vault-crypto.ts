import { ONE_VAULT_SCHEMA, ONE_VAULT_SUITE, OneVaultError, oneVaultCanonical as canonical, oneVaultUnsigned as unsigned, type OneVaultRequest, type OneVaultBinding, type OneVaultEnvelope, type OneVaultReceipt, type OneVaultStatusQuery, type OneVaultRecoveryDescriptor } from "@shared/one-vault";
import type { OneVaultSecureChannel } from "@/components/one/OneVaultRequestForm";
/** Must come from the native pinned-host enrollment and current-session authority.
 * Neither relay metadata nor a key received with a request can supply this object. */
export interface OneVaultRendererTrust {
  hostId: string; hostKeyId: string; hostPublicKey: string; senderId: string; senderKeyId: string;
  trustGeneration: number;currentAuthorityDigest?:string;currentRecovery?:OneVaultRecoveryDescriptor|null;
  current: Pick<OneVaultBinding,"principalId"|"sessionId"|"scope"|"organizationId"|"authorityRevision"|"permissionRevision"|"expectedGeneration"|"requestId"|"requestRevision">;
  /** Opaque native signer. Receives canonical value-free transcripts, never a secret. */
  sign(transcript: Uint8Array): Promise<Uint8Array>;
}
export interface OneVaultRendererPorts {
  trustedIdentity(requestId:string):Promise<OneVaultRendererTrust>;
  submit(requestId:string,envelope:OneVaultEnvelope):Promise<OneVaultReceipt>;
  reconcile(requestId:string,query:OneVaultStatusQuery):Promise<OneVaultReceipt>;
  now?():number;
}
const encode=new TextEncoder();
function b64(bytes:Uint8Array){let value="";for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");}
function decode(value:string,length?:number):Uint8Array{
  if(typeof value!=="string"||value.length>24576||!/^[A-Za-z0-9_-]*$/.test(value))throw new OneVaultError("invalid_envelope");
  try{const decoded=Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")),character=>character.charCodeAt(0));if(b64(decoded)!==value||length!==undefined&&decoded.length!==length)throw new Error();return decoded;}catch{throw new OneVaultError("invalid_envelope");}
}
function exact(value:object,keys:string[]){if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join("|")!==[...keys].sort().join("|"))throw new OneVaultError("invalid_request");}
function id(value:unknown){if(typeof value!=="string"||!/^[A-Za-z0-9._:/@ -]{1,256}$/.test(value))throw new OneVaultError("invalid_request");}
function requestShape(request:OneVaultRequest,now:number,expired=false){
  exact(request,["schema","suite","binding","nonce","issuedAt","expiresAt","hostKeyId","recipientKeyId","recipientPublicKey","signature"]);
  exact(request.binding,["requestId","requestRevision","commandId","intentDigest","principalId","sessionId","scope","organizationId","workspaceId","resourceId","purpose","payerId","taskId","runId","controlVersion","authorityRevision","provider","providerWorkspace","region","endpoint","operations","permissionRevision","storage","expectedGeneration","cost","hostId","senderId","trustGeneration"]);
  canonical(request);const binding=request.binding;
  if(request.schema!==ONE_VAULT_SCHEMA||request.suite!==ONE_VAULT_SUITE||request.expiresAt<=request.issuedAt||request.expiresAt-request.issuedAt>300000||request.issuedAt>now+30000)throw new OneVaultError("invalid_request");
  if(!expired&&request.expiresAt<=now)throw new OneVaultError("request_expired");
  if(!["personal","organization"].includes(binding.scope)||binding.storage!=="os-vault"||!binding.endpoint.startsWith("https://")||!binding.operations.length||binding.scope==="personal"&&binding.organizationId!==null||binding.scope==="organization"&&!binding.organizationId)throw new OneVaultError("invalid_request");
  if(binding.controlVersion!==null)id(binding.controlVersion);else if(!binding.taskId.startsWith("one:")||binding.taskId.length<=4)throw new OneVaultError("invalid_request");decode(request.nonce,32);decode(request.recipientPublicKey,65);decode(request.signature,64);id(request.hostKeyId);id(request.recipientKeyId);
}
async function digest(value:unknown){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",encode.encode(canonical(value))))).map(byte=>byte.toString(16).padStart(2,"0")).join("");}
function transcript(domain:string,value:{signature:string}){return encode.encode(canonical([domain,unsigned(value)]));}
async function verify(domain:"request"|"receipt"|"recovery",value:{signature:string},publicKey:string){try{const key=await crypto.subtle.importKey("raw",decode(publicKey,65).buffer as ArrayBuffer,{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);return await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},key,decode(value.signature,64).buffer as ArrayBuffer,transcript(domain,value));}catch{return false;}}
async function sign<T extends {signature:string}>(domain:"envelope"|"status",value:T,trust:OneVaultRendererTrust):Promise<T>{const signature=await trust.sign(transcript(domain,value));if(signature.byteLength!==64)throw new OneVaultError("sender_untrusted");return {...value,signature:b64(signature)};}
export function createOneVaultSecureChannel(ports:OneVaultRendererPorts):OneVaultSecureChannel {
  const now=ports.now??(()=>Date.now());
  const trustFor=async(request:OneVaultRequest,allowExpired=false)=>{requestShape(request,now(),allowExpired);const trust=await ports.trustedIdentity(request.binding.requestId);
    if(trust.hostId!==request.binding.hostId||trust.hostKeyId!==request.hostKeyId||trust.senderId!==request.binding.senderId||trust.trustGeneration!==request.binding.trustGeneration)throw new OneVaultError("host_mismatch");
    for(const key of Object.keys(trust.current) as Array<keyof typeof trust.current>)if(trust.current[key]!==request.binding[key])throw new OneVaultError("revision_changed");
    if(Object.keys(trust.current).sort().join("|")!==["principalId","sessionId","scope","organizationId","authorityRevision","permissionRevision","expectedGeneration","requestId","requestRevision"].sort().join("|"))throw new OneVaultError("authority_unavailable");
    if(!await verify("request",request,trust.hostPublicKey))throw new OneVaultError("host_mismatch");return trust;
  };
  const recoveryTrust=async(request:OneVaultRequest,recovery:OneVaultRecoveryDescriptor)=>{const trust=await trustFor(request,true);exact(recovery,["schema","hostId","hostKeyId","requestDigest","operationId","envelopeDigest","action","expectedGeneration","senderKeyId","currentAuthorityDigest","issuedAt","expiresAt","signature"]);canonical(recovery);
    if(!trust.currentRecovery||["requestDigest","operationId","envelopeDigest","action","expectedGeneration","senderKeyId","currentAuthorityDigest"].some(key=>recovery[key as keyof OneVaultRecoveryDescriptor]!==trust.currentRecovery![key as keyof OneVaultRecoveryDescriptor]))throw new OneVaultError("revision_changed");
    if(recovery.schema!=="agentlas.one-vault-recovery.v1"||recovery.hostId!==trust.hostId||recovery.hostKeyId!==trust.hostKeyId||recovery.requestDigest!==await digest(request)||recovery.senderKeyId!==trust.senderKeyId||recovery.expectedGeneration!==request.binding.expectedGeneration||!["store","delete"].includes(recovery.action)||!/^[a-f0-9]{64}$/.test(recovery.envelopeDigest)||!/^[a-f0-9]{64}$/.test(recovery.currentAuthorityDigest)||recovery.currentAuthorityDigest!==trust.currentAuthorityDigest||recovery.issuedAt>now()+30000||recovery.issuedAt<now()-120000||recovery.expiresAt<=now()||recovery.expiresAt<=recovery.issuedAt||recovery.expiresAt-recovery.issuedAt>120000||!await verify("recovery",recovery,trust.hostPublicKey))throw new OneVaultError("secure_route_unavailable");id(recovery.operationId);return trust;};
  const verifyExactReceipt=async(request:OneVaultRequest,receipt:OneVaultReceipt,identity:{operationId:string;envelopeDigest:string;action:"store"|"delete"},trust:OneVaultRendererTrust)=>{
    exact(receipt,["schema","hostId","hostKeyId","requestDigest","operationId","envelopeDigest","requestId","requestRevision","state","credentialRef","generation","providerState","errorCode","responseNonce","observedAt","signature"]);canonical(receipt);
    if(receipt.schema!==ONE_VAULT_SCHEMA||receipt.hostId!==trust.hostId||receipt.hostKeyId!==trust.hostKeyId||receipt.requestDigest!==await digest(request)||receipt.envelopeDigest!==identity.envelopeDigest||receipt.operationId!==identity.operationId||receipt.requestId!==request.binding.requestId||receipt.requestRevision!==request.binding.requestRevision||receipt.providerState!=="unverified"||!["saved","deleted","store_unknown","failed"].includes(receipt.state)||receipt.state==="saved"&&identity.action!=="store"||receipt.state==="deleted"&&identity.action!=="delete"||receipt.generation!==request.binding.expectedGeneration+(["saved","deleted"].includes(receipt.state)?1:0)||receipt.observedAt<now()-120000||receipt.observedAt>now()+30000)return false;
    return verify("receipt",receipt,trust.hostPublicKey);
  };
  return {
    async authenticate(request){const trust=await trustFor(request);if(trust.currentRecovery)throw new OneVaultError("request_consumed");return true;},
    async seal(request,operationId,action,value){
      const trust=await trustFor(request);if(trust.currentRecovery)throw new OneVaultError("request_consumed");id(operationId);id(trust.senderKeyId);
      if(action!=="store"&&action!=="delete"||action==="delete"&&value!==null||action==="store"&&(typeof value!=="string"||encode.encode(value).byteLength<1||encode.encode(value).byteLength>8192))throw new OneVaultError("invalid_envelope");
      const ephemeral=await crypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"},false,["deriveBits"]);
      const recipient=await crypto.subtle.importKey("raw",decode(request.recipientPublicKey,65).buffer as ArrayBuffer,{name:"ECDH",namedCurve:"P-256"},false,[]);
      const envelope:OneVaultEnvelope={schema:ONE_VAULT_SCHEMA,suite:ONE_VAULT_SUITE,requestDigest:await digest(request),operationId,action,senderKeyId:trust.senderKeyId,ephemeralPublicKey:b64(new Uint8Array(await crypto.subtle.exportKey("raw",ephemeral.publicKey))),iv:b64(crypto.getRandomValues(new Uint8Array(12))),ciphertext:"",tag:"",signature:""};
      const aad=encode.encode(canonical(["aad",envelope.requestDigest,envelope.operationId,envelope.action,envelope.senderKeyId,envelope.ephemeralPublicKey,envelope.iv]));
      const shared=new Uint8Array(await crypto.subtle.deriveBits({name:"ECDH",public:recipient},ephemeral.privateKey,256));
      let plain:Uint8Array|null=null;
      try{const material=await crypto.subtle.importKey("raw",shared.buffer as ArrayBuffer,"HKDF",false,["deriveKey"]);const key=await crypto.subtle.deriveKey({name:"HKDF",hash:"SHA-256",salt:decode(request.nonce,32).buffer as ArrayBuffer,info:aad},material,{name:"AES-GCM",length:256},false,["encrypt"]);
        plain=encode.encode(canonical({action,value}));value=null;const cipher=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv:decode(envelope.iv,12).buffer as ArrayBuffer,additionalData:aad,tagLength:128},key,plain.buffer as ArrayBuffer));envelope.ciphertext=b64(cipher.subarray(0,-16));envelope.tag=b64(cipher.subarray(-16));
      }finally{shared.fill(0);plain?.fill(0);value=null;}
      // Recheck native current identity after encryption; never dispatch a stale binding.
      await trustFor(request);return sign("envelope",envelope,trust);
    },
    submit:ports.submit,
    async statusQuery(request,envelope){const trust=await trustFor(request);if(trust.currentRecovery)throw new OneVaultError("request_consumed");if(envelope.requestDigest!==await digest(request))throw new OneVaultError("invalid_envelope");return sign("status",{schema:ONE_VAULT_SCHEMA,requestDigest:envelope.requestDigest,operationId:envelope.operationId,senderKeyId:trust.senderKeyId,nonce:b64(crypto.getRandomValues(new Uint8Array(32))),expiresAt:now()+30000,signature:""},trust);},
    reconcile:ports.reconcile,
    async verifyReceipt(request,envelope,receipt,expectedResponseNonce=null){try{const trust=await trustFor(request);if(trust.currentRecovery||receipt.responseNonce!==expectedResponseNonce)return false;if(expectedResponseNonce!==null)decode(expectedResponseNonce,32);if(!await verifyExactReceipt(request,receipt,{operationId:envelope.operationId,envelopeDigest:await digest(envelope),action:envelope.action},trust))return false;const current=await trustFor(request);return canonical([current.hostId,current.hostKeyId,current.senderId,current.senderKeyId,current.trustGeneration,current.current])===canonical([trust.hostId,trust.hostKeyId,trust.senderId,trust.senderKeyId,trust.trustGeneration,trust.current])&&!current.currentRecovery;}catch{return false;}},
    async authenticateRecovery(request,recovery){await recoveryTrust(request,recovery);return true;},
    async statusQueryRecovery(request,recovery){const trust=await recoveryTrust(request,recovery);return sign("status",{schema:ONE_VAULT_SCHEMA,requestDigest:recovery.requestDigest,operationId:recovery.operationId,senderKeyId:trust.senderKeyId,nonce:b64(crypto.getRandomValues(new Uint8Array(32))),expiresAt:Math.min(now()+30000,recovery.expiresAt),signature:""},trust);},
    async verifyRecoveryReceipt(request,recovery,receipt,query){try{const trust=await recoveryTrust(request,recovery);if(query.requestDigest!==recovery.requestDigest||query.operationId!==recovery.operationId||query.senderKeyId!==trust.senderKeyId||query.expiresAt<=now()||receipt.responseNonce!==query.nonce)return false;if(!await verifyExactReceipt(request,receipt,recovery,trust))return false;const current=await recoveryTrust(request,recovery);return canonical([current.hostId,current.hostKeyId,current.senderId,current.senderKeyId,current.trustGeneration,current.current,current.currentAuthorityDigest,current.currentRecovery])===canonical([trust.hostId,trust.hostKeyId,trust.senderId,trust.senderKeyId,trust.trustGeneration,trust.current,trust.currentAuthorityDigest,trust.currentRecovery]);}catch{return false;}},
  };
}
