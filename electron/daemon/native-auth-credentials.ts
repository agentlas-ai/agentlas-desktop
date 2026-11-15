import { nativePreparationWireRequest, nativeStartDescriptor, type NativePreparationWireRequest } from "./native-start-protocol";
import { companionFrontReceiptBytes } from "../../shared/companion-front-receipt";
import { companionPollBytes, isCompanionPollHolding } from "../../shared/companion-poll-holding";
import { takeCompanionFrontReceiptPermit } from "../one/companion-front-receipt";
import { companionContinuityBytes } from "../../shared/companion-continuity-proof";
import { takeContinuityConsentPermit } from "../one/companion-continuity-permit";
import { takeFrontTransferConsentPermit } from "../one/companion-front-transfer-permit";
import { takeCompanionDaemonAttestationRequestPermit, takeCompanionDaemonDelegationConsentPermit } from "../one/companion-daemon-delegation-permit";
import { companionFrontTransferBytes } from "../../shared/companion-front-transfer-proof";
import { companionFrontRetirementBytes } from "../../shared/companion-front-retirement";
import fs from "node:fs";
import path from "node:path";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { createRequire } from "node:module";
import { requireConfiguredInstallIdentity, serializeInstallIdentity } from "../install-identity";
import { userDataDir } from "../runtime-paths";
import { keychainGet, keychainSet, retryKeychainReadFromUser } from "../secrets/keychain-host";
import { canonicalDaemonPath, resolveDaemonServiceIdentity } from "./service-identity";
import { sameFileIdentity } from "../../shared/file-identity";
import { companionHandoffProofBytes, companionWorkReceiptBytes, companionWorkFullChunkBytes, COMPANION_HANDOFF_PROOF_FIELDS } from "../../shared/companion-handoff-proof";
import { companionDirectLeaseBytes, type CompanionDirectLease } from "../../shared/companion-direct-lease";
import { takeCompanionDirectLeasePermit } from "../one/companion-direct-lease";

/** Encoded native frame bytes, excluding its newline. */
export const NATIVE_AUTH_MAX_FRAME_BYTES = 1048576;

