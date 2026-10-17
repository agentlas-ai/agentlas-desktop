import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAuthenticatedSessionBinding, onAuthSessionOwnershipChanged } from "../auth";
import { fetchAccountContext } from "../account-context";
import { userDataPath } from "../runtime-paths";
import { deviceMemoryCustodyId, getMemoryStoreInfo, memoryRoot } from "./database";

const SCHEMA = "agentlas.memory-owner-binding.v1";
const bootId = randomUUID();
const TTL = 30_000;
type Binding = { schema_version: typeof SCHEMA; source_id: string; binding_revision: string;
  state: "active" | "revoked" | "unavailable"; memory_root: string; owner_namespace: string;
  device_custody_id: string; revocation_epoch: number; auth_binding_id: string | null;
  user_id: string | null; workspace_id: string | null; expires_at: number; reason?: string;
  /**
   * The account's opaque subject (sha256:…), the value the web's agentlas.account_context returns. Core's memory curation
   * verifies the bound owner with it (independent review wave 2, engine-w2-03 / handoff H2): without it a bound curation
   * fails memory_web_owner_unverifiable. It is derived from the session, so it is not part of the identity comparison:
   * it is written once known, and it never revokes a binding whose session is unchanged.
   */
  account_subject?: string | null };
let current: { file: string; value: Binding } | null = null;
let accountSubject: { authBindingId: string; value: string } | null = null;
let accountSubjectFetch: Promise<void> | null = null;

/** The known subject of this session, or null while it is unknown (one fetch in flight; a failure retries on a later write). */
function accountSubjectFor(authBindingId: string | null): string | null {
  if (!authBindingId) return null;
  if (accountSubject?.authBindingId === authBindingId) return accountSubject.value;
  if (!accountSubjectFetch) {
    accountSubjectFetch = fetchAccountContext().then((context) => {
      if (getAuthenticatedSessionBinding()?.sessionId === authBindingId) accountSubject = { authBindingId, value: context.accountSubject };
    }, () => { /* unknown stays null; Core refuses typed (memory_web_owner_unverifiable) until a later write has it */ })
      .finally(() => { accountSubjectFetch = null; });
  }
  return null;
}
const curatorOwners = new Set<AbortController>();

function atomic(file: string, value: Binding): void {
  for (let component = path.dirname(file); ; component = path.dirname(component)) {
    if (fs.existsSync(component) && fs.lstatSync(component).isSymbolicLink()) throw new Error("memory_host_binding_path_invalid");
    if (path.dirname(component) === component) break;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("memory_host_binding_path_invalid");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch { /* renamed */ } }
}

/** Synchronous value-free invalidation; cookie deletion and another launch are irrelevant. */
export function revokeTrustedMemoryOwnerBinding(): void {
  try { if (accountSubject && accountSubject.authBindingId !== (getAuthenticatedSessionBinding()?.sessionId ?? null)) accountSubject = null; }
  catch { accountSubject = null; }
  for (const owner of curatorOwners) owner.abort(new Error("os_curator_owner_revoked"));
  curatorOwners.clear();
  if (current) {
    // A separate immutable tombstone also works while a Windows reader holds
    // the old descriptor open and prevents rename-overwrite.
    try { fs.writeFileSync(`${current.file}.revoked.${current.value.binding_revision}`, "revoked", { flag: "wx", mode: 0o600 }); } catch { /* already revoked */ }
    try { atomic(current.file, { ...current.value, state: "revoked", expires_at: 0 }); } catch { /* expiry still closes custody */ }
  }
  current = null;
}

function snapshot(): Omit<Binding, "binding_revision" | "expires_at"> {
  const root = memoryRoot();
  const session = getAuthenticatedSessionBinding();
  // A stored credential awaiting restoration is not a credential-free local
  // install. Do not open its inherited device memory while auth is unknown.
  if (!session && fs.existsSync(userDataPath("auth", "session-cookie.v1.json"))) throw new Error("memory_account_binding_unavailable");
  const info = getMemoryStoreInfo();
  return { schema_version: SCHEMA, source_id: `desktop-native:${deviceMemoryCustodyId()}`,
    state: "active", memory_root: root, owner_namespace: info.ownerNamespace,
    device_custody_id: deviceMemoryCustodyId(), revocation_epoch: info.revocationEpoch,
    auth_binding_id: session?.sessionId ?? null, user_id: session?.userId ?? null,
    workspace_id: session?.workspaceId ?? null };
}
function same(left: Binding, right: ReturnType<typeof snapshot>): boolean {
  const { binding_revision: _revision, expires_at: _expires, account_subject: _subject, ...identity } = left;
  return JSON.stringify(identity) === JSON.stringify(right);
}

