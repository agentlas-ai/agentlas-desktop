import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAuthenticatedSessionBinding, onAuthSessionOwnershipChanged } from "../auth";
import { fetchAccountContext } from "../account-context";
import { onHostShutdown } from "../host-lifecycle";
import { userDataPath } from "../runtime-paths";
import { deviceMemoryCustodyId, getMemoryStoreInfo, memoryRoot } from "./database";

const SCHEMA = "agentlas.memory-owner-binding.v1";
const bootId = randomUUID();
const TTL = 30_000;
/** Renewal period while a consumer is live: Core never sees a binding with less than TTL - RENEW_MS left. */
const RENEW_MS = 5_000;
/**
 * A binding file whose expiry passed this long ago is refused by every reader and is never written again: its writer
 * renews only an unexpired binding, and a revision's file name is never reused. The margin also covers the Terminal's
 * asynchronous renewer, which can extend a binding a few seconds after its expiry.
 */
const DEAD_BINDING_GRACE_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 60 * 60_000;
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
/**



 */
const childLeases = new Map<object, string>();
let renewal: NodeJS.Timeout | null = null;
let idleExpiry: NodeJS.Timeout | null = null;
let lastSweep = 0;

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

/**
 * Remove a revoked binding's file. The tombstone goes first: a separate immutable tombstone still revokes the binding
 * while a Windows reader holds the old descriptor open, which refuses unlink and rename-overwrite alike. Once the file is
 * gone no reader can accept the revision (a missing file fails closed as memory_host_binding_unavailable; a reader that
 * opened it before the unlink fails its same-inode check), so the tombstone goes too. If the unlink is refused, both
 * stay, the file is marked revoked best effort, and the sweep removes them after the binding has expired.
 */
