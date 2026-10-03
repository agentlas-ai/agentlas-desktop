// Adaptive Toolchain state — one small JSON document per automation in `meta`.
//
// Why not new tables: a ladder step (schema 128) would also require regenerating
// the Terminal's bootstrap schema, which would make every Terminal user on a
// 127 Desktop refuse to open the shared store until a Desktop release ships
// (scripts/verify-desktop-release-order.cjs in agentlas_terminal). The state is
// tiny (a handful of automations, a few overlays each) and episodes are derived
// from run_events on demand, so `meta` — "small singletons that don't deserve
// their own table" — is the honest home until a release can carry real tables.
//
// Every write is compare-and-set on `revision` inside one IMMEDIATE transaction:
// the learner, the runtime overlay and owner decisions can race.

import {
  emptyToolchainState,
  type ToolchainAutomationState,
} from "../../shared/toolchain";
import { getDb } from "../store/db";
import { emitDesktopStoreChange } from "../store/change-bus";

const KEY_PREFIX = "toolchain.v1:";

function keyOf(automationId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(automationId)) throw new Error("toolchain_automation_id_invalid");
  return `${KEY_PREFIX}${automationId}`;
}

function parse(automationId: string, raw: string | undefined): ToolchainAutomationState {
  if (!raw) return emptyToolchainState(automationId);
  try {
    const value = JSON.parse(raw) as ToolchainAutomationState;
    if (value?.schemaVersion !== "agentlas.toolchain-state.v1" || value.automationId !== automationId) {
      return emptyToolchainState(automationId);
    }
    return {
      ...emptyToolchainState(automationId),
      ...value,
      observations: Array.isArray(value.observations) ? value.observations : [],
      crystallizations: Array.isArray(value.crystallizations) ? value.crystallizations : [],
      interface: value.interface ?? null,
    };
  } catch {
    // A damaged document is not silently "empty forever": the next write replaces it.
    return emptyToolchainState(automationId);
  }
}

export function readToolchainState(automationId: string): ToolchainAutomationState {
  const row = getDb().prepare("SELECT value FROM meta WHERE key = ?").get(keyOf(automationId)) as { value: string } | undefined;
  return parse(automationId, row?.value);
}

export function listToolchainStates(): ToolchainAutomationState[] {
  const rows = getDb().prepare("SELECT key, value FROM meta WHERE key >= ? AND key < ?")
    .all(KEY_PREFIX, `${KEY_PREFIX}￿`) as Array<{ key: string; value: string }>;
  return rows.map((row) => parse(row.key.slice(KEY_PREFIX.length), row.value));
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
  update: (current: ToolchainAutomationState) => ToolchainAutomationState | null,
): ToolchainAutomationState {
  const db = getDb();
  const key = keyOf(automationId);
  let result: ToolchainAutomationState | null = null;
  let changed = false;
  db.transaction(() => {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    const current = parse(automationId, row?.value);
    const next = update(current);
    if (!next) { result = current; return; }
    if (next.revision !== current.revision) throw new ToolchainStateConflict();
    const saved: ToolchainAutomationState = { ...next, revision: current.revision + 1 };
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(saved));
    result = saved;
    changed = true;
  }).immediate();
  if (changed) emitDesktopStoreChange({ entity: "automation", id: automationId });
  return result as unknown as ToolchainAutomationState;
}

export function removeToolchainState(automationId: string): void {
  getDb().prepare("DELETE FROM meta WHERE key = ?").run(keyOf(automationId));
}
