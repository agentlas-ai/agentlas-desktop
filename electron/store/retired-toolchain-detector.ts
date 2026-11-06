import type Database from "better-sqlite3";

/**
 * One-time cleanup of the rows the removed Toolchain detector and trial path left in `meta`. Nobody reads them any more
 * (the writers are gone); this deletes them at store open (owner role only) and does nothing once they are gone.
 * Draft and owner Toolchain assets are never touched. Returns the number of rows deleted.
 *
 * One fact in those rows is still live: an earlier build recorded "this callable Toolchain's stable version was pulled back for
 * failing" as a trial ledger with state `retired`. Dropping that row would make the Toolchain callable again. Before the rows go,
 * each such mark is carried into the version's health ledger (`toolchain.health.v1:<id>@<version>`, the record the current build
 * reads), in the same transaction as the delete: a pass that fails leaves both untouched and the next open tries again.
 * A retired ledger that does not describe the callable asset's current stable version (a draft's trial, an older version) is dropped.
 *
 * Cost: a store open with no old rows runs two indexed range probes and takes no write lock.
 */
const PREFIXES = ["toolchain.detector.", "toolchain.trial.v1:"] as const;
const TRIAL = "toolchain.trial.v1:";
const ASSET = "toolchain.asset.v1:";
const HEALTH = "toolchain.health.v1:";

const present = (db: Database.Database, prefix: string): boolean =>
  db.prepare("SELECT 1 FROM meta WHERE key >= ? AND key < ? LIMIT 1").get(prefix, `${prefix}￿`) !== undefined;

function carryPulledBackMarks(db: Database.Database): void {
  const rows = db.prepare("SELECT value FROM meta WHERE key >= ? AND key < ?").all(TRIAL, `${TRIAL}￿`) as Array<{ value: string }>;
  const read = db.prepare("SELECT value FROM meta WHERE key=?");
  const write = db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)");
  for (const row of rows) {
    // Only reading and deciding may be skipped on a bad row; a failed write must throw so the transaction (carry and delete) rolls back.
    let pending: { key: string; value: string } | null = null;
    try {
      const ledger = JSON.parse(row.value) as { state?: unknown; toolchainId?: unknown; version?: unknown; contentHash?: unknown };
      if (ledger.state !== "retired" || typeof ledger.toolchainId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(ledger.toolchainId)
        || !Number.isSafeInteger(ledger.version)) continue;
      const assetRow = read.get(`${ASSET}${ledger.toolchainId}`) as { value: string } | undefined;
      const asset = assetRow ? JSON.parse(assetRow.value) as { status?: unknown; stableVersion?: unknown; versions?: Array<{ version?: unknown; contentHash?: unknown }> } : null;
      const release = asset?.versions?.find(item => item.version === ledger.version);
      if (!asset || asset.status !== "callable" || asset.stableVersion !== ledger.version || !release || typeof release.contentHash !== "string") continue;
      // A mark written for different content than the asset's current release does not describe it.
      if (typeof ledger.contentHash === "string" && ledger.contentHash !== release.contentHash) continue;
      const key = `${HEALTH}${ledger.toolchainId}@${ledger.version}`;
      const existingRow = read.get(key) as { value: string } | undefined;
      let existing: Record<string, unknown> | null = null;
      try { existing = existingRow ? JSON.parse(existingRow.value) as Record<string, unknown> : null; } catch { existing = null; }
      if (existing?.pulledBack === true) continue;
      const base = existing && existing.contentHash === release.contentHash ? existing
        : { schema: "agentlas.toolchain-health.v1", toolchainId: ledger.toolchainId, version: ledger.version, contentHash: release.contentHash, outcomes: [] };
      pending = { key, value: JSON.stringify({ ...base, pulledBack: true, updatedAt: new Date().toISOString() }) };
    } catch {
      // An unreadable old row carries nothing; it is deleted with the rest.
    }
    if (pending) write.run(pending.key, pending.value);
  }
}

export function purgeRetiredToolchainDetector(db: Database.Database): number {
  try {
    if (!PREFIXES.some(prefix => present(db, prefix))) return 0;
    return db.transaction(() => {
      carryPulledBackMarks(db);
      return PREFIXES.reduce((n, p) => n + db.prepare("DELETE FROM meta WHERE key >= ? AND key < ?").run(p, `${p}￿`).changes, 0);
    }).immediate();
  } catch (error) {
    console.warn("[toolchain-detector-cleanup] skipped:", error instanceof Error ? error.message : error);
    return 0;
  }
}
