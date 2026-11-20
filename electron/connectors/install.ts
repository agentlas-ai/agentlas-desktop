/*
 * The one entry Main (and the background service) calls to turn the desktop's connector routing on (decision-; design CONNECTOR-ROUTING-API-FIRST).
 *
 * Off by default (AGENTLAS_CONNECTOR_ROUTE_V1 != "1"): `installConnectorRoute` then does NOTHING and returns an inert handle: no probe, no connection test, no gate, no place column, no IPC answer
 * beyond an empty list. On: it installs the enforcement gate (route-gate.ts), measures this computer's roads (desktop-paths.ts) on the SIGNALS the caller gives it (start, a program installed or removed,
 * a permission change, the start of a turn that finds a different answer) - never a timer - and tells the places link only when the measured set CHANGED.
 *
 * Everything outside is a port (`ConnectorRouteHost`), so a gate drives this with fakes and the file imports no Electron.
 */
import type { ConnectorCard, RouteState } from "../../shared/connector-route";
import { buildAccountConnectorRows, type RouteViewRow } from "../../shared/connector-route-view";
import type { ServerAppsState } from "../one/server-apps";
import { connectorRouteSwitchOn, desktopRouteState, installRouteGate, screenGranted } from "./route-gate";
import { defaultDesktopPathProbes, desktopOsOf, measureDesktopPaths, mergeDesktopCards, type CatalogRow, type DesktopPathProbes } from "./desktop-paths";

export interface ConnectorRouteHost {
  hostId: string;
  /** The stored list of connected apps (server-apps.ts snapshot): memory only, no request. Null = none / not the home. */
  serverApps(): ServerAppsState | null;
  /** This process holds the device key (Desktop Main at home). False in the background service: the server roads are then not reachable from here. */
  serverTools(): boolean;
  /** Extra source for "the person explicitly granted driving the screen" (the registry `noteScreenGrant` in route-gate.ts is always read too). */
  screenGrant?(sessionKey: string): boolean;
  /** The computer's own tool catalog (MCP_TOOL_CATALOG). */
  catalog(): ReadonlyArray<CatalogRow>;
  /** What the server's list answer carried: its cards and the words of the account roads. Null until the server sends them: nothing about the account roads is then claimed except by the single-road rule. */
  server(): { cards?: Record<string, ConnectorCard>; vault?: RouteState["vault"]; review?: string[]; serverKeys?: string[]; previews?: string[] } | null;
  /** Other computers of the person (the server's place list); [] when not known. */
  otherDesktops?(): NonNullable<RouteState["desktops"]>;
  /** The phone's measured state when the server's answer carries it; absent = the phone is not known here. */
  phone?(): RouteState["phone"] | undefined;
  /** The measured set changed: the places link reports it (a report only when its digest differs). */
  onPaths(paths: string[]): void;
  probes?: DesktopPathProbes;
}

export interface ConnectorRouteHandle {
  readonly on: boolean;
  /** Measure the roads now (a signal happened). Resolves to the ready road ids. */
  remeasure(): Promise<string[]>;
  /** The rows of the account-connections section (empty when off). */
  rows(): RouteViewRow[];
  /** The roads measured ready at the last measurement (the places link's provider). */
  paths(): string[];
  stop(): void;
}

const INERT: ConnectorRouteHandle = Object.freeze({ on: false, remeasure: async () => [], rows: () => [], paths: () => [], stop: () => undefined });

export function installConnectorRoute(host: ConnectorRouteHost, env: Record<string, string | undefined> = process.env): ConnectorRouteHandle {
  if (!connectorRouteSwitchOn(env)) { installRouteGate(null); return INERT; }
  const os = desktopOsOf();
  let measured: string[] = [];
  let measuring: Promise<string[]> | null = null;

  const cards = (): Record<string, ConnectorCard> => {
    try {
      const apps = host.serverApps()?.apps ?? [];
      const ids: Record<string, string> = {};
      for (const app of apps) if (app.desktopId) ids[app.connectorId] = app.desktopId;
      return mergeDesktopCards(host.server()?.cards ?? null, ids, host.catalog());
    } catch { return {}; }
  };
  const state = (sessionKey: string): RouteState | null => {
    try {
      const server = host.server();
      const base = desktopRouteState(cards(), {
        hostId: host.hostId, os, serverTools: host.serverTools(), serverApps: (host.serverApps()?.apps ?? []).map((a) => a.connectorId),
        ...(server?.vault ? { vault: server.vault } : {}), ...(server?.review ? { review: server.review } : {}), ...(server?.serverKeys ? { serverKeys: server.serverKeys } : {}), ...(server?.previews ? { previews: server.previews } : {}),
        ownPaths: measured, screenGrant: screenGranted(sessionKey) || host.screenGrant?.(sessionKey) === true,
      });
      const phone = host.phone?.();
      return { ...base, desktops: [...(base.desktops ?? []), ...(host.otherDesktops?.() ?? [])], ...(phone ? { phone } : {}) };
    } catch { return null; }
  };
  installRouteGate({ cards, state });

  const remeasure = (): Promise<string[]> => {
    if (measuring) return measuring; // a signal during a measurement is folded into it (one probe run at a time)
    measuring = (async () => {
      try {
        const next = await measureDesktopPaths(cards(), host.probes ?? defaultDesktopPathProbes());
        if (next.join("\u0000") !== measured.join("\u0000")) { measured = next; try { host.onPaths([...measured]); } catch { /* the next signal reports again */ } }
      } catch { /* a failed measurement keeps the last one: nothing is claimed that was not measured */ }
      return [...measured];
    })().finally(() => { measuring = null; });
    return measuring;
  };

  return {
    on: true, remeasure, paths: () => [...measured],
    rows: () => { const s = state("view"); return s ? buildAccountConnectorRows(cards(), s) : []; },
    stop: () => installRouteGate(null),
  };
}
