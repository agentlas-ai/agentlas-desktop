/*
 * The desktop's enforcement of "API first, macro second" (decision; design CONNECTOR-ROUTING-API-FIRST-20261120 section 4.3).
 *
 * ONE place decides at the moment of a call: runtime/tool-approval.ts (every MCP proxy call, ACP permission, in-process loop call and CLI hook goes through its arbiter wrapper,
 * so the 7 subscription CLIs, the API runners and the local models are all covered the same way). That wrapper asks `routeRefusalOf(ask)` here. This file is the pure judgment
 * plus the small per-session memory; it imports no Electron and no database (the background service loads tool-approval.ts), and the cards and the measured state come in as ports.
 *
 * What is refused: a call whose road is LOWER on the ladder than a road that is READY now for the same (service, effect) - for example the computer's own program or its browser
 * when the account connection on the server already serves that service. The refusal carries the road to use. Never refused: a road with nothing higher ready (nothing is proven, nothing
 * is stopped), a call that is not provably about a known service, a road that failed this turn, and anything while the person has explicitly granted driving the screen.
 *
 * No dead end: the refusal is told at most REFUSALS_PER_ROAD times per (conversation, service, effect). If the road to use was never called or its failure never reached `noteRoadFailed`, the
 * next ask goes on its way (an unreported failure of the higher road must not strand the person; the cap is the net, `noteRoadFailed` is the exact signal).
 *
 * Off by default: nothing is installed until Main installs the gate with AGENTLAS_CONNECTOR_ROUTE_V1=1 (switch word below). With nothing installed this file answers null for every ask and the
 * behaviour is byte for byte what it was.
 */
import { mayCall, routeConnector, type ConnectorCard, type ConnectorEffect, type MayCallInput, type RouteState, type RouteStep } from "../../shared/connector-route";
import { bridgeToolName, SERVER_APPS_CONFIG_KEY } from "../one/server-apps";
import { registerDeclaredPromptModule } from "../runtime/prompt-order";

export const CONNECTOR_ROUTE_SWITCH_ENV = "AGENTLAS_CONNECTOR_ROUTE_V1";
export const connectorRouteSwitchOn = (env: Record<string, string | undefined> = process.env): boolean => env[CONNECTOR_ROUTE_SWITCH_ENV] === "1";

/**
 * Numbers (desktop connector route):
 *  REFUSALS_PER_ROAD 2: how many times one conversation is told "a higher road is ready" for the same service and effect. Why 2: the first tells the model the road; the second covers a model
 *     that retried the same call before reading it; after that the road to use evidently cannot be used from here and the call goes through. Without it: a higher road whose failure never reached
 *     `noteRoadFailed` would refuse the lower road forever. Reached: the third ask is allowed (the person sees nothing; the lower road runs as it did before this gate existed).
 *  MEMORY_ENTRIES 256: how many (conversation, service, effect) counters are kept; the oldest is dropped. Without it: memory grows with every conversation of a long session. Reached: an evicted counter
 *     starts again at 0 (at most two more refusals for that one service).
 */
export const REFUSALS_PER_ROAD = 2;
export const MEMORY_ENTRIES = 256;

/** The model-facing refusal line (registered module; ledger recipe desktop.connector-route.refusal, channel tool-result). One fixed `key: value` line; `use` is a tool name of the connected-app bridge, nothing else of the call, the owner or the machine. */
export const CONNECTOR_ROUTE_REFUSAL_MODULE: { readonly id: string; readonly revision: number; readonly stability: "fixed-policy"; readonly changeTriggers: readonly "release"[]; readonly order: number } = {
  id: "connector.route.refusal", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], order: 0,
};
const REFUSAL_NEXT = "a connected account road is ready for this service and effect, so this call was not made; call the tool named in use instead; if that tool fails, repeat this call and it will go through";

export interface RouteRefusal { reason: "api_available"; use: RouteStep; text: string }
export interface RouteGateDeps {
  /** The cards of this turn: the server's list when it sent them, plus this computer's own roads (desktop-paths.ts mergeDesktopCards). Never throws. */
  cards(): Record<string, ConnectorCard>;
  /** The measured state for this conversation's turn, or null when it cannot be measured (then nothing is stopped). `failed`/`unknown` here are merged with what `noteRoadFailed` recorded. */
  state(sessionKey: string): RouteState | null;
}
let gate: RouteGateDeps | null = null;
/** Main installs the gate when the switch is on; null removes it (and forgets the counters). */
export function installRouteGate(deps: RouteGateDeps | null): void { gate = deps; counters.clear(); failures.clear(); screenGrants.clear(); }
export const routeGateInstalled = (): boolean => gate !== null;

const counters = new Map<string, number>();
const failures = new Map<string, Set<string>>();
const remember = <V>(map: Map<string, V>, key: string, value: V): void => { map.delete(key); map.set(key, value); while (map.size > MEMORY_ENTRIES) map.delete(map.keys().next().value as string); };

