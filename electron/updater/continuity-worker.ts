import fs from "node:fs";
import path from "node:path";
import { captureUpdaterContinuity, capturedRecoveryCleanProof, verifyUpdaterContinuity } from "./continuity";
import { isValidContinuitySnapshot } from "./controller";
import { CONTINUITY_OWNER_FILE, CONTINUITY_WORKER_PROTOCOL, type ContinuityWorkerRequest, type ContinuityWorkerReply } from "./continuity-worker-protocol";

/** Dedicated Electron utility process: same native ABI and ASAR resolution as Main.
 * No app initialization, environment-derived data root, signal handler or inline fallback. */
export async function executeContinuityWorker(request: ContinuityWorkerRequest): Promise<ContinuityWorkerReply> {
  if (!request || request.protocol !== CONTINUITY_WORKER_PROTOCOL || !/^[a-f0-9-]{36}$/.test(request.nonce)
    || (request.operation !== "capture" && request.operation !== "verify")) throw new Error("continuity_worker_request_invalid");
  const databasePath = request.operation === "capture" ? request.input.databasePath : request.input.currentDatabasePath;
  const checkDatabase = () => {
    if (!path.isAbsolute(databasePath) || fs.realpathSync(databasePath) !== databasePath) throw new Error("continuity_worker_identity_changed");
    const stat = fs.lstatSync(databasePath);
    if (!stat.isFile() || stat.dev !== request.databaseIdentity.dev || stat.ino !== request.databaseIdentity.ino) throw new Error("continuity_worker_identity_changed");
  };
  checkDatabase();
  const base = { protocol: CONTINUITY_WORKER_PROTOCOL, nonce: request.nonce } as const;
  if (request.operation === "verify") {
    if (!isValidContinuitySnapshot(request.input.snapshot)) throw new Error("continuity_worker_request_invalid");
    const root = path.join(request.input.currentUserDataPath, "updater", "recovery");
    for (const candidate of [request.input.snapshot.backupPath, request.input.snapshot.agentsBackupPath,
      ...(request.input.snapshot.routeBackupPath ? [request.input.snapshot.routeBackupPath] : [])]) {
      const relative = path.relative(root, candidate);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("continuity_worker_directory_invalid");
      if (fs.existsSync(candidate)) {
        const realRelative = path.relative(fs.realpathSync(root), fs.realpathSync(candidate));
        if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error("continuity_worker_directory_invalid");
      }
    }
    const verification = await verifyUpdaterContinuity(request.input);
    checkDatabase();
    return { ...base, operation: "verify", ok: true, verification };
  }
  const directory = request.ownedDirectory;
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory
    || path.dirname(directory) !== path.join(request.input.userDataPath, "updater", "recovery")
    || !path.basename(directory).endsWith(`-${request.nonce}`)) throw new Error("continuity_worker_directory_invalid");
  const ownerPath = path.join(directory, CONTINUITY_OWNER_FILE);
  const ownerStat = fs.lstatSync(ownerPath);
  if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 16_384) throw new Error("continuity_worker_owner_invalid");
  const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  if (owner.protocol !== CONTINUITY_WORKER_PROTOCOL || owner.nonce !== request.nonce || owner.directory !== directory
    || owner.databasePath !== databasePath) throw new Error("continuity_worker_owner_invalid");
  const snapshot = await captureUpdaterContinuity({ ...request.input, ownedDirectory: directory });
  const cleanProof = capturedRecoveryCleanProof(snapshot.backupPath);
  checkDatabase();
  return { ...base, operation: "capture", ok: true, snapshot, cleanProof };
}

if (require.main === module) {
  process.parentPort.once("message", async (event: { data: ContinuityWorkerRequest }) => {
    const request = event.data;
    try { process.parentPort.postMessage(await executeContinuityWorker(request)); }
    catch {
      process.parentPort.postMessage({ protocol: CONTINUITY_WORKER_PROTOCOL, nonce: request?.nonce,
        operation: request?.operation, ok: false, code: "continuity_worker_failed" });
    }
    // Post the only terminal receipt before exiting; parent requires both receipt and exit.
    setImmediate(() => process.exit(0));
  });
}
