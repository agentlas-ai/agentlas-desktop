import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CONTINUITY_CORE_TABLES, isValidContinuitySnapshot, type ContinuitySnapshot, type ContinuityVerification } from "./controller";
import { commitCapturedRecoveryCleanProof } from "./continuity";
import { CONTINUITY_OWNER_FILE, CONTINUITY_WORKER_PROTOCOL, continuityWorkerError,
  type CaptureInput, type VerifyInput, type ContinuityWorkerRequest, type ContinuityWorkerReply } from "./continuity-worker-protocol";

type Child = Pick<Electron.UtilityProcess, "once" | "on" | "removeListener" | "postMessage" | "kill" | "pid">;
type WorkerFactory = () => Child;
// A retry cannot hand off installation while a previous worker may still write.
const unconfirmedWorkers = new Set<Child>();
const activeWorkers = new Map<Child, { stop: (error: Error) => void; settled: Promise<void> }>();
const activeOperations = new Set<Promise<unknown>>();
let closing = false;

function track<T>(operation: Promise<T>): Promise<T> {
  const tracked = operation.finally(() => { activeOperations.delete(tracked); });
  activeOperations.add(tracked);
  return tracked;
}

/** Called before Main closes stores/quits. Includes post-exit owned-directory cleanup. */
export async function shutdownContinuityWorkers(): Promise<void> {
  closing = true;
  const workers = [...activeWorkers.values()];
  for (const worker of workers) worker.stop(continuityWorkerError("continuity_worker_aborted"));
  const results = await Promise.allSettled([...workers.map(worker => worker.settled), ...activeOperations]);
  if (unconfirmedWorkers.size) throw continuityWorkerError("continuity_worker_exit_unconfirmed");
  if (results.some(result => result.status === "rejected"
    && result.reason?.code === "continuity_worker_cleanup_unconfirmed")) throw continuityWorkerError("continuity_worker_cleanup_unconfirmed");
}
const forkWorker: WorkerFactory = () => {
  // Main-only, lazy Electron binding. Shared updater/controller remains Node/daemon-loadable.
  const { utilityProcess } = require("electron") as typeof import("electron");
  return utilityProcess.fork(path.join(__dirname, "continuity-worker.js"), [], {
    serviceName: "Agentlas update continuity", stdio: "ignore",
  });
};

function validReply(value: unknown, request: ContinuityWorkerRequest): value is ContinuityWorkerReply {
  if (!value || typeof value !== "object") return false;
  const row = value as ContinuityWorkerReply;
  if (row.protocol !== CONTINUITY_WORKER_PROTOCOL || row.nonce !== request.nonce || row.operation !== request.operation) return false;
  if (row.ok === false) return row.code === "continuity_worker_failed";
  if (row.ok !== true) return false;
  if (row.operation === "verify") return typeof row.verification?.ok === "boolean"
    && Array.isArray(row.verification.violations) && row.verification.violations.every(v => typeof v === "string")
    && row.verification.ok === (row.verification.violations.length === 0);
  if (request.operation !== "capture" || !isValidContinuitySnapshot(row.snapshot)) return false;
  const snapshot = row.snapshot;
  return snapshot.schemaVersion === 2
    && Object.keys(snapshot.rowCounts).sort().join("\0") === [...CONTINUITY_CORE_TABLES].sort().join("\0")
    && snapshot.accountSignedIn === request.input.accountSignedIn && snapshot.accountExpiresAt === request.input.accountExpiresAt
    && snapshot.userDataPath === request.input.userDataPath && snapshot.databasePath === request.input.databasePath
    && snapshot.backupPath === path.join(request.ownedDirectory, "agentlas.sqlite")
    && snapshot.agentsBackupPath === path.join(request.ownedDirectory, "agents")
    && snapshot.routeBackupPath === (snapshot.routeFilePresent ? path.join(request.ownedDirectory, "agent-routes.json") : null)
    && (row.cleanProof === null || (typeof row.cleanProof === "object"
      && ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(k => Number.isFinite(row.cleanProof?.[k as keyof NonNullable<typeof row.cleanProof>]))));
}

