import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { createInvocationRunOwnerStore, type InvocationRunOwner } from "./invocation-owner-core";
import { releaseGoneTerminalOwners } from "./terminal-owner-liveness";
import { userDataDir } from "../runtime-paths";

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

// A terminal's lease is proven abandoned per owner (store/terminal-owner-liveness.ts). Every start path of this process (chat turns,
// automations, graph nodes, Telegram, the daemon) claims here, so this is where a dead terminal's row stops refusing the chat. The proof
// can run `ps`/PowerShell for a live terminal and a refused start is retried often: look again at most this often per chat.
const TERMINAL_CLAIM_SWEEP_EVERY_MS = 10_000;
const terminalClaimSweepAt = new Map<string, number>();

/** `reopenReleased`: the caller runs several executions in sequence under one run id (graph agent nodes) and may open
 * this process's own released lease again. Chat turns never pass it: a released turn stays closed. */
export function claimInvocationRunOwner(chatId: string, runId: string, opts: { reopenReleased?: boolean } = {}): InvocationRunOwner {
  ownerUsed = true;
  const local = invocationProcessOwner();
  const claimOnce = () => invocationRunOwners.claim({ chatId, runId, ...local, reopenReleased: opts.reopenReleased === true });
  let claim = claimOnce();
  // Why a terminal-held chat stayed refused: the proof's machine code (never prose), for the log and the AI that reads it.
  let terminalProof: { code: string; pid?: number } | undefined;
  if (claim.kind !== "claimed" && claim.owner.ownerKind === "terminal" && claim.owner.ownerId !== local.ownerId
    && (claim.owner.state === "active" || claim.owner.state === "settling")) {
    const now = Date.now();
    if (now - (terminalClaimSweepAt.get(chatId) ?? 0) >= TERMINAL_CLAIM_SWEEP_EVERY_MS) {
      terminalClaimSweepAt.set(chatId, now);
      try {
        const swept = releaseGoneTerminalOwners(invocationRunOwners, userDataDir(), { chatId });
        if (swept.released.length > 0) {
          console.warn("[invocation] released a lease of a terminal that is gone", { chatId, runIds: swept.released.map((owner) => owner.runId) });
          claim = claimOnce();
        } else if (swept.kept[0]) {
          terminalProof = { code: swept.kept[0].code, ...(swept.kept[0].pid !== undefined ? { pid: swept.kept[0].pid } : {}) };
        }
      } catch { /* a failed proof keeps the lease: the chat stays busy and the refusal below is retried */ }
    }
  }
  if (claim.kind !== "claimed") {
    // The other run is live in the other process (Desktop <-> background service): one host per chat at a time (A2).
    const other = claim.owner;
    const code = (other.state === "active" || other.state === "settling")
      && other.ownerKind !== local.ownerKind && (other.ownerKind === "desktop" || other.ownerKind === "daemon")
      && (local.ownerKind === "desktop" || local.ownerKind === "daemon")
      ? "invocation_chat_busy_other_host" : "invocation_chat_owned_by_other_run";
    throw Object.assign(new Error(code), { code, holderKind: other.ownerKind, ...(terminalProof ? { terminalProof: terminalProof.code } : {}) });
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
