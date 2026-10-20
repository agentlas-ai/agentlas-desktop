// Health of callable Toolchains (shared/toolchain-health.ts decides; this file keeps the record and acts).
//
// Every real call of a callable Toolchain's stable version leaves an outcome. When failures that point at the tool — the page or
// app changed — become frequent, the Toolchain is pulled back, whoever made it (owner scheme: "it breaks often → the Toolchain
// is changed"): it leaves search and its tc_ tool, cannot be called, and the failures are sent to the generalizer as a repair
// request (detector.ts, once per version). The repaired version proves itself in trial like any new draft and becomes the
// stable one. Until then the work goes back to the agent, which is where it came from.

import { getDb } from "../store/db";
import type { ToolchainAsset, ToolchainCallReceipt } from "../../shared/toolchain-asset";
import { TOOLCHAIN_HEALTH_POLICY, healthOutcomeFrom, healthVerdict, type HealthLedger, type HealthVerdict } from "../../shared/toolchain-health";
import { getToolchainAsset } from "./assets";
import { isToolchainPulledBack, writeTrialLedger } from "./trial-ledger";

const HEALTH = "toolchain.health.v1:";
const key = (id: string, version: number) => `${HEALTH}${id}@${version}`;

export function readToolchainHealth(id: string, version: number): HealthLedger | null {
  const row = getDb().prepare("SELECT value FROM meta WHERE key=?").get(key(id, version)) as { value: string } | undefined;
  try { return row ? JSON.parse(row.value) as HealthLedger : null; } catch { return null; }
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

/** Called by the call executor with every terminal receipt of a non-trial, non-validation call. Never throws. */
export function recordToolchainHealthOutcome(receipt: Readonly<ToolchainCallReceipt>): void {
  try {
    const outcome = healthOutcomeFrom(receipt);
    if (!outcome) return;
    const asset = getToolchainAsset(receipt.toolchainId);
    const release = asset?.versions.find(item => item.version === receipt.version);
    // Only the stable version of a callable asset has a record; a draft in trial has its own ledger (trial.ts).
    if (!asset || !release || asset.status !== "callable" || asset.stableVersion !== receipt.version || release.contentHash !== receipt.contentHash) return;
    const prior = readToolchainHealth(asset.id, release.version);
    const base: HealthLedger = prior && prior.contentHash === release.contentHash ? prior
      : { schema: "agentlas.toolchain-health.v1", toolchainId: asset.id, version: release.version, contentHash: release.contentHash, outcomes: [], updatedAt: "" };
    if (base.outcomes.some(item => item.callId === outcome.callId)) return;
    const ledger: HealthLedger = { ...base, outcomes: [...base.outcomes, outcome].slice(-TOOLCHAIN_HEALTH_POLICY.keep), updatedAt: new Date().toISOString() };
    getDb().prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(key(asset.id, release.version), JSON.stringify(ledger));
    const verdict = healthVerdict(ledger.outcomes);
    if (verdict.state !== "degraded" || isToolchainPulledBack(asset)) return;
    // The failures become a retired ledger: the same record the repair request reads when a trial fails.
    writeTrialLedger({ schema: "agentlas.toolchain-trial.v1", toolchainId: asset.id, version: release.version, contentHash: release.contentHash,
      state: "retired", grants: [], updatedAt: "",
      outcomes: ledger.outcomes.filter(item => item.status !== "succeeded" && item.kind !== "environment").slice(-5)
        .map(item => ({ callId: item.callId, chatId: item.chatId, parentRunId: null, status: item.status === "uncertain" ? "uncertain" as const : "failed" as const, error: item.error, at: item.at })) });
    console.info(`[toolchain-health] pulled back ${asset.id}@${release.version}: ${verdict.reason} (${verdict.failures} of ${verdict.counted} counted calls failed, ${verdict.ignored} environment failures ignored)`);
  } catch (error) {
    console.warn("[toolchain-health] outcome not recorded:", error instanceof Error ? error.message : error);
  }
}