/** Settlement always follows exit. No message alone authorizes a journal or cleanup. */
export function runContinuityWorker(request: ContinuityWorkerRequest, signal: AbortSignal,
  factory: WorkerFactory = forkWorker, stopGraceMs = 1000, exitBoundMs = 5000): Promise<ContinuityWorkerReply> {
  if (closing) return Promise.reject(continuityWorkerError("continuity_worker_closed"));
  if (signal.aborted) return Promise.reject(continuityWorkerError("continuity_worker_aborted"));
  return new Promise((resolve, reject) => {
    let child: Child;
    try { child = factory(); } catch { reject(continuityWorkerError("continuity_worker_launch_failed")); return; }
    let exited = false, settled = false, reply: ContinuityWorkerReply | undefined, failure: Error | undefined;
    let didSettle!: () => void;
    const stopped = new Promise<void>(resolve => { didSettle = resolve; });
    let escalation: ReturnType<typeof setTimeout> | undefined, exitBound: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(escalation); clearTimeout(exitBound);
      signal.removeEventListener("abort", abort);
      child.removeListener("exit", onExit); child.removeListener("message", onMessage); child.removeListener("spawn", onSpawn);
      if ((error as { code?: string } | undefined)?.code === "continuity_worker_exit_unconfirmed") {
        unconfirmedWorkers.add(child);
        child.once("exit", () => { unconfirmedWorkers.delete(child); activeWorkers.delete(child); child.removeListener("error", onError); });
      } else { activeWorkers.delete(child); child.removeListener("error", onError); }
      didSettle();
      if (error) reject(error); else resolve(reply!);
    };
    const stop = (error: Error) => {
      failure ??= error;
      if (exited || settled || exitBound) return;
      try { child.kill(); } catch { /* Escalate only this owned child. */ }
      if (exited || settled) return;
      escalation = setTimeout(() => {
        if (!exited && !settled) {
          // Keep termination tied to Electron's owned process handle, never a
          // numeric PID that could be reused before JS receives the exit event.
          try { child.kill(); } catch { /* Exit event remains authoritative. */ }
        }
      }, stopGraceMs);
      exitBound = setTimeout(() => finish(continuityWorkerError("continuity_worker_exit_unconfirmed")), exitBoundMs);
    };
    const abort = () => stop(continuityWorkerError("continuity_worker_aborted"));
    activeWorkers.set(child, { stop, settled: stopped });
    const onExit = (code: number) => {
      exited = true;
      finish(failure ?? (code !== 0 || !reply ? continuityWorkerError("continuity_worker_exit_failed") : undefined));
    };
    const onMessage = (value: unknown) => {
      if (failure || settled) return;
      if (reply || !validReply(value, request)) { stop(continuityWorkerError("continuity_worker_protocol_invalid")); return; }
      if (!value.ok) { stop(continuityWorkerError(value.code)); return; }
      reply = value;
    };
    const onSpawn = () => {
      if (failure || signal.aborted) { try { child.kill(); } catch { /* Exit bound owns settlement. */ } return; }
      try { child.postMessage(request); } catch { stop(continuityWorkerError("continuity_worker_send_failed")); }
    };
    // Never forward Node's diagnostic report (it can contain private process data).
    const onError = () => stop(continuityWorkerError("continuity_worker_failed"));
    child.once("exit", onExit); child.on("message", onMessage); child.once("spawn", onSpawn); child.on("error", onError);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function databaseIdentity(databasePath: string): Promise<{ dev: number; ino: number }> {
  if (!path.isAbsolute(databasePath) || await fs.realpath(databasePath) !== databasePath) throw continuityWorkerError("continuity_worker_identity_changed");
  const stat = await fs.lstat(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw continuityWorkerError("continuity_worker_identity_changed");
  return { dev: stat.dev, ino: stat.ino };
}

export function captureUpdaterContinuityInWorker(input: CaptureInput, signal?: AbortSignal): Promise<ContinuitySnapshot> {
  return track(capture(input, signal));
}
async function capture(input: CaptureInput, signal?: AbortSignal): Promise<ContinuitySnapshot> {
  if (closing) throw continuityWorkerError("continuity_worker_closed");
  if (unconfirmedWorkers.size) throw continuityWorkerError("continuity_worker_exit_unconfirmed");
  const deadline = AbortSignal.timeout(120_000);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const nonce = randomUUID();
  const userDataPath = path.resolve(input.userDataPath), databasePath = path.resolve(input.databasePath);
  if (await fs.realpath(userDataPath) !== userDataPath) throw continuityWorkerError("continuity_worker_identity_changed");
  const identity = await databaseIdentity(databasePath);
  const root = path.join(userDataPath, "updater", "recovery");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if (await fs.realpath(root) !== root) throw continuityWorkerError("continuity_worker_identity_changed");
  bounded.throwIfAborted();
  const ownedDirectory = path.join(root, `${input.targetVersion.replace(/[^0-9A-Za-z._-]/g, "_")}-${Date.now()}-${nonce}`);
  await fs.mkdir(ownedDirectory, { mode: 0o700 });
  const ownerPath = path.join(ownedDirectory, CONTINUITY_OWNER_FILE);
  let exitUnconfirmed = false, accepted = false, ownerWritten = false;
  const directoryIdentity = await fs.lstat(ownedDirectory);
  try {
    // Durable ownership precedes spawn and every DB/asset copy.
    const ownerFile = await fs.open(ownerPath, "wx", 0o600);
    try { await ownerFile.writeFile(JSON.stringify({ protocol: CONTINUITY_WORKER_PROTOCOL, nonce, directory: ownedDirectory,
      databasePath, createdAt: new Date().toISOString(), parentPid: process.pid,
      paths: ["agentlas.sqlite", "agentlas.sqlite-wal", "agentlas.sqlite-shm", "agentlas.sqlite-journal",
        "agents", "agent-routes.json", "continuity.json"].map(name => path.join(ownedDirectory, name)),
    })); await ownerFile.sync(); } finally { await ownerFile.close(); }
    ownerWritten = true;
    const request: ContinuityWorkerRequest = { protocol: CONTINUITY_WORKER_PROTOCOL, nonce, operation: "capture",
      databaseIdentity: identity, input: { ...input, userDataPath, databasePath }, ownedDirectory };
    const reply = await runContinuityWorker(request, bounded);
    bounded.throwIfAborted();
    const current = await databaseIdentity(databasePath);
    if (current.dev !== identity.dev || current.ino !== identity.ino) throw continuityWorkerError("continuity_worker_identity_changed");
    if (!reply.ok || reply.operation !== "capture") throw continuityWorkerError("continuity_worker_protocol_invalid");
    await commitCapturedRecoveryCleanProof(reply.snapshot.backupPath, reply.cleanProof, bounded);
    bounded.throwIfAborted();
    accepted = true;
    return reply.snapshot;
  } catch (error) {
    exitUnconfirmed = (error as { code?: string }).code === "continuity_worker_exit_unconfirmed";
    throw error;
  } finally {
    if (!accepted && !exitUnconfirmed) {
      try {
      const stat = await fs.lstat(ownedDirectory);
      if (stat.isSymbolicLink() || stat.dev !== directoryIdentity.dev || stat.ino !== directoryIdentity.ino
        || await fs.realpath(ownedDirectory) !== ownedDirectory) throw continuityWorkerError("continuity_worker_cleanup_unconfirmed");
      if (ownerWritten) {
        const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
        if (owner.nonce !== nonce || owner.directory !== ownedDirectory) throw continuityWorkerError("continuity_worker_cleanup_unconfirmed");
      }
      await fs.rm(ownedDirectory, { recursive: true, force: false });
      try { await fs.lstat(ownedDirectory); throw continuityWorkerError("continuity_worker_cleanup_unconfirmed"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      } catch { throw continuityWorkerError("continuity_worker_cleanup_unconfirmed"); }
    }
  }
}

export function verifyUpdaterContinuityInWorker(input: VerifyInput): Promise<ContinuityVerification> {
  return track(verify(input));
}
async function verify(input: VerifyInput): Promise<ContinuityVerification> {
  if (closing) throw continuityWorkerError("continuity_worker_closed");
  if (unconfirmedWorkers.size) throw continuityWorkerError("continuity_worker_exit_unconfirmed");
  const signal = AbortSignal.timeout(120_000);
  const currentDatabasePath = path.resolve(input.currentDatabasePath);
  const request: ContinuityWorkerRequest = { protocol: CONTINUITY_WORKER_PROTOCOL, nonce: randomUUID(), operation: "verify",
    databaseIdentity: await databaseIdentity(currentDatabasePath), input: { ...input, currentDatabasePath } };
  const reply = await runContinuityWorker(request, signal);
  signal.throwIfAborted();
  if (!reply.ok || reply.operation !== "verify") throw continuityWorkerError("continuity_worker_protocol_invalid");
  return reply.verification;
}
