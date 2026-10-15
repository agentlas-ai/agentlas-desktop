/**
 * Readiness probe for the canonical registry (G31). Synchronous, local state only, no network, no electron import.
 *
 * A signal maps to the registry's three unreachable reasons:
 *   not_installed  -> provider / plugin / connector is not installed
 *   needs_auth     -> installed but the owner has not signed in / connected     -> auth_required
 *   offline        -> installed and authorised but its process is known down    -> provider_offline
 * Anything else, and every entry with no signal, is "available": unknown is not unavailable.
 *
 * Today the host holds NO synchronous reader for MCP connector / plugin install or auth state. Every `tool` backing in
 * the registry points at a first-party in-process server (agentlas-browser, agentlas-turn, agentlas-ui, one-team,
 * hephaestus-network, builtin) that ships with the app, so there is nothing that can be "not installed". The default
 * state reader therefore returns no signal and the probe reports available for all entries; the mapping is in place
 * for readers that appear later (register one with registerCanonicalServerState).
 */
import { setCanonicalReadinessProbe, type CanonicalEntry, type CanonicalReadinessProbe } from "./canonical-registry";

export type CanonicalServerSignal = "ready" | "not_installed" | "needs_auth" | "offline";
export type CanonicalServerStateReader = (server: string) => CanonicalServerSignal | null | undefined;

const REASON: Record<Exclude<CanonicalServerSignal, "ready">, string> = {
  not_installed: "not_installed",
  needs_auth: "auth_required",
  offline: "provider_offline",
};

let reader: CanonicalServerStateReader = () => null;

/** Hosts with a real local connector / plugin state reader plug it in here; a throwing reader counts as no signal. */
export function registerCanonicalServerState(next: CanonicalServerStateReader | null): void { reader = next ?? (() => null); }

export function readinessFromSignal(signal: CanonicalServerSignal | null | undefined): string | null {
  return signal && signal !== "ready" && signal in REASON ? REASON[signal] : null;
}

export const canonicalReadinessProbe: CanonicalReadinessProbe = (item: CanonicalEntry) => {
  if (item.backing.kind !== "tool") return null; // ports and unbuilt entries are judged by the registry itself
  let signal: CanonicalServerSignal | null | undefined = null;
  try { signal = reader(item.backing.server); } catch { signal = null; }
  return readinessFromSignal(signal);
};

export function installCanonicalReadinessProbe(): void { setCanonicalReadinessProbe(canonicalReadinessProbe); }