/** A road failed in this conversation's turn (the exact signal): it is no longer a candidate, so a lower road is not refused because of it. */
export function noteRoadFailed(sessionKey: string, pathId: string): void {
  const set = failures.get(sessionKey) ?? new Set<string>();
  set.add(pathId);
  remember(failures, sessionKey, set);
}
/** A call through the connected-app bridge failed: the server roads of that service are no longer candidates in this conversation's turn (the lower road is then allowed). */
export function noteServerAppFailed(chatId: string, connectorId: string): void {
  const g = gate;
  if (!g) return;
  try {
    const card = cardOfDesktopId(g.cards(), connectorId);
    for (const p of card?.paths ?? []) if (p.runsOn === "server") noteRoadFailed(chatId, p.id);
  } catch { /* nothing changes for the person */ }
}
const screenGrants = new Set<string>();
/**
 * The person explicitly selected Computer Use for this conversation's run (mcp/client.ts: `req.toolMode === "computer-use"` -> `desktopControlGrant`): driving the screen is then theirs to choose and nothing here
 * stops any road (the same explicit choice that opens everything in shared/capability-priority.ts). Bounded like the other memories.
 */
export function noteScreenGrant(chatId: string, on: boolean): void {
  screenGrants.delete(chatId);
  if (on) { screenGrants.add(chatId); while (screenGrants.size > MEMORY_ENTRIES) screenGrants.delete(screenGrants.values().next().value as string); }
}
export const screenGranted = (chatId: string): boolean => screenGrants.has(chatId);
/** The turn ended: its failures and refusal counters are forgotten. */
export function forgetRouteSession(sessionKey: string): void {
  failures.delete(sessionKey);
  screenGrants.delete(sessionKey);
  for (const key of [...counters.keys()]) if (key.startsWith(`${sessionKey}\u0000`)) counters.delete(key);
}

/** The slice of a tool ask this file reads (tool-approval.ts RuntimeToolPermissionAsk). */
export interface RouteAsk { tool: string; kind: string; mutating: boolean; sessionKey: string; chatId?: string; catalogId?: string | null; arguments?: unknown; unattended?: boolean }
/** The memory is per conversation when the ask has one (the bridge only knows the conversation), else per session key. */
const sessionOf = (ask: Pick<RouteAsk, "sessionKey" | "chatId">): string => ask.chatId ?? ask.sessionKey;

const BRIDGE_PREFIX = `mcp__${SERVER_APPS_CONFIG_KEY}__`;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const cardOfDesktopId = (cards: Record<string, ConnectorCard>, id: string): ConnectorCard | null => cards[id] ?? Object.values(cards).find((card) => card.desktopId === id) ?? null;

/**
 * Which service and which road a call is, from facts the host holds - never from a name in the text: the registry identity of the MCP server the call goes to (`catalogId`), or the
 * web address a navigation opens (`arguments.url`, matched against the hosts a card lists). A call through the connected-app bridge is the server road itself: never judged here.
 */
export function callOfAsk(ask: RouteAsk, cards: Record<string, ConnectorCard>): MayCallInput | null {
  if (ask.tool.startsWith(BRIDGE_PREFIX) || ask.tool.startsWith(`${SERVER_APPS_CONFIG_KEY}__`)) return null;
  const effect: ConnectorEffect = ask.kind === "delete" ? "delete" : ask.mutating ? "write" : "read";
  const url = isRecord(ask.arguments) && typeof ask.arguments.url === "string" ? ask.arguments.url : null;
  if (url !== null && (/browser_navigate$/.test(ask.tool) || ask.kind === "fetch" || ask.kind === "network")) return { effect, url, how: "browser", runsOn: "desktop" };
  if (ask.tool.startsWith("mcp__") && typeof ask.catalogId === "string" && ask.catalogId) {
    const card = cardOfDesktopId(cards, ask.catalogId);
    if (card) return { effect, connector: card.id, how: "local-mcp", runsOn: "desktop" };
  }
  return null;
}

/** The step's tool as the model sees it on this computer: the bridge's own name (`<connector>__<tool>`), never the phone's `connector.<card>.<op>` form. */
function bridgeNameOf(use: RouteStep): string {
  const m = /^connector\.([^.]+)\.(.+)$/.exec(use.tool ?? "");
  if (m) return bridgeToolName(m[1], m[2]);
  // A road with no named tool for this effect: the connected app's tools of that service, by their common prefix (`<connector>__*`).
  return `${use.path.split("/")[0]}__*`;
}

export function routeRefusalText(use: RouteStep): string {
  registerDeclaredPromptModule(CONNECTOR_ROUTE_REFUSAL_MODULE);
  return `route_refused: reason=api_available; use=${bridgeNameOf(use)}; next=${REFUSAL_NEXT}`;
}

