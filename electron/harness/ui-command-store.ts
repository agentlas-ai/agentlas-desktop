import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type UiCommandOutcome = { status: "ok"; data: unknown } | { status: "refused" | "unavailable"; reason: string; next?: string; data?: unknown };
interface CommandRow { binding: string; owner: string; pid: number; state: string; outcome: string | null; sent_receipt: string | null }
const activeOwners = new Set<string>();
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
export const unknownCommand = (evidence?: string | null): UiCommandOutcome => {
  let data: Record<string, unknown> | undefined;
  try {
    const receipt = JSON.parse(evidence ?? "null") as { receiptId?: unknown; operationId?: unknown; data?: { resultRef?: unknown } } | null;
    if (receipt && typeof receipt.receiptId === "string") data = { sentReceiptId: receipt.receiptId,
      ...(typeof receipt.operationId === "string" ? { operationId: receipt.operationId } : {}),
      ...(typeof receipt.data?.resultRef === "string" ? { resultRef: receipt.data.resultRef } : {}) };
  } catch { /* malformed evidence grants no replay */ }
  return { status: "refused", reason: "command_outcome_unknown", next: "inspect the original attempt before issuing a new command", ...(data ? { data } : {}) };
};

/** Canonical wire bytes: object key order is irrelevant; array order and every JSON value are bound. */
export function uiCommandBinding(value: unknown): string {
  const wire = JSON.parse(JSON.stringify(value)) as unknown;
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sorted(wire));
}

/** Seal existing POSIX paths too: mkdir mode does not tighten a legacy directory and SQLite uses the umask. */
function sealUiCommandPath(target: string, directory: boolean): void {
  // Windows inherits the existing userData ACL. POSIX bits are not ACL proof; do not add an unrelated ACL/spawn gate.
  if (process.platform === "win32") return;
  const mode = directory ? 0o700 : 0o600;
  fs.chmodSync(target, mode);
  if ((fs.statSync(target).mode & 0o777) !== mode) throw new Error("command_store_permissions_unverified");
}

/** A committed row is never deleted or reacquired. No timeout, refusal, cancellation or missing ACK grants a retry. */
export class UiCommandStore {
  private readonly db: Database.Database;
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    sealUiCommandPath(dir, true);
    const file = path.join(dir, "commands.sqlite");
    // Create without truncation before SQLite can write any payload; preserve existing database/journal bytes.
    const fd = fs.openSync(file, "a", 0o600);
    fs.closeSync(fd);
    sealUiCommandPath(file, false);
    for (const name of [`${file}-wal`, `${file}-shm`, `${file}-journal`]) {
      if (!fs.existsSync(name)) continue;
      try { sealUiCommandPath(name, false); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // Another SQLite connection may remove a transient companion; new companions inherit the sealed DB mode.
    }
    this.db = new Database(file, { timeout: 250 });
    try {
      this.db.pragma("synchronous = FULL");
      this.db.exec(`CREATE TABLE IF NOT EXISTS commands (
        key TEXT PRIMARY KEY, binding TEXT NOT NULL, owner TEXT NOT NULL, pid INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('claimed','sent','settled','unknown')),
        outcome TEXT, sent_receipt TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)`);
    } catch (e) { this.db.close(); throw e; }
  }
  claim(key: string, binding: string, legacy: () => unknown): { owner: string } | { wait: true } | { outcome: UiCommandOutcome } {
    const result = this.db.transaction((): { owner: string } | { wait: true } | { outcome: UiCommandOutcome } => {
      const row = this.db.prepare("SELECT binding,owner,pid,state,outcome,sent_receipt FROM commands WHERE key=?").get(key) as CommandRow | undefined;
      if (row) {
        if (row.binding !== binding) return { outcome: { status: "refused" as const, reason: "command_binding_mismatch" } };
        if (row.state === "settled") {
          const outcome = JSON.parse(row.outcome ?? "null") as UiCommandOutcome | null;
          if (!outcome || !((outcome.status === "ok" && Object.prototype.hasOwnProperty.call(outcome, "data")) || ((outcome.status === "refused" || outcome.status === "unavailable") && typeof outcome.reason === "string"))) throw new Error("command_outcome_invalid");
          return { outcome };
        }
        if (row.state === "unknown") return { outcome: unknownCommand(row.sent_receipt) };
        if (!alive(row.pid) || (row.pid === process.pid && !activeOwners.has(row.owner))) {
          this.db.prepare("UPDATE commands SET state='unknown',updated_at_ms=? WHERE key=? AND owner=?").run(Date.now(), key, row.owner);
          return { outcome: unknownCommand(row.sent_receipt) };
        }
        return { wait: true as const };
      }
      // Old executable attempts are not safe to replay. Preserve their evidence, including malformed/empty claims.
      const inherited = legacy();
      const owner = randomUUID(), now = Date.now();
      this.db.prepare("INSERT INTO commands(key,binding,owner,pid,state,sent_receipt,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?)")
        .run(key, binding, owner, process.pid, inherited === undefined ? "claimed" : "unknown", inherited === undefined ? null : JSON.stringify(inherited), now, now);
      if (inherited !== undefined) return { outcome: unknownCommand() };
      return { owner };
    }).immediate();
    if ("owner" in result) activeOwners.add(result.owner);
    return result;
  }
  sent(key: string, owner: string, validate: () => UiCommandOutcome | null): UiCommandOutcome | null {
    return this.db.transaction(() => {
      const refusal = validate();
      if (refusal) return refusal;
      const n = this.db.prepare("UPDATE commands SET state='sent',updated_at_ms=? WHERE key=? AND owner=? AND state='claimed'").run(Date.now(), key, owner).changes;
      if (n !== 1) throw new Error("command_owner_lost");
      return null;
    }).immediate();
  }
  rememberReceipt(key: string, owner: string, receipt: unknown): void {
    const n = this.db.prepare("UPDATE commands SET sent_receipt=?,updated_at_ms=? WHERE key=? AND owner=? AND state='sent'")
      .run(JSON.stringify(receipt), Date.now(), key, owner).changes;
    if (n !== 1) throw new Error("command_owner_lost");
  }
  settle(key: string, owner: string, outcome: UiCommandOutcome): void {
    const n = this.db.prepare("UPDATE commands SET state='settled',outcome=?,updated_at_ms=? WHERE key=? AND owner=? AND state IN ('claimed','sent')")
      .run(JSON.stringify(outcome), Date.now(), key, owner).changes;
    if (n !== 1) throw new Error("command_owner_lost");
  }
  unknown(key: string, owner: string): void { this.db.prepare("UPDATE commands SET state='unknown',updated_at_ms=? WHERE key=? AND owner=? AND state IN ('claimed','sent')").run(Date.now(), key, owner); }
  unknownOutcome(key: string, owner: string): UiCommandOutcome {
    const row = this.db.prepare("SELECT sent_receipt FROM commands WHERE key=? AND owner=?").get(key, owner) as { sent_receipt: string | null } | undefined;
    return unknownCommand(row?.sent_receipt);
  }
  release(owner: string): void { activeOwners.delete(owner); }
  close(): void { this.db.close(); }
}
