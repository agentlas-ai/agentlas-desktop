/*
 * The account-connections screen's rows, decided here and not in the component (decision: reuse the existing screen, no new page).
 * Pure: cards + measured state in, rows out. The screen has no judgment of its own (`phone_entries.dart`'s principle on the phone): which group a service is in and which road is the one used
 * (`use`) are the route function's answers.
 *
 * Groups (what the design lists, nothing more):
 *   account        the service's account connection (sign-in, key, hosted MCP) on the server: the phone agent and every computer use the same one
 * this-desktop a road only this computer has, measured ready (its own program, a synced folder, app scripting, the signed-in browser)
 *   other-desktop  a road another computer of the person reported (read-only here)
 *   phone-only     a road the phone has and this computer does not (read-only: "the phone agent takes it")
 * A service appears once, in the group of the road that is used now; `via` words are closed words the component translates.
 */
import { routeConnector, rungOf, type ConnectorCard, type ConnectorEffect, type ConnectorHow, type RouteState, type RouteStep } from "./connector-route";

export type RouteViewGroup = "account" | "this-desktop" | "other-desktop" | "phone-only";
/** The closed words of "the road in use" (the component maps each to a ko/en label). */
export type RouteViewWay = "login" | "key" | "remote" | "program" | "file" | "app_script" | "browser" | "other_desktop" | "phone";
export interface RouteViewRow { id: string; name: string; group: RouteViewGroup; way: RouteViewWay; /** The id of the road used (a card road id). */ path: string; /** Another computer's host id, for the other-desktop group. */ host?: string }

const wayOf = (how: ConnectorHow, via: RouteStep["via"], runsOn: string): RouteViewWay => {
  if (runsOn === "phone") return "phone";
  if (via === "hand_off") return "other_desktop";
  switch (how) {
    case "oauth": return "login";
    case "api-key": return "key";
    case "remote-mcp": return "remote";
    case "local-mcp": return runsOn === "server" ? "remote" : "program";
    case "local-file": return "file";
    case "local-app": return "app_script";
    default: return "browser";
  }
};

/**
 * One row per service that has a road ready or connected, in the group of the road the route would take for a read (a service that cannot be read is judged for a write). Sorted by name, then id,
 * so the same state gives the same rows. A service with nothing ready is not a row (the screen's existing lists show installable ones).
 */
export function buildAccountConnectorRows(cards: Record<string, ConnectorCard>, state: RouteState): RouteViewRow[] {
  const rows: RouteViewRow[] = [];
  for (const card of Object.values(cards)) {
    let picked: { use: RouteStep; effect: ConnectorEffect } | null = null;
    for (const effect of ["read", "write"] as const) {
      const answer = routeConnector({ connector: card.id, effect }, cards, state);
      if (answer.use && answer.use.state === "ready") { picked = { use: answer.use, effect }; break; }
    }
    if (!picked) continue;
    const road = card.paths.find((p) => p.id === picked!.use.path);
    if (!road) continue;
    const group: RouteViewGroup = rungOf(road) === "api" || rungOf(road) === "mcp" ? "account" : road.runsOn === "phone" ? "phone-only" : picked.use.via === "hand_off" ? "other-desktop" : "this-desktop";
    rows.push({ id: card.id, name: card.names?.en || card.id, group, way: wayOf(road.how, picked.use.via, road.runsOn), path: road.id, ...(picked.use.host && group === "other-desktop" ? { host: picked.use.host } : {}) });
  }
  return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const ROUTE_VIEW_GROUP_ORDER: readonly RouteViewGroup[] = ["account", "this-desktop", "other-desktop", "phone-only"];
