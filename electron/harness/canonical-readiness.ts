/**
 * Readiness probe for the canonical registry (G31). Synchronous, local state only, no network, no electron import.
 *
 * A signal maps to the registry's three unreachable reasons:
 *   not_installed  -> provider / plugin / connector is not installed
 *   needs_auth     -> installed but the owner has not signed in / connected     -> auth_required
 *   offline        -> installed and authorised but its process is known down    -> provider_offline
 * Anything else, and every entry with no signal, is "available": unknown is not unavailable.
 *
 * Every `tool` backing points at a first-party server (agentlas-browser, agentlas-turn, agentlas-ui, one-team,
 * hephaestus-network) launched from an installed MCP row, or the in-process "builtin". Main and the background service
 * each register canonical-server-state.ts (installed rows, value-free credential presence, the last exact connection
 * observation); a host that registered nothing keeps the default reader, which reports no signal (available).
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
