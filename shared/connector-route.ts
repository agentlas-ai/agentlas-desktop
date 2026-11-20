/*
 * Which road does a task about a connected service take: the desktop's port of the ONE pure function the phone agent's service also runs
 * (agentlas/AgentsAtlas/app/companion-connector-route.mjs).
 * API first, macro second; phone and desktop split by data.
 *
 *   routeConnector(need, cards, state, rules?) -> { use, alt, why? }
 *   mayCall(call, cards, state, rules?)        -> { allow } | { allow: false, reason: "api_available", use }
 *
 * PURE and a LINE-FOR-LINE port: no I/O, no clock, no environment, no module state, no randomness, no Electron import (the background service loads it).
 * The model decides three words (which service, read | write | send | delete, where the effect must happen); the road is chosen from the card's typed facts
 * (how / runsOn / needs) and the measured state, never from a name. The ladder order is DATA (connector-route-rules.json, a copy of the web file; the
 * vectors file embeds the same `rules` and the gate holds the three equal). The two ports are held to the same answers by connector-route-vectors.json
 * (scripts/test-connector-route-vectors.cjs runs every case, with the merge rule in the vectors `note`).
 */
import RULES_JSON from "./connector-route-rules.json";

export type ConnectorEffect = "read" | "write" | "send" | "delete";
export type ConnectorRung = "api" | "mcp" | "desktop" | "phone-ui";
export type ConnectorHow = "oauth" | "api-key" | "remote-mcp" | "local-mcp" | "local-file" | "local-app" | "browser" | "screen" | "deep-link" | "macro";
export type ConnectorRunsOn = "server" | "phone" | "desktop" | "any";
export type ConnectorReview = "none" | "brand" | "sensitive" | "restricted";

export interface ConnectorOp { name: string; method: string; path: string; effect: ConnectorEffect; readBack?: { method: string; path: string; idAt: string } }
export interface ConnectorPath {
  id: string;
  how: ConnectorHow;
  runsOn: ConnectorRunsOn;
  needs: string[];
  effects: ConnectorEffect[];
  at?: "phone" | "desktop";
  os?: string[];
  engine?: "a11y" | "shortcut";
  phoneCan?: string;
  listed?: "routines" | "shortcuts";
  keyOwner?: "person" | "agentlas";
  google?: { scopes: Partial<Record<ConnectorEffect, string[]>> };
  review: ConnectorReview;
  completes: "host" | "person";
  verify: "read_back" | "status" | "job" | "person" | "none";
  ops?: ConnectorOp[];
  check?: { method: "GET" | "HEAD"; path: string };
  tool?: string;
  preview?: true;
  costsMoney?: true;
  source: string;
}
export interface ConnectorCard {
  schema: "agentlas.connector-card.v1";
  id: string;
  rev: string;
  names: Record<string, string>;
  identity: { hosts: string[] };
  /** The id this service has in the computer's own catalog when it differs from `id`. */
  desktopId?: string;
  supersededBy?: string;
  paths: ConnectorPath[];
}
export interface RouteRules {
  schema: string;
  rungs: ConnectorRung[];
  within: Record<string, string[]>;
  stateOrder: string[];
  viaOrder: string[];
  altMax: number;
  whyOrder: string[];
  note?: string;
}
export interface RouteNeed { connector: string; effect: ConnectorEffect; at?: "phone" | "desktop" | "any" }
export interface RouteState {
  harness: { kind: "phone" } | { kind: "desktop"; hostId: string; serverTools: boolean };
  vault?: Record<string, { state: "connected" | "saved" | "reconnect" | "pending" | "none" | "blocked"; scopes?: string[]; reason?: string }>;
  review?: string[];
  serverKeys?: string[];
  previews?: string[];
  phone?: { present: boolean; platform: string | null; can?: Record<string, unknown>; withApp?: string[] | null; routines?: Array<{ id?: string; hosts?: string[] }>; shortcuts?: Array<{ name?: string; card?: string }> };
  desktops?: Array<{ hostId: string; on: boolean | null; os: string | null; paths: string[]; order?: number }>;
  turn?: { personPresent: boolean; handedIn: boolean; failed: string[]; unknown: string[]; screenGrant: boolean };
}
export interface RouteStep {
  path: string;
  rung: ConnectorRung;
  how: ConnectorHow;
  via: "self" | "server" | "hand_off" | "person";
  host?: string;
  state: "ready" | "queued" | "connectable";
  action?: string;
  tool: string | null;
  completes: "host" | "person";
}
export interface RouteAnswer { use: RouteStep | null; alt: RouteStep[]; why?: string }
export interface MayCallInput { effect: ConnectorEffect; connector?: string; host?: string; url?: string; path?: string; how?: ConnectorHow; runsOn?: ConnectorRunsOn }
export type MayCallAnswer = { allow: true } | { allow: false; reason: "api_available"; use: RouteStep };

