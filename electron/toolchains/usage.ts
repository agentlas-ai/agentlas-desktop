import type { ToolchainAsset } from "../../shared/toolchain-asset";
import { getDb } from "../store/db";
import { getToolchainAsset } from "./assets";
import { listToolchainCalls } from "./calls";
import { mutateToolchainState, readToolchainState } from "./store";

interface AssetDiscoveryUsage { returned: number }
type StateWithDiscovery = ReturnType<typeof readToolchainState> & { assetDiscovery?: AssetDiscoveryUsage };
const ledger = (id: string) => `asset:${id}`;

/** Host-returned search exposure is separate from an admitted call or delivered result.
 * Record only the exact selected current assets; no task text or new execution is stored. */
export function recordToolchainAssetDiscovery(selected: readonly ToolchainAsset[]): void {
  const unique = new Set(selected.map(asset => asset.id));
  if (unique.size !== selected.length) throw Error("toolchain_discovery_duplicate_identity");
  getDb().transaction(() => {
    for (const selectedAsset of selected) {
      const current = getToolchainAsset(selectedAsset.id);
      if (!current || current.status !== "callable" || current.revision !== selectedAsset.revision
        || current.stableVersion !== selectedAsset.stableVersion) throw Error("toolchain_discovery_changed");
      const version = current.versions.find(release => release.version === current.stableVersion);
      const expected = selectedAsset.versions.find(release => release.version === selectedAsset.stableVersion);
      if (!version || version.validation.state !== "passed" || version.contentHash !== expected?.contentHash)
        throw Error("toolchain_discovery_changed");
      mutateToolchainState(ledger(current.id), state => {
        const previous = (state as StateWithDiscovery).assetDiscovery?.returned ?? 0;
        if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER)
          throw Error("toolchain_discovery_usage_invalid");
        return { ...state, assetDiscovery: { returned: previous + 1 } };
      });
    }
  }).immediate();
}

export function toolchainAssetUsage(id: string): { returned: number; runs: number } {
  const returned = (readToolchainState(ledger(id)) as StateWithDiscovery).assetDiscovery?.returned ?? 0;
  if (!Number.isSafeInteger(returned) || returned < 0) throw Error("toolchain_discovery_usage_invalid");
  // A refused input has no receipt; idempotent replay has the same receipt.
  // Validation examples are intentionally excluded from owner-requested use.
  const runs = listToolchainCalls(id).filter(call => !call.dryRun && !call.requestId.startsWith("validation:")).length;
  return { returned, runs };
}