export type NativeAuthBinding = Readonly<{ scope: string; serviceIdentity: string }>;
export type NativeCredential = Readonly<{ scope: string; generation: string; role: "gui" | "daemon"; publicKey: string; peerPublicKey: string }>;
type BindingState = { service: string; account: string; userDataDir: string; storePath: string };
type PairRecord = { schema: "agentlas.native-role-key.v1"; scope: string; generation: string; role: "gui" | "daemon"; publicKey: string; privateKey: string };
type Registry = { schema: "agentlas.native-auth-registry.v1"; scope: string; generation: string; state: "ready"; guiPublicKey: string; daemonPublicKey: string; guiDigest: string; daemonDigest: string };
const bindings = new WeakMap<object, BindingState>();
const keys = new WeakMap<object, KeyObject>();
const requireNative = createRequire(__filename);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export function nativeAuthError(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
function deny(code: string): never { throw nativeAuthError(code); }
function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** No path/role/boolean is accepted from a payload. Capture the already-open
 * native store and immutable native install before registering an opaque object. */
export function captureNativeAuthBinding(): NativeAuthBinding {
  const install = requireConfiguredInstallIdentity();
  const store = (requireNative("../store/db") as { openedStorePath(): string | null }).openedStorePath();
  if (!store) deny("native_auth_store_not_open");
  const directory = canonicalDaemonPath(userDataDir());
  const storePath = canonicalDaemonPath(store);
  const account = digest(JSON.stringify(["agentlas.native-auth.scope.v1", serializeInstallIdentity(install), directory, storePath]));
  const binding = Object.freeze({ scope: account, serviceIdentity: resolveDaemonServiceIdentity({ userDataDir: directory, storePath, installIdentity: install }).serviceIdentity });
  bindings.set(binding, { service: install.keychainService, account, userDataDir: directory, storePath });
  return binding;
}
export function assertNativeAuthBinding(binding: NativeAuthBinding): void { if (!bindings.has(binding)) deny("native_auth_binding_unregistered"); }
function state(binding: NativeAuthBinding): BindingState { assertNativeAuthBinding(binding); return bindings.get(binding)!; }
function keytar(): typeof import("keytar") { return requireNative("keytar") as typeof import("keytar"); }
function account(binding: NativeAuthBinding, kind: "gui-private" | "daemon-private" | "registry"): string { return `native-auth:v1:${kind}:${state(binding).account}`; }
async function read(binding: NativeAuthBinding, kind: "gui-private" | "daemon-private" | "registry"): Promise<string | null> {
  const service = state(binding).service, name = account(binding, kind);
  // null is verified absence; an exception remains unavailable. Never catch it
  // as absence or invoke a fallback namespace/backend.
  return keychainGet(service, name, () => keytar().getPassword(service, name));
}
/** Value-free match against the current installation; no caller may choose an arbitrary account. */
export function nativeGuiRecoveryKind(service: string, resourceAccount: string): "registry" | "gui-private" | null {
  const binding = captureNativeAuthBinding();
  if (state(binding).service !== service) return null;
  return (["registry", "gui-private"] as const).find((kind) => account(binding, kind) === resourceAccount) ?? null;
}
/** One user-initiated retry, executed inside the current One owner process. */
export async function retryNativeGuiResourceFromUser(kind: "registry" | "gui-private"): Promise<"restored" | "missing"> {
  if (kind !== "registry" && kind !== "gui-private") deny("native_auth_recovery_invalid");
  const binding = captureNativeAuthBinding(), service = state(binding).service;
  // A service pause may block both the registry and GUI key even when only one
  // originally failed. Reopen exactly these two linked resources in the owner
  // process; unrelated credentials are never read or unpaused.
  const retry = (part: "registry" | "gui-private") => {
    const name = account(binding, part);
    return retryKeychainReadFromUser(service, name, () => keytar().getPassword(service, name));
  };
  const rawRegistry = await retry("registry");
  if (rawRegistry === null) return "missing";
  const reg = registry(rawRegistry, binding);
  const rawGui = await retry("gui-private");
  if (rawGui === null) return "missing";
  pairRecord(rawGui, binding, reg, "gui");
  return "restored";
}
async function write(binding: NativeAuthBinding, kind: "gui-private" | "daemon-private" | "registry", value: string): Promise<void> {
  const service = state(binding).service, name = account(binding, kind);
  // Automatic bootstrap is not a fresh user permission decision.
  await keychainSet(service, name, value, () => keytar().setPassword(service, name, value), false);
  if (await read(binding, kind) !== value) deny("native_auth_write_unconfirmed");
}
function json(value: string | null): unknown { if (value === null) return null; if (Buffer.byteLength(value) > 16_384) deny("native_auth_credential_too_large"); try { return JSON.parse(value); } catch { return deny("native_auth_credential_invalid"); } }
function registry(raw: string | null, binding: NativeAuthBinding): Registry {
  const r = json(raw);
  if (!exact(r, ["schema", "scope", "generation", "state", "guiPublicKey", "daemonPublicKey", "guiDigest", "daemonDigest"]) || r.schema !== "agentlas.native-auth-registry.v1" || r.scope !== binding.scope || r.state !== "ready" || typeof r.generation !== "string" || !/^[a-f0-9]{64}$/.test(r.generation) || ![r.guiPublicKey, r.daemonPublicKey].every(v => typeof v === "string" && v.length < 1024) || ![r.guiDigest, r.daemonDigest].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))) deny("native_auth_registry_invalid");
  return r as Registry;
}
function pairRecord(raw: string | null, binding: NativeAuthBinding, reg: Registry, role: "gui" | "daemon"): PairRecord {
  const value = json(raw);
  if (!exact(value, ["schema", "scope", "generation", "role", "publicKey", "privateKey"]) || value.schema !== "agentlas.native-role-key.v1" || value.scope !== binding.scope || value.generation !== reg.generation || value.role !== role || typeof value.publicKey !== "string" || typeof value.privateKey !== "string") deny("native_auth_role_record_invalid");
  const expected = role === "gui" ? reg.guiPublicKey : reg.daemonPublicKey;
  const expectedDigest = role === "gui" ? reg.guiDigest : reg.daemonDigest;
  if (digest(raw!) !== expectedDigest || value.publicKey !== expected) deny("native_auth_credential_mismatch");
  try { const priv = createPrivateKey(value.privateKey); if (priv.asymmetricKeyType !== "ed25519" || createPublicKey(priv).export({ type: "spki", format: "pem" }) !== expected) deny("native_auth_key_pair_invalid"); } catch { deny("native_auth_key_pair_invalid"); }
  return value as PairRecord;
}
function handle(record: PairRecord, reg: Registry): NativeCredential {
  const credential = Object.freeze({ scope: record.scope, generation: record.generation, role: record.role, publicKey: record.publicKey, peerPublicKey: record.role === "gui" ? reg.daemonPublicKey : reg.guiPublicKey });
  keys.set(credential, createPrivateKey(record.privateKey)); return credential;
}
function lock(binding: NativeAuthBinding): () => void {
  const target = path.join(state(binding).userDataDir, `.native-auth-${binding.scope}.lock`);
  let fd: number;
  try { fd = fs.openSync(target, "wx", 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") deny("native_auth_provision_busy"); throw error; }
  const identity = fs.fstatSync(fd);
  return () => { try { const current = fs.lstatSync(target); if (sameFileIdentity(current, identity)) fs.unlinkSync(target); } finally { fs.closeSync(fd); } };
}
/** Native GUI startup only. Registry-last; no destructive repair/rotation,
 * expiry lock, generic secret namespace, or automatic keychain retry. */
export async function provisionNativeGuiCredential(binding: NativeAuthBinding): Promise<NativeCredential> {
  const release = lock(binding);
  try {
    const rawRegistry = await read(binding, "registry");
    if (rawRegistry !== null) { const reg = registry(rawRegistry, binding); const gui = pairRecord(await read(binding, "gui-private"), binding, reg, "gui"); pairRecord(await read(binding, "daemon-private"), binding, reg, "daemon"); return handle(gui, reg); }
    const oldGui = await read(binding, "gui-private"); if (oldGui !== null) deny("native_auth_provision_partial");
    const oldDaemon = await read(binding, "daemon-private"); if (oldDaemon !== null) deny("native_auth_provision_partial");
    const generation = randomBytes(32).toString("hex");
    const generate = (role: "gui" | "daemon"): PairRecord => { const pair = generateKeyPairSync("ed25519"); return { schema: "agentlas.native-role-key.v1", scope: binding.scope, generation, role, publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString() }; };
    const gui = generate("gui"), daemon = generate("daemon"), guiWire = JSON.stringify(gui), daemonWire = JSON.stringify(daemon);
    await write(binding, "gui-private", guiWire); await write(binding, "daemon-private", daemonWire);
    const reg: Registry = { schema: "agentlas.native-auth-registry.v1", scope: binding.scope, generation, state: "ready", guiPublicKey: gui.publicKey, daemonPublicKey: daemon.publicKey, guiDigest: digest(guiWire), daemonDigest: digest(daemonWire) };
    await write(binding, "registry", JSON.stringify(reg)); return handle(gui, reg);
  } finally { release(); }
}
/** Autostart/load-only path intentionally never reads the GUI private account. */
export async function loadNativeDaemonCredential(binding: NativeAuthBinding): Promise<NativeCredential> {
  const raw = await read(binding, "registry"); if (raw === null) deny("native_auth_not_provisioned");
  const reg = registry(raw, binding); return handle(pairRecord(await read(binding, "daemon-private"), binding, reg, "daemon"), reg);
}
export async function loadNativeGuiCredential(binding: NativeAuthBinding): Promise<NativeCredential> {
  const raw = await read(binding, "registry"); if (raw === null) deny("native_auth_not_provisioned");
  const reg = registry(raw, binding); return handle(pairRecord(await read(binding, "gui-private"), binding, reg, "gui"), reg);
}
/** Module-only closed protocol operation, not an IPC/sign-arbitrary-data API. */
export function signNativeAuthFrame(credential: NativeCredential, frame: Readonly<Record<string, unknown>>): string {
  const key = keys.get(credential); if (!key) deny("native_auth_credential_unregistered");
  if (frame.scope !== credential.scope || frame.generation !== credential.generation) deny("native_auth_sign_scope_denied");
  const gui = frame.domain === "agentlas.native.proof.v1" || frame.domain === "agentlas.native.request.v1" || frame.domain === "agentlas.native.checkpointReply.v1";
  const daemon = frame.domain === "agentlas.native.challenge.v1" || frame.domain === "agentlas.native.accept.v1" || frame.domain === "agentlas.native.reply.v1" || frame.domain === "agentlas.native.event.v1" || frame.domain === "agentlas.native.checkpoint.v1";
  if (credential.role === "gui" ? !gui : !daemon) deny("native_auth_sign_domain_denied");
  return sign(null, Buffer.from(nativeAuthCanonical(frame)), key).toString("base64");
}

/** The GUI key may sign only the closed Companion authority transcripts.
 * This is not a generic signing port; account and paired-device admission is
 * performed by the original mobile bridge before invoking it. */
export function nativeCompanionPublicKey(credential: NativeCredential): string {
  if (credential.role !== "gui" || !keys.has(credential)) deny("native_companion_gui_required");
  return createPublicKey(credential.publicKey).export({ type: "spki", format: "der" }).toString("base64url");
}
/** GUI-only, one-use server-attested Work lease. No arbitrary bytes or
 * unverified binding can reach this signing operation. */
export function signNativeCompanionDirectLease(credential:NativeCredential,capability:unknown):{lease:CompanionDirectLease;signature:string;authorityToken:string} {
  const key=keys.get(credential);if(!key || credential.role!=="gui")deny("native_companion_gui_required");
  const permit=takeCompanionDirectLeasePermit(capability);if(!permit)deny("companion_lease_permit_invalid");
  const der=createPublicKey(credential.publicKey).export({type:"spki",format:"der"});
  if(createHash("sha256").update(der).digest("hex")!==permit.deviceKeyFingerprint)deny("companion_lease_key_changed");
  permit.assertCurrent();const signature=sign(null,companionDirectLeaseBytes(permit.lease),key).toString("base64url");permit.assertCurrent();
  return {lease:permit.lease,signature,authorityToken:permit.authorityToken};
}
/** Main-only receipt signer. It is not an IPC operation: the trusted Work
 * receipt owner must construct the value from durable Desktop state. */
export function signNativeCompanionWorkReceipt(credential: NativeCredential, value: unknown): string {
  const key = keys.get(credential);
  if (!key || credential.role !== "gui") deny("native_companion_gui_required");
  let bytes: Buffer;
  try { bytes = companionWorkReceiptBytes(value); }
  catch { return deny("native_companion_receipt_invalid"); }
  return sign(null, bytes, key).toString("base64url");
}
/** Closed chunk transcript; callers cannot sign an arbitrary message. */
export function signNativeCompanionWorkFullChunk(credential: NativeCredential, value: unknown): string {
  const key = keys.get(credential);
  if (!key || credential.role !== "gui") deny("native_companion_gui_required");
  let bytes: Buffer;
  try { bytes = companionWorkFullChunkBytes(value); } catch { return deny("native_companion_chunk_invalid"); }
  return sign(null, bytes, key).toString("base64url");
}

/** Requesting Main attestation is distinct from user consent. */
export function signNativeCompanionDaemonAttestationRequest(credential:NativeCredential,capability:unknown):string {
  const key=keys.get(credential);if(!key||credential.role!=="gui")deny("native_companion_gui_required");
  const {companionDaemonDelegationBytes}=require("../../shared/companion-daemon-delegation") as typeof import("../../shared/companion-daemon-delegation");
  const value=takeCompanionDaemonAttestationRequestPermit(capability);if(!value)deny("daemon_attestation_permit_required");
  const fingerprint=createHash("sha256").update(createPublicKey(credential.publicKey).export({type:"spki",format:"der"})).digest("hex");
  if(fingerprint!==value.guiKeyFingerprint)deny("daemon_attestation_key_changed");
  value.assertCurrent();const result=sign(null,companionDaemonDelegationBytes("attestation-request",value.binding),key).toString("base64url");value.assertCurrent();return result;
}
/** The GUI consent capability is one-use and was created only after a fresh
 * Main attestation and an explicit decision for this exact target. */
export function signNativeCompanionDaemonDelegation(credential:NativeCredential,capability:unknown):string {
  const key=keys.get(credential);if(!key||credential.role!=="gui")deny("native_companion_gui_required");
  const {companionDaemonDelegationBytes}=require("../../shared/companion-daemon-delegation") as typeof import("../../shared/companion-daemon-delegation");
  const value=takeCompanionDaemonDelegationConsentPermit(capability);if(!value)deny("daemon_consent_permit_required");
  const fingerprint=createHash("sha256").update(createPublicKey(credential.publicKey).export({type:"spki",format:"der"})).digest("hex");
  if(fingerprint!==value.guiKeyFingerprint)deny("daemon_consent_key_changed");
  value.assertCurrent();const result=sign(null,companionDaemonDelegationBytes("gui",value.binding),key).toString("base64url");value.assertCurrent();return result;
}
/** The daemon proves possession only for a current, locally matched target.
 * This signature alone is never an approval or a generic signing port. */
export function signNativeCompanionDaemonPossession(credential:NativeCredential,capability:unknown):string {
  const key=keys.get(credential);if(!key||credential.role!=="daemon")deny("native_companion_daemon_required");
  const {takeCompanionDaemonPossessionPermit}=require("./companion-daemon-delegation-possession") as typeof import("./companion-daemon-delegation-possession");
  const {companionDaemonDelegationBytes}=require("../../shared/companion-daemon-delegation") as typeof import("../../shared/companion-daemon-delegation");
  const value=takeCompanionDaemonPossessionPermit(capability);if(!value)deny("daemon_possession_permit_required");
  const der=createPublicKey(credential.publicKey).export({type:"spki",format:"der"}).toString("base64url");
  if(der!==value.binding.daemonPublicKey)deny("daemon_possession_key_changed");
  value.assertCurrent();const result=sign(null,companionDaemonDelegationBytes("possession",value.binding),key).toString("base64url");value.assertCurrent();return result;
}
/** A registered Desktop signs only these purpose-separated intake transcripts.
 * The caller must independently bind them to the current local account and device.
 * `holding` (direct-work-capacity R5, poll v2): present = the v2 transcript that also signs the list of commands this registration holds (shared/companion-poll-holding.ts); absent = v1. */
export function signNativeCompanionDirectPoll(credential: NativeCredential, value: unknown): string {
  const key = keys.get(credential);
  if (!key || credential.role !== "gui") deny("native_companion_gui_required");
  const v2 = !!value && typeof value === "object" && Object.hasOwn(value, "holding");
  if (!exact(value, v2 ? ["userId", "deviceId", "hostId", "oneId", "challenge", "holding"] : ["userId", "deviceId", "hostId", "oneId", "challenge"])) deny("native_companion_proof_invalid");
  const b = value as Record<string, unknown>;
  if (![b.userId, b.deviceId, b.hostId, b.oneId].every(v => typeof v === "string" && /^[A-Za-z0-9_.:@-]{1,128}$/.test(v)) ||
      typeof b.challenge !== "string" || b.challenge.length < 16 || b.challenge.length > 4096 || !/^[A-Za-z0-9_.-]+$/.test(b.challenge) ||
      (v2 && !isCompanionPollHolding(b.holding)))
    deny("native_companion_proof_invalid");
  return sign(null, companionPollBytes("direct", b as Parameters<typeof companionPollBytes>[1], v2 ? b.holding as string[] : undefined), key).toString("base64url");
}

export function signNativeCompanionDirectClaim(credential: NativeCredential, binding: unknown, challenge: unknown): string {
  const key = keys.get(credential);
  if (!key || credential.role !== "gui") deny("native_companion_gui_required");
  try { companionHandoffProofBytes(binding); } catch { return deny("native_companion_proof_invalid"); }
  if (typeof challenge !== "string" || challenge.length < 16 || challenge.length > 4096 || !/^[A-Za-z0-9_.-]+$/.test(challenge)) deny("native_companion_proof_invalid");
  const b = binding as Record<string, unknown>;
  if (b.method !== "one.work-handoff.send.v1") deny("native_companion_proof_invalid");
  return sign(null, Buffer.from(JSON.stringify(["agentlas.companion.desktop-direct.claim.v1", ...COMPANION_HANDOFF_PROOF_FIELDS.map(field => b[field]), challenge]), "utf8"), key).toString("base64url");
}

/** A lifecycle proof is tied to one accepted command and one exact local run. */
export function signNativeCompanionDirectLifecycle(credential: NativeCredential, purpose: "start" | "status", binding: unknown, challenge: unknown, runId: unknown): string {
  const key = keys.get(credential);
  if (!key || credential.role !== "gui") deny("native_companion_gui_required");
  try { companionHandoffProofBytes(binding); } catch { return deny("native_companion_proof_invalid"); }
  if ((purpose !== "start" && purpose !== "status") || typeof challenge !== "string" || challenge.length < 16 || challenge.length > 4096 ||
      !/^[A-Za-z0-9_.-]+$/.test(challenge) || typeof runId !== "string" || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(runId)) deny("native_companion_proof_invalid");
  const b = binding as Record<string, unknown>;
  if (b.method !== "one.work-handoff.send.v1") deny("native_companion_proof_invalid");
  return sign(null, Buffer.from(JSON.stringify([`agentlas.companion.desktop-direct.${purpose}.v1`, ...COMPANION_HANDOFF_PROOF_FIELDS.map(field => b[field]), challenge, runId]), "utf8"), key).toString("base64url");
}

/** The personal front uses distinct domains and cannot sign a Work command. `holding`: as for the direct poll (the front's own commands). */
export function signNativeCompanionFrontPoll(credential: NativeCredential, value: unknown): string {
  const key = keys.get(credential);
  if (!key || credential.role !== "gui") deny("native_companion_gui_required");
  const v2 = !!value && typeof value === "object" && Object.hasOwn(value, "holding");
  if (!exact(value,v2 ? ["userId","deviceId","hostId","oneId","challenge","holding"] : ["userId","deviceId","hostId","oneId","challenge"])) deny("native_companion_proof_invalid");
  const b=value as Record<string,unknown>;
  if (![b.userId,b.deviceId,b.hostId,b.oneId].every(v=>typeof v === "string" && /^[A-Za-z0-9_.:@-]{1,128}$/.test(v)) ||
      typeof b.challenge !== "string" || b.challenge.length < 16 || b.challenge.length > 4096 || !/^fc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(b.challenge) ||
      (v2 && !isCompanionPollHolding(b.holding))) deny("native_companion_proof_invalid");
  return sign(null,companionPollBytes("front",b as Parameters<typeof companionPollBytes>[1],v2 ? b.holding as string[] : undefined),key).toString("base64url");
}
export function signNativeCompanionFrontClaim(credential: NativeCredential, binding: unknown, challenge: unknown): string {
  const key=keys.get(credential);
  if (!key || credential.role !== "gui") deny("native_companion_gui_required");
  if (!binding || typeof binding !== "object" || Array.isArray(binding) || (binding as Record<string,unknown>).method !== "one.front-turn.send.v1") deny("native_companion_proof_invalid");
  try { companionHandoffProofBytes({...binding,method:"one.work-handoff.send.v1"}); } catch { return deny("native_companion_proof_invalid"); }
  if (typeof challenge !== "string" || challenge.length < 16 || challenge.length > 4096 || !/^fc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(challenge)) deny("native_companion_proof_invalid");
  const b=binding as Record<string,unknown>;
  return sign(null,Buffer.from(JSON.stringify(["agentlas.companion.front-direct.claim.v1",...COMPANION_HANDOFF_PROOF_FIELDS.map(field=>b[field]),challenge]),"utf8"),key).toString("base64url");
}
/** A front lifecycle can authorize only the same front command and run. */
export function signNativeCompanionFrontLifecycle(credential: NativeCredential, purpose: "start" | "status", binding: unknown, challenge: unknown, runId: unknown): string {
  const key=keys.get(credential);
  if(!key || credential.role!=="gui")deny("native_companion_gui_required");
  if(!binding || typeof binding!=="object" || Array.isArray(binding) || (binding as Record<string,unknown>).method!=="one.front-turn.send.v1")deny("native_companion_proof_invalid");
  try{companionHandoffProofBytes({...binding,method:"one.work-handoff.send.v1"});}catch{return deny("native_companion_proof_invalid");}
  if((purpose!=="start" && purpose!=="status") || typeof challenge!=="string" || challenge.length<16 || challenge.length>4096 ||
    !/^fc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(challenge) || typeof runId!=="string" || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(runId))deny("native_companion_proof_invalid");
  const b=binding as Record<string,unknown>;
  return sign(null,Buffer.from(JSON.stringify([`agentlas.companion.front-direct.${purpose}.v1`,...COMPANION_HANDOFF_PROOF_FIELDS.map(field=>b[field]),challenge,runId]),"utf8"),key).toString("base64url");
}
/** A short-lived front-context authority request is bound to a checked local turn. */
export function signNativeCompanionFrontTurnAuthority(credential:NativeCredential,capability:unknown):string {
  const key=keys.get(credential);if(!key || credential.role!=="gui")deny("native_companion_gui_required");
  const {takeCompanionFrontTurnAuthorityPermit}=require("../one/companion-front-turn-authority") as typeof import("../one/companion-front-turn-authority");
  const {companionFrontTurnAuthorityRequestBytes}=require("../../shared/companion-front-turn-authority") as typeof import("../../shared/companion-front-turn-authority");
  const value=takeCompanionFrontTurnAuthorityPermit(capability);if(!value)deny("front_turn_authority_permit_required");
  const der=createPublicKey(credential.publicKey).export({type:"spki",format:"der"});
  if(createHash("sha256").update(der).digest("hex")!==value.deviceKeyFingerprint)deny("front_turn_authority_key_changed");
  const signature=sign(null,companionFrontTurnAuthorityRequestBytes(value.binding,value.runId,value.requestNonce),key).toString("base64url");value.assertCurrent();return signature;
}
/** A front result must come from the exact terminal-run receipt owner. */
export function signNativeCompanionFrontReceipt(credential:NativeCredential,capability:unknown):string {
  const key=keys.get(credential);if(!key || credential.role!=="gui")deny("native_companion_gui_required");
  const value=takeCompanionFrontReceiptPermit(capability);if(!value)deny("companion_front_receipt_required");
  const signature=sign(null,companionFrontReceiptBytes(value.receipt),key).toString("base64url");value.assertCurrent();return signature;
}
/** Each front full-result chunk is signed only after the exact local result is re-read. */
export function signNativeCompanionFrontFullChunk(credential:NativeCredential,capability:unknown):string {
  const key=keys.get(credential);if(!key || credential.role!=="gui")deny("native_companion_gui_required");
  const {takeCompanionFrontChunkPermit}=require("../one/companion-front-receipt") as typeof import("../one/companion-front-receipt");
  const {companionFrontFullChunkBytes}=require("../../shared/companion-front-receipt") as typeof import("../../shared/companion-front-receipt");
  const value=takeCompanionFrontChunkPermit(capability);if(!value)deny("front_chunk_permit_required");
  const signature=sign(null,companionFrontFullChunkBytes(value.chunk),key).toString("base64url");value.assertCurrent();return signature;
}
/** Only a local no-start or observed terminal interruption may retire a turn. */
export function signNativeCompanionFrontRetirement(credential:NativeCredential,capability:unknown):string {
  const key=keys.get(credential);if(!key || credential.role!=="gui")deny("native_companion_gui_required");
  const {takeCompanionFrontRetirementPermit}=require("../one/companion-front-retirement") as typeof import("../one/companion-front-retirement");
  const value=takeCompanionFrontRetirementPermit(capability);if(!value)deny("front_retirement_proof_required");
  const signature=sign(null,companionFrontRetirementBytes(value.binding,value.runId,value.proof),key).toString("base64url");value.assertCurrent();return signature;
}
/** Registration possession is separate from user consent. */
export function signNativeContinuityAttestationRequest(credential:NativeCredential,binding:unknown):string {
  const key=keys.get(credential);if(!key || credential.role!=="gui")deny("native_companion_gui_required");
  let bytes:Buffer;try{bytes=companionContinuityBytes("attestation-request",binding);}catch{return deny("continuity_binding_invalid");}
  return sign(null,bytes,key).toString("base64url");
}
/** The permit exists only after the desktop displayed and approved the exact
 * scope and a fresh server attestation was rechecked. */
export function signNativeContinuityConsent(credential:NativeCredential,permit:unknown):string {
  const key=keys.get(credential);if(!key || credential.role!=="gui")deny("native_companion_gui_required");
  const value=takeContinuityConsentPermit(permit);if(!value)deny("continuity_consent_required");
  const fingerprint=createHash("sha256").update(createPublicKey(credential.publicKey).export({type:"spki",format:"der"})).digest("hex");
  if(fingerprint!==value.deviceKeyFingerprint)deny("continuity_consent_target_changed");
  const signature=sign(null,companionContinuityBytes("desktop-consent",value.binding),key).toString("base64url");value.assertCurrent();return signature;
}
/** Possession and explicit transfer consent use distinct purpose transcripts. */
export function signNativeFrontTransferAttestationRequest(credential:NativeCredential,binding:unknown):string {
  const key=keys.get(credential);if(!key || credential.role!=="gui")deny("native_companion_gui_required");
  let bytes:Buffer;try{bytes=companionFrontTransferBytes("attestation-request",binding);}catch{return deny("front_transfer_binding_invalid");}
  return sign(null,bytes,key).toString("base64url");
}
export function signNativeFrontTransferConsent(credential:NativeCredential,permit:unknown):string {
  const key=keys.get(credential);if(!key || credential.role!=="gui")deny("native_companion_gui_required");
  const value=takeFrontTransferConsentPermit(permit);if(!value)deny("front_transfer_consent_required");
  const fingerprint=createHash("sha256").update(createPublicKey(credential.publicKey).export({type:"spki",format:"der"})).digest("hex");
  if(fingerprint!==value.deviceKeyFingerprint)deny("front_transfer_consent_target_changed");
  const signature=sign(null,companionFrontTransferBytes("desktop-consent",value.binding),key).toString("base64url");value.assertCurrent();return signature;
}
export function signNativeCompanionProof(credential: NativeCredential, purpose: "enroll" | "run" | "handoff", value: unknown): string {
  const key = keys.get(credential);
  if (!key || credential.role !== "gui") deny("native_companion_gui_required");
  if (purpose === "handoff") {
    let bytes: Buffer;
    try { bytes = companionHandoffProofBytes(value); }
    catch { return deny("native_companion_proof_invalid"); }
    return sign(null, bytes, key).toString("base64url");
  }
  const enrollment = ["accountSubject", "workspaceId", "authEpoch", "hostId", "oneId", "deviceId", "desktopKey", "challenge", "approvalId"];
  const run = ["userId", "workspaceId", "accountSubject", "authEpoch", "familyId", "deviceId", "deviceGeneration", "hostId", "oneId", "turnId", "runGeneration", "contextDigest", "contextRevision", "challenge"];
  if (!exact(value, purpose === "enroll" ? enrollment : purpose === "run" ? run : [])) deny("native_companion_proof_invalid");
  const b = value as Record<string, unknown>;
  const id = (x: unknown) => typeof x === "string" && /^[A-Za-z0-9_.:@-]{1,128}$/.test(x);
  if (![b.accountSubject, b.workspaceId, b.hostId, b.oneId, b.deviceId].every(id) ||
      !Number.isSafeInteger(b.authEpoch) || Number(b.authEpoch) < 0) deny("native_companion_proof_invalid");
  let transcript: unknown[];
  if (purpose === "enroll") {
    if (b.desktopKey !== nativeCompanionPublicKey(credential) || typeof b.challenge !== "string" || !/^dch_[A-Za-z0-9_-]{22}$/.test(b.challenge) ||
        !id(b.approvalId)) deny("native_companion_proof_invalid");
    transcript = ["agentlas.companion.desktop-key-possession.v1", b.accountSubject, b.workspaceId, b.authEpoch,
      b.hostId, b.oneId, b.deviceId, b.desktopKey, b.challenge, b.approvalId];
  } else {
    if (![b.userId, b.familyId].every(id) || typeof b.turnId !== "string" || !/^trn_[A-Za-z0-9_-]{8,80}$/.test(b.turnId) ||
        typeof b.challenge !== "string" || !/^drch_[A-Za-z0-9_-]{22}$/.test(b.challenge) ||
        typeof b.contextDigest !== "string" || !/^[a-f0-9]{64}$/.test(b.contextDigest) ||
        !Number.isSafeInteger(b.deviceGeneration) || Number(b.deviceGeneration) < 1 ||
        !Number.isSafeInteger(b.runGeneration) || Number(b.runGeneration) < 1 ||
        !Number.isSafeInteger(b.contextRevision) || Number(b.contextRevision) < 0) deny("native_companion_proof_invalid");
    transcript = ["agentlas.companion.desktop-run-authority.v1", b.userId, b.workspaceId, b.accountSubject, b.authEpoch,
      b.familyId, b.deviceId, b.deviceGeneration, b.hostId, b.oneId, b.turnId, b.runGeneration,
      b.contextDigest, b.contextRevision, b.challenge];
  }
  return sign(null, Buffer.from(JSON.stringify(transcript), "utf8"), key).toString("base64url");
}
export function validateNativeTerminalPreparationRequest(value: unknown): NativePreparationWireRequest {
  const request = nativePreparationWireRequest(value), p = request.payload;
  if (request.action === "cancel" || request.action === "ingress.reject") {
    if (!exact(p, [])) deny("native_auth_terminal_payload_invalid");
  } else if (request.action === "quiesce" || request.action === "finish") {
    if (!exact(p, ["status"]) || typeof p.status !== "string" || !["handed-off", "rejected", "cancelled", "uncertain", ...(request.action === "finish" ? ["settled"] : [])].includes(p.status)) deny("native_auth_terminal_payload_invalid");
  } else deny("native_auth_terminal_action_denied");
  return request;
}
/** Native authenticators hold this closed role/domain signer. Generic signing
 * cannot mint terminal traffic; this closure is never an IPC/payload port. */
export function createNativeTerminalAuthSigner(credential: NativeCredential): (frame: Readonly<Record<string, unknown>>) => string {
  const key = keys.get(credential); if (!key) deny("native_auth_credential_unregistered");
  return frame => {
    if (frame.scope !== credential.scope || frame.generation !== credential.generation) deny("native_auth_sign_scope_denied");
    if (credential.role === "daemon") {
      if (frame.domain !== "agentlas.native.terminalCheckpoint.v1" || !exact(frame, ["scope", "generation", "serviceIdentity", "bootId", "connection", "sequence", "requestId", "direction", "domain", "method", "params"]) || frame.method !== "native.checkpoint" || frame.direction !== "daemon-to-gui") deny("native_auth_sign_domain_denied");
      validateNativeTerminalPreparationRequest(frame.params);
    } else {
      if (frame.domain !== "agentlas.native.terminalCheckpointReply.v1" || !exact(frame, ["scope", "generation", "serviceIdentity", "bootId", "connection", "sequence", "requestId", "direction", "domain", "result", "error", "start", "nonce"]) || frame.direction !== "gui-to-daemon" || typeof frame.nonce !== "string" || !/^[a-f0-9]{64}$/.test(frame.nonce)) deny("native_auth_sign_domain_denied");
      nativeStartDescriptor(frame.start);
    }
    return sign(null, Buffer.from(nativeAuthCanonical(frame)), key).toString("base64");
  };
}
export type NativeIngressNoStartObservation = Readonly<{ kind: "native-ingress-closed-before-prepared-v1"; binding: Readonly<{ chatId: string; runId: string; inputDigest: string; ownerProcessEpoch: string }> }>;
export function validateNativeIngressNoStartObservation(value: unknown, request: NativePreparationWireRequest): NativeIngressNoStartObservation {
  if (!exact(value, ["kind", "binding"]) || value.kind !== "native-ingress-closed-before-prepared-v1" || !exact(value.binding, ["chatId", "runId", "inputDigest", "ownerProcessEpoch"])) deny("native_auth_ingress_proof_invalid");
  const v = value.binding;
  if (v.chatId !== request.start.binding.chatId || v.runId !== request.start.binding.runId || v.inputDigest !== request.start.binding.inputDigest || typeof v.ownerProcessEpoch !== "string" || v.ownerProcessEpoch.length < 1 || v.ownerProcessEpoch.length > 200 || /[\u0000-\u001f]/.test(v.ownerProcessEpoch)) deny("native_auth_ingress_proof_invalid");
  return Object.freeze({ kind: "native-ingress-closed-before-prepared-v1", binding: Object.freeze({ chatId: v.chatId as string, runId: v.runId as string, inputDigest: v.inputDigest as string, ownerProcessEpoch: v.ownerProcessEpoch }) });
}
export function validateNativeIngressNoStartRequest(value: unknown): NativePreparationWireRequest {
  const request = validateNativeTerminalPreparationRequest(value);
  if (request.action !== "ingress.reject") deny("native_auth_ingress_request_invalid");
  return request;
}
/** Native authenticator closure only: neither ordinary nor terminal signer can
 * sign this attestation domain. Service provenance is consumed before minting. */
export function createNativeIngressNoStartSigner(credential: NativeCredential): (frame: Readonly<Record<string, unknown>>) => string {
  const key = keys.get(credential); if (!key) deny("native_auth_credential_unregistered");
  return frame => {
    if (frame.scope !== credential.scope || frame.generation !== credential.generation) deny("native_auth_sign_scope_denied");
    if (credential.role === "daemon") {
      if (frame.domain !== "agentlas.native.ingressNoStart.v1" || !exact(frame, ["scope", "generation", "serviceIdentity", "bootId", "connection", "sequence", "requestId", "direction", "domain", "method", "params", "proof"]) || frame.method !== "native.checkpoint" || frame.direction !== "daemon-to-gui") deny("native_auth_sign_domain_denied");
      validateNativeIngressNoStartObservation(frame.proof, validateNativeIngressNoStartRequest(frame.params));
    } else {
      if (frame.domain !== "agentlas.native.ingressNoStartReply.v1" || !exact(frame, ["scope", "generation", "serviceIdentity", "bootId", "connection", "sequence", "requestId", "direction", "domain", "result", "error", "start", "nonce"]) || frame.direction !== "gui-to-daemon" || typeof frame.nonce !== "string" || !/^[a-f0-9]{64}$/.test(frame.nonce)) deny("native_auth_sign_domain_denied");
      nativeStartDescriptor(frame.start);
    }
    return sign(null, Buffer.from(nativeAuthCanonical(frame)), key).toString("base64");
  };
}
export type NativeServiceObservation = Readonly<{
  kind: "native-execution-cwd-selected-v1"; binding: NativeIngressNoStartObservation["binding"]; cwd: string;
}> | Readonly<{
  kind: "native-undispatched-start-v1"; binding: NativeIngressNoStartObservation["binding"]; leaseId: string;
}>;
export function validateNativeServiceObservationRequest(value: unknown): NativePreparationWireRequest {
  const request = nativePreparationWireRequest(value);
  const claim = request.action === "checkpoint" && exact(request.payload, ["kind", "payload"])
    && request.payload.kind === "attachments.claim" && request.payload.payload && typeof request.payload.payload === "object"
    && !Array.isArray(request.payload.payload) && typeof (request.payload.payload as Record<string, unknown>).resultFolder === "string";
  const finish = request.action === "finish" && exact(request.payload, ["status"])
    && ["rejected", "cancelled", "uncertain"].includes(request.payload.status as string);
  if (!claim && !finish) deny("native_auth_service_observation_request_invalid");
  return request;
}
export function validateNativeServiceObservation(value: unknown, request: NativePreparationWireRequest): NativeServiceObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny("native_auth_service_observation_invalid");
  const v = value as Record<string, unknown>, selected = v.kind === "native-execution-cwd-selected-v1";
  if (!(selected || v.kind === "native-undispatched-start-v1") || !exact(v, ["kind", "binding", selected ? "cwd" : "leaseId"])) deny("native_auth_service_observation_invalid");
  const binding = validateNativeIngressNoStartObservation({ kind: "native-ingress-closed-before-prepared-v1", binding: v.binding }, request).binding;
  if (selected) {
    if (request.action !== "checkpoint" || typeof v.cwd !== "string" || v.cwd.length < 1 || /[\u0000]/.test(v.cwd)
      || (request.payload.payload as Record<string, unknown>).resultFolder !== v.cwd) deny("native_auth_service_observation_invalid");
    return Object.freeze({ kind: "native-execution-cwd-selected-v1", binding, cwd: v.cwd });
  }
  if (request.action !== "finish" || typeof v.leaseId !== "string" || v.leaseId.length < 1 || v.leaseId.length > 200 || /[\u0000-\u001f]/.test(v.leaseId)) deny("native_auth_service_observation_invalid");
  return Object.freeze({ kind: "native-undispatched-start-v1", binding, leaseId: v.leaseId });
}
/** Closed source observer domain. Ordinary/terminal traffic cannot mint it. */
export function createNativeServiceObservationSigner(credential: NativeCredential): (frame: Readonly<Record<string, unknown>>) => string {
  const key = keys.get(credential); if (!key) deny("native_auth_credential_unregistered");
  return frame => {
    if (frame.scope !== credential.scope || frame.generation !== credential.generation) deny("native_auth_sign_scope_denied");
    if (credential.role === "daemon") {
      if (frame.domain !== "agentlas.native.serviceObservation.v1" || !exact(frame, ["scope", "generation", "serviceIdentity", "bootId", "connection", "sequence", "requestId", "direction", "domain", "method", "params", "proof"]) || frame.method !== "native.checkpoint" || frame.direction !== "daemon-to-gui") deny("native_auth_sign_domain_denied");
      validateNativeServiceObservation(frame.proof, validateNativeServiceObservationRequest(frame.params));
    } else {
      if (frame.domain !== "agentlas.native.serviceObservationReply.v1" || !exact(frame, ["scope", "generation", "serviceIdentity", "bootId", "connection", "sequence", "requestId", "direction", "domain", "result", "error", "start", "nonce"]) || frame.direction !== "gui-to-daemon" || typeof frame.nonce !== "string" || !/^[a-f0-9]{64}$/.test(frame.nonce)) deny("native_auth_sign_domain_denied");
      nativeStartDescriptor(frame.start);
    }
    return sign(null, Buffer.from(nativeAuthCanonical(frame)), key).toString("base64");
  };
}
export function verifyNativeAuthFrame(credential: NativeCredential, frame: Readonly<Record<string, unknown>>, signature: unknown): boolean {
  if (!keys.has(credential)) deny("native_auth_credential_unregistered");
  try { return typeof signature === "string" && /^[A-Za-z0-9+/]{86}==$/.test(signature) && verify(null, Buffer.from(nativeAuthCanonical(frame)), credential.peerPublicKey, Buffer.from(signature, "base64")); } catch { return false; }
}
/** Deterministic compact JSON, rejects values JSON would silently erase or
 * coerce. Wire input must equal this encoding, so duplicate keys fail closed. */
export function nativeAuthCanonical(value: unknown): string {
  const maxNodes = 8192;
  let nodes = 0;
  const walk = (v: unknown, depth: number): string => {
    if (++nodes > maxNodes || depth > 24) deny("native_auth_value_limit");
    if (v === null || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "number") { if (!Number.isFinite(v)) deny("native_auth_value_invalid"); return JSON.stringify(v); }
    if (typeof v === "string") { if (Buffer.byteLength(v) > 524288) deny("native_auth_value_limit"); return JSON.stringify(v); }
    if (Array.isArray(v)) {
      // Every array slot needs its own JSON value. map() skips holes (or reads
      // inherited indices), which could emit invalid JSON after preflight.
      // Check the minimum node cost first: a huge sparse length cannot make
      // this scan unbounded before the normal value limit is reached.
      if (v.length > maxNodes - nodes) deny("native_auth_value_limit");
      const items: string[] = [];
      for (let index = 0; index < v.length; index++) {
        if (!Object.hasOwn(v, index)) deny("native_auth_value_invalid");
        items.push(walk(v[index], depth + 1));
      }
      return "[" + items.join(",") + "]";
    }
    if (!v || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) deny("native_auth_value_invalid");
    return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + walk((v as Record<string, unknown>)[k], depth + 1)).join(",") + "}";
  };
  const encoded = walk(value, 0); if (Buffer.byteLength(encoded) > NATIVE_AUTH_MAX_FRAME_BYTES) deny("native_auth_frame_limit"); return encoded;
}
/** The private inherited pipe contains only the daemon role, never GUI private.
 * This Node-only function requires the actual registered GUI handle and binding. */
