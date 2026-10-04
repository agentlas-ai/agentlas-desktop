import type { RuntimeSelection, RuntimeStatus } from "../../shared/types";
import { quotaExhausted } from "../../shared/runtime-quota";

export interface ScienceRuntimeSelectionAvailability {
  status: "available" | "unavailable" | "unknown";
  reason?: "quota" | "auth" | "runtime";
  retryAfterAt?: string;
}
interface AvailabilityPorts {
  cooldown(runtime: Pick<RuntimeStatus, "kind" | "backend" | "source" | "model">, now: number): { kind: string; until: number } | null;
  signedOut(runtime: Pick<RuntimeStatus, "kind" | "backend" | "source" | "model">): unknown;
  usedPercent(providerId: string, now: number, model?: string): number | null;
  quotaExhausted?(providerId: string, now: number, model?: string): boolean;
}

/** Read authority for an exact detected executable/account and selected model.
 * No provider probe, owner-choice write, or account inference occurs here. */
export function scienceRuntimeSelectionAvailability(
  selection: RuntimeSelection,
  inventory: readonly RuntimeStatus[],
  ports: AvailabilityPorts,
  now = Date.now(),
): ScienceRuntimeSelectionAvailability {
  const sameKind = inventory.filter(runtime => runtime.kind === selection.kind);
  const matching = sameKind.filter(runtime => (!selection.backend || runtime.backend === selection.backend)
    && (!selection.source || runtime.source === selection.source)
    && (selection.kind !== "acp" || runtime.acpAgentId === selection.acpAgentId));
  if (!matching.length) return { status: "unavailable", reason: "runtime" };
  if (matching.length !== 1) return { status: "unknown" };
  const runtime = matching[0];
  const exact = { kind: runtime.kind, backend: runtime.backend, source: runtime.source, model: selection.model ?? runtime.model };
  if (runtime.credentialAccess?.status === "unavailable" || runtime.signInRequired || ports.signedOut(exact))
    return { status: "unavailable", reason: "auth" };
  const cooling = ports.cooldown(exact, now);
  if (cooling && cooling.until > now && (cooling.kind === "quota" || cooling.kind === "auth")) {
    return { status: "unavailable", reason: cooling.kind,
      ...(cooling.kind === "quota" ? { retryAfterAt: new Date(cooling.until).toISOString() } : {}) };
  }
  // Subscription usage is keyed by CLI provider, not BYOK backend/account.
  // Multiple executable identities cannot be bound to that one snapshot; leave
  // their quota unknown instead of blocking a different account's usable seat.
  const subscriptionBackend = { "claude-code": "anthropic", codex: "openai", kimi: "kimi", grok: "custom" }[runtime.kind as string];
  if (!subscriptionBackend || runtime.backend !== subscriptionBackend || sameKind.length !== 1)
    return { status: "unknown" };
  const used = ports.usedPercent(runtime.kind, now, exact.model ?? undefined);
  const exhausted = ports.quotaExhausted?.(runtime.kind, now, exact.model ?? undefined) ?? quotaExhausted(used);
  if (exhausted) return { status: "unavailable", reason: "quota" };
  return { status: typeof used === "number" && Number.isFinite(used) ? "available" : "unknown" };
}

export async function inspectScienceRuntimeSelectionAvailability(selection: RuntimeSelection): Promise<ScienceRuntimeSelectionAvailability> {
  const [{ detectRuntimes }, cooldown, { peekProviderUsedPercent, peekProviderQuotaExhausted }] = await Promise.all([
    import("../runtime/detect"), import("../runtime/runtime-cooldown"), import("../usage"),
  ]);
  return scienceRuntimeSelectionAvailability(selection, await detectRuntimes(), {
    cooldown: cooldown.runtimeCooldown,
    signedOut: cooldown.runtimeSignedOut,
    usedPercent: peekProviderUsedPercent,
    quotaExhausted: peekProviderQuotaExhausted,
  });
}
