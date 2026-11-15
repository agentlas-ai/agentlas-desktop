import { createHash, randomBytes, verify, type KeyObject } from "node:crypto";
import { companionDirectLeaseBytes, type CompanionDirectLease } from "../../shared/companion-direct-lease";
import { COMPANION_HANDOFF_PROOF_FIELDS } from "../../shared/companion-handoff-proof";
import type Database from "better-sqlite3";
import { createWorkLeaseAuthorityVerifier, takeWorkLeaseAuthority } from "./companion-work-lease-authority";

type SignPermit = {lease:CompanionDirectLease;authorityToken:string;deviceKeyFingerprint:string;assertCurrent():void};
const signPermits=new WeakMap<object,SignPermit>();
/** Only a freshly verified server capability can become a one-use GUI signing
 * permit. The daemon boot comes from the current authenticated native channel. */
export function prepareCompanionDirectLease(authority:unknown,options:{daemonBootId():string;scopeKey():string;assertCurrent():void;now?:()=>number}):object|null {
  try {
    const server=takeWorkLeaseAuthority(authority);if(!server)return null;
    options.assertCurrent();server.assertCurrent();const now=(options.now ?? Date.now)(),boot=options.daemonBootId(),scope=options.scopeKey();
    const lease:CompanionDirectLease={binding:structuredClone(server.binding),runId:server.runId,deviceGeneration:server.deviceGeneration,
      daemonBootId:boot,scopeKey:scope,authorityDigest:createHash("sha256").update(server.token,"utf8").digest("hex"),issuedAt:now,
      expiresAt:Math.min(now+15_000,server.expiresAt),nonce:randomBytes(16).toString("hex")};
    companionDirectLeaseBytes(lease);
    const assertCurrent=()=>{options.assertCurrent();server.assertCurrent();if(options.daemonBootId()!==boot || options.scopeKey()!==scope || (options.now ?? Date.now)()>=lease.expiresAt)throw new Error("companion_lease_owner_changed");};
    assertCurrent();const permit=Object.freeze({});signPermits.set(permit,{lease,authorityToken:server.token,deviceKeyFingerprint:server.deviceKeyFingerprint,assertCurrent});return permit;
  }catch{return null;}
}
export function takeCompanionDirectLeasePermit(value:unknown):SignPermit|null {
  if(!value || typeof value!=="object")return null;const permit=signPermits.get(value);signPermits.delete(value);
  if(!permit)return null;try{permit.assertCurrent();return permit}catch{return null;}
}

type Scope = {binding:Record<string,unknown>;runId:string;deviceGeneration:number;daemonBootId:string;scopeKey:string;authorityDigest:string};

/** The daemon receives a GUI-signed lease, never the GUI private key. Its
 * native enrollment supplies the GUI public key; its own current owner and
 * registered-device authority supply the expected scope independently. */
export function createCompanionDirectLeaseVerifier(options:{guiPublicKey:KeyObject;scope():Scope|null;assertCurrent():void;now?:()=>number}) {
  if(options.guiPublicKey?.type!=="public" || options.guiPublicKey.asymmetricKeyType!=="ed25519")throw new TypeError("companion_lease_key_invalid");
  const now=options.now ?? Date.now;
  return function verifyLease(lease:unknown, signature:unknown):boolean {
    try {
      options.assertCurrent();const bytes=companionDirectLeaseBytes(lease),v=lease as CompanionDirectLease,expected=options.scope(),time=now();
      if(!expected || !Number.isSafeInteger(time) || v.issuedAt>time || v.expiresAt<=time || v.runId!==expected.runId ||
        v.deviceGeneration!==expected.deviceGeneration || v.daemonBootId!==expected.daemonBootId || v.scopeKey!==expected.scopeKey || v.authorityDigest!==expected.authorityDigest ||
        COMPANION_HANDOFF_PROOF_FIELDS.some(field=>v.binding[field]!==expected.binding[field]) ||
        typeof signature!=="string" || !/^[A-Za-z0-9_-]+$/.test(signature))return false;
      const raw=Buffer.from(signature,"base64url");
      if(raw.length!==64 || raw.toString("base64url")!==signature || !verify(null,bytes,options.guiPublicKey,raw))return false;
      options.assertCurrent();const current=options.scope();
      return !!current && v.expiresAt>now() && v.runId===current.runId && v.deviceGeneration===current.deviceGeneration &&
        v.daemonBootId===current.daemonBootId && v.scopeKey===current.scopeKey && v.authorityDigest===current.authorityDigest &&
        COMPANION_HANDOFF_PROOF_FIELDS.every(field=>v.binding[field]===current.binding[field]);
    } catch {return false;}
  };
}

/** Daemon-side double verification: neither a GUI signature nor a server
 * attestation alone authorizes a run, and both name the same GUI key. */