export async function nativeDaemonEnrollment(binding: NativeAuthBinding, gui: NativeCredential): Promise<string> {
  assertNativeAuthBinding(binding); if (!keys.has(gui) || gui.role !== "gui" || gui.scope !== binding.scope) deny("native_auth_gui_credential_invalid");
  const reg = registry(await read(binding, "registry"), binding);
  const raw = await read(binding, "daemon-private"); pairRecord(raw, binding, reg, "daemon");
  if (reg.generation !== gui.generation || reg.guiPublicKey !== gui.publicKey) deny("native_auth_generation_changed");
  const body = { domain: "agentlas.native.enroll.v1", scope: binding.scope, serviceIdentity: binding.serviceIdentity, generation: reg.generation, nonce: randomBytes(32).toString("hex"), daemonRecord: raw };
  return nativeAuthCanonical({ body, signature: sign(null, Buffer.from(nativeAuthCanonical(body)), keys.get(gui)!).toString("base64") });
}
export async function acceptNativeDaemonEnrollment(binding: NativeAuthBinding, wire: string): Promise<NativeCredential> {
  assertNativeAuthBinding(binding); if (Buffer.byteLength(wire) > 16384) deny("native_auth_enrollment_limit");
  let envelope: unknown; try { envelope = JSON.parse(wire); } catch { deny("native_auth_enrollment_invalid"); }
  if (nativeAuthCanonical(envelope) !== wire || !exact(envelope, ["body", "signature"]) || !exact(envelope.body, ["domain", "scope", "serviceIdentity", "generation", "nonce", "daemonRecord"])) deny("native_auth_enrollment_invalid");
  const body = envelope.body; const reg = registry(await read(binding, "registry"), binding);
  if (body.domain !== "agentlas.native.enroll.v1" || body.scope !== binding.scope || body.serviceIdentity !== binding.serviceIdentity || body.generation !== reg.generation || typeof body.nonce !== "string" || !/^[a-f0-9]{64}$/.test(body.nonce) || typeof body.daemonRecord !== "string" || typeof envelope.signature !== "string") deny("native_auth_enrollment_scope_mismatch");
  if (!verify(null, Buffer.from(nativeAuthCanonical(body)), reg.guiPublicKey, Buffer.from(envelope.signature, "base64"))) deny("native_auth_enrollment_signature_invalid");
  return handle(pairRecord(body.daemonRecord, binding, reg, "daemon"), reg);
}
