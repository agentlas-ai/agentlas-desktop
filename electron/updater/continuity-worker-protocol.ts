import type { ContinuitySnapshot, ContinuityVerification } from "./controller";
import type { RecoveryCleanFingerprint } from "./continuity";

export const CONTINUITY_WORKER_PROTOCOL = "agentlas.updater-continuity-worker.v1";
export const CONTINUITY_OWNER_FILE = "capture-owner.v1.json";
export type CaptureInput = {
  userDataPath: string; databasePath: string; targetVersion: string;
  accountSignedIn: boolean; accountExpiresAt?: number;
};
export type VerifyInput = {
  snapshot: ContinuitySnapshot; currentUserDataPath: string;
  currentDatabasePath: string; currentAccountSignedIn: boolean;
};
export type ContinuityWorkerRequest = {
  protocol: typeof CONTINUITY_WORKER_PROTOCOL; nonce: string;
  databaseIdentity: { dev: number; ino: number };
} & ({ operation: "capture"; input: CaptureInput; ownedDirectory: string }
  | { operation: "verify"; input: VerifyInput });
export type ContinuityWorkerReply = {
  protocol: typeof CONTINUITY_WORKER_PROTOCOL; nonce: string; operation: "capture" | "verify";
} & ({ ok: false; code: "continuity_worker_failed" }
  | { ok: true; operation: "capture"; snapshot: ContinuitySnapshot; cleanProof: RecoveryCleanFingerprint | null }
  | { ok: true; operation: "verify"; verification: ContinuityVerification });
export function continuityWorkerError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
