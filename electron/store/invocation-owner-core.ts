import { randomUUID } from "node:crypto";
import type { CurrentTurnSteerSqliteDb } from "./current-turn-steer-core";

export interface InvocationRunOwner {
  chatId: string;
  runId: string;
  ownerId: string;
  ownerKind: "desktop" | "daemon" | "terminal";
  leaseId: string;
  state: "active" | "settling" | "released";
  createdAt: string;
  updatedAt: string;
}

export interface InvocationRunOwnerStorePorts {
  /** An already opened database. Schema creation belongs to its migration owner. */
  getDb(): CurrentTurnSteerSqliteDb;
  now?(): string;
}

type OwnerRow = {
  chat_id: string; run_id: string; owner_id: string;
  owner_kind: InvocationRunOwner["ownerKind"]; lease_id: string;
  state: InvocationRunOwner["state"]; created_at: string; updated_at: string;
};

function owner(row: OwnerRow | undefined): InvocationRunOwner | null {
  return row ? { chatId: row.chat_id, runId: row.run_id, ownerId: row.owner_id,
    ownerKind: row.owner_kind, leaseId: row.lease_id, state: row.state,
    createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f]/.test(value);
}

function validate(input: Pick<InvocationRunOwner, "chatId" | "runId" | "ownerId" | "ownerKind">): void {
  if (!input || !validId(input.chatId) || !validId(input.runId) || !validId(input.ownerId)
    || !["desktop", "daemon", "terminal"].includes(input.ownerKind)) {
    throw new Error("invocation_owner_identity_invalid");
  }
}

/** Custody is a durable conversation/run/process identity, never a PID or a timer.
 * Disconnecting a viewer does not prove its brain/tools stopped. Only the owner
 * releases its exact lease after its complete execution lifetime has drained. */
