import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { ONE_VAULT_SCHEMA, ONE_VAULT_SUITE, OneVaultError, oneVaultCanonical as canonical, oneVaultUnsigned as unsigned, type OneVaultBinding, type OneVaultRequest, type OneVaultEnvelope, type OneVaultReceipt, type OneVaultStatusQuery, type OneVaultCancelQuery } from '../../shared/one-vault';
// NOTE: parent integration changes ../../shared to ../../../shared? In product electron/secrets -> ../../shared is correct.
const b64 = (v: Uint8Array) => Buffer.from(v).toString('base64url');
export const oneVaultDigest = (v: unknown): string => createHash('sha256').update(canonical(v)).digest('hex');
export function decodeOneVaultBase64(v: string, length?: number): Buffer {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]*$/.test(v) || v.length > 24576) throw new OneVaultError('invalid_envelope');
  const decoded = Buffer.from(v, 'base64url');
  if (b64(decoded) !== v || length !== undefined && decoded.length !== length) throw new OneVaultError('invalid_envelope');
  return decoded;
}
function exact(v: object, keys: string[]): void {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).sort().join('|') !== keys.sort().join('|')) throw new OneVaultError('invalid_request');
}
function id(v: unknown): void { if (typeof v !== 'string' || !/^[A-Za-z0-9._:/@ -]{1,256}$/.test(v)) throw new OneVaultError('invalid_request'); }
function integer(v: unknown): void { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new OneVaultError('invalid_request'); }
export function validateOneVaultBinding(b: OneVaultBinding): void {
  const keys = ['requestId','requestRevision','commandId','intentDigest','principalId','sessionId','scope','organizationId','workspaceId','resourceId','purpose','payerId','taskId','runId','controlVersion','authorityRevision','provider','providerWorkspace','region','endpoint','operations','permissionRevision','storage','expectedGeneration','cost','hostId','senderId','trustGeneration'];
  exact(b, keys);
  for (const key of keys.filter(k => !['organizationId','operations','cost','requestRevision','expectedGeneration','trustGeneration','controlVersion'].includes(k))) id((b as unknown as Record<string,unknown>)[key]);
  if(b.controlVersion===null){if(!b.taskId.startsWith('one:')||b.taskId.length<=4)throw new OneVaultError('invalid_request');}else id(b.controlVersion);
  for (const n of [b.requestRevision,b.expectedGeneration,b.trustGeneration]) integer(n);
  if (!/^[a-f0-9]{64}$/.test(b.intentDigest) || !['personal','organization'].includes(b.scope) || b.storage !== 'os-vault') throw new OneVaultError('invalid_request');
  if (b.scope === 'organization') id(b.organizationId); else if (b.organizationId !== null) throw new OneVaultError('invalid_request');
  if (!Array.isArray(b.operations) || b.operations.length < 1 || b.operations.length > 32 || new Set(b.operations).size !== b.operations.length) throw new OneVaultError('invalid_request');
  b.operations.forEach(id);
  if (b.cost !== null) { exact(b.cost,['currency','maxMinor','consentRevision']); id(b.cost.currency); id(b.cost.consentRevision); integer(b.cost.maxMinor); }
  if (!b.endpoint.startsWith('https://')) throw new OneVaultError('invalid_request');
}
export function validateOneVaultRequest(r: OneVaultRequest, now = Date.now(), allowExpired = false): void {
  exact(r,['schema','suite','binding','nonce','issuedAt','expiresAt','hostKeyId','recipientKeyId','recipientPublicKey','signature']);
  validateOneVaultBinding(r.binding); integer(r.issuedAt); integer(r.expiresAt); id(r.hostKeyId); id(r.recipientKeyId);
  if (r.schema !== ONE_VAULT_SCHEMA || r.suite !== ONE_VAULT_SUITE || r.expiresAt <= r.issuedAt || r.expiresAt-r.issuedAt > 300000 || r.issuedAt > now+30000) throw new OneVaultError('invalid_request');
  if (!allowExpired && r.expiresAt <= now) throw new OneVaultError('request_expired');
  decodeOneVaultBase64(r.nonce,32); decodeOneVaultBase64(r.recipientPublicKey,65); decodeOneVaultBase64(r.signature,64);
}
export function oneVaultPublicPoint(key: KeyObject): string {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  const jwk = pub.export({format:'jwk'});
  if (jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new OneVaultError('secure_route_unavailable');
  return b64(Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x,'base64url'),Buffer.from(jwk.y,'base64url')]));
}
export function oneVaultPublicKey(point: string): KeyObject {
  const raw = decodeOneVaultBase64(point,65);
  if (raw[0] !== 4) throw new OneVaultError('invalid_envelope');
  try { return createPublicKey({key:{kty:'EC',crv:'P-256',x:b64(raw.subarray(1,33)),y:b64(raw.subarray(33))},format:'jwk'}); }
  catch { throw new OneVaultError('invalid_envelope'); }
}
export function generateOneVaultKey(): {privateKey: KeyObject; publicKey: KeyObject} { return generateKeyPairSync('ec',{namedCurve:'prime256v1'}); }
function transcript(domain: string, value: unknown): Buffer { return Buffer.from(canonical([domain,value]),'utf8'); }
export function signOneVault<T extends {signature:string}>(domain: 'request'|'envelope'|'receipt'|'status'|'recovery'|'cancel'|'cancel-receipt', value:T, privateKey:KeyObject):T {
  oneVaultPublicPoint(privateKey);
  return {...value,signature:b64(sign('sha256',transcript(domain,unsigned(value)),{key:privateKey,dsaEncoding:'ieee-p1363'}))};
}
export function verifyOneVault(domain:'request'|'envelope'|'receipt'|'status'|'recovery'|'cancel'|'cancel-receipt',value:{signature:string},trustedPublicKey:string):boolean {
  try { return verify('sha256',transcript(domain,unsigned(value)),{key:oneVaultPublicKey(trustedPublicKey),dsaEncoding:'ieee-p1363'},decodeOneVaultBase64(value.signature,64)); } catch { return false; }
}
export function issueOneVaultRequest(binding:OneVaultBinding, keys:{hostKeyId:string; signingKey:KeyObject; recipientKeyId:string; recipientKey:KeyObject}, now=Date.now()):OneVaultRequest {
  validateOneVaultBinding(binding);
  const request = signOneVault('request',{schema:ONE_VAULT_SCHEMA,suite:ONE_VAULT_SUITE,binding:structuredClone(binding),nonce:b64(randomBytes(32)),issuedAt:now,expiresAt:now+120000,hostKeyId:keys.hostKeyId,recipientKeyId:keys.recipientKeyId,recipientPublicKey:oneVaultPublicPoint(keys.recipientKey),signature:''},keys.signingKey);
  validateOneVaultRequest(request,now); return request;
}
export function oneVaultAad(e:OneVaultEnvelope):string { return canonical(['aad',e.requestDigest,e.operationId,e.action,e.senderKeyId,e.ephemeralPublicKey,e.iv]); }
function encryptionKey(privateKey:KeyObject,publicKey:string,nonce:string,aad:string):Buffer {
  const shared = diffieHellman({privateKey,publicKey:oneVaultPublicKey(publicKey)});
  try { return Buffer.from(hkdfSync('sha256',shared,decodeOneVaultBase64(nonce,32),Buffer.from(aad),32)); } finally { shared.fill(0); }
}
/** Main/synthetic harness helper. UI must use WebCrypto/native equivalent without forwarding plaintext. */
export function sealOneVault(request:OneVaultRequest,trustedHostPublicKey:string,senderKeyId:string,senderPrivateKey:KeyObject,operationId:string,value:Buffer|null,now=Date.now()):OneVaultEnvelope {
  validateOneVaultRequest(request,now);
  if (!verifyOneVault('request',request,trustedHostPublicKey)) throw new OneVaultError('host_mismatch');
  id(operationId); id(senderKeyId);
  if (value !== null && (value.length < 1 || value.length > 8192)) throw new OneVaultError('invalid_envelope');
  const ephemeral = generateOneVaultKey();
  const e:OneVaultEnvelope = {schema:ONE_VAULT_SCHEMA,suite:ONE_VAULT_SUITE,requestDigest:oneVaultDigest(request),operationId,action:value===null?'delete':'store',senderKeyId,ephemeralPublicKey:oneVaultPublicPoint(ephemeral.publicKey),iv:b64(randomBytes(12)),ciphertext:'',tag:'',signature:''};
  const aad = oneVaultAad(e), key = encryptionKey(ephemeral.privateKey,request.recipientPublicKey,request.nonce,aad);
  const plaintext = Buffer.from(canonical({action:e.action,value:value===null?null:value.toString('utf8')}));
  try { const cipher=createCipheriv('aes-256-gcm',key,decodeOneVaultBase64(e.iv,12)); cipher.setAAD(Buffer.from(aad)); e.ciphertext=b64(Buffer.concat([cipher.update(plaintext),cipher.final()])); e.tag=b64(cipher.getAuthTag()); return signOneVault('envelope',e,senderPrivateKey); }
  finally { key.fill(0); plaintext.fill(0); }
}
export function authenticateOneVaultEnvelope(request:OneVaultRequest,e:OneVaultEnvelope,trustedSenderPublicKey:string):void {
  exact(e,['schema','suite','requestDigest','operationId','action','senderKeyId','ephemeralPublicKey','iv','ciphertext','tag','signature']);
  id(e.operationId); id(e.senderKeyId);
  if(e.schema!==ONE_VAULT_SCHEMA || e.suite!==ONE_VAULT_SUITE || !['store','delete'].includes(e.action) || e.requestDigest!==oneVaultDigest(request)) throw new OneVaultError('invalid_envelope');
  decodeOneVaultBase64(e.ephemeralPublicKey,65); decodeOneVaultBase64(e.iv,12); decodeOneVaultBase64(e.tag,16); decodeOneVaultBase64(e.ciphertext);
  if (!verifyOneVault('envelope',e,trustedSenderPublicKey)) throw new OneVaultError('sender_untrusted');
}
export function openOneVault(request:OneVaultRequest,e:OneVaultEnvelope,trustedSenderPublicKey:string,recipientPrivateKey:KeyObject):Buffer|null {
  authenticateOneVaultEnvelope(request,e,trustedSenderPublicKey);
  const aad=oneVaultAad(e), key=encryptionKey(recipientPrivateKey,e.ephemeralPublicKey,request.nonce,aad); let plaintext:Buffer|undefined;
  try {
    const decipher=createDecipheriv('aes-256-gcm',key,decodeOneVaultBase64(e.iv,12)); decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(decodeOneVaultBase64(e.tag,16));
    plaintext=Buffer.concat([decipher.update(decodeOneVaultBase64(e.ciphertext)),decipher.final()]);
    const v=JSON.parse(plaintext.toString('utf8')); exact(v,['action','value']);
    if(v.action!==e.action || e.action==='delete' && v.value!==null || e.action==='store' && (typeof v.value!=='string' || Buffer.byteLength(v.value)<1 || Buffer.byteLength(v.value)>8192)) throw new OneVaultError('invalid_envelope');
    return v.value===null?null:Buffer.from(v.value,'utf8');
  } catch { throw new OneVaultError('invalid_envelope'); } finally { key.fill(0); plaintext?.fill(0); }
}
/** Initial submit has no status nonce. A status reply must explicitly supply
 * its pending query nonce; host signature validity alone is not freshness. */
