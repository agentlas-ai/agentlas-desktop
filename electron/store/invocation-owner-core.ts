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

  function listActiveOwners(): InvocationRunOwner[] {
    return (ports.getDb().prepare("SELECT * FROM invocation_run_owners WHERE state IN ('active','settling')")
      .all() as OwnerRow[]).map(row => owner(row)!);
  }

  function claim(input: Pick<InvocationRunOwner, "chatId" | "runId" | "ownerId" | "ownerKind">):
    { kind: "claimed" | "busy"; owner: InvocationRunOwner } {
    validate(input);
    return ports.getDb().transaction(() => {
      const prior = getOwnerByRunId(input.runId);
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
    })();
  }

  function transition(expected: InvocationRunOwner, state: "settling" | "released"): boolean {
    validate(expected);
    if (!validId(expected.leaseId)) throw new Error("invocation_owner_identity_invalid");
    return ports.getDb().prepare(`UPDATE invocation_run_owners SET state = ?, updated_at = ?
      WHERE chat_id = ? AND run_id = ? AND owner_id = ? AND owner_kind = ? AND lease_id = ?
      AND state IN ('active','settling')`)
      .run(state, now(), expected.chatId, expected.runId, expected.ownerId, expected.ownerKind, expected.leaseId).changes === 1;
  }

  return { claim, getActiveOwner, getRunOwner, getOwnerByRunId, listActiveOwners,
    markSettling: (expected: InvocationRunOwner) => transition(expected, "settling"),
    release: (expected: InvocationRunOwner) => transition(expected, "released") };
}
