import type { InvocationRunOwner } from "../store/invocation-owner-core";
import type { InvocationSteerResult, McpInvocationRequest } from "../../shared/types";

/** Host-written admission provenance, persisted beside the accepted dispatch.
 * PID reuse conservatively preserves custody; only ESRCH establishes death. */
export interface WorkSessionHostClaim {
  ownerId: string;
  ownerKind: "desktop" | "daemon" | "terminal";
  pid: number;
}
export type WorkSessionHostState = "live" | "dead" | "unknown";
export type WorkSessionRunOwnerState = WorkSessionHostState | "none";
type StopResult = "requested" | "already-requested" | "not-found";
interface HostPorts {
  current(): WorkSessionHostClaim;
  owner(chatId: string, runId: string): InvocationRunOwner | null;
  localOwner(runId: string): InvocationRunOwner | null;
  release(expected: InvocationRunOwner): boolean;
  probe(pid: number): void;
  cancel(runId: string): Promise<StopResult>;
}
function valid(claim: WorkSessionHostClaim): boolean {
  return !!claim && typeof claim.ownerId === "string" && !!claim.ownerId.trim() && claim.ownerId.length <= 256
    && claim.ownerId.trim() === claim.ownerId && !/[\u0000-\u001f]/.test(claim.ownerId)
    && ["desktop", "daemon", "terminal"].includes(claim.ownerKind)
    && Number.isSafeInteger(claim.pid) && claim.pid > 0;
}
function sameHost(a: WorkSessionHostClaim, b: WorkSessionHostClaim): boolean {
  return a.ownerId === b.ownerId && a.ownerKind === b.ownerKind && a.pid === b.pid;
}

/** Shared Main/daemon/Terminal observation and Stop port. A foreign ledger-only
 * `interrupted` projection cannot establish that its original owner stopped. */
export function createWorkSessionHostAdapter(ports: HostPorts) {
  const hostClaim = (): WorkSessionHostClaim => {
    const claim = ports.current();
    if (!valid(claim)) throw Object.assign(new Error("work_session_host_identity_unavailable"), { code: "work_session_host_identity_unavailable" });
    return Object.freeze({ ...claim });
  };
  const hostState = (claim: WorkSessionHostClaim): WorkSessionHostState => {
    if (!valid(claim)) return "unknown";
    try {
      const current = hostClaim();
      if (sameHost(claim, current)) return "live";
      // A reused local PID with a different boot identity is not the original host.
      if (claim.pid === current.pid || claim.ownerId === current.ownerId) return "unknown";
      ports.probe(claim.pid);
      return "live";
    } catch (error) { return (error as { code?: unknown })?.code === "ESRCH" ? "dead" : "unknown"; }
  };
  const runOwnerState = (chatId: string, runId: string, claim?: WorkSessionHostClaim): WorkSessionRunOwnerState => {
    try {
      const owner = ports.owner(chatId, runId);
      if (!owner) return "none";
      if (owner.chatId !== chatId || owner.runId !== runId) return "unknown";
      // Released is an ended invocation lease, not permission to bypass the native writer's physical-close gate.
      if (owner.state === "released") return "dead";
      if (owner.state !== "active" && owner.state !== "settling") return "unknown";
      const local = ports.localOwner(runId), current = hostClaim();
      if (local && local.chatId === chatId && local.runId === runId && local.ownerId === current.ownerId
        && local.ownerKind === current.ownerKind && local.ownerId === owner.ownerId && local.ownerKind === owner.ownerKind
        && local.leaseId === owner.leaseId) return "live";
      if (!claim || !valid(claim) || claim.ownerId !== owner.ownerId || claim.ownerKind !== owner.ownerKind) return "unknown";
      const state = hostState(claim);
      if (state !== "dead") return state;
      // Reconcile only this positively dead process's exact lease. A newer
      // owner/PID or an uncertain second probe keeps custody intact. This does
      // not release a native writer ticket or authorize replaying any effect.
      if (hostState(claim) !== "dead") return "unknown";
      const latest = ports.owner(chatId, runId);
      if (!latest || latest.ownerId !== owner.ownerId || latest.ownerKind !== owner.ownerKind
        || latest.leaseId !== owner.leaseId || latest.chatId !== chatId || latest.runId !== runId) return "unknown";
      return latest.state === "released" || ports.release(latest) ? "dead" : "unknown";
    } catch { return "unknown"; }
  };
  return { hostClaim, hostState, runOwnerState, cancelRun: (runId: string) => ports.cancel(runId) };
}

const production = createWorkSessionHostAdapter({
  current: () => ({ ...(require("../store/invocation-run-owners") as typeof import("../store/invocation-run-owners")).invocationProcessOwner(), pid: process.pid }),
  owner: (chatId, runId) => (require("../store/invocation-run-owners") as typeof import("../store/invocation-run-owners")).invocationRunOwners.getRunOwner(chatId, runId),
  localOwner: runId => (require("../invocation/service") as typeof import("../invocation/service")).invocationService.liveRunOwner(runId),
  release: expected => (require("../store/invocation-run-owners") as typeof import("../store/invocation-run-owners")).invocationRunOwners.release(expected),
  probe: pid => { process.kill(pid, 0); },
  cancel: runId => (require("../runtime/invocation-owner-control") as typeof import("../runtime/invocation-owner-control")).cancelInvocationOwnerRun(runId),
});
/** Admission is a write boundary. Pure liveness probes above use hostClaim
 * directly; callers accepting Work must first retain this process's evidence. */