/** The order data (a copy of the web's route-rules.json; the gate holds it equal to the vectors file's `rules`). */
export const ROUTE_RULES: RouteRules = RULES_JSON as RouteRules;

const EFFECTS = ["read", "write", "send", "delete"];

/** The ladder rung of a road, from its typed facts alone: phone -> phone-ui, desktop -> desktop, a server road with a sign-in or a key -> api, any other server road -> mcp. */
export const rungOf = (p: Pick<ConnectorPath, "runsOn" | "how">): ConnectorRung => (p.runsOn === "phone" ? "phone-ui" : p.runsOn === "desktop" ? "desktop" : p.how === "oauth" || p.how === "api-key" ? "api" : "mcp");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const arr = (v: unknown): Any[] => (Array.isArray(v) ? v : []);
const hostUnder = (host: unknown, root: unknown): boolean => typeof host === "string" && typeof root === "string" && (host === root || host.endsWith(`.${root}`));

/** The card a web address belongs to: the card that lists that host (exactly or as a name under it). The listed hosts are facts of the card, never public suffixes (generation refuses those). */
export function cardOfHost(cards: Record<string, ConnectorCard>, host: string | undefined): ConnectorCard | null {
  if (typeof host !== "string" || host === "" || cards === null || typeof cards !== "object") return null;
  const h = host.toLowerCase();
  for (const id of Object.keys(cards)) if (arr(cards[id]?.identity?.hosts).some((root) => hostUnder(h, root))) return cards[id];
  return null;
}

interface NState {
  harness: Any; vault: Record<string, Any>; review: string[]; serverKeys: string[]; previews: string[];
  phone: { present: boolean; platform: Any; can: Record<string, unknown>; withApp: string[] | null; routines: Any[]; shortcuts: Any[] };
  desktops: Array<{ hostId: Any; on: boolean | null; os: Any; paths: string[]; order: number }>;
  turn: { personPresent: boolean; handedIn: boolean; failed: string[]; unknown: string[]; screenGrant: boolean };
}

function normalized(st: RouteState | undefined | null): NState {
  const s: Any = st && typeof st === "object" ? st : {};
  const t: Any = s.turn && typeof s.turn === "object" ? s.turn : {};
  const ph: Any = s.phone && typeof s.phone === "object" ? s.phone : {};
  return {
    harness: s.harness && typeof s.harness === "object" ? s.harness : { kind: "phone" },
    vault: s.vault && typeof s.vault === "object" ? s.vault : {},
    review: arr(s.review),
    serverKeys: arr(s.serverKeys),
    previews: arr(s.previews),
    phone: { present: ph.present === true, platform: ph.platform ?? null, can: ph.can && typeof ph.can === "object" ? ph.can : {}, withApp: Array.isArray(ph.withApp) ? ph.withApp : null, routines: arr(ph.routines), shortcuts: arr(ph.shortcuts) },
    desktops: arr(s.desktops).map((d: Any, i: number) => ({ hostId: d.hostId, on: d.on === true ? true : d.on === false ? false : null, os: d.os ?? null, paths: arr(d.paths), order: typeof d.order === "number" ? d.order : i })),
    turn: { personPresent: t.personPresent === true, handedIn: t.handedIn === true, failed: arr(t.failed), unknown: arr(t.unknown), screenGrant: t.screenGrant === true },
  };
}

const toolOf = (p: ConnectorPath, card: ConnectorCard, effect: string): string | null => {
  if (typeof p.tool === "string") return p.tool;
  const op = arr(p.ops).find((o) => o.effect === effect);
  return op ? `connector.${card.id}.${op.name}` : null;
};

// What the person has that fits this road: routines whose target app opens one of the card's hosts (a routine that did not say is not excluded: a fact that is not
// known is never used to block), shortcuts the person marked for this card (an unmarked one is offered to every card).
function listedFor(phone: NState["phone"], p: ConnectorPath, card: ConnectorCard): Any[] {
  const hosts = arr(card.identity?.hosts);
  if (p.listed === "routines") return phone.routines.filter((r) => !Array.isArray(r.hosts) || r.hosts.some((h: string) => hosts.some((root) => hostUnder(h, root))));
  if (p.listed === "shortcuts") return phone.shortcuts.filter((s) => typeof s.card !== "string" || s.card === card.id);
  return [];
}

interface Step extends RouteStep { order: number; reason?: string }

