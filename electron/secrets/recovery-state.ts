import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { requireConfiguredInstallIdentity } from "../install-identity";
import { userDataPath } from "../runtime-paths";

export type CredentialRecoveryCode = "keychain_unavailable" | "credential_attempt_incomplete"
  | "credential_recovery_state_invalid" | "credential_recovery_busy";
export type CredentialRecoveryResource = { service: string; operation: "read" | "list"; account: string };
export type CredentialRecoveryRecord = { resource: CredentialRecoveryResource; errorCode: CredentialRecoveryCode; generation: string };

/** Recovery state contains resource names and attempt metadata, never credentials. */
export class CredentialRecoveryStateError extends Error {
  readonly code = "keychain_unavailable";
  readonly automaticRetrySuppressed = true;
  constructor(readonly recoveryCode: CredentialRecoveryCode) {
    super(recoveryCode);
    this.name = "CredentialRecoveryStateError";
  }
}

type Descriptor = { schemaVersion: 1; serviceHash: string; operation: "read" | "list"; account: string };
type Attempt = Descriptor & { id: string; state: "unresolved" | "failed"; pid: number; instanceId: string };
type Owner = { id: string; pid: number; instanceId: string };
const instanceId = randomUUID();
const activeAttempts = new Set<string>();
const observed = new Map<string, CredentialRecoveryResource>();
const observedErrors = new Map<string, CredentialRecoveryCode>();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalid = (): CredentialRecoveryStateError => new CredentialRecoveryStateError("credential_recovery_state_invalid");
const isMissing = (error: unknown): boolean => (error as { code?: string })?.code === "ENOENT";
const isExists = (error: unknown): boolean => ["EEXIST", "ENOTEMPTY"].includes((error as { code?: string })?.code ?? "");

function descriptor(resource: CredentialRecoveryResource): Descriptor {
  return { schemaVersion: 1, serviceHash: hash(resource.service), operation: resource.operation, account: resource.account };
}

function location(resource: CredentialRecoveryResource): string {
  const identity = requireConfiguredInstallIdentity();
  if (identity.keychainService !== resource.service) throw invalid();
  const key = hash(descriptor(resource));
  observed.set(key, { ...resource });
  return userDataPath("credential-recovery-v1", hash(resource.service), key);
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value), "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.unlink(temporary).catch((error) => { if (!isMissing(error)) throw error; }); }
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function validOwner(value: unknown): value is Owner {
  const row = value as Owner;
  return !!row && UUID.test(row.id) && Number.isInteger(row.pid) && row.pid > 0 && UUID.test(row.instanceId);
}

function ownerIsLive(owner: Owner): boolean {
  if (owner.pid === process.pid && owner.instanceId === instanceId) return activeAttempts.has(owner.id);
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return (error as { code?: string })?.code !== "ESRCH"; }
}

async function acquireLock(dir: string, owner: Owner, explicit: boolean): Promise<() => Promise<void>> {
  const lock = path.join(dir, "lock");
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (!isExists(error)) throw error;
    let previous: unknown;
    try { previous = await readJson(path.join(lock, "owner.json")); } catch { /* incomplete/corrupt owner */ }
    if (!explicit) throw new CredentialRecoveryStateError("credential_attempt_incomplete");
    let retirement: string;
    if (validOwner(previous)) {
      if (ownerIsLive(previous)) throw new CredentialRecoveryStateError("credential_recovery_busy");
      retirement = previous.id;
    } else {
      // A process can die between mkdir and writing its owner. Give an active
      // initializer time to finish; explicit recovery alone can retire it.
      const stat = await fs.stat(lock);
      if (Date.now() - stat.mtimeMs < 30_000) throw new CredentialRecoveryStateError("credential_recovery_busy");
      retirement = hash([stat.dev, stat.ino, stat.birthtimeMs]);
    }
    // Retain this nonempty generation tombstone. A second stale reclaimer then
    // cannot rename a newly acquired lock over it (rename fails with EEXIST).
    await fs.writeFile(path.join(lock, "retirement"), retirement, { flag: "wx", mode: 0o600 }).catch((error) => { if (!isExists(error)) throw error; });
    try { await fs.rename(lock, path.join(dir, `retired-${retirement}`)); }
    catch (error) { if (isExists(error) || isMissing(error)) throw new CredentialRecoveryStateError("credential_recovery_busy"); throw error; }
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch (error) { if (isExists(error)) throw new CredentialRecoveryStateError("credential_recovery_busy"); throw error; }
  }
  // Exclusive creation prevents a late initializer from replacing a new owner.
  try {
    const handle = await fs.open(path.join(lock, "owner.json"), "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(owner), "utf8"); await handle.sync(); } finally { await handle.close(); }
    const current = await readJson(path.join(lock, "owner.json"));
    if (!validOwner(current) || current.id !== owner.id) throw new CredentialRecoveryStateError("credential_recovery_busy");
    activeAttempts.add(owner.id);
  } catch (error) { throw error instanceof CredentialRecoveryStateError ? error : invalid(); }
  return async () => {
    activeAttempts.delete(owner.id);
    const current = await readJson(path.join(lock, "owner.json"));
    if (!validOwner(current) || current.id !== owner.id) throw invalid();
    await fs.unlink(path.join(lock, "owner.json"));
    await fs.unlink(path.join(lock, "retirement")).catch((error) => { if (!isMissing(error)) throw error; });
    await fs.rmdir(lock);
  };
}

