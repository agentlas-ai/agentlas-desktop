import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { OneSupervisorApprovalStore } from "./supervisor-approval-store";
import { setToolApprovalLedger, type ToolApprovalRequest } from "../runtime/tool-approval";

/** Requests without a Main-computed consent identity belong to this install's single local owner. */
const LOCAL_OWNER_IDENTITY = "local-owner";

/**
 * Native hosts seal live tool approvals before the waiting run hears the decision.
 * Each process generation has its own epoch. Restart retires that host's earlier
 * pending requests while preserving the other host's live waiters in the shared DB.
 * An earlier process's receipt never authorizes a replacement run.
 */
export function installDurableToolApprovalLedger(
  db: Database.Database,
  now: () => number = Date.now,
  hostKind: "main" | "daemon" = "main",
): OneSupervisorApprovalStore {
  if (hostKind !== "main" && hostKind !== "daemon") throw new Error("supervisor_approval_host_invalid");
  const store = new OneSupervisorApprovalStore(db, true, now);
  const epoch = `${hostKind}:${randomUUID()}`;
  store.retireEarlierOwners(epoch, hostKind);
  store.prune();
  const identityOf = (request: ToolApprovalRequest) => request.consentBinding?.userIdentity || LOCAL_OWNER_IDENTITY;
  setToolApprovalLedger({
    persist: (request) => store.persist(request, {
      epoch, identity: identityOf(request), leaseUntil: Date.parse(request.expiresAt ?? ""),
    }),
    decide: (id, decision, actionId, assertCurrent) => store.decide(id, decision, actionId, assertCurrent),
    consume: (id, assertCurrent) => store.consume(id, epoch, assertCurrent),
    cancel: (id) => store.cancel(id, epoch),
    recordConsent: (id, receipt) => store.recordConsent(id, epoch, receipt),
    get: (id) => store.get(id),
  });
  return store;
}