function stepsOf(p: ConnectorPath, order: number, card: ConnectorCard, need: RouteNeed, st: NState): Step[] {
  const base = { path: p.id, rung: rungOf(p), how: p.how, completes: p.completes, tool: toolOf(p, card, need.effect), order };
  const no = (reason: string): Step[] => [{ ...base, state: "blocked", reason } as unknown as Step];
  if (p.review !== "none" && p.review !== undefined && !st.review.includes(p.review)) return no("review");
  if (p.completes === "person" && !st.turn.personPresent) return no("needs_person"); // a task with nobody there
  if (p.runsOn === "any") return [{ ...base, via: "self", state: "ready" }];
  if (p.runsOn === "server") {
    if (st.harness.kind === "desktop" && !st.harness.serverTools) return no("no_server_bridge");
    if (p.keyOwner === "agentlas") return st.serverKeys.includes(p.id) ? [{ ...base, via: "server", state: "ready" }] : no("not_configured");
    const v = st.vault[p.id] ?? { state: "none" };
    if (v.state === "blocked") return no(v.reason ?? "blocked");
    const want = arr(p.google?.scopes?.[need.effect]);
    const have = arr(v.scopes);
    if ((v.state === "connected" || v.state === "saved") && want.every((s) => have.includes(s))) return [{ ...base, via: "server", state: "ready" }];
    const action = v.state === "connected" ? "grant_scope" : v.state === "reconnect" ? "sign_in_again" : arr(p.needs).includes("key") ? "add_key" : "connect";
    return [{ ...base, via: "server", state: "connectable", action }];
  }
  if (p.runsOn === "desktop") {
    const fits = st.desktops.filter((d) => !p.os || p.os.includes(d.os));
    const holders = fits.filter((d) => d.paths.includes(p.id));
    if (st.harness.kind === "desktop" && holders.some((d) => d.hostId === st.harness.hostId)) return [{ ...base, via: "self", host: st.harness.hostId, state: "ready" }];
    if (st.turn.handedIn) return no("hop_limit"); // a task handed in is never handed on
    if (holders.length) return holders.map((d) => ({ ...base, via: "hand_off" as const, host: d.hostId, order: order + d.order / 1000, state: d.on === true ? ("ready" as const) : ("queued" as const) }));
    if (fits.length) return fits.map((d) => ({ ...base, via: "hand_off" as const, host: d.hostId, order: order + d.order / 1000, state: "connectable" as const, action: "set_up_on_desktop" }));
    return no(st.desktops.length ? "os" : "no_desktop");
  }
  // runsOn === "phone"
  if (st.harness.kind === "desktop") return st.turn.handedIn ? no("hop_limit") : [{ ...base, via: "hand_off", host: "phone", state: "queued" }]; // the phone agent runs it when the person opens the app
  if (!st.phone.present) return no("no_phone");
  if (p.os && !p.os.includes(st.phone.platform)) return no("os");
  const can = p.phoneCan ? st.phone.can[p.phoneCan] : "on";
  if (can !== "on") return p.how === "macro" && can === "off" ? [{ ...base, via: "person", state: "connectable", action: "enable_accessibility" }] : no("phone_cannot");
  if (arr(p.needs).includes("phone-app") && st.phone.withApp !== null && !st.phone.withApp.includes(card.id)) return [{ ...base, via: "person", state: "connectable", action: "get_app" }];
  if (p.listed && listedFor(st.phone, p, card).length === 0) return [{ ...base, via: "person", state: "connectable", action: p.engine === "shortcut" ? "make_shortcut" : "draft_routine" }];
  return [{ ...base, via: "person", state: "ready" }];
}

