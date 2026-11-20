/*
 * Desktop Main's one call for connector routing (decision-; design CONNECTOR-ROUTING-API-FIRST): `installConnectorRouteInMain(ipcMain,...)`.
 * Everything here is the glue to modules only Main may load; the decisions are in route-gate.ts / desktop-paths.ts / install.ts (all Electron-free and tested with fakes).
 * With AGENTLAS_CONNECTOR_ROUTE_V1 off (the default) this registers an IPC answer that returns [] and nothing else: no gate, no probe, no place column.
 *
 * The signals that measure (never a timer): the call itself (start), `remeasure()` for "a program was installed / removed / enabled", "an OS permission changed", "the browser login was imported",
 * and the start of a turn - Main passes `onSignal` handles to whoever already raises those events.
 */
import type { IpcMain } from "electron";
import { MCP_TOOL_CATALOG } from "../mcp-tools/catalog";
import { currentServerApps } from "../one/server-apps-host";
import { notifyPlacePathsChanged, setPlacePathsProvider } from "../mobile-bridge/places-link";
import { setBrowserSessionProbe } from "./desktop-paths";
import { installConnectorRoute, type ConnectorRouteHandle } from "./install";
import { onRoadsMaybeChanged } from "./road-signal";

export const CONNECTOR_ROUTE_VIEW_CHANNEL = "connectors:routeView";

export function installConnectorRouteInMain(
  ipc: Pick<IpcMain, "handle">,
  options: { /** The Agentlas browser holds a signed-in session for this host (the receipts of imported logins live in the window host). */ browserSession?: (host: string) => boolean | Promise<boolean> } = {},
): ConnectorRouteHandle {
  const handle = installConnectorRoute({
    hostId: "self",
    serverApps: () => { try { return currentServerApps()?.snapshot() ?? null; } catch { return null; } },
    // Main holds the device key at home; the background service does not (`server-apps-host.ts` isMainProcess): this file is only called from Main.
    serverTools: () => Boolean(process.versions.electron) && !process.env.ELECTRON_RUN_AS_NODE,
    catalog: () => MCP_TOOL_CATALOG,
    server: () => null, // 's list answer does not carry cards/vault/review yet: nothing is claimed beyond the single-server-road rule
    onPaths: () => notifyPlacePathsChanged(),
  });
  if (handle.on) {
    setPlacePathsProvider(() => handle.paths());
    if (options.browserSession) setBrowserSessionProbe(options.browserSession);
    void handle.remeasure();
    // A program installed / removed / enabled (mcp-tools/registry.ts) measures again; the places link reports only a changed set.
    onRoadsMaybeChanged(() => { void handle.remeasure(); });
  }
  ipc.handle(CONNECTOR_ROUTE_VIEW_CHANNEL, () => handle.rows());
  return handle;
}