async function attemptFiles(dir: string): Promise<string[]> {
  try { return (await fs.readdir(dir)).filter((name) => /^attempt-[a-f0-9-]+\.json$/i.test(name)).sort(); }
  catch (error) { if (isMissing(error)) return []; throw error; }
}

async function inspect(dir: string, expected: Descriptor): Promise<{ files: string[]; errorCode: CredentialRecoveryCode | null; generation: string }> {
  const files = await attemptFiles(dir);
  let errorCode: CredentialRecoveryCode | null = null;
  const generations: unknown[] = [];
  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(dir, file), "utf8");
      generations.push([file, hash(raw)]);
      const row = JSON.parse(raw) as Attempt;
      if (row.schemaVersion !== 1 || row.serviceHash !== expected.serviceHash || row.operation !== expected.operation
        || row.account !== expected.account || !UUID.test(row.id) || file !== `attempt-${row.id}.json`
        || !validOwner(row) || !["unresolved", "failed"].includes(row.state)) throw invalid();
      if (row.state === "unresolved" && errorCode !== "credential_recovery_state_invalid") errorCode = "credential_attempt_incomplete";
      else if (!errorCode) errorCode = "keychain_unavailable";
    } catch { errorCode = "credential_recovery_state_invalid"; generations.push([file, "invalid"]); }
  }
  try {
    const actual = await readJson(path.join(dir, "resource.json"));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) errorCode = "credential_recovery_state_invalid";
  } catch (error) { if (!isMissing(error) || files.length) errorCode = "credential_recovery_state_invalid"; }
  try {
    const owner = await fs.readFile(path.join(dir, "lock", "owner.json"), "utf8");
    generations.push(["lock", hash(owner)]);
    if (!errorCode) errorCode = "credential_attempt_incomplete";
  } catch (error) {
    if (!isMissing(error)) errorCode = "credential_recovery_state_invalid";
    else {
      try { await fs.stat(path.join(dir, "lock")); if (!errorCode) errorCode = "credential_attempt_incomplete"; }
      catch (statError) { if (!isMissing(statError)) errorCode = "credential_recovery_state_invalid"; }
    }
  }
  return { files, errorCode, generation: hash(generations) };
}

/** Persists an unresolved attempt before native work, including the first read.
 * Success removes only the captured generations. Failure never erases a marker.
 */