// Register at import, before any launcher. Authority clear immediately revokes
// already running Core children even if no later launch ever occurs.
onAuthSessionOwnershipChanged(revokeTrustedMemoryOwnerBinding);
try {
  const app = (require("electron") as typeof import("electron")).app;
  app?.on("before-quit", revokeTrustedMemoryOwnerBinding);
} catch { /* pure Node host */ }
const renewal = setInterval(() => {
  if (!current) return;
  try {
    const now = Date.now();
    if (current.value.expires_at <= now || !same(current.value, snapshot())) {
      revokeTrustedMemoryOwnerBinding(); return;
    }
    current.value = { ...current.value, account_subject: accountSubjectFor(current.value.auth_binding_id), expires_at: now + TTL };
    atomic(current.file, current.value);
  } catch { revokeTrustedMemoryOwnerBinding(); }
}, 5_000);
renewal.unref();

/** Only the owning native launcher calls this; neither model DTOs nor a lease
 * confer a provider, tools, or account selection capability.
 */
export function trustedMemoryOwnerEnvironment(): Record<string, string> {
  let identity: ReturnType<typeof snapshot>;
  try { identity = snapshot(); }
  catch {
    revokeTrustedMemoryOwnerBinding();
    const root = memoryRoot();
    identity = { schema_version: SCHEMA, source_id: `desktop-unavailable:${bootId}`, state: "unavailable",
      memory_root: root, owner_namespace: "unavailable", device_custody_id: "unavailable",
      revocation_epoch: 0, auth_binding_id: null, user_id: null, workspace_id: null,
      reason: "memory_account_binding_unavailable" };
  }
  if (!current || current.value.expires_at <= Date.now() || !same(current.value, identity)) {
    revokeTrustedMemoryOwnerBinding();
    const file = path.join(identity.memory_root, "runtime-bindings", `desktop-${bootId}.json`);
    const value: Binding = { ...identity, account_subject: accountSubjectFor(identity.auth_binding_id),
      binding_revision: randomUUID(), expires_at: Date.now() + TTL };
    atomic(file, value); current = { file, value };
  }
  return { AGENTLAS_MEMORY_ROOT: current.value.memory_root,
    AGENTLAS_MEMORY_OWNER_NAMESPACE: current.value.owner_namespace,
    AGENTLAS_MEMORY_BINDING_FILE: current.file,
    AGENTLAS_MEMORY_BINDING_REVISION: current.value.binding_revision };
}

/** Native snapshot only; no model/renderer DTO can reconstruct this capture. */
export function captureTrustedMemoryOwnerBinding() {
  trustedMemoryOwnerEnvironment();
  const captured = current;
  if (!captured || captured.value.state !== "active") throw new Error("os_curator_owner_unavailable");
  const control = new AbortController(); curatorOwners.add(control);
  const assertCurrent = () => {
    if (control.signal.aborted || current !== captured || captured.value.expires_at <= Date.now()
      || !same(captured.value, snapshot())
      || fs.existsSync(`${captured.file}.revoked.${captured.value.binding_revision}`)) {
      control.abort(new Error("os_curator_owner_revoked")); throw new Error("os_curator_owner_revoked");
    }
  };
  try { assertCurrent(); } catch (error) { curatorOwners.delete(control); throw error; }
  return Object.freeze({ ownerNamespace: captured.value.owner_namespace, revocationEpoch: captured.value.revocation_epoch,
    signal: control.signal, assertCurrent,
    release() { curatorOwners.delete(control); control.abort(new Error("os_curator_owner_released")); } });
}
