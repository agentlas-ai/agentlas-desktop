// The trial ledger of one Toolchain version (meta rows `toolchain.trial.v1:<id>@<version>`), shared by trial use (trial.ts),
// health (health.ts) and search. A version's ledger says "trial" while a draft proves itself in real use, "promoted" once it
// did, and "retired" when it failed — a retired STABLE version is a callable Toolchain that was pulled back for failing.

import { getDb } from "../store/db";
import type { TrialLedger } from "../../shared/toolchain-detector";
import type { ToolchainAsset } from "../../shared/toolchain-asset";

export const TRIAL_LEDGER_PREFIX = "toolchain.trial.v1:";

const key = (id: string, version: number) => `${TRIAL_LEDGER_PREFIX}${id}@${version}`;

export function readTrialLedger(id: string, version: number): TrialLedger | null {
  const row = getDb().prepare("SELECT value FROM meta WHERE key=?").get(key(id, version)) as { value: string } | undefined;
  try { return row ? JSON.parse(row.value) as TrialLedger : null; } catch { return null; }
}

export function writeTrialLedger(ledger: TrialLedger): void {
  getDb().prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(key(ledger.toolchainId, ledger.version),
    JSON.stringify({ ...ledger, updatedAt: new Date().toISOString() }));
}

export function allTrialLedgers(): TrialLedger[] {
  const rows = getDb().prepare("SELECT value FROM meta WHERE key >= ? AND key < ?").all(TRIAL_LEDGER_PREFIX, `${TRIAL_LEDGER_PREFIX}￿`) as Array<{ value: string }>;
  return rows.flatMap(row => { try { return [JSON.parse(row.value) as TrialLedger]; } catch { return []; } });
}

/**
 * A callable Toolchain whose stable version failed in real use and was pulled back. It leaves search and cannot be called until a
 * repaired version proves itself in trial and becomes the stable one (promoteToolchainVersionFromTrial moves stableVersion, so the
 * new stable version has its own ledger).
 */
export function isToolchainPulledBack(asset: Pick<ToolchainAsset, "id" | "status" | "stableVersion">): boolean {
  if (asset.status !== "callable" || asset.stableVersion === null) return false;
  return readTrialLedger(asset.id, asset.stableVersion)?.state === "retired";
}