export function createAttestedCompanionLeaseVerifier(options:{guiPublicKey:KeyObject;serverPublicKey:KeyObject;
  target():{binding:Record<string,unknown>;runId:string;daemonBootId:string;scopeKey:string}|null;assertCurrent():void;now?:()=>number}) {
  const fingerprint=createHash("sha256").update(options.guiPublicKey.export({type:"spki",format:"der"})).digest("hex");
  const server=createWorkLeaseAuthorityVerifier({publicKey:options.serverPublicKey,assertCurrent:options.assertCurrent,now:options.now,
    target:()=>{const target=options.target();return target ? {binding:target.binding,runId:target.runId,deviceKeyFingerprint:fingerprint} : null;}});
  return (lease:unknown,signature:unknown,authorityToken:unknown):boolean=>{
    try {
      const proof=takeWorkLeaseAuthority(server(authorityToken));if(!proof)return false;
      const tokenDigest=createHash("sha256").update(proof.token,"utf8").digest("hex"),target=options.target();
      if(!target || !lease || typeof lease!=="object" || (lease as CompanionDirectLease).expiresAt>proof.expiresAt)return false;
      const verifyLease=createCompanionDirectLeaseVerifier({guiPublicKey:options.guiPublicKey,assertCurrent:options.assertCurrent,now:options.now,
        scope:()=>{const live=options.target();return live ? {binding:live.binding,runId:live.runId,deviceGeneration:proof.deviceGeneration,
          daemonBootId:live.daemonBootId,scopeKey:live.scopeKey,authorityDigest:tokenDigest} : null;}});
      proof.assertCurrent();return verifyLease(lease,signature) && (proof.assertCurrent(),true);
    }catch{return false;}
  };
}

/** Shared local storage contains only verified signed leases and their signed
 * server evidence. Scope is an opaque GUI-owned session digest, not a cookie. */
export function createCompanionDirectLeaseStore(options:{db:Database.Database;assertScope(scope:string):void;
  verify(lease:unknown,signature:unknown,authorityToken:unknown):boolean;now?:()=>number}) {
  const now=options.now ?? Date.now;
  options.db.exec(`CREATE TABLE IF NOT EXISTS one_companion_direct_leases (
    command_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,scope_key TEXT NOT NULL,lease_json TEXT NOT NULL,
    signature TEXT NOT NULL,authority_token TEXT NOT NULL,expires_at INTEGER NOT NULL
  )`);
  function put(scope:string,lease:CompanionDirectLease,signature:string,authorityToken:string):void {
    if(!/^[a-f0-9]{64}$/.test(scope) || typeof signature!=="string" || typeof authorityToken!=="string" || authorityToken.length>8192)throw new Error("companion_lease_input_invalid");
    options.db.transaction(()=>{
      options.assertScope(scope);
      if(lease.scopeKey!==scope)throw new Error("companion_lease_scope_conflict");
      if(!options.verify(lease,signature,authorityToken) || lease.expiresAt<=now())throw new Error("companion_lease_authority_invalid");
      const command=lease.binding.commandId;if(typeof command!=="string")throw new Error("companion_lease_input_invalid");
      const previous=options.db.prepare("SELECT scope_key,run_id FROM one_companion_direct_leases WHERE command_id=?").get(command) as {scope_key:string;run_id:string}|undefined;
      if(previous && (previous.scope_key!==scope || previous.run_id!==lease.runId))throw new Error("companion_lease_scope_conflict");
      options.db.prepare(`INSERT INTO one_companion_direct_leases(command_id,run_id,scope_key,lease_json,signature,authority_token,expires_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(command_id) DO UPDATE SET lease_json=excluded.lease_json,signature=excluded.signature,
        authority_token=excluded.authority_token,expires_at=excluded.expires_at`).run(command,lease.runId,scope,JSON.stringify(lease),signature,authorityToken,lease.expiresAt);
      options.assertScope(scope);
      if(!options.verify(lease,signature,authorityToken) || lease.expiresAt<=now())throw new Error("companion_lease_authority_invalid");
    }).immediate();
  }
  function read(scope:string,commandId:string,runId:string):boolean {
    try {
      options.assertScope(scope);
      const row=options.db.prepare("SELECT * FROM one_companion_direct_leases WHERE command_id=? AND run_id=? AND scope_key=?").get(commandId,runId,scope) as
        {lease_json:string;signature:string;authority_token:string;expires_at:number}|undefined;
      if(!row || row.expires_at<=now())return false;
      const lease:unknown=JSON.parse(row.lease_json);if(!options.verify(lease,row.signature,row.authority_token))return false;
      options.assertScope(scope);return row.expires_at>now();
    } catch {return false;}
  }
  function revoke(scope:string,commandId?:string):void {
    if(!/^[a-f0-9]{64}$/.test(scope))throw new Error("companion_lease_scope_invalid");
    if(commandId===undefined)options.db.prepare("DELETE FROM one_companion_direct_leases WHERE scope_key=?").run(scope);
    else options.db.prepare("DELETE FROM one_companion_direct_leases WHERE scope_key=? AND command_id=?").run(scope,commandId);
  }
  return Object.freeze({put,read,revoke});
}
