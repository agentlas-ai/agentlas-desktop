/*
 * The canonical registry's server-state reader (G31, NH31), built from state the host already holds.
 *
 * registerCanonicalServerState had no caller, so canonical-readiness.ts read every `tool` backing as available and the
 * registry could never answer not_installed / auth_required / provider_offline; an agent learned it only after calling
 * (production 10-17: login_may_be_required 13 times from harness calls). This reader is synchronous and local:
 *  - the installed MCP rows (mcp_servers) the backing server is launched from: no row -> not_installed; a row that is
 *    switched off -> not_installed, or needs_auth when its credentials are known to be gone (signed out);
 *  - credential presence from value-free metadata only (connector-presence.ts; no secret read, no keychain prompt);
 *  - the last exact connection observation for the row's current configuration (readiness-observations.ts):
 *    authentication_required -> needs_auth, unavailable -> offline.
 * Anything it cannot tell is no signal (available): unknown is not unavailable. In-process servers ("builtin") always
 * have no signal. Main and the background service each install it (they are separate registries); no electron import.
 */
import { installCanonicalReadinessProbe, registerCanonicalServerState, type CanonicalServerSignal } from "./canonical-readiness";
import { connectorCredentialPresence } from "./connector-presence";
import type { InstalledMcpServer } from "../../shared/types";
import type { ReadinessObservation } from "./readiness-observations";

const IN_PROCESS_SERVERS: ReadonlySet<string> = new Set(["builtin"]);

export interface CanonicalServerStateDeps {
  listInstalled(): readonly InstalledMcpServer[];
  observation(serverId: string): ReadinessObservation | null;
  configurationDigest(server: InstalledMcpServer): string;
}

function productionDeps(): CanonicalServerStateDeps {
  return {
    listInstalled: () => (require("../mcp-tools/registry") as typeof import("../mcp-tools/registry")).listInstalledServers(),
    observation: (id) => (require("./readiness-observations") as typeof import("./readiness-observations")).readReadinessObservationSync("connection", id),
    configurationDigest: (server) => (require("../mcp-tools/prepared-transport") as typeof import("../mcp-tools/prepared-transport")).mcpServerConfigurationDigest(server),
  };
}

export function canonicalServerSignal(server: string, deps: CanonicalServerStateDeps = productionDeps()): CanonicalServerSignal | null {
  if (IN_PROCESS_SERVERS.has(server)) return null;
  let rows: readonly InstalledMcpServer[];
  try { rows = deps.listInstalled().filter((row) => row.catalogId === server || row.id === server); }
  catch { return null; } // no store in this host: no signal
  if (rows.length === 0) return "not_installed";
  const credentials = (row: InstalledMcpServer) => connectorCredentialPresence({ serverId: row.id, transport: row.transport,
    envKeys: row.envKeys ?? [], credentialRefs: row.credentialRefs ?? null }).credentialState;
  const enabled = rows.find((row) => row.enabled && row.configurationValid !== false);
  if (!enabled) {
    const signedOut = rows.some((row) => row.connectionEpoch && ["credential_missing", "login_may_be_required"].includes(credentials(row)));
    return signedOut ? "needs_auth" : "not_installed";
  }
  const state = credentials(enabled);
  let observation: ReadinessObservation | null = null;
  try {
    const observed = deps.observation(enabled.id);
    observation = observed && observed.configurationDigest === deps.configurationDigest(enabled) ? observed : null;
  } catch { observation = null; }
  if (state === "credential_missing" || observation?.outcome === "authentication_required") return "needs_auth";
  // A remote server with no key and no OAuth session may need none: only an observed handshake settles it.
  if (state === "login_may_be_required" && observation?.outcome !== "ok") return "needs_auth";
  if (observation?.outcome === "unavailable") return "offline";
  return "ready";
}

/** Each host (Main, the background service) calls this once its store is open. */
export function installCanonicalServerStateReader(): void {
  registerCanonicalServerState((server) => canonicalServerSignal(server));
  installCanonicalReadinessProbe();
}
