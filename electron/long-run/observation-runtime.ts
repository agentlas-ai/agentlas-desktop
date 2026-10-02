import type { RuntimeSelection, RuntimeStatus } from "../../shared/types";
import { detectRuntimes } from "../runtime/detect";
import { runtimeCooldownForSelection } from "../runtime/runtime-cooldown";
import { rolePriorityRuntimes } from "../runtime/selection";

let inventory: { at: number; runtimes: RuntimeStatus[] } | null = null;
let probing: Promise<void> | null = null;
const pending = new Map<string, () => void>();

/** An observation only reads. A measured quota may route that read through the
 * configured healthy pool without changing the owner's saved preference or
 * replaying the original action. Authentication failures never grant fallback. */
export function observationRuntime(preferred: RuntimeSelection | null | undefined, key: string, retry: () => void):
  { selection: RuntimeSelection | null | undefined } | { wait: string } {
  if (!preferred || runtimeCooldownForSelection(preferred)?.kind !== "quota") return { selection: preferred };
  if (inventory && Date.now() - inventory.at < 60_000) {
    const candidate = rolePriorityRuntimes(inventory.runtimes, "orchestrator").find(item =>
      item.kind !== preferred.kind || item.backend !== preferred.backend || item.model !== preferred.model);
    if (!candidate) return { wait: "effect_observation_runtime_quota_wait" };
    return { selection: { kind: candidate.kind, backend: candidate.backend, source: candidate.source,
      model: candidate.model ?? undefined, effort: candidate.effort ?? undefined,
      longContext: candidate.longContextEnabled,
      ...(candidate.acpAgentId ? { acpAgentId: candidate.acpAgentId } : {}) } };
  }
  pending.set(key, retry);
  if (!probing) {
    probing = detectRuntimes().then(runtimes => { inventory = { at: Date.now(), runtimes }; })
      .catch(() => { inventory = { at: Date.now(), runtimes: [] }; })
      .finally(() => {
        probing = null;
        const callbacks = [...pending.values()]; pending.clear();
        for (const callback of callbacks) { try { callback(); } catch { /* Next sweep retries admission. */ } }
      });
  }
  return { wait: "effect_observation_runtime_probe_pending" };
}
