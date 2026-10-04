import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { OneSupervisorApprovalStore } from "./supervisor-approval-store";
import { setToolApprovalLedger, type ToolApprovalRequest } from "../runtime/tool-approval";

/** Requests without a Main-computed consent identity belong to this install's single local owner. */
const LOCAL_OWNER_IDENTITY = "local-owner";

/**
 * Main seals every live tool approval into the scoped SQLite store, so a decision is committed before
 * the waiting run hears it and its receipt survives a renderer, phone or app restart (Hope Stage 2
 * handover item 4; acceptance R05/S03, invariant I07). Each Main run is its own owner epoch: what an
 * earlier run left pending is retired at install, and an earlier run's decision is never consumed.
 */
export function installDurableToolApprovalLedger(db: Database.Database, now: () => number = Date.now): OneSupervisorApprovalStore {
  const store = new OneSupervisorApprovalStore(db, true, now);
  const epoch = `main:${randomUUID()}`;
  store.retireEarlierOwners(epoch);
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