/** Null = let the call go on (always the answer when no gate is installed or anything is unknown). Otherwise the refusal to hand to the model. */
export function routeRefusalOf(ask: RouteAsk): RouteRefusal | null {
  const g = gate;
  if (!g) return null;
  try {
    const cards = g.cards();
    const call = callOfAsk(ask, cards);
    if (!call) return null;
    const who = sessionOf(ask);
    const base = g.state(who);
    if (!base) return null;
    const seen = failures.get(who);
    const state: RouteState = { ...base, turn: { personPresent: ask.unattended !== true, handedIn: false, screenGrant: false, unknown: [], ...(base.turn ?? {}), failed: [...new Set([...(base.turn?.failed ?? []), ...(seen ?? [])])] } };
    const answer = mayCall(call, cards, state);
    if (answer.allow) return null;
    const card = (call.connector ? cards[call.connector] : null) ?? routeCardOfUrl(cards, call);
    const key = `${who}\u0000${card?.id ?? "?"}\u0000${call.effect}`;
    const told = counters.get(key) ?? 0;
    if (told >= REFUSALS_PER_ROAD) return null; // no dead end: the third ask goes through
    remember(counters, key, told + 1);
    return { reason: "api_available", use: answer.use, text: routeRefusalText(answer.use) };
  } catch { return null; } // a fault in the judgment never stops a call (the approval rule still runs after it)
}
const routeCardOfUrl = (cards: Record<string, ConnectorCard>, call: MayCallInput): ConnectorCard | null => {
  if (!call.url) return null;
  try { const host = new URL(call.url).hostname.toLowerCase(); return Object.values(cards).find((c) => c.identity.hosts.some((root) => host === root || host.endsWith(`.${root}`))) ?? null; } catch { return null; }
};

/**
 * For the bridge of the connected apps (server-apps.ts bridgeTools): the apps this computer also has itself whose server road is READY for a read: today the computer's own copy wins and the
 * server's tools are left out of the list; with the gate on, the server's tools stay in (the computer's call would be refused toward them), so there is always a tool to go to.
 */
export function serverFirstConnectorIds(computerHas: ReadonlySet<string>, sessionKey: string): ReadonlySet<string> {
  const g = gate;
  const out = new Set<string>();
  if (!g || computerHas.size === 0) return out;
  try {
    const cards = g.cards();
    const state = g.state(sessionKey);
    if (!state) return out;
    for (const id of computerHas) {
      const card = cardOfDesktopId(cards, id);
      if (!card) continue;
      const answer = routeConnector({ connector: card.id, effect: "read" }, cards, state);
      if (answer.use && answer.use.state === "ready" && answer.use.via === "server") out.add(card.id);
    }
  } catch { /* nothing changes for the person */ }
  return out;
}

export interface DesktopRouteInputs {
  hostId: string;
  os: "macos" | "windows" | "linux" | null;
  /** The Main process holds the device key (a daemon turn does not): the server roads are reachable only then. */
  serverTools: boolean;
  /** The connected apps of the server list (connector ids, as the server says them). */
  serverApps: readonly string[];
  /** What the server's list answer says about the account roads: when absent the single-server-road rule below is used. */
  vault?: RouteState["vault"];
  review?: readonly string[];
  serverKeys?: readonly string[];
  previews?: readonly string[];
  /** The roads this computer measured as ready (desktop-paths.ts measureDesktopPaths). */
  ownPaths: readonly string[];
  /** The person's explicit grant to drive the screen for this run (the Computer Use permission), read by the caller. */
  screenGrant: boolean;
  unattended?: boolean;
}

/**
 * The measured state of a desktop turn. `vault` comes from the server's list answer when it carries it; until then a connected app counts for a card only when the card has
 * EXACTLY ONE server road (so which road the connection is can not be wrong); more than one = not claimed (the answer errs toward not stopping anything). Review words and server keys come from the
 * server too; an absent word is "not through", so a road that needs a review is never ready from a guess.
 */
export function desktopRouteState(cards: Record<string, ConnectorCard>, input: DesktopRouteInputs): RouteState {
  let vault = input.vault;
  if (!vault) {
    const derived: NonNullable<RouteState["vault"]> = {};
    for (const id of input.serverApps) {
      const card = cardOfDesktopId(cards, id);
      const server = card?.paths.filter((p) => p.runsOn === "server") ?? [];
      if (card && server.length === 1) derived[server[0].id] = { state: "connected" };
    }
    vault = derived;
  }
  return {
    harness: { kind: "desktop", hostId: input.hostId, serverTools: input.serverTools },
    vault,
    review: [...(input.review ?? [])],
    serverKeys: [...(input.serverKeys ?? [])],
    previews: [...(input.previews ?? [])],
    phone: { present: false, platform: null },
    desktops: [{ hostId: input.hostId, on: true, os: input.os, paths: [...input.ownPaths], order: 0 }],
    turn: { personPresent: input.unattended !== true, handedIn: false, failed: [], unknown: [], screenGrant: input.screenGrant },
  };
}
