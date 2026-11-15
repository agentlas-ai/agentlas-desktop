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
  // R3-3: the requests the restart is about to close leave their one quiet line (runtime/approval-closure-notice.ts); read before they are retired.
  let earlierPending: Array<{ id: string; chatId: string }> = [];
  try { earlierPending = store.pendingOfEarlierOwners(epoch, hostKind); } catch { /* the record is a courtesy */ }
  store.retireEarlierOwners(epoch, hostKind);
  if (earlierPending.length) {
    // Loaded only when a restart really closed something: the chat store is a heavy module graph and this ledger is installed at every start.
    try {
      const { recordApprovalClosure } = require("../runtime/approval-closure-notice") as typeof import("../runtime/approval-closure-notice");
      for (const row of earlierPending) recordApprovalClosure({ requestId: row.id, chatId: row.chatId, reason: "restarted" });
    } catch { /* the record is a courtesy */ }
  }
  store.prune();
  const identityOf = (request: ToolApprovalRequest) => request.consentBinding?.userIdentity || LOCAL_OWNER_IDENTITY;
  setToolApprovalLedger({
    persist: (request) => store.persist(request, {
      epoch, identity: identityOf(request), leaseUntil: Date.parse(request.expiresAt ?? ""),
    }),
    decide: (id, decision, actionId, assertCurrent, via) => store.decide(id, decision, actionId, assertCurrent, via),
    // BB-1a: a delete / send call that passed with no card (a saved "always allow", full access) leaves one settled row; the device of an answer a host-held request got is named after the fact.
    recordAuto: (event, basis) => store.recordAuto(event, { epoch, identity: LOCAL_OWNER_IDENTITY }, basis),
    markHandler: (id, via) => store.markHandler(id, via),
    consume: (id, assertCurrent) => store.consume(id, epoch, assertCurrent),
    cancel: (id) => store.cancel(id, epoch),
    recordConsent: (id, receipt) => store.recordConsent(id, epoch, receipt),
    get: (id) => store.get(id),
    settled: (chatIds) => store.listSettled(chatIds),
  });
  return store;
}