export function verifyOneVaultReceipt(r:OneVaultReceipt,request:OneVaultRequest,e:OneVaultEnvelope,trustedHostPublicKey:string,expectedResponseNonce:string|null=null):boolean {
  try {
    exact(r,['schema','hostId','hostKeyId','requestDigest','operationId','envelopeDigest','requestId','requestRevision','state','credentialRef','generation','providerState','errorCode','observedAt','responseNonce','signature']);
    if(expectedResponseNonce!==null)decodeOneVaultBase64(expectedResponseNonce,32);
    return r.schema===ONE_VAULT_SCHEMA && r.hostId===request.binding.hostId && r.hostKeyId===request.hostKeyId && r.requestDigest===oneVaultDigest(request) && r.requestId===request.binding.requestId && r.requestRevision===request.binding.requestRevision && r.operationId===e.operationId && r.envelopeDigest===oneVaultDigest(e)
      &&r.responseNonce===expectedResponseNonce&&r.providerState==='unverified'&&['saved','deleted','store_unknown','failed'].includes(r.state)
      &&!(r.state==='saved'&&e.action!=='store'||r.state==='deleted'&&e.action!=='delete')
      &&Number.isSafeInteger(r.generation)&&r.generation===request.binding.expectedGeneration+(['saved','deleted'].includes(r.state)?1:0)
      &&verifyOneVault('receipt',r,trustedHostPublicKey);
  }catch{return false;}
}
export function validateOneVaultStatus(q:OneVaultStatusQuery,request:OneVaultRequest,trustedSenderKey:string,now=Date.now()):void {
  exact(q,['schema','requestDigest','operationId','senderKeyId','nonce','expiresAt','signature']); id(q.operationId); id(q.senderKeyId); integer(q.expiresAt); decodeOneVaultBase64(q.nonce,32);
  if(q.schema!==ONE_VAULT_SCHEMA || q.requestDigest!==oneVaultDigest(request) || q.expiresAt<=now || q.expiresAt>now+120000 || !verifyOneVault('status',q,trustedSenderKey)) throw new OneVaultError('sender_untrusted');
}
/** Status consumers retain the exact signed pending query, request and envelope.
 * Original request/control validation remains the caller's native authority fence. */
