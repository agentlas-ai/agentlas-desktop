import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

/** Latest owner toggle wins while enabling awaits remote entitlement checks. Disable never waits. */
export class AliveOwnerIntentGate {
  private readonly pending = new Map<string, symbol>();

  async run<T>(scopeKey: string, enabled: boolean, actions: {
    refreshAccess: () => Promise<unknown>;
    read: () => T;
    apply: () => T;
  }): Promise<T> {
    const intent = Symbol();
    this.pending.set(scopeKey, intent);
    try {
      if (enabled) {
        await actions.refreshAccess();
        // A later toggle (including an already-completed disable) supersedes this enable.
        if (this.pending.get(scopeKey) !== intent) return actions.read();
      }
      return actions.apply();
    } finally {
      if (this.pending.get(scopeKey) === intent) this.pending.delete(scopeKey);
    }
  }
}


export interface DurableAliveOwnerIntent {
  readonly intentId: string;
  readonly epoch: number;
  readonly scopeKeys: readonly string[];
}
const intentJson = (input: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.keys(input).sort().map(key => [key, input[key]])));
const scopeJson = (keys: readonly string[]) => JSON.stringify([...new Set(keys)].sort());

/** Owner toggles are ordered across processes, including a stop while the owner channel is unavailable.
 * A forwarded request reuses its immutable receipt: delayed delivery never becomes a newer owner instruction.
 * The write transaction encloses both the latest-intent check and the synchronous host/store mutation.
 */
export class DurableAliveOwnerIntents {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS alive_owner_intents (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, intent_id TEXT NOT NULL UNIQUE,
      request_json TEXT NOT NULL CHECK(json_valid(request_json)),
      scope_keys_json TEXT NOT NULL CHECK(json_valid(scope_keys_json)), created_at_ms INTEGER NOT NULL)`);
  }
  issue(input: Record<string, unknown>, scopeKeys: readonly string[], nowMs: number): DurableAliveOwnerIntent {
    if (!scopeKeys.length || scopeKeys.length > 64 || scopeKeys.some(key => typeof key !== "string" || !key.length || key.length > 500)) throw new Error("alive-owner-intent-scope-invalid");
    const intentId = randomUUID();
    const result = this.db.prepare("INSERT INTO alive_owner_intents(intent_id,request_json,scope_keys_json,created_at_ms) VALUES (?,?,?,?)")
      .run(intentId, intentJson(input), scopeJson(scopeKeys), nowMs);
    return Object.freeze({ intentId, epoch: Number(result.lastInsertRowid), scopeKeys: Object.freeze([...new Set(scopeKeys)].sort()) });
  }
  accept(intentId: string, input: Record<string, unknown>): DurableAliveOwnerIntent {
    if (!/^[a-f0-9-]{36}$/i.test(intentId)) throw new Error("alive-owner-intent-invalid");
    const row = this.db.prepare("SELECT sequence,request_json,scope_keys_json FROM alive_owner_intents WHERE intent_id=?").get(intentId) as
      { sequence: number; request_json: string; scope_keys_json: string } | undefined;
    if (!row || row.request_json !== intentJson(input)) throw new Error("alive-owner-intent-binding-invalid");
    return Object.freeze({ intentId, epoch: row.sequence, scopeKeys: Object.freeze(JSON.parse(row.scope_keys_json) as string[]) });
  }
  current(intent: DurableAliveOwnerIntent, scopeKeys: readonly string[]): boolean {
    if (scopeJson(intent.scopeKeys) !== scopeJson(scopeKeys)) return false;
    const placeholders = intent.scopeKeys.map(() => "?").join(",");
    const newer = this.db.prepare(`SELECT 1 FROM alive_owner_intents i, json_each(i.scope_keys_json) s
      WHERE i.sequence > ? AND s.value IN (${placeholders}) LIMIT 1`).get(intent.epoch, ...intent.scopeKeys);
    return !newer;
  }
  commit<T>(intent: DurableAliveOwnerIntent, scopeKeys: () => readonly string[], apply: () => T): { applied: true; value: T } | { applied: false } {
    return this.db.transaction(() => this.current(intent, scopeKeys()) ? { applied: true as const, value: apply() } : { applied: false as const }).immediate();
  }
}
