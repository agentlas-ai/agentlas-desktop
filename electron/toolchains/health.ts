// Health of callable Toolchains (shared/toolchain-health.ts decides; this file keeps the record and acts).
//
// Every real call of a callable Toolchain's stable version leaves an outcome. When failures that point at the tool — the page or
// app changed — become frequent, the Toolchain is pulled back, whoever made it (owner scheme: "it breaks often → the Toolchain
// is changed"): it leaves search and its tc_ tool and cannot be called. Until the owner (or One, through toolchain_create and
// toolchain_publish) publishes a new stable version, the work goes back to the agent, which is where it came from. The pulled-back
// mark lives on this version's health ledger, so a new stable version starts clean.

import { getDb } from "../store/db";
import type { ToolchainAsset, ToolchainCallReceipt } from "../../shared/toolchain-asset";
import { TOOLCHAIN_HEALTH_POLICY, healthOutcomeFrom, healthVerdict, type HealthLedger, type HealthVerdict } from "../../shared/toolchain-health";
import { getToolchainAsset, TOOLCHAIN_ASSET_META_PREFIX } from "./assets";

const HEALTH = "toolchain.health.v1:";
const key = (id: string, version: number) => `${HEALTH}${id}@${version}`;

export function readToolchainHealth(id: string, version: number): HealthLedger | null {
  const row = getDb().prepare("SELECT value FROM meta WHERE key=?").get(key(id, version)) as { value: string } | undefined;
  try { return row ? JSON.parse(row.value) as HealthLedger : null; } catch { return null; }
}

/** A callable Toolchain whose stable version failed in real use and was pulled back (set below, never cleared for that version). */
export function isToolchainPulledBack(asset: Pick<ToolchainAsset, "id" | "status" | "stableVersion">): boolean {
  if (asset.status !== "callable" || asset.stableVersion === null) return false;
  return readToolchainHealth(asset.id, asset.stableVersion)?.pulledBack === true;
}

/** What the Toolchains screen and the owner see: this version's recent outcomes and the host's reading of them. */
export function toolchainHealthVerdict(id: string, version: number): HealthVerdict | null {
  const ledger = readToolchainHealth(id, version);
  return ledger ? healthVerdict(ledger.outcomes) : null;
}

/** The reading the Toolchains screen shows next to a callable Toolchain; empty until it has been called for real. */
export function toolchainHealthView(asset: ToolchainAsset): { health?: NonNullable<ToolchainAsset["health"]> } {
  if (asset.status !== "callable" || asset.stableVersion === null) return {};
  const verdict = toolchainHealthVerdict(asset.id, asset.stableVersion);
  if (!verdict) return {};
  return { health: { state: isToolchainPulledBack(asset) ? "pulled_back" : verdict.state, counted: verdict.counted, failures: verdict.failures } };
}

/** Called by the call executor with every terminal receipt of a non-validation call. Never throws. */
export function recordToolchainHealthOutcome(receipt: Readonly<ToolchainCallReceipt>): void {
  try {
    const outcome = healthOutcomeFrom(receipt);
    if (!outcome) return;
    // Validate the potentially large release outside the write lock. Compare its
    // exact stored snapshot inside the transaction before applying the outcome.
    const db = getDb();
    for (let attempt = 0; attempt < 2; attempt++) {
      const asset = getToolchainAsset(receipt.toolchainId);
      const release = asset?.versions.find(item => item.version === receipt.version);
      if (!asset || !release || asset.status !== "callable" || asset.stableVersion !== receipt.version || release.contentHash !== receipt.contentHash) return;
      const keyOfAsset = `${TOOLCHAIN_ASSET_META_PREFIX}${asset.id}`;
      const snapshot = db.prepare("SELECT value FROM meta WHERE key=?").get(keyOfAsset) as { value: string } | undefined;
      if (!snapshot || JSON.stringify(JSON.parse(snapshot.value)) !== JSON.stringify(asset)) continue;
      const updated = db.transaction(() => {
        const current = db.prepare("SELECT value FROM meta WHERE key=?").get(keyOfAsset) as { value: string } | undefined;
        if (!current || current.value !== snapshot.value) return { changed: true as const };
        const prior = readToolchainHealth(asset.id, release.version);
        const base: HealthLedger = prior && prior.contentHash === release.contentHash ? prior
          : { schema: "agentlas.toolchain-health.v1", toolchainId: asset.id, version: release.version, contentHash: release.contentHash, outcomes: [], updatedAt: "" };
        if (base.outcomes.some(item => item.callId === outcome.callId)) return { changed: false as const };
        const outcomes = [...base.outcomes, outcome].slice(-TOOLCHAIN_HEALTH_POLICY.keep);
        const verdict = healthVerdict(outcomes);
        const pull = verdict.state === "degraded" && base.pulledBack !== true;
        const ledger: HealthLedger = { ...base, outcomes, ...(pull ? { pulledBack: true as const } : {}), updatedAt: new Date().toISOString() };
        db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(key(asset.id, release.version), JSON.stringify(ledger));
        return { changed: false as const, ...(pull ? { verdict } : {}) };
      }).immediate();
      if (updated.changed) continue;
      if (updated.verdict) console.info(`[toolchain-health] pulled back ${asset.id}@${release.version}: ${updated.verdict.reason} (${updated.verdict.failures} of ${updated.verdict.counted} counted calls failed, ${updated.verdict.ignored} environment failures ignored)`);
      return;
    }
    console.warn("[toolchain-health] outcome not recorded: asset changed during verification");
  } catch (error) {
    console.warn("[toolchain-health] outcome not recorded:", error instanceof Error ? error.message : error);
  }
}