export function verifyOneVaultStatusReceipt(r:OneVaultReceipt,request:OneVaultRequest,e:OneVaultEnvelope,trustedHostPublicKey:string,query:OneVaultStatusQuery,trustedSenderPublicKey:string,now=Date.now()):boolean {
  try {
    validateOneVaultStatus(query,request,trustedSenderPublicKey,now);
    return query.operationId===e.operationId&&Number.isSafeInteger(r.observedAt)&&r.observedAt>=now-120000&&r.observedAt<=now+30000
      &&verifyOneVaultReceipt(r,request,e,trustedHostPublicKey,query.nonce);
  }catch{return false;}
}

export function validateOneVaultCancel(q:OneVaultCancelQuery,request:OneVaultRequest,trustedSenderKey:string,now=Date.now()):void {
 exact(q,['schema','requestDigest','senderKeyId','nonce','expiresAt','reason','signature']);id(q.senderKeyId);integer(q.expiresAt);decodeOneVaultBase64(q.nonce,32);
 if(q.schema!=='agentlas.one-vault-cancel.v1'||q.requestDigest!==oneVaultDigest(request)||q.expiresAt<=now||q.expiresAt>now+120000||!['cancelled','expired','background'].includes(q.reason)||!verifyOneVault('cancel',q,trustedSenderKey))throw new OneVaultError('sender_untrusted');
}