const idx = (list: unknown, v: unknown): number => {
  const i = arr(list).indexOf(v);
  return i < 0 ? arr(list).length : i;
};
const keyOf = (R: RouteRules, s: Step): number[] => [idx(R.rungs, s.rung), idx(R.within?.[s.rung], s.how), idx(R.stateOrder, s.state), idx(R.viaOrder, s.via), s.order];
const before = (R: RouteRules, a: Step, b: Step): boolean => {
  const x = keyOf(R, a);
  const y = keyOf(R, b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};
const rank = (R: RouteRules) => (a: Step, b: Step): number => (before(R, a, b) ? -1 : before(R, b, a) ? 1 : 0);

// The closed word told when no road is left: the highest of whyOrder among the blocked reasons; a reason that is not in the order (an administrator's block, no key
// configured, no server bridge) is told as "unavailable". `review` is told as "not_yet" (the service's own review of this app is not through) and `no_desktop` as "needs_computer".
const WHY_WORD: Record<string, string> = { review: "not_yet", no_desktop: "needs_computer" };
function whyOf(steps: Step[], R: RouteRules): string {
  const order = arr(R.whyOrder);
  const wordOf = (reason: string | undefined): string | undefined => (reason === undefined ? undefined : WHY_WORD[reason] ?? reason);
  for (const word of order) if (steps.some((s) => (s.state as string) === "blocked" && wordOf(s.reason) === word)) return word;
  return "unavailable";
}

const outStep = (s: Step): RouteStep => ({ path: s.path, rung: s.rung, how: s.how, via: s.via, ...(s.host !== undefined ? { host: s.host } : {}), state: s.state, ...(s.action !== undefined ? { action: s.action } : {}), tool: s.tool, completes: s.completes });

/**
 * need = { connector, effect: read | write | send | delete, at?: phone | desktop | any }  (the three words the model decides)
 * state = { harness, vault, review, serverKeys, previews?, phone, desktops, turn } (all measured by the host; see connector-route-vectors.json `defaults` for the shape)
 */
export function routeConnector(need: RouteNeed, cards: Record<string, ConnectorCard>, st: RouteState, R: RouteRules = ROUTE_RULES): RouteAnswer {
  const state = normalized(st);
  const card = need && cards ? cards[need.connector] : undefined;
  if (!card || !Array.isArray(card.paths)) return { use: null, alt: [], why: "unknown_app" };
  if (!EFFECTS.includes(need.effect)) return { use: null, alt: [], why: "unavailable" };
  const at = need.at;
  const paths = card.paths.filter(
    (p) => arr(p.effects).includes(need.effect) && (!p.preview || state.previews.includes(p.id)) && (at === undefined || at === "any" || (p.at ?? p.runsOn) === at || p.runsOn === "server"),
  );
  // A write whose result is not known stays on its road: no other road is offered (a second send would be a second mail).
  if (need.effect !== "read" && paths.some((p) => state.turn.unknown.includes(p.id))) return { use: null, alt: [], why: "outcome_unknown" };
  const steps = paths.flatMap((p, order) => stepsOf(p, order, card, need, state));
  const live = steps.filter((s) => (s.state as string) !== "blocked" && !state.turn.failed.includes(s.path)).sort(rank(R));
  const use = live.find((s) => s.state === "ready") ?? live.find((s) => s.state === "queued") ?? null;
  let alt: Array<Step | undefined>;
  if (use) {
    alt = [
      live.find((s) => s !== use && before(R, s, use) && s.state !== "ready"), // a better road, one step away
      live.find((s) => s !== use && !before(R, s, use) && s.state === "ready"), // a lower road that works now
    ].filter(Boolean);
  } else {
    alt = live;
  }
  const seen = new Set<string>();
  const outAlt: RouteStep[] = [];
  for (const s of alt) {
    if (!s) continue;
    const k = `${s.path}|${s.action ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    outAlt.push(outStep(s));
    if (outAlt.length >= R.altMax) break;
  }
  return use ? { use: outStep(use), alt: outAlt } : { use: null, alt: outAlt, why: whyOf(steps, R) };
}

/**
 * The host's check at the moment of a call. call = { effect, connector? | host? | url?, path? | (how, runsOn) }: which service the call is about (a connector id, or the
 * host of the web address it opens), and which road the call itself is (a road id of that card, or its how/runsOn). A call that is not provably about a known service is allowed (a thing
 * that is not proven is not stopped). If a road of a higher rung is READY for the same (service, effect), the call is refused with the closed word `api_available` and the road to use.
 * Allowed always: the person's explicit grant to drive the screen (`turn.screenGrant`), and a road that failed this turn (it is no longer a candidate).
 */
export function mayCall(call: MayCallInput, cards: Record<string, ConnectorCard>, st: RouteState, R: RouteRules = ROUTE_RULES): MayCallAnswer {
  const state = normalized(st);
  if (state.turn.screenGrant || !call || typeof call !== "object" || !EFFECTS.includes(call.effect)) return { allow: true };
  let card: ConnectorCard | null = null;
  if (typeof call.connector === "string" && cards) card = cards[call.connector] ?? null;
  if (!card) {
    let host: string | undefined = call.host;
    if (typeof host !== "string" && typeof call.url === "string") {
      try {
        host = new URL(call.url).hostname;
      } catch {
        host = undefined;
      }
    }
    card = cardOfHost(cards, host);
  }
  if (!card) return { allow: true };
  const own: Any = typeof call.path === "string" ? arr(card.paths).find((p) => p.id === call.path) : { how: call.how, runsOn: call.runsOn };
  if (!own || typeof own.runsOn !== "string") return { allow: true };
  const answer = routeConnector({ connector: card.id, effect: call.effect }, cards, st, R);
  if (!answer.use || answer.use.state !== "ready") return { allow: true };
  if (idx(R.rungs, answer.use.rung) < idx(R.rungs, rungOf(own))) return { allow: false, reason: "api_available", use: answer.use };
  return { allow: true };
}
