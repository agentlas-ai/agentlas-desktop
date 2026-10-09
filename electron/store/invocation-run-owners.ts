import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { createInvocationRunOwnerStore, type InvocationRunOwner } from "./invocation-owner-core";

let processOwnerId: string = randomUUID();
let processOwnerKind: InvocationRunOwner["ownerKind"] = "desktop";
let ownerUsed = false;

/** Configure before the daemon imports its invocation service. The identity is
 * frozen on first admission and cannot be changed underneath a running brain. */
export function configureInvocationProcessOwner(kind: InvocationRunOwner["ownerKind"], ownerId: string): void {
  if (ownerUsed || !ownerId || !["desktop", "daemon", "terminal"].includes(kind)) {
    throw new Error("invocation_process_owner_already_bound");
  }
  processOwnerKind = kind;
  processOwnerId = ownerId;
}

export function invocationProcessOwner(): { ownerId: string; ownerKind: InvocationRunOwner["ownerKind"] } {
  return { ownerId: processOwnerId, ownerKind: processOwnerKind };
}

export const invocationRunOwners = createInvocationRunOwnerStore({ getDb });

export function claimInvocationRunOwner(chatId: string, runId: string): InvocationRunOwner {
  ownerUsed = true;
  const claim = invocationRunOwners.claim({ chatId, runId, ...invocationProcessOwner() });
  if (claim.kind !== "claimed") {
    throw Object.assign(new Error("invocation_chat_owned_by_other_run"), { code: "invocation_chat_owned_by_other_run" });
  }
  return claim.owner;
}

export function assertInvocationRunOwner(expected: InvocationRunOwner): void {
  const current = invocationRunOwners.getRunOwner(expected.chatId, expected.runId);
  if (!current || current.ownerId !== expected.ownerId || current.ownerKind !== expected.ownerKind
    || current.leaseId !== expected.leaseId || current.state !== "active") {
    throw new Error("invocation_owner_custody_unavailable");
  }
}