export function createInvocationRunOwnerStore(ports: InvocationRunOwnerStorePorts) {
  const now = ports.now ?? (() => new Date().toISOString());

  function getActiveOwner(chatId: string): InvocationRunOwner | null {
    if (!validId(chatId)) throw new Error("invocation_owner_identity_invalid");
    return owner(ports.getDb().prepare(`SELECT * FROM invocation_run_owners
      WHERE chat_id = ? AND state IN ('active','settling')`).get(chatId) as OwnerRow | undefined);
  }

  function getRunOwner(chatId: string, runId: string): InvocationRunOwner | null {
    if (!validId(chatId) || !validId(runId)) throw new Error("invocation_owner_identity_invalid");
    return owner(ports.getDb().prepare(`SELECT * FROM invocation_run_owners
      WHERE chat_id = ? AND run_id = ?`).get(chatId, runId) as OwnerRow | undefined);
  }

  function getOwnerByRunId(runId: string): InvocationRunOwner | null {
    if (!validId(runId)) throw new Error("invocation_owner_identity_invalid");
    return owner(ports.getDb().prepare("SELECT * FROM invocation_run_owners WHERE run_id = ?")
      .get(runId) as OwnerRow | undefined);
  }

  /** The chat's most recent run owner other than `excludeRunId`: which process ran the chat's turn before this one.
   * Rows are never deleted, so this is the durable "last execution host" of the chat (1.3.0 A2). */
  function getPreviousOwner(chatId: string, excludeRunId: string): InvocationRunOwner | null {
    if (!validId(chatId) || !validId(excludeRunId)) throw new Error("invocation_owner_identity_invalid");
    return owner(ports.getDb().prepare(`SELECT * FROM invocation_run_owners
      WHERE chat_id = ? AND run_id <> ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(chatId, excludeRunId) as OwnerRow | undefined);
  }

  function listActiveOwners(): InvocationRunOwner[] {
    return (ports.getDb().prepare("SELECT * FROM invocation_run_owners WHERE state IN ('active','settling')")
      .all() as OwnerRow[]).map(row => owner(row)!);
  }

  function claim(input: Pick<InvocationRunOwner, "chatId" | "runId" | "ownerId" | "ownerKind"> & { reopenReleased?: boolean }):
    { kind: "claimed" | "busy"; owner: InvocationRunOwner } {
    validate(input);
    return ports.getDb().transaction(() => {
      const prior = getOwnerByRunId(input.runId);
      // A graph run invokes its agent nodes one after another under one run id, often on the same chat. The process that
      // released the run's lease may open it again for the next node, with a new lease id, so whoever still holds the old
      // lease stays refused. Without this, every second node on a chat failed with invocation_chat_owned_by_other_run
      // (production 2026-10-15..16: the daily YouTube graph, step2, right after step1 released).
      if (prior && input.reopenReleased && prior.state === "released" && prior.chatId === input.chatId
        && prior.ownerId === input.ownerId && prior.ownerKind === input.ownerKind) {
        const active = getActiveOwner(input.chatId);
        if (active) return { kind: "busy" as const, owner: active };
        const reopened = ports.getDb().prepare(`UPDATE invocation_run_owners SET state = 'active', lease_id = ?, updated_at = ?
          WHERE run_id = ? AND lease_id = ? AND state = 'released'`).run(randomUUID(), now(), prior.runId, prior.leaseId);
        if (reopened.changes === 1) return { kind: "claimed" as const, owner: getRunOwner(input.chatId, input.runId)! };
      }
      if (prior) return { kind: prior.chatId === input.chatId && prior.ownerId === input.ownerId
        && prior.ownerKind === input.ownerKind && prior.state === "active" ? "claimed" as const : "busy" as const,
      owner: prior };
      const active = getActiveOwner(input.chatId);
      if (active) return { kind: "busy" as const, owner: active };
      const timestamp = now(), leaseId = randomUUID();
      ports.getDb().prepare(`INSERT INTO invocation_run_owners
        (chat_id, run_id, owner_id, owner_kind, lease_id, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
        .run(input.chatId, input.runId, input.ownerId, input.ownerKind, leaseId, timestamp, timestamp);
      return { kind: "claimed" as const, owner: getRunOwner(input.chatId, input.runId)! };
    }).immediate();
  }

  function transition(expected: InvocationRunOwner, state: "settling" | "released"): boolean {
    validate(expected);
    if (!validId(expected.leaseId)) throw new Error("invocation_owner_identity_invalid");
    return ports.getDb().prepare(`UPDATE invocation_run_owners SET state = ?, updated_at = ?
      WHERE chat_id = ? AND run_id = ? AND owner_id = ? AND owner_kind = ? AND lease_id = ?
      AND state IN ('active','settling')`)
      .run(state, now(), expected.chatId, expected.runId, expected.ownerId, expected.ownerKind, expected.leaseId).changes === 1;
  }

  /** Leases a previous process of `ownerKind` left active or settling because it died without settling them (crash,
   * forced reboot). Only a caller that has proven it is now the sole live process of that kind may release them:
   * Desktop under Electron's single-instance lock, the daemon after it won the control socket. Measured 2026-10-12:
   * after a forced reboot two rooms stayed refused with invocation_cleanup_pending on every resume, because nothing
   * ever released the dead Desktop's rows and the chat's active-owner index stayed taken. */
  function releaseAbandoned(ownerKind: InvocationRunOwner["ownerKind"], liveOwnerId: string): InvocationRunOwner[] {
    if (!validId(liveOwnerId) || !["desktop", "daemon", "terminal"].includes(ownerKind)) {
      throw new Error("invocation_owner_identity_invalid");
    }
    return ports.getDb().transaction(() => {
      const rows = (ports.getDb().prepare(`SELECT * FROM invocation_run_owners
        WHERE owner_kind = ? AND owner_id <> ? AND state IN ('active','settling')`)
        .all(ownerKind, liveOwnerId) as OwnerRow[]).map(row => owner(row)!);
      const release = ports.getDb().prepare(`UPDATE invocation_run_owners SET state = 'released', updated_at = ?
        WHERE run_id = ? AND lease_id = ? AND state IN ('active','settling')`);
      for (const row of rows) release.run(now(), row.runId, row.leaseId);
      return rows;
    }).immediate();
  }

  /** The leases of specific owner processes that the caller has PROVEN gone. Unlike releaseAbandoned this is not "every other
   * process of the kind": a terminal has no single-instance lock, so one terminal's death proves nothing about another that is
   * still running its own turn. Only rows of the named owner ids and kind, still active or settling, in one transaction. */
  function releaseAbandonedOwners(ownerKind: InvocationRunOwner["ownerKind"], deadOwnerIds: readonly string[]): InvocationRunOwner[] {
    if (!["desktop", "daemon", "terminal"].includes(ownerKind) || !Array.isArray(deadOwnerIds) || !deadOwnerIds.every(validId)) {
      throw new Error("invocation_owner_identity_invalid");
    }
    const ids = [...new Set(deadOwnerIds)];
    if (ids.length === 0) return [];
    return ports.getDb().transaction(() => {
      const select = ports.getDb().prepare(`SELECT * FROM invocation_run_owners
        WHERE owner_kind = ? AND owner_id = ? AND state IN ('active','settling')`);
      const release = ports.getDb().prepare(`UPDATE invocation_run_owners SET state = 'released', updated_at = ?
        WHERE run_id = ? AND lease_id = ? AND state IN ('active','settling')`);
      const released: InvocationRunOwner[] = [];
      for (const id of ids) {
        for (const row of select.all(ownerKind, id) as OwnerRow[]) {
          const lease = owner(row)!;
          if (release.run(now(), lease.runId, lease.leaseId).changes === 1) released.push(lease);
        }
      }
      return released;
    }).immediate();
  }

  return { claim, getActiveOwner, getRunOwner, getOwnerByRunId, getPreviousOwner, listActiveOwners, releaseAbandoned, releaseAbandonedOwners,
    markSettling: (expected: InvocationRunOwner) => transition(expected, "settling"),
    release: (expected: InvocationRunOwner) => transition(expected, "released") };
}
