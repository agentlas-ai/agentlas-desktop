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
import { getToolchainAsset } from "./assets";

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
    const asset = getToolchainAsset(receipt.toolchainId);
    const release = asset?.versions.find(item => item.version === receipt.version);
    // Only the stable version of a callable asset has a record.
    if (!asset || !release || asset.status !== "callable" || asset.stableVersion !== receipt.version || release.contentHash !== receipt.contentHash) return;
    const prior = readToolchainHealth(asset.id, release.version);
    const base: HealthLedger = prior && prior.contentHash === release.contentHash ? prior
      : { schema: "agentlas.toolchain-health.v1", toolchainId: asset.id, version: release.version, contentHash: release.contentHash, outcomes: [], updatedAt: "" };
    if (base.outcomes.some(item => item.callId === outcome.callId)) return;
    const outcomes = [...base.outcomes, outcome].slice(-TOOLCHAIN_HEALTH_POLICY.keep);
    const verdict = healthVerdict(outcomes);
    const pull = verdict.state === "degraded" && base.pulledBack !== true;
    const ledger: HealthLedger = { ...base, outcomes, ...(pull ? { pulledBack: true as const } : {}), updatedAt: new Date().toISOString() };
    getDb().prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(key(asset.id, release.version), JSON.stringify(ledger));
    if (!pull) return;
    console.info(`[toolchain-health] pulled back ${asset.id}@${release.version}: ${verdict.reason} (${verdict.failures} of ${verdict.counted} counted calls failed, ${verdict.ignored} environment failures ignored)`);
  } catch (error) {
    console.warn("[toolchain-health] outcome not recorded:", error instanceof Error ? error.message : error);
  }
}
