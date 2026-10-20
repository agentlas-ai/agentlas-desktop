// Per-Toolchain ledger — one small JSON document per Toolchain in `meta` (key `toolchain.v1:asset:<id>`):
// caller reports, repairs and search exposure.
//
// Why not new tables: a ladder step would also require regenerating the Terminal's bootstrap schema, which
// would make every Terminal user on an older Desktop refuse to open the shared store until a Desktop release
// ships (scripts/verify-desktop-release-order.cjs in agentlas_terminal). The documents are tiny, so `meta` —
// "small singletons that don't deserve their own table" — is the honest home until a release can carry tables.
//
// Every write is compare-and-set on `revision` inside one IMMEDIATE transaction: reports and repairs can race.

import { emptyToolchainLedger, type ToolchainLedgerState } from "../../shared/toolchain";
import { getDb } from "../store/db";
import { emitDesktopStoreChange } from "../store/change-bus";

const KEY_PREFIX = "toolchain.v1:";

function keyOf(automationId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(automationId)) throw new Error("toolchain_automation_id_invalid");
  return `${KEY_PREFIX}${automationId}`;
}

function parse(automationId: string, raw: string | undefined): ToolchainLedgerState {
  if (!raw) return emptyToolchainLedger(automationId);
  try {
    const value = JSON.parse(raw) as ToolchainLedgerState;
    if (value?.schemaVersion !== "agentlas.toolchain-state.v1" || value.automationId !== automationId) {
      return emptyToolchainLedger(automationId);
    }
    return { ...emptyToolchainLedger(automationId), ...value };
  } catch {
    // A damaged document is not silently "empty forever": the next write replaces it.
    return emptyToolchainLedger(automationId);
  }
}

export function readToolchainState(automationId: string): ToolchainLedgerState {
  const row = getDb().prepare("SELECT value FROM meta WHERE key = ?").get(keyOf(automationId)) as { value: string } | undefined;
  return parse(automationId, row?.value);
}

export class ToolchainStateConflict extends Error {
  constructor() { super("toolchain_state_conflict"); }
}

/**
 * Read-modify-write under one transaction. `update` returns the next document
 * (or null for "no change"); the revision it saw must still be current.
 */
export function mutateToolchainState(
  automationId: string,
  update: (current: ToolchainLedgerState) => ToolchainLedgerState | null,
): ToolchainLedgerState {
  const db = getDb();
  const key = keyOf(automationId);
  let result: ToolchainLedgerState | null = null;
  let changed = false;
  db.transaction(() => {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    const current = parse(automationId, row?.value);
    const next = update(current);
    if (!next) { result = current; return; }
    if (next.revision !== current.revision) throw new ToolchainStateConflict();
    const saved: ToolchainLedgerState = { ...next, revision: current.revision + 1 };
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(saved));
    result = saved;
    changed = true;
  }).immediate();
  if (changed) emitDesktopStoreChange({ entity: "automation", id: automationId });
  return result as unknown as ToolchainLedgerState;
}