export function currentWorkSessionHost(): WorkSessionHostClaim {
  const claim = production.hostClaim();
  recovery.remember(claim);
  return claim;
}
export const workSessionHostState = production.hostState;
export const workSessionRunOwnerState = production.runOwnerState;
export const cancelWorkSessionRun = production.cancelRun;

/** Process provenance is recorded only by native host startup / authenticated
 * broker registration. An epoch is immutable; a PID by itself is not authority. */
export function createWorkSessionHostRecovery(ports: {
  adapter: Pick<ReturnType<typeof createWorkSessionHostAdapter>, "hostState" | "runOwnerState">;
  activeOwners(): InvocationRunOwner[];
  activeOwner(chatId: string): InvocationRunOwner | null;
  readClaim(ownerId: string): WorkSessionHostClaim | null;
  insertClaim(claim: WorkSessionHostClaim): void;
  steer(request: McpInvocationRequest, intentId: string): Promise<InvocationSteerResult & { workSessionHost?: WorkSessionHostClaim }>;
}) {
  const remember = (claim: WorkSessionHostClaim): void => {
    if (!valid(claim)) throw new Error("work_session_host_identity_unavailable");
    ports.insertClaim(Object.freeze({ ownerId: claim.ownerId, ownerKind: claim.ownerKind, pid: claim.pid }));
    const stored = ports.readClaim(claim.ownerId);
    if (!stored || !valid(stored) || !sameHost(stored, claim)) throw new Error("work_session_host_identity_conflict");
  };
  const reconcile = (claim: WorkSessionHostClaim): boolean => {
    try {
      if (ports.adapter.hostState(claim) !== "dead") return false;
      for (const owner of ports.activeOwners()) {
        if (owner.ownerId !== claim.ownerId || owner.ownerKind !== claim.ownerKind) continue;
        const state = ports.adapter.runOwnerState(owner.chatId, owner.runId, claim);
        if (state !== "dead" && state !== "none") return false;
      }
      // A failed CAS, a newly observed lease, or an unreadable store retains the
      // wake claim. Native writer tickets and effect receipts are untouched.
      return !ports.activeOwners().some(owner => owner.ownerId === claim.ownerId && owner.ownerKind === claim.ownerKind);
    } catch { return false; }
  };
  const steer = async (request: McpInvocationRequest, intentId: string) => {
    const owner = ports.activeOwner(request.chatId);
    if (owner) {
      const claim = ports.readClaim(owner.ownerId);
      if (claim && valid(claim) && claim.ownerId === owner.ownerId && claim.ownerKind === owner.ownerKind
        && ports.adapter.hostState(claim) === "dead" && !reconcile(claim)) {
        throw Object.assign(new Error("work_session_host_reconciliation_pending"), { code: "work_session_host_reconciliation_pending" });
      }
    }
    return ports.steer(request, intentId);
  };
  return { remember, reconcile, steer };
}

const recovery = createWorkSessionHostRecovery({
  adapter: production,
  activeOwners: () => (require("../store/invocation-run-owners") as typeof import("../store/invocation-run-owners")).invocationRunOwners.listActiveOwners(),
  activeOwner: chatId => (require("../store/invocation-run-owners") as typeof import("../store/invocation-run-owners")).invocationRunOwners.getActiveOwner(chatId),
  readClaim: ownerId => {
    const row = (require("../store/db") as typeof import("../store/db")).getDb()
      .prepare("SELECT value FROM meta WHERE key=?").get(`work_session_host:${ownerId}`) as { value: string } | undefined;
    if (!row) return null;
    const claim = JSON.parse(row.value) as WorkSessionHostClaim;
    if (!valid(claim) || claim.ownerId !== ownerId) throw new Error("work_session_host_identity_invalid");
    return claim;
  },
  insertClaim: claim => {
    (require("../store/db") as typeof import("../store/db")).getDb()
      .prepare("INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)").run(`work_session_host:${claim.ownerId}`, JSON.stringify(claim));
  },
  steer: (request, intentId) => (require("../runtime/invocation-owner-control") as typeof import("../runtime/invocation-owner-control")).steerInvocationOwnerNextTurn(request, intentId),
});
export const rememberWorkSessionHost = recovery.remember;
export const reconcileDeadWorkSessionHost = recovery.reconcile;
/** Durable next-turn delivery to the exact currently leased execution owner. */
export function steerWorkSessionOwnerTurn(request: McpInvocationRequest, intentId: string): Promise<InvocationSteerResult & { workSessionHost?: WorkSessionHostClaim }> {
  currentWorkSessionHost();
  return recovery.steer(request, intentId);
}