export async function runWithCredentialRecovery<T>(resource: CredentialRecoveryResource, explicit: boolean, run: () => Promise<T>): Promise<T> {
  let dir: string;
  try { dir = location(resource); } catch { throw invalid(); }
  const expected = descriptor(resource);
  let release: (() => Promise<void>) | undefined;
  let attemptFile: string | undefined;
  let attemptDurable = false;
  let ownerId: string | undefined;
  try {
    const previous = await inspect(dir, expected);
    if (previous.errorCode && !explicit) throw new CredentialRecoveryStateError(previous.errorCode);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const owner: Owner = { id: randomUUID(), pid: process.pid, instanceId };
    ownerId = owner.id;
    release = await acquireLock(dir, owner, explicit);
    // Re-read after the cross-process lock: another host may have failed while
    // this caller was preparing. Passive calls must not bypass that new failure.
    const captured = await inspect(dir, expected);
    const oldFiles = captured.files;
    if (oldFiles.length && !explicit) throw new CredentialRecoveryStateError(captured.errorCode ?? "credential_attempt_incomplete");
    await atomicJson(path.join(dir, "resource.json"), expected);
    const attempt: Attempt = { ...expected, ...owner, state: "unresolved" };
    attemptFile = path.join(dir, `attempt-${owner.id}.json`);
    await atomicJson(attemptFile, attempt);
    attemptDurable = true;
    let value: T;
    try { value = await run(); }
    catch (error) {
      // If the failed-state write fails, the durable unresolved marker remains.
      await atomicJson(attemptFile, { ...attempt, state: "failed" }).catch(() => {});
      throw error;
    }
    for (const file of [...oldFiles, path.basename(attemptFile)]) {
      await fs.unlink(path.join(dir, file)).catch((error) => { if (!isMissing(error)) throw error; });
    }
    if ((await attemptFiles(dir)).length) throw new CredentialRecoveryStateError("credential_attempt_incomplete");
    observedErrors.delete(hash(expected));
    return value;
  } catch (error) {
    observedErrors.set(hash(expected), error instanceof CredentialRecoveryStateError ? error.recoveryCode
      : (error as { code?: string })?.code === "keychain_unavailable" ? "keychain_unavailable" : "credential_recovery_state_invalid");
    if (error instanceof CredentialRecoveryStateError || (error as { code?: string })?.code === "keychain_unavailable") throw error;
    throw invalid();
  } finally {
    if (release && !attemptDurable) {
      // Failed preparation must leave a restart-visible incomplete lock. No
      // native work ran, but a fresh process cannot assume storage is healthy.
      if (ownerId) activeAttempts.delete(ownerId);
    } else if (release) {
      try { await release(); }
      catch {
        observedErrors.set(hash(expected), "credential_recovery_state_invalid");
        throw invalid();
      }
    }
  }
}

/** Value-free persisted failures; called by the user-facing recovery listing.
 * Reading this list never asks the native credential backend for anything.
 */
export async function readCredentialRecoveryRecords(): Promise<CredentialRecoveryRecord[]> {
  const identity = requireConfiguredInstallIdentity();
  const root = userDataPath("credential-recovery-v1", hash(identity.keychainService));
  let names: string[];
  try { names = await fs.readdir(root); } catch (error) { if (isMissing(error)) names = []; else throw invalid(); }
  const resources = new Map(observed);
  let unknownDescriptor = false;
  for (const name of names.filter((value) => HASH.test(value))) {
    try {
      const row = await readJson(path.join(root, name, "resource.json")) as Descriptor;
      if (row.schemaVersion !== 1 || row.serviceHash !== hash(identity.keychainService)
        || !["read", "list"].includes(row.operation) || typeof row.account !== "string" || hash(row) !== name) throw invalid();
      resources.set(name, { service: identity.keychainService, operation: row.operation, account: row.account });
    } catch { if (!resources.has(name)) unknownDescriptor = true; }
  }
  const out: CredentialRecoveryRecord[] = [];
  for (const [key, resource] of resources) {
    if (resource.service !== identity.keychainService) continue;
    try {
      const state = await inspect(path.join(root, key), descriptor(resource));
      const errorCode = observedErrors.get(key) === "credential_recovery_state_invalid"
        ? "credential_recovery_state_invalid" : state.errorCode ?? observedErrors.get(key);
      if (errorCode) out.push({ resource: { ...resource }, errorCode, generation: state.generation });
    } catch { out.push({ resource: { ...resource }, errorCode: "credential_recovery_state_invalid", generation: "invalid" }); }
  }
  // An unknown damaged descriptor cannot be turned into a guessed account or
  // an empty (apparently healthy) list. Its actual consumer can bind it exactly.
  if (unknownDescriptor) throw invalid();
  return out;
}