function retire(binding: { file: string; value: Binding }): void {
  const tombstone = `${binding.file}.revoked.${binding.value.binding_revision}`;
  try { fs.writeFileSync(tombstone, "revoked", { flag: "wx", mode: 0o600 }); } catch { /* already revoked */ }
  let gone = false;
  try { fs.unlinkSync(binding.file); gone = true; }
  catch (error) { gone = (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
  if (gone) {
    try { fs.unlinkSync(tombstone); } catch { /* a sweep removes it */ }
    return;
  }
  try { atomic(binding.file, { ...binding.value, state: "revoked", expires_at: 0 }); } catch { /* expiry still closes custody */ }
}

function stopTimers(): void {
  if (renewal) { clearInterval(renewal); renewal = null; }
  if (idleExpiry) { clearTimeout(idleExpiry); idleExpiry = null; }
}

/** Synchronous value-free invalidation; cookie deletion and another launch are irrelevant. */
export function revokeTrustedMemoryOwnerBinding(): void {
  try { if (accountSubject && accountSubject.authBindingId !== (getAuthenticatedSessionBinding()?.sessionId ?? null)) accountSubject = null; }
  catch { accountSubject = null; }
  for (const owner of curatorOwners) owner.abort(new Error("os_curator_owner_revoked"));
  curatorOwners.clear();
  const revoked = current;
  current = null;
  stopTimers();
  if (revoked) {
    // Children of the revoked revision fail closed; their leases cannot keep a later binding renewed.
    for (const [lease, revision] of childLeases) if (revision === revoked.value.binding_revision) childLeases.delete(lease);
    retire(revoked);
  }
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

function renew(): void {
  if (!current) return;
  try {
    const now = Date.now();
    if (current.value.expires_at <= now || !same(current.value, snapshot())) {
      revokeTrustedMemoryOwnerBinding(); return;
    }
    current.value = { ...current.value, account_subject: accountSubjectFor(current.value.auth_binding_id), expires_at: now + TTL };
    atomic(current.file, current.value);
  } catch { revokeTrustedMemoryOwnerBinding(); }
}

function demanded(): boolean {
  if (!current) return false;
  if (curatorOwners.size > 0) return true;
  for (const revision of childLeases.values()) if (revision === current.value.binding_revision) return true;
  return false;
}

/** Renew while a Core child or curator owner is live. Idle, the binding runs out and its file is removed at expiry. */
function scheduleRenewal(): void {
  if (!current) { stopTimers(); return; }
  if (demanded()) {
    if (idleExpiry) { clearTimeout(idleExpiry); idleExpiry = null; }
    if (!renewal) {
      // Resumed after an idle stretch: renew now, so a new consumer starts with a full TTL, not what the last write left.
      if (current.value.expires_at - Date.now() < TTL - RENEW_MS) renew();
      if (current && demanded()) { renewal = setInterval(renew, RENEW_MS); renewal.unref(); }
    }
    return;
  }
  if (renewal) { clearInterval(renewal); renewal = null; }
  if (!idleExpiry) {
    const idle = current;
    idleExpiry = setTimeout(() => {
      idleExpiry = null;
      if (current === idle && !demanded()) revokeTrustedMemoryOwnerBinding();
    }, Math.max(0, idle.value.expires_at - Date.now()));
    idleExpiry.unref();
  }
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const BINDING_FILE = new RegExp(`^(?:desktop|terminal)-${UUID}\\.json$`);
const TOMBSTONE_FILE = new RegExp(`^((?:desktop|terminal)-${UUID}\\.json)\\.revoked\\.(${UUID})$`);
const TEMPORARY_FILE = new RegExp(`^(?:desktop|terminal)-${UUID}\\.json\\.${UUID}\\.tmp$`);

/**







 */
export function sweepDeadMemoryOwnerBindings(directory = path.join(memoryRoot(), "runtime-bindings"), now = Date.now()): number {
  for (let component = directory; ; component = path.dirname(component)) {
    try { if (fs.lstatSync(component).isSymbolicLink()) return 0; } catch { if (component === directory) return 0; }
    if (path.dirname(component) === component) break;
  }
  let names: string[];
  try { names = fs.readdirSync(directory); } catch { return 0; }
  const own = current ? path.basename(current.file) : null;
  const read = (name: string): { stat: fs.Stats; value: Partial<Binding> | null } | null => {
    try {
      const stat = fs.lstatSync(path.join(directory, name));
      if (!stat.isFile() || stat.size > 16_384) return null;
      let value: Partial<Binding> | null = null;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
        value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Partial<Binding> : null;
      } catch { value = null; }
      return { stat, value };
    } catch { return null; }
  };
  const remove = (name: string): boolean => {
    try { fs.unlinkSync(path.join(directory, name)); return true; } catch { return false; }
  };
  let removed = 0;
  const bindings = new Map<string, Partial<Binding> | null>();
  for (const name of names) {
    if (!BINDING_FILE.test(name) || name === own) continue;
    const entry = read(name);
    if (!entry) continue;
    bindings.set(name, entry.value);
    const expires = entry.value?.expires_at;
    const dead = (typeof expires === "number" ? expires + DEAD_BINDING_GRACE_MS < now : entry.value === null)
      && entry.stat.mtimeMs + DEAD_BINDING_GRACE_MS < now;
    if (dead && remove(name)) { removed += 1; bindings.delete(name); }
  }
  for (const name of names) {
    const tombstone = TOMBSTONE_FILE.exec(name);
    if (tombstone) {
      if (tombstone[1] === own) continue;
      const binding = bindings.get(tombstone[1]);
      const protecting = binding != null && binding.binding_revision === tombstone[2] && binding.state === "active"
        && typeof binding.expires_at === "number" && binding.expires_at > now;
      if (!protecting && (bindings.has(tombstone[1]) || !fs.existsSync(path.join(directory, tombstone[1]))) && remove(name)) removed += 1;
      continue;
    }
    if (TEMPORARY_FILE.test(name)) {
      try {
        const stat = fs.lstatSync(path.join(directory, name));
        if (stat.isFile() && stat.mtimeMs + DEAD_BINDING_GRACE_MS < now && remove(name)) removed += 1;
      } catch { /* already gone */ }
    }
  }
  return removed;
}

function scheduleSweep(directory: string): void {
  const now = Date.now();
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  // Off the launch path: the first sweep after an update reads every file older versions left behind.
  setTimeout(() => { try { sweepDeadMemoryOwnerBindings(directory); } catch { /* the next sweep retries */ } }, 0).unref();
}

// Register at import, before any launcher. Authority clear immediately revokes
// already running Core children even if no later launch ever occurs.
onAuthSessionOwnershipChanged(revokeTrustedMemoryOwnerBinding);
// Main (will-quit) and the daemon (SIGTERM/SIGINT) both run the host shutdown hooks; only Electron Main has before-quit.
onHostShutdown(revokeTrustedMemoryOwnerBinding);
// Any other ordinary exit (a helper process, a dev or test host that never runs the hooks) removes its file too, instead
// of leaving it for the next sweep. Only a kill or crash still leaves one.
process.once("exit", revokeTrustedMemoryOwnerBinding);
try {
  const app = (require("electron") as typeof import("electron")).app;
  app?.on("before-quit", revokeTrustedMemoryOwnerBinding);
} catch { /* pure Node host */ }

function currentEnvironment(): Record<string, string> {
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
    // One file per revision: a revoked or expired binding's name is never written again, so a leftover is provably dead.
    const revision = randomUUID();
    const file = path.join(identity.memory_root, "runtime-bindings", `desktop-${revision}.json`);
    const value: Binding = { ...identity, account_subject: accountSubjectFor(identity.auth_binding_id),
      binding_revision: revision, expires_at: Date.now() + TTL };
    atomic(file, value); current = { file, value };
    scheduleSweep(path.dirname(file));
  }
  return { AGENTLAS_MEMORY_ROOT: current.value.memory_root,
    AGENTLAS_MEMORY_OWNER_NAMESPACE: current.value.owner_namespace,
    AGENTLAS_MEMORY_BINDING_FILE: current.file,
    AGENTLAS_MEMORY_BINDING_REVISION: current.value.binding_revision };
}

/** Only the owning native launcher calls this; neither model DTOs nor a lease
 * confer a provider, tools, or account selection capability. This form holds
 * no lease: unless a Core child lease or a curator owner is live, the binding
 * expires within TTL. Launchers use retainTrustedMemoryOwnerEnvironment.
 */
export function trustedMemoryOwnerEnvironment(): Record<string, string> {
  const environment = currentEnvironment();
  scheduleRenewal();
  return environment;
}

/**
 * The environment for one Core child, with a lease that keeps the binding renewed until `release()` (idempotent) is
 * called when that child's authority ends: its prepared MCP config is cleaned up, or its owned transport closes.
 */
export function retainTrustedMemoryOwnerEnvironment(): { env: Record<string, string>; release(): void } {
  const env = currentEnvironment();
  const lease = {};
  childLeases.set(lease, env.AGENTLAS_MEMORY_BINDING_REVISION);
  scheduleRenewal();
  let released = false;
  return Object.freeze({ env, release() {
    if (released) return;
    released = true;
    childLeases.delete(lease);
    scheduleRenewal();
  } });
}

/** Native snapshot only; no model/renderer DTO can reconstruct this capture. */
export function captureTrustedMemoryOwnerBinding() {
  currentEnvironment();
  const captured = current;
  if (!captured || captured.value.state !== "active") { scheduleRenewal(); throw new Error("os_curator_owner_unavailable"); }
  const control = new AbortController(); curatorOwners.add(control);
  const assertCurrent = () => {
    if (control.signal.aborted || current !== captured || captured.value.expires_at <= Date.now()
      || !same(captured.value, snapshot())
      || fs.existsSync(`${captured.file}.revoked.${captured.value.binding_revision}`)) {
      control.abort(new Error("os_curator_owner_revoked")); throw new Error("os_curator_owner_revoked");
    }
  };
  try { assertCurrent(); } catch (error) { curatorOwners.delete(control); scheduleRenewal(); throw error; }
  scheduleRenewal();
  return Object.freeze({ ownerNamespace: captured.value.owner_namespace, revocationEpoch: captured.value.revocation_epoch,
    signal: control.signal, assertCurrent,
    release() { curatorOwners.delete(control); control.abort(new Error("os_curator_owner_released")); scheduleRenewal(); } });
}
