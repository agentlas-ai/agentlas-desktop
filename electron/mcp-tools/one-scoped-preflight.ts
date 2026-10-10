import { randomUUID } from "node:crypto";
import type { InstalledMcpServer } from "../../shared/types";
import { inspectOneOriginalMcpAvailability, type OneOriginalMcpSelection, type OneMcpScopedOutcome } from "../one/one-original-mcp-credential";
import { buildMcpConfigFile, type McpConfigBuildOptions } from "./mcp-config";
import { preparedMcpBindings, preparedMcpScopedOutcome, mcpServerConfigurationDigest, type PreparedMcpBinding } from "./prepared-transport";
import { getServer } from "./registry";
import { testServerConnection } from "./client";

/** One invocation-local view of the existing native selection. No selection,
 * approval, installation or credential is created by this constructor. */
export function createOneScopedMcpPreflight(p: {
  resolveSelection(server: Readonly<InstalledMcpServer>): OneOriginalMcpSelection;
  isCurrent(): boolean;
  runId?: string;
  gate: NonNullable<McpConfigBuildOptions["toolGate"]>;
}) {
  let claimed: Extract<OneOriginalMcpSelection, { route: "scoped" }> | null = null;
  let selectionUncertain = false;
  let terminalServer: string | null = null, terminalOutcome: OneMcpScopedOutcome | null = null;
  const unavailable = (serverId: string) => ({ route: "scoped" as const, available: false, connected: false,
    ...(terminalOutcome && terminalServer === serverId ? { outcome: terminalOutcome } : {}) });
  function selection(server: Readonly<InstalledMcpServer>): OneOriginalMcpSelection {
    if (terminalServer === server.id) return { route: "scoped", serverId: server.id, owners: null };
    let next: OneOriginalMcpSelection;
    try { next = p.resolveSelection(server); }
    catch (error) { selectionUncertain = true; throw error; }
    if (next?.route === "legacy") {
      return claimed?.serverId === server.id ? { route: "scoped", serverId: server.id, owners: null } : next;
    }
    if (next?.route !== "scoped" || next.serverId !== server.id || claimed && next.serverId !== claimed.serverId) {
      selectionUncertain = true;
      throw new Error("one_mcp_scoped_selection_changed");
    }
    claimed = next;
    return next;
  }
  return Object.freeze({
    async probe(server: InstalledMcpServer, signal?: AbortSignal) {
      let config: Awaited<ReturnType<typeof buildMcpConfigFile>> = null;
      let binding: PreparedMcpBinding | null = null;
      const observe = () => {
        if (!binding) return;
        const outcome = preparedMcpScopedOutcome(binding);
        if (outcome) { terminalServer = binding.server.id; terminalOutcome = outcome; }
      };
      try {
        const chosen = selection(server);
        if (!p.isCurrent() || signal?.aborted) return unavailable(server.id);
        if (terminalServer === server.id) return unavailable(server.id);
        const availability = await inspectOneOriginalMcpAvailability(chosen, server);
        if (availability.route === "legacy") return { route: "legacy" as const };
        if (!availability.available || chosen.route !== "scoped" || !chosen.owners
          || !server.enabled || server.configurationValid === false || !p.isCurrent() || signal?.aborted) return unavailable(server.id);
        const before = mcpServerConfigurationDigest(server);
        config = await buildMcpConfigFile({
          configKey: `one-scoped-probe-${randomUUID()}`, skipDefaultSeed: true, serverIds: [server.id],
          supervisorReplyRunId: p.runId, admissionCurrent: p.isCurrent,
          nativeScopedSelection: chosen, workingFolder: p.gate.cwd, toolGate: p.gate,
        });
        if (!config || !p.isCurrent() || signal?.aborted) return unavailable(server.id);
        const bindings = preparedMcpBindings(config.configPath).filter(b => b.server.id === server.id);
        if (bindings.length !== 1) return unavailable(server.id);
        binding = bindings[0];
        // Use the real SDK read through the owned Main proxy, never the legacy
        // resolver. A saved reference or a fabricated receipt cannot say connected.
        const result = await testServerConnection(binding.server, { prepared: binding, signal });
        observe();
        if (terminalServer === server.id || !result.connected || result.missingEnv.length > 0) {
          terminalServer = server.id;
          return unavailable(server.id);
        }
        const actual = getServer(server.id), current = actual ? selection(actual) : null;
        if (!p.isCurrent() || signal?.aborted || !actual || mcpServerConfigurationDigest(actual) !== before
          || current?.route !== "scoped" || current.serverId !== chosen.serverId || current.owners !== chosen.owners) {
          terminalServer = server.id; return unavailable(server.id);
        }
        const after = await inspectOneOriginalMcpAvailability(current, actual);
        if (!p.isCurrent() || signal?.aborted || after.route !== "scoped" || !after.available) {
          terminalServer = server.id; return unavailable(server.id);
        }
        return { route: "scoped" as const, available: true, connected: true };
      } catch {
        if (binding) { terminalServer = binding.server.id; try { observe(); } catch { /* unavailable is not success */ } }
        return unavailable(server.id);
      }
      finally { config?.cleanup?.(); }
    },
    /** Final config uses actual installed rows instead of depending on whether
     * auto-select happened to probe this invocation. This callback stays in Main. */
    selectionForServer(server: Readonly<InstalledMcpServer>): OneOriginalMcpSelection {
      if (selectionUncertain) throw new Error("one_mcp_scoped_selection_changed");
      const next = selection(server);
      return next.route === "scoped" && !p.isCurrent()
        ? { route: "scoped", serverId: server.id, owners: null } : next;
    },
    /** The same explicit claim survives failed probes, revoke or missing owners.
     * A required-tool union must not silently restore a global credential path. */
    selectionForConfig(): OneOriginalMcpSelection | undefined {
      if (selectionUncertain) throw new Error("one_mcp_scoped_selection_changed");
      if (!claimed) return undefined;
      const server = getServer(claimed.serverId);
      if (!server || !p.isCurrent()) return { route: "scoped", serverId: claimed.serverId, owners: null };
      try {
        const next = selection(server);
        return next.route === "scoped" ? next : { route: "scoped", serverId: claimed.serverId, owners: null };
      } catch { return { route: "scoped", serverId: claimed.serverId, owners: null }; }
    },
  });
}
